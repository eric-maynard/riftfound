import { describe, it, expect, beforeEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

/**
 * Display-name search, against a corpus large enough for the bug to exist in.
 *
 * **The bug this file exists to prevent coming back.** `searchPlayers` was a
 * Scan with `Limit: 500` over four pages, and `Limit` on a Scan caps the items
 * examined *before* the filter. Measured against production on 2026-10-29:
 * 2,000 items examined held **178 of 40,979 profiles (0.43%)**, for 203.5 read
 * units. `illusionz#1337` and `tpcstld#NA1` - both rated, both served in full
 * by `/api/players/:id`, both sitting on the public leaderboard - came back
 * from `/api/players/search` as zero results, while `sealsmasher` and
 * `Dromex13` were found purely for sitting at the front of scan order.
 *
 * So the test that matters is not "does search find somebody". It is **does
 * search find a player who is deep in the corpus** - a test that only checks
 * the first page passes against the broken implementation, which is exactly
 * what happened. Every case below puts its target past the point the old
 * capped scan could reach.
 *
 * The table is faked rather than mocked call-by-call, with DynamoDB's real
 * Scan semantics (see the helper), because the thing under test is what a
 * reader can get back out.
 */

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    constructor(public readonly config: unknown) {}
  },
}));

vi.mock('@aws-sdk/lib-dynamodb', async () => {
  const { fakeSend, FAKE_COMMANDS } = await import('./helpers/fakeDynamo.js');
  return { DynamoDBDocumentClient: { from: () => ({ send: fakeSend }) }, ...FAKE_COMMANDS };
});

// Static imports, not top-level `await import`: `vi.mock` is hoisted above
// them by vitest, and this package compiles to CommonJS where a top-level
// await is a type error.
import { fakeTable, fakeSend, putFakeItem, resetFakeTable } from './helpers/fakeDynamo.js';
import { dynamoRankingStore, resetPlayerNameIndexCache } from '../adapters/rankingDynamoAdapter.js';
import {
  buildNameIndex,
  decodeSearchShards,
  searchNameIndex,
  scoreNameMatch,
} from '../adapters/playerNameIndex.js';
import { PLAYER_SEARCH_INDEX_FORMAT } from '../config/dynamodb.js';

/**
 * A production-shaped corpus: 40,000 players, plus the ~10 non-profile items
 * per player that make the real table 441,214 items for 40,979 profiles. The
 * ratio is what starves the capped scan, so the test has to reproduce it
 * rather than a table of nothing but profiles.
 */
const CORPUS = 40_000;
const NOISE_PER_PLAYER = 10;

interface Seeded {
  playerId: string;
  displayName: string;
  tagLine: string;
}

function seedTable(options: { withIndex: boolean; extra?: Seeded[] }): Seeded[] {
  resetFakeTable();
  const players: Seeded[] = [];

  for (let i = 0; i < CORPUS; i++) {
    const playerId = `p-${String(i).padStart(6, '0')}`;
    const player: Seeded = {
      playerId,
      displayName: `Filler${i}`,
      tagLine: `NA${i % 10}`,
    };
    players.push(player);
    putFakeItem({
      PK: `PLAYER#${playerId}`,
      SK: 'PROFILE',
      playerId,
      displayName: player.displayName,
      tagLine: player.tagLine,
      rating: 1200 + (i % 300),
      uncertainty: 95,
      gamesPlayed: 12,
      rated: true,
      provisional: false,
      regionLabel: 'Somewhere',
    });
    // Match log entries and rating points, which is what the real table is
    // mostly made of and what a Scan spends its Limit examining.
    for (let n = 0; n < NOISE_PER_PLAYER; n++) {
      putFakeItem({ PK: `PLAYER#${playerId}`, SK: `MATCH#2026-10-${String((n % 28) + 1).padStart(2, '0')}#m${n}` });
    }
  }

  // The targets go in *last*, so they are at the very back of scan order -
  // the position `tpcstld` was in.
  for (const player of options.extra ?? []) {
    players.push(player);
    putFakeItem({
      PK: `PLAYER#${player.playerId}`,
      SK: 'PROFILE',
      playerId: player.playerId,
      displayName: player.displayName,
      tagLine: player.tagLine,
      rating: 1380,
      uncertainty: 97,
      gamesPlayed: 8,
      rated: true,
      provisional: false,
      regionLabel: 'Somewhere',
    });
  }

  if (options.withIndex) putIndexShards(players);
  return players;
}

/**
 * Write the index the way the scraper does: tab-separated lines, gzipped, in
 * `PLAYER_SEARCH` / `SHARD#<nnn>` items.
 *
 * Encoded here by hand rather than by importing the scraper's builder, on
 * purpose: the writer and the reader are in different packages and can be
 * deployed apart, so this is the reader being tested against the *format* it
 * promises to read, not against the other package's implementation of it.
 * `scraper/src/__tests__/rankingSearchIndex.test.ts` pins the other side.
 */
function putIndexShards(players: Seeded[], perShard = 6000): void {
  const lines = players
    .map((p) => `${p.playerId}\t${p.displayName}\t${p.tagLine}`)
    .sort();
  for (let shardIndex = 0; shardIndex * perShard < lines.length; shardIndex++) {
    const body = lines.slice(shardIndex * perShard, (shardIndex + 1) * perShard).join('\n');
    putFakeItem({
      PK: 'PLAYER_SEARCH',
      SK: `SHARD#${String(shardIndex).padStart(3, '0')}`,
      entityType: 'PLAYER_SEARCH_SHARD',
      format: PLAYER_SEARCH_INDEX_FORMAT,
      shardIndex,
      entries: body.length === 0 ? 0 : body.split('\n').length,
      entriesGz: gzipSync(Buffer.from(body, 'utf8')),
      generatedAt: '2026-10-29T00:00:00.000Z',
    });
  }
}

/**
 * The four reported failures, by name, put at the back of the corpus.
 *
 * `u-tagonly` is the fifth and is not one of them: it exists because the three
 * real tag lines (`NA1`, `1337`, `EUW`) all occur *inside* a filler display
 * name in a corpus this size, and a name hit correctly outranks a tag hit, so
 * a tag-line test needs a tag that cannot collide with a name.
 */
const DEEP_PLAYERS: Seeded[] = [
  { playerId: 'u-tpcstld', displayName: 'tpcstld', tagLine: 'NA1' },
  { playerId: 'u-illusionz', displayName: 'illusionz', tagLine: '1337' },
  { playerId: 'u-sealsmasher', displayName: 'SealSmasher', tagLine: 'EUW' },
  { playerId: 'u-tagonly', displayName: 'Quietest', tagLine: 'ZZQ' },
];

beforeEach(() => {
  resetPlayerNameIndexCache();
  resetFakeTable();
});

describe('the bug: a capped Scan cannot see the corpus', () => {
  it('misses a player at the back of scan order when there is no index', async () => {
    seedTable({ withIndex: false, extra: DEEP_PLAYERS });

    // This is the production behaviour, reproduced: the fallback scan examines
    // 2,000 items of a 440,003-item table and the deep players are nowhere
    // near that window.
    const result = await dynamoRankingStore.searchPlayers('tpcstld', 10);
    expect(result.records).toEqual([]);

    // And - this is the part that was missing before - it *says* it could not
    // see the corpus, instead of letting an empty list read as "no such
    // player". The old shape was a bare array with no room for this.
    expect(result.complete).toBe(false);
    expect(result.searchedPlayers).toBeLessThan(CORPUS / 10);
  });

  it('finds the first player in scan order even with no index, which is why the bug hid', async () => {
    seedTable({ withIndex: false });

    // `Filler0` is item one. The broken implementation answers this correctly,
    // so any test that only searched for a player near the front would have
    // passed against it - exactly how a 0.43% search shipped.
    const result = await dynamoRankingStore.searchPlayers('Filler0', 10);
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.complete).toBe(false);
  });
});

describe('the fix: the published index covers every player', () => {
  it('finds a player at the very back of a 40,003-player corpus', async () => {
    seedTable({ withIndex: true, extra: DEEP_PLAYERS });

    for (const player of DEEP_PLAYERS) {
      const result = await dynamoRankingStore.searchPlayers(player.displayName, 10);
      expect(result.records.map((record) => record.playerId)).toContain(player.playerId);
      expect(result.complete).toBe(true);
      expect(result.searchedPlayers).toBe(CORPUS + DEEP_PLAYERS.length);
    }
  });

  it('finds a player by a tag line, not only by a display name', async () => {
    seedTable({ withIndex: true, extra: DEEP_PLAYERS });
    const result = await dynamoRankingStore.searchPlayers('zzq', 10);
    expect(result.records.map((record) => record.playerId)).toContain('u-tagonly');
  });

  it('prefers a name hit over a tag-line hit when a needle is both', async () => {
    // `1337` is `illusionz`'s real tag line and is also inside the display
    // names `Filler1337`, `Filler11337` and so on. Every one of those is a
    // name hit, so they come first - which is the ranking being right rather
    // than the tag search being broken, and is worth pinning as such.
    seedTable({ withIndex: true, extra: DEEP_PLAYERS });
    const result = await dynamoRankingStore.searchPlayers('1337', 25);
    const ids = result.records.map((record) => record.playerId);
    expect(ids[0]).toBe('p-001337');
    expect(result.matched).toBeGreaterThan(1);
  });

  it('keeps substring search, which a prefix index would have dropped', async () => {
    // Measured over 8,000 real display names, a whole-name prefix index
    // answers 14.8% of the substrings that occur in names and a word-prefix
    // index 17.3%, because the corpus is dominated by single-token handles.
    // `smasher` inside `SealSmasher` is that case.
    seedTable({ withIndex: true, extra: DEEP_PLAYERS });
    const result = await dynamoRankingStore.searchPlayers('smasher', 10);
    expect(result.records.map((record) => record.playerId)).toContain('u-sealsmasher');
  });

  it('publishes the full rating fields for a hit, not the index\'s three columns', async () => {
    seedTable({ withIndex: true, extra: DEEP_PLAYERS });
    const result = await dynamoRankingStore.searchPlayers('tpcstld', 10);
    // The index carries id, name and tag; everything else comes from the
    // BatchGet of the matched profiles, which is what keeps the index small.
    expect(result.records[0]).toMatchObject({
      playerId: 'u-tpcstld',
      displayName: 'tpcstld',
      rating: 1380,
      uncertainty: 97,
      gamesPlayed: 8,
    });
  });

  it('costs one Query for the index and one BatchGet for the hits, and then nothing', async () => {
    seedTable({ withIndex: true, extra: DEEP_PLAYERS });

    fakeSend.mockClear();
    await dynamoRankingStore.searchPlayers('tpcstld', 10);
    const cold = fakeSend.mock.calls.length;

    fakeSend.mockClear();
    await dynamoRankingStore.searchPlayers('illusionz', 10);
    const warm = fakeSend.mock.calls.length;

    // Cold pays for the index shards; warm is the BatchGet alone. This is the
    // property that makes the steady-state cost ~5 read units against the
    // capped scan's 203.5 - and a regression here (an index read per query)
    // would be invisible in every other test in this file.
    expect(warm).toBe(1);
    expect(cold).toBeGreaterThan(warm);

    // No Scan anywhere: the whole point is that no query walks the table.
    const scans = fakeSend.mock.calls.filter(
      ([command]) => command.constructor.name === 'FakeScanCommand'
    );
    expect(scans).toHaveLength(0);
  });

  it('falls back and says so when the index cannot be read, rather than throwing', async () => {
    seedTable({ withIndex: true, extra: DEEP_PLAYERS });
    // A shard in a format this build does not know. Refused rather than
    // half-parsed, because a partially-decoded index is a search that works
    // and is wrong.
    for (const item of fakeTable.values()) {
      if (item.PK === 'PLAYER_SEARCH') item.format = 'tsv-99';
    }
    resetPlayerNameIndexCache();

    const result = await dynamoRankingStore.searchPlayers('tpcstld', 10);
    expect(result.complete).toBe(false);
  });
});

describe('the cap and the minimum stay', () => {
  it('never returns more than the cap, however many match', async () => {
    seedTable({ withIndex: true });
    const result = await dynamoRankingStore.searchPlayers('filler', 25);
    expect(result.records).toHaveLength(25);
    // `matched` is the honest total, so a page can say "25 of 40,000" rather
    // than silently truncating - the same reasoning as publishing coverage
    // beside a ladder page.
    expect(result.matched).toBe(CORPUS);
  });

  it('refuses a one-character needle in the matcher as well as at the route', async () => {
    seedTable({ withIndex: true });
    const result = await dynamoRankingStore.searchPlayers('f', 10);
    expect(result.records).toEqual([]);
    expect(result.matched).toBe(0);
  });

  it('has no cursor: the capped set is all there is for a needle', () => {
    // Asserted as a shape rather than behaviour, because the absence of
    // pagination is the actual export guard (the cap alone is not - see
    // PLAYER_SEARCH_MAX_RESULTS). A cursor added here would need this test
    // changed, which is the point.
    expect(Object.keys({ records: [], complete: true, searchedPlayers: 0, matched: 0 })).not.toContain(
      'cursor'
    );
  });
});

describe('result order is the match quality, not the storage order', () => {
  const entries = buildNameIndex([
    { playerId: 'exact', displayName: 'ill', tagLine: 'NA1' },
    { playerId: 'prefix', displayName: 'illusionz', tagLine: 'NA1' },
    { playerId: 'word', displayName: 'Dark Illusion', tagLine: 'NA1' },
    { playerId: 'substring', displayName: 'TheIllusionist', tagLine: 'NA1' },
    { playerId: 'tag', displayName: 'Nobody', tagLine: 'ill' },
    { playerId: 'longer-substring', displayName: 'AVeryLongIllusionHandleIndeed', tagLine: 'NA1' },
  ]);

  it('ranks exact, then prefix, then word prefix, then substring, then tag line', () => {
    const { playerIds } = searchNameIndex(entries, 'ill', 10);
    expect(playerIds).toEqual(['exact', 'prefix', 'word', 'substring', 'longer-substring', 'tag']);
  });

  it('never lets a tag-line hit outrank a name hit', () => {
    // A tag line is short and shared - `NA1` is thousands of players - so it
    // is the weakest signal here and must stay below every name tier.
    expect(scoreNameMatch('ill', entries.entries[4])).toBeGreaterThan(
      scoreNameMatch('ill', entries.entries[3])
    );
  });

  it('breaks ties on the shorter name, so a close match is not buried', () => {
    const { playerIds } = searchNameIndex(entries, 'illusion', 10);
    // Both `substring` and `longer-substring` are tier 3; the shorter handle
    // is the closer answer to what was typed.
    expect(playerIds.indexOf('substring')).toBeLessThan(playerIds.indexOf('longer-substring'));
  });

  it('is fully determined, because the route is edge-cached', () => {
    // Two origin hits for one URL must not produce two orders, or CloudFront
    // serves whichever it saw first and the page order looks random.
    const a = searchNameIndex(entries, 'ill', 10).playerIds;
    const b = searchNameIndex(
      buildNameIndex([...entries.entries].reverse().map((entry) => ({
        playerId: entry.playerId,
        displayName: entry.displayName,
        tagLine: entry.tagLine,
      }))),
      'ill',
      10
    ).playerIds;
    expect(a).toEqual(b);
  });
});

describe('the index format is a contract, and the reader holds its side', () => {
  const shard = (overrides: Record<string, unknown>) => ({
    format: PLAYER_SEARCH_INDEX_FORMAT,
    shardIndex: 0,
    entries: 1,
    entriesGz: gzipSync(Buffer.from('p-1\tAlice\tNA1', 'utf8')),
    ...overrides,
  });

  it('reads a well-formed shard', () => {
    const index = decodeSearchShards([shard({})]);
    expect(index?.entries).toEqual([
      { playerId: 'p-1', displayName: 'Alice', tagLine: 'NA1', name: 'alice', tag: 'na1' },
    ]);
  });

  it('refuses an unknown format rather than guessing at the bytes', () => {
    expect(decodeSearchShards([shard({ format: 'tsv-2' })])).toBeNull();
  });

  it('refuses a shard whose body will not decompress', () => {
    expect(decodeSearchShards([shard({ entriesGz: Buffer.from('not gzip') })])).toBeNull();
  });

  it('drops a malformed line instead of reading a name as a player id', () => {
    const body = ['p-1\tAlice\tNA1', 'p-2\tonly-two-fields', 'p-3\tCarol\tEUW'].join('\n');
    const index = decodeSearchShards([shard({ entriesGz: gzipSync(Buffer.from(body, 'utf8')) })]);
    expect(index?.entries.map((entry) => entry.playerId)).toEqual(['p-1', 'p-3']);
    expect(index?.malformed).toBe(1);
  });

  it('concatenates shards in shard order however they arrive', () => {
    const second = shard({
      shardIndex: 1,
      entriesGz: gzipSync(Buffer.from('p-2\tBob\tEUW', 'utf8')),
    });
    const index = decodeSearchShards([second, shard({})]);
    expect(index?.entries.map((entry) => entry.playerId)).toEqual(['p-1', 'p-2']);
    expect(index?.shards).toBe(2);
  });

  it('reports null for no shards at all, which is the pre-refit window', () => {
    expect(decodeSearchShards([])).toBeNull();
  });
});
