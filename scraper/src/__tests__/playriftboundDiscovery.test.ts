import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  chunkNamesIn,
  extractQueryHashFromChunk,
  fetchPlayriftboundEvents,
  rediscoverQueryHash,
  resetQueryHashCache,
  SEED_ANCHORS,
} from '../sources/playriftbound.js';

/**
 * Fixtures for the persisted-query-hash self-heal.
 *
 * They mirror the shapes measured on Riot's 2026-10-25 build rather than being
 * invented, because the whole discovery chain is shape-dependent:
 *
 * - the events page HTML references chunks only as `static/chunks/<name>.js`
 *   inside script/preload tags, and carries no hash of its own;
 * - the manifest chunk is *not* one of those - it is lazily loaded, and the only
 *   pointer to it is a Turbopack loader call inside one of the page's chunks;
 * - the manifest payload is Apollo's
 *   `{"format":"apollo-persisted-query-manifest","version":1,"operations":[…]}`,
 *   each operation `{"id":"<64 hex>","name":"…","type":"query","body":"…"}`.
 */

const NEW_HASH = '868030f676276bec926c740aada7129713d4097f6e2dd7c3a0451c4fb43852eb';
const LAST_MEASURED_CHUNK = '3ljhtmeypccge.js';

/** Real Turbopack loader form: this is the *only* reference to a lazy chunk. */
function lazyLoader(name: string): string {
  return `},47828,e=>{e.v(t=>Promise.all(["static/chunks/${name}"].map(t=>e.l(t))).then(()=>t(972560)))}]);`;
}

function manifestChunk(hash = NEW_HASH, operationName = 'CompeteTournamentSearch'): string {
  return (
    '(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,' +
    `972560,(n,e,t)=>{e.exports=JSON.parse('{"format":"apollo-persisted-query-manifest","version":1,"operations":[` +
    `{"id":"${'a'.repeat(64)}","name":"ALlArticle","type":"query","body":"query ALlArticle {\\\\n  __typename\\\\n}"},` +
    `{"id":"${hash}","name":"${operationName}","type":"query","body":"query ${operationName} {\\\\n  __typename\\\\n}"}` +
    `]}')}]);`
  );
}

/** Events page HTML: n chunk references, in document order. */
function eventsPageHtml(names: string[]): string {
  return (
    '<!DOCTYPE html><html><head>' +
    names.map(n => `<link rel="preload" href="/_next/static/chunks/${n}" as="script"/>`).join('') +
    names.map(n => `<script src="/_next/static/chunks/${n}" async=""></script>`).join('') +
    '</head><body></body></html>'
  );
}

const EVENTS_PAGE = 'https://events.playriftbound.com/en-US/events';
const CHUNK_BASE = 'https://events.playriftbound.com/_next/static/chunks/';

/**
 * Serve a fake bundle. `chunks` maps a chunk filename to its body; anything not
 * listed 404s, which is what a rotated chunk name actually does (the previous
 * hardcoded manifest URL returned HTTP 404 with a 9-byte body on 2026-10-25).
 */
function serveBundle(bundle: { html?: string | null; chunks: Record<string, string> }) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(url);
    if (url === EVENTS_PAGE) {
      return bundle.html == null
        ? new Response('Not Found', { status: 404 })
        : new Response(bundle.html, { status: 200 });
    }
    if (url.startsWith(CHUNK_BASE)) {
      const name = url.slice(CHUNK_BASE.length);
      const body = bundle.chunks[name];
      return body === undefined ? new Response('Not Found', { status: 404 }) : new Response(body, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, urls, probed: () => urls.filter(u => u.startsWith(CHUNK_BASE)).map(u => u.slice(CHUNK_BASE.length)) };
}

beforeEach(() => {
  resetQueryHashCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetQueryHashCache();
});

describe('chunkNamesIn', () => {
  it('reads the chunk names the events page references, in document order', () => {
    const names = chunkNamesIn(eventsPageHtml(['0_-2fycvvxpi5.js', '1x7ey3ub0c35t.js', '2gcq9b44spshr.js']));
    // Each name appears twice in the HTML (preload + script); de-duplicated.
    expect(names).toEqual(['0_-2fycvvxpi5.js', '1x7ey3ub0c35t.js', '2gcq9b44spshr.js']);
  });

  it('reads the lazily-loaded chunk name out of a Turbopack loader call', () => {
    expect(chunkNamesIn(lazyLoader('3ljhtmeypccge.js'))).toEqual(['3ljhtmeypccge.js']);
  });

  it('ignores anything that is not a chunk path', () => {
    expect(chunkNamesIn('import("/_next/static/media/logo.svg");var x="foo.js"')).toEqual([]);
  });
});

describe('extractQueryHashFromChunk', () => {
  it('pulls the id out of a real-shaped Apollo manifest chunk', () => {
    expect(extractQueryHashFromChunk(manifestChunk())).toBe(NEW_HASH);
  });

  it('returns null for a manifest that does not list the operation', () => {
    expect(extractQueryHashFromChunk(manifestChunk(NEW_HASH, 'CompeteTournamentRenamed'))).toBeNull();
  });
});

describe('rediscoverQueryHash', () => {
  it('finds the manifest in a lazily-loaded chunk the page never mentions', async () => {
    const bundle = serveBundle({
      html: eventsPageHtml(['a1.js', 'a2.js', 'a3.js']),
      chunks: {
        'a1.js': 'nothing here',
        'a2.js': `some code ${lazyLoader('lazy-manifest.js')}`,
        'a3.js': 'nothing here either',
        'lazy-manifest.js': manifestChunk(),
      },
    });

    expect(await rediscoverQueryHash(0)).toBe(NEW_HASH);
    // The lazy chunk jumps the queue: a3.js is never fetched.
    expect(bundle.probed()).toEqual(['a1.js', 'a2.js', 'lazy-manifest.js']);
  });

  it('prefers lazily-referenced chunks over the page\'s own remaining chunks', async () => {
    // Measured on the live build: of 36 page chunks, only 2 names were new -
    // so a name discovered inside a chunk is nearly always the lazy manifest.
    const page = ['p1.js', 'p2.js', 'p3.js', 'p4.js', 'p5.js'];
    const bundle = serveBundle({
      html: eventsPageHtml(page),
      chunks: {
        'p1.js': lazyLoader('lazy-a.js'),
        'p2.js': '',
        'p3.js': '',
        'p4.js': '',
        'p5.js': '',
        'lazy-a.js': lazyLoader('lazy-b.js'),
        'lazy-b.js': manifestChunk(),
      },
    });

    expect(await rediscoverQueryHash(0)).toBe(NEW_HASH);
    expect(bundle.probed()).toEqual(['p1.js', 'lazy-a.js', 'lazy-b.js']);
  });

  it('remembers the chunk, so a second rediscovery costs one request', async () => {
    const bundle = serveBundle({
      html: eventsPageHtml(['a1.js']),
      chunks: { 'a1.js': lazyLoader('lazy-manifest.js'), 'lazy-manifest.js': manifestChunk() },
    });

    expect(await rediscoverQueryHash(0)).toBe(NEW_HASH);
    const afterFirst = bundle.urls.length;

    expect(await rediscoverQueryHash(0)).toBe(NEW_HASH);
    expect(bundle.urls.slice(afterFirst)).toEqual([`${CHUNK_BASE}lazy-manifest.js`]);
  });

  it('re-crawls when the remembered chunk has rotated away', async () => {
    const first = serveBundle({
      html: eventsPageHtml(['a1.js']),
      chunks: { 'a1.js': lazyLoader('old-manifest.js'), 'old-manifest.js': manifestChunk() },
    });
    expect(await rediscoverQueryHash(0)).toBe(NEW_HASH);
    expect(first.probed()).toContain('old-manifest.js');

    // Riot redeploys: every chunk name changes and the old one 404s.
    const rotatedHash = 'f'.repeat(64);
    const second = serveBundle({
      html: eventsPageHtml(['b1.js']),
      chunks: { 'b1.js': lazyLoader('new-manifest.js'), 'new-manifest.js': manifestChunk(rotatedHash) },
    });

    expect(await rediscoverQueryHash(0)).toBe(rotatedHash);
    expect(second.probed()).toEqual(['old-manifest.js', 'b1.js', 'new-manifest.js']);
  });

  it('falls back to the last measured chunk name when the events page is down', async () => {
    const bundle = serveBundle({
      html: null,
      chunks: { [LAST_MEASURED_CHUNK]: manifestChunk() },
    });

    expect(await rediscoverQueryHash(0)).toBe(NEW_HASH);
    expect(bundle.probed()).toEqual([LAST_MEASURED_CHUNK]);
  });

  it('gives up loudly when neither the crawl nor the last measured chunk works', async () => {
    const bundle = serveBundle({ html: eventsPageHtml(['a1.js', 'a2.js']), chunks: { 'a1.js': '', 'a2.js': '' } });

    expect(await rediscoverQueryHash(0)).toBeNull();
    // Page chunks exhausted, then the long shot, then it stops.
    expect(bundle.probed()).toEqual(['a1.js', 'a2.js', LAST_MEASURED_CHUNK]);
    expect(console.error).toHaveBeenCalled();
  });

  it('never probes the same chunk twice, however tangled the reference graph', async () => {
    const bundle = serveBundle({
      html: eventsPageHtml(['a1.js', 'a2.js']),
      // a1 <-> a2 <-> lazy, lazy points back at both: a cycle.
      chunks: {
        'a1.js': `${lazyLoader('lazy.js')} static/chunks/a2.js`,
        'a2.js': 'static/chunks/a1.js',
        'lazy.js': 'static/chunks/a1.js static/chunks/a2.js',
      },
    });

    expect(await rediscoverQueryHash(0)).toBeNull();
    const probed = bundle.probed();
    expect(new Set(probed).size).toBe(probed.length);
    expect(probed).toEqual(['a1.js', 'lazy.js', 'a2.js', LAST_MEASURED_CHUNK]);
  });

  it('stops at the deadline instead of eating the invocation budget', async () => {
    const bundle = serveBundle({
      html: eventsPageHtml(['a1.js', 'a2.js']),
      chunks: { 'a1.js': '', 'a2.js': manifestChunk() },
    });

    // Deadline already passed: the page is read, then nothing is probed, and the
    // long-shot chunk is skipped too.
    expect(await rediscoverQueryHash(0, Date.now() - 1)).toBeNull();
    expect(bundle.probed()).toEqual([]);
    expect(bundle.urls).toEqual([EVENTS_PAGE]);
  });
});

describe('persisted query self-heal end to end', () => {
  const staleHashError = {
    errors: [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_IN_LIST' } }],
  };
  const emptySearch = {
    data: { competeTournamentSearch: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } } },
  };

  function serveGql(bundle: Record<string, string>, html: string | null, acceptHash: string) {
    const gqlHashes: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://events.playriftbound.com/api/gql')) {
        const extensions = JSON.parse(new URL(url).searchParams.get('extensions') as string);
        const hash = extensions.persistedQuery.sha256Hash as string;
        gqlHashes.push(hash);
        return hash === acceptHash
          ? new Response(JSON.stringify(emptySearch), { status: 200 })
          : new Response(JSON.stringify(staleHashError), { status: 404 });
      }
      if (url === EVENTS_PAGE) {
        return html == null ? new Response('', { status: 404 }) : new Response(html, { status: 200 });
      }
      const name = url.slice(CHUNK_BASE.length);
      return bundle[name] === undefined
        ? new Response('Not Found', { status: 404 })
        : new Response(bundle[name], { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { gqlHashes, fetchMock };
  }

  const options = {
    anchors: SEED_ANCHORS.slice(0, 2),
    maxAnchorsPerRun: 2,
    requestDelayMs: 0,
    anchorDelayMs: 0,
    rotation: 0,
  };

  it('rediscovers the hash on PERSISTED_QUERY_NOT_IN_LIST and retries once', async () => {
    const live = 'd'.repeat(64);
    const { gqlHashes } = serveGql(
      { 'a1.js': lazyLoader('m.js'), 'm.js': manifestChunk(live) },
      eventsPageHtml(['a1.js']),
      live
    );

    const result = await fetchPlayriftboundEvents(options);

    expect(result.failed).toBe(false);
    // First call with the shipped default, every later call with the new hash.
    expect(gqlHashes[0]).not.toBe(live);
    expect(gqlHashes.slice(1).every(h => h === live)).toBe(true);
    expect(gqlHashes.length).toBeGreaterThan(1);
  });

  it('caches the rediscovered hash for the process, so the next run starts with it', async () => {
    const live = 'e'.repeat(64);
    const bundle = { 'a1.js': lazyLoader('m.js'), 'm.js': manifestChunk(live) };
    serveGql(bundle, eventsPageHtml(['a1.js']), live);
    await fetchPlayriftboundEvents(options);

    const second = serveGql(bundle, eventsPageHtml(['a1.js']), live);
    await fetchPlayriftboundEvents(options);

    expect(second.gqlHashes[0]).toBe(live);
  });

  it('skips the source for the run - without throwing - when no hash can be found', async () => {
    const { gqlHashes } = serveGql({}, null, 'never-matches');

    const result = await fetchPlayriftboundEvents(options);

    expect(result.failed).toBe(true);
    expect(result.events).toEqual([]);
    // One rejected query, then it stops rather than hammering every anchor.
    expect(gqlHashes.length).toBe(1);
  });

  it('honours PLAYRIFTBOUND_QUERY_HASH as a manual pin, skipping discovery', async () => {
    const pinned = 'c'.repeat(64);
    const { gqlHashes, fetchMock } = serveGql({}, null, pinned);

    const result = await fetchPlayriftboundEvents({ ...options, queryHash: pinned });

    expect(result.failed).toBe(false);
    expect(gqlHashes.every(h => h === pinned)).toBe(true);
    expect(fetchMock.mock.calls.every(c => String(c[0]).includes('/api/gql'))).toBe(true);
  });
});
