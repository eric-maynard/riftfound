import geohash from 'ngeohash';
import type { ScrapedEvent, StoreInfo } from '../database.js';
import { formatPrice } from '../api.js';
import { sanitizeScrapedEvent, sanitizeStoreInfo, sanitizeText } from '../sanitize.js';
import { SOURCE_PLAYRIFTBOUND } from '../merge.js';

/**
 * Riot's official Riftbound event API (https://events.playriftbound.com).
 *
 * This is the second event source, merged with the UVS Games source in index.ts.
 *
 * Three things make this API awkward and drive the design of this module:
 *
 * 1. It only accepts *persisted* GraphQL queries. Freeform queries are rejected
 *    with PERSISTED_QUERY_ID_REQUIRED, so we send a sha256 hash that Riot's own
 *    web client uses. That hash rotates on every Riot deploy, so we self-heal by
 *    re-reading the public persisted-query manifest (see rediscoverQueryHash).
 *    The manifest's *chunk filename* rotates too, so it is crawled for rather
 *    than hardcoded - and because the persisted document itself changes shape
 *    between builds, the node parser accepts both address shapes Riot has
 *    shipped (see convertTournamentNode).
 * 2. Every search is anchored on a coordinate and the distance filter is enforced
 *    server side - there is no "give me everything" query. Worse, the server
 *    silently clamps `distanceMeters` to roughly 161km (100 miles): asking for a
 *    5,000km radius around San Francisco returns 428 events, the farthest 159km
 *    away, with hasNextPage=false. So coverage has to come from *many* anchors,
 *    one per ~156km geohash cell, seeded from the coordinates the UVS source
 *    already knows about (see anchorsFromCoordinates).
 * 3. It is Riot's production API and we are a guest on it, so every request is
 *    rate limited (default ~1 req/sec) with an extra pause between anchors, and
 *    each run sweeps only a rotating batch of anchors (see selectAnchorBatch).
 *
 * Every failure mode here is non-fatal: if the hash cannot be resolved or an
 * anchor errors out we log loudly and return what we have, so the UVS source
 * still completes its run.
 */

const GQL_ENDPOINT = 'https://events.playriftbound.com/api/gql';
const EVENTS_PAGE_URL = 'https://events.playriftbound.com/en-US/events';
const EVENT_URL_BASE = 'https://playriftbound.com/en-us/events';

const CHUNK_URL_BASE = 'https://events.playriftbound.com/_next/static/chunks/';

/**
 * Last chunk *measured* to hold the persisted-query manifest (2026-10-25,
 * 149,859 bytes, 165 operations).
 *
 * This is only a long shot, never the primary path. Turbopack names chunks after
 * a content hash, so the filename rotates on every Riot deploy: the previous
 * value here (`00kyxx5y6b23i.js`, verified 2026-09-15) was serving HTTP 404 with
 * a 9-byte body by 2026-10-25, which silently killed the whole self-heal. Any
 * hardcoded name in this class will rot the same way, so discovery crawls for
 * the manifest instead (see crawlForQueryHash) and this name is tried only when
 * the crawl cannot even start.
 */
const LAST_MEASURED_MANIFEST_CHUNK = '3ljhtmeypccge.js';

/**
 * Marker Apollo stamps on the manifest payload, whatever chunk it lands in:
 * `{"format":"apollo-persisted-query-manifest","version":1,"operations":[…]}`.
 * Unlike a filename this does not rotate, so it is how a probed chunk is
 * recognised as the manifest.
 */
const MANIFEST_FORMAT_MARKER = '"format":"apollo-persisted-query-manifest"';

const OPERATION_NAME = 'CompeteTournamentSearch';

/**
 * Known-good persisted query hash: the id Riot's own web client was sending on
 * 2026-10-25, read out of the manifest chunk above and verified with a live
 * query (HTTP 200, 100 edges).
 *
 * Rotates on Riot deploys; see rediscoverQueryHash. Riot keeps retired ids in
 * the allow-list for a while - the previous value here
 * (`acbcbba681a9…`, shipped 2026-09-15) still answered HTTP 200 on 2026-10-25 -
 * so a stale hash degrades late and quietly rather than failing fast. That is
 * exactly why the self-heal has to keep working: by the time the API starts
 * rejecting the hash, the discovery path has usually been dead for weeks.
 */
const DEFAULT_QUERY_HASH = '868030f676276bec926c740aada7129713d4097f6e2dd7c3a0451c4fb43852eb';

const PAGE_SIZE = 100;

/** Identify ourselves honestly - never as Riot's own web client. */
const USER_AGENT = 'Riftfound/1.0 (+https://riftfound.com)';
const CLIENT_NAME = 'Riftfound';

/** Per-request timeout, so one hung connection can't eat the Lambda's budget. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Consecutive failed anchors before the source gives up for the run. */
const MAX_CONSECUTIVE_ANCHOR_FAILURES = 3;

/**
 * Radius requested around each anchor.
 *
 * The server clamps the distance filter to ~161km (100 miles) whatever we ask
 * for, so that is the ceiling. We ask for less: an anchor only has to cover its
 * own geohash cell, whose centre is at most ~110.6km from a corner, and a
 * tighter radius means neighbouring anchors return far fewer of each other's
 * events (less duplicate work, fewer pages, less load on Riot).
 */
export const ANCHOR_RADIUS_METERS = 120_000;

/**
 * Geohash precision used to turn known event coordinates into anchors.
 * Precision 3 cells are ~156km x 156km, so the centre of a cell is at most
 * ~110km from any of its corners - comfortably inside the 161km radius cap,
 * which means one anchor per cell fully covers that cell.
 */
export const ANCHOR_GEOHASH_PRECISION = 3;

const DEFAULT_REQUEST_DELAY_MS = 1000; // ~1 req/sec: polite by default
const DEFAULT_ANCHOR_DELAY_MS = 2000; // extra breather between anchors
const DEFAULT_MAX_ANCHORS_PER_RUN = 150; // ~6-9 minutes of requests per cycle
const ROTATION_PERIOD_MS = 24 * 60 * 60 * 1000; // one full pass over all anchors per day
const MAX_PAGES_PER_ANCHOR = 12; // safety valve (1,200 events within one cell)
const MAX_CHUNKS_TO_PROBE = 60; // safety valve: the 2026-10 build needs 12 of these
const DAYS_FORWARD = 90; // match the UVS source / calendar display range

/** Prefix on externalId so Riot events never collide with UVS numeric event ids. */
export const PLAYRIFTBOUND_ID_PREFIX = 'prb-';

/**
 * Hosts whose `/events/<id>` path is one of Riot's own event pages.
 *
 * Compared **exactly**, after dropping a leading `www.` - never by suffix or
 * substring. `playriftbound.com.evil.test` contains our hostname and ends in
 * somebody else's, and an `includes`/`endsWith` test would wave it through.
 * `events.playriftbound.com` is in the list because that is where the search UI
 * lives (`EVENTS_PAGE_URL` above) and a URL captured from it names the same
 * tournament; the id is all that is read out either way, and the results pass
 * then builds its own canonical fetch URL from it.
 */
const EVENT_URL_HOSTS = new Set(['playriftbound.com', 'events.playriftbound.com']);

/** A locale path segment: `en-us`, `en-US`, `fr`, `pt-BR`. */
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;

/** Riot's tournament ids are 18-digit snowflakes; the length cap is a sanity bound. */
const TOURNAMENT_ID_PATTERN = /^[0-9]{1,32}$/;

/**
 * Riot's tournament id out of an event-page URL, or null when the URL is not one.
 *
 * This is the **only** route to a tournament id for a *merged* event. A matched
 * cross-source pair keeps the UVS identity (see merge.ts), so the surviving
 * row's `externalId` is the UVS number and carries no `prb-` prefix - but `url`
 * is Riot-owned in the merge policy, so Riot's event page URL survives on it.
 * Measured against production on 2026-10-26, one day partition
 * (`DATE#2026-10-18`, 2,977 stored rows): 62 rows were merged
 * (`sources: [uvs, playriftbound]`, numeric externalId) and **62 of 62** carried
 * a `https://playriftbound.com/en-us/events/<id>` URL, while all 389 UVS-only
 * rows carried no URL at all. So on today's data a parseable URL and a merged
 * row are the same set.
 *
 * Parsed with the URL class rather than a regex, because the one thing that must
 * not happen is accepting a hostname that merely *contains* `playriftbound.com`.
 * What legitimately varies, and is therefore tolerated: the scheme, a `www.`
 * prefix, the locale segment and its case (the converter above writes `en-us`
 * while the user-facing links elsewhere in this repo use `en-US`), a trailing
 * slash, and a query string or fragment.
 */
export function tournamentIdFromEventUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!EVENT_URL_HOSTS.has(host)) return null;

  // `/events/<id>` or `/<locale>/events/<id>`, and nothing deeper: a longer path
  // is some other page about the event, not the event page itself.
  const segments = parsed.pathname.split('/').filter(segment => segment.length > 0);
  const path = segments.length === 3 && LOCALE_SEGMENT.test(segments[0]) ? segments.slice(1) : segments;
  if (path.length !== 2 || path[0].toLowerCase() !== 'events') return null;

  // Not decoded: a run of digits never needs it, and anything percent-escaped
  // fails the pattern, which is the right answer.
  return TOURNAMENT_ID_PATTERN.test(path[1]) ? path[1] : null;
}

/**
 * The Riot tournament id a stored event row is a results candidate for, or null
 * when it is not one.
 *
 * Two row shapes qualify, and the results pass cannot tell them apart once this
 * has run - which is the point:
 *
 * 1. a `prb-` externalId: a Riot event the UVS feed never duplicated. The slice
 *    is returned verbatim, including the pathological case of a prefix with
 *    nothing numeric after it, because `fetchEventFacts` already rejects that
 *    loudly and narrowing it here would be a silent behaviour change on the
 *    path that works today.
 * 2. a row whose `url` is a Riot event page: a **merged** row, whose externalId
 *    is the UVS one. Before this existed those rows were structurally invisible
 *    to the results pass - 4,052 of them inside the 45-day lookback on
 *    2026-10-27, 3,424 results-due, and not one of them carrying a capture.
 *
 * The capture itself is still keyed on the row's own `externalId`
 * (`RESULTS#<externalId>`), so a merged event's facts land under its UVS id -
 * which is the id the calendar and the backend's availability lookup already
 * ask about. See scraper/CLAUDE.md, "Which rows are results candidates".
 */
export function resultsCandidateTournamentId(
  row: { externalId: string; url?: string | null }
): string | null {
  if (row.externalId.startsWith(PLAYRIFTBOUND_ID_PREFIX)) {
    return row.externalId.slice(PLAYRIFTBOUND_ID_PREFIX.length);
  }
  return tournamentIdFromEventUrl(row.url);
}

/**
 * Offset applied to synthesised shop external ids. UVS store ids are small
 * integers; keeping Riot organizers in their own numeric band avoids collisions.
 */
const ORGANIZER_ID_OFFSET = 2_000_000_000;
const ORGANIZER_ID_SPACE = 1_000_000_000;

/** Whether a shop external id was synthesised from a Riot organizer (vs a UVS store id). */
export function isSynthesizedShopId(id: number | null | undefined): boolean {
  return typeof id === 'number' && id >= ORGANIZER_ID_OFFSET && id < ORGANIZER_ID_OFFSET + ORGANIZER_ID_SPACE;
}

export interface Anchor {
  name: string;
  latitude: number;
  longitude: number;
}

/**
 * Fallback anchors, used only when no event coordinates are available to seed
 * the sweep (e.g. the UVS pass returned nothing). Major metros across every
 * region Riftbound currently runs in - deliberately small, because real coverage
 * comes from anchorsFromCoordinates below.
 */
export const SEED_ANCHORS: Anchor[] = [
  { name: 'San Francisco', latitude: 37.7749, longitude: -122.4194 },
  { name: 'Los Angeles', latitude: 34.0522, longitude: -118.2437 },
  { name: 'Seattle', latitude: 47.6062, longitude: -122.3321 },
  { name: 'Denver', latitude: 39.7392, longitude: -104.9903 },
  { name: 'Dallas', latitude: 32.7767, longitude: -96.797 },
  { name: 'Houston', latitude: 29.7604, longitude: -95.3698 },
  { name: 'Chicago', latitude: 41.8781, longitude: -87.6298 },
  { name: 'Atlanta', latitude: 33.749, longitude: -84.388 },
  { name: 'Miami', latitude: 25.7617, longitude: -80.1918 },
  { name: 'New York', latitude: 40.7128, longitude: -74.006 },
  { name: 'Toronto', latitude: 43.6532, longitude: -79.3832 },
  { name: 'Vancouver', latitude: 49.2827, longitude: -123.1207 },
  { name: 'Mexico City', latitude: 19.4326, longitude: -99.1332 },
  { name: 'Bogota', latitude: 4.711, longitude: -74.0721 },
  { name: 'Lima', latitude: -12.0464, longitude: -77.0428 },
  { name: 'Santiago', latitude: -33.4489, longitude: -70.6693 },
  { name: 'Buenos Aires', latitude: -34.6037, longitude: -58.3816 },
  { name: 'Sao Paulo', latitude: -23.5505, longitude: -46.6333 },
  { name: 'Rio de Janeiro', latitude: -22.9068, longitude: -43.1729 },
  { name: 'London', latitude: 51.5074, longitude: -0.1278 },
  { name: 'Manchester', latitude: 53.4808, longitude: -2.2426 },
  { name: 'Paris', latitude: 48.8566, longitude: 2.3522 },
  { name: 'Madrid', latitude: 40.4168, longitude: -3.7038 },
  { name: 'Barcelona', latitude: 41.3851, longitude: 2.1734 },
  { name: 'Milan', latitude: 45.4642, longitude: 9.19 },
  { name: 'Rome', latitude: 41.9028, longitude: 12.4964 },
  { name: 'Berlin', latitude: 52.52, longitude: 13.405 },
  { name: 'Cologne', latitude: 50.9375, longitude: 6.9603 },
  { name: 'Amsterdam', latitude: 52.3676, longitude: 4.9041 },
  { name: 'Warsaw', latitude: 52.2297, longitude: 21.0122 },
  { name: 'Stockholm', latitude: 59.3293, longitude: 18.0686 },
  { name: 'Istanbul', latitude: 41.0082, longitude: 28.9784 },
  { name: 'Dubai', latitude: 25.2048, longitude: 55.2708 },
  { name: 'Johannesburg', latitude: -26.2041, longitude: 28.0473 },
  { name: 'Mumbai', latitude: 19.076, longitude: 72.8777 },
  { name: 'Bangkok', latitude: 13.7563, longitude: 100.5018 },
  { name: 'Kuala Lumpur', latitude: 3.139, longitude: 101.6869 },
  { name: 'Singapore', latitude: 1.3521, longitude: 103.8198 },
  { name: 'Jakarta', latitude: -6.2088, longitude: 106.8456 },
  { name: 'Manila', latitude: 14.5995, longitude: 120.9842 },
  { name: 'Hong Kong', latitude: 22.3193, longitude: 114.1694 },
  { name: 'Taipei', latitude: 25.033, longitude: 121.5654 },
  { name: 'Seoul', latitude: 37.5665, longitude: 126.978 },
  { name: 'Tokyo', latitude: 35.6762, longitude: 139.6503 },
  { name: 'Osaka', latitude: 34.6937, longitude: 135.5023 },
  { name: 'Sydney', latitude: -33.8688, longitude: 151.2093 },
  { name: 'Melbourne', latitude: -37.8136, longitude: 144.9631 },
  { name: 'Auckland', latitude: -36.8485, longitude: 174.7633 },
];

/**
 * Turn known event coordinates into a de-duplicated anchor set: one anchor at
 * the centre of every ~156km geohash cell that contains at least one event.
 *
 * Seeding from the UVS source's coordinates means coverage automatically tracks
 * wherever Riftbound is actually played, instead of a hand-maintained city list,
 * and every anchor is guaranteed to be somewhere with real events nearby.
 */
export function anchorsFromCoordinates(
  coordinates: { latitude?: number | null; longitude?: number | null }[]
): Anchor[] {
  const cells = new Set<string>();

  for (const coord of coordinates) {
    const { latitude, longitude } = coord;
    if (
      latitude === null || latitude === undefined || !Number.isFinite(latitude) ||
      longitude === null || longitude === undefined || !Number.isFinite(longitude)
    ) {
      continue;
    }
    cells.add(geohash.encode(latitude, longitude, ANCHOR_GEOHASH_PRECISION));
  }

  // Sorted so the rotation below is stable from run to run.
  return [...cells].sort().map(cell => {
    const { latitude, longitude } = geohash.decode(cell);
    return { name: cell, latitude, longitude };
  });
}

/**
 * Pick the batch of anchors to sweep this run.
 *
 * There are far more cells with events (1,000+) than is polite to query in one
 * cycle at one request per second, so each run sweeps a window of the anchor
 * list and the window slides with the wall clock, wrapping once every
 * ROTATION_PERIOD_MS.
 *
 * Using wall-clock *position* rather than a run counter means the scraper needs
 * no persisted state (each production run is a fresh Lambda invocation) and the
 * schedule can change without opening coverage gaps: as long as
 * runs-per-period x maxPerRun >= anchors.length, consecutive windows overlap and
 * every anchor is swept each period. At the default 150 anchors/run and the
 * production 2-hourly schedule that is 12 x 150 = 1,800 anchor-slots per day for
 * ~1,000 anchors.
 *
 * @param rotation Position in the sweep cycle as a fraction of a full pass
 *                 (only the fractional part matters).
 */
export function selectAnchorBatch(anchors: Anchor[], maxPerRun: number, rotation: number): Anchor[] {
  if (anchors.length === 0 || maxPerRun <= 0) return [];
  if (anchors.length <= maxPerRun) return anchors;

  const fraction = Number.isFinite(rotation) ? ((rotation % 1) + 1) % 1 : 0;
  const start = Math.floor(fraction * anchors.length) % anchors.length;

  const batch: Anchor[] = [];
  for (let i = 0; i < maxPerRun; i++) {
    batch.push(anchors[(start + i) % anchors.length]);
  }
  return batch;
}

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

export interface PrbLocation {
  adminArea1: string | null;
  city: string | null;
  formattedAddress: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface PrbOrganizer {
  id: string;
  name: string;
  /** Present in builds up to 2026-09; replaced by PrbTournament.tournamentLocation. */
  physicalAddress?: PrbLocation | null;
}

export interface PrbTournamentConfig {
  tournamentType: string | null;
  format: string | null;
  playerFormat: string | null;
  participantCapacity: number | null;
}

export interface PrbTournament {
  id: string;
  name: string;
  startsAt: string;
  pricing: string | null;
  entryFee: { currency: string | null; minorUnits: number | null } | null;
  registrantCounts: { count: number; status: string }[] | null;
  config: PrbTournamentConfig | null;
  /**
   * Where the event is held. The 2026-10 persisted document selects this; the
   * 2026-09 one selected organizer.physicalAddress instead. Measured over 25
   * events returned by both documents the two agreed to <1m on every one, and
   * tournamentLocation was non-null on 100/100 events, so either is usable.
   */
  tournamentLocation?: PrbLocation | null;
}

export interface PrbTournamentNode {
  __typename?: string;
  distanceMeters?: number | null;
  organizer: PrbOrganizer | null;
  tournament: PrbTournament;
}

interface PrbSearchResponse {
  data?: {
    competeTournamentSearch?: {
      edges: { cursor: string; node: PrbTournamentNode }[];
      pageInfo: { endCursor: string | null; hasNextPage: boolean };
    } | null;
  } | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

export interface PlayriftboundOptions {
  /** Delay between individual HTTP requests (default 1000ms, ~1 req/sec). */
  requestDelayMs?: number;
  /** Extra delay between anchors (defaults to 2x requestDelayMs). */
  anchorDelayMs?: number;
  /** Override for the persisted query hash (env: PLAYRIFTBOUND_QUERY_HASH). */
  queryHash?: string;
  /** Only keep events starting within this many days (default 90, matches UVS). */
  daysForward?: number;
  /** Known event coordinates used to seed the anchor set (normally the UVS pass). */
  coordinates?: { latitude?: number | null; longitude?: number | null }[];
  /** Explicit anchor set, bypassing coordinate seeding. Mainly for tests. */
  anchors?: Anchor[];
  /** Anchors swept per run (default 150). The rest are picked up by later runs. */
  maxAnchorsPerRun?: number;
  /** Position in the rotating sweep, as a fraction of a full pass. Defaults to the time of day. */
  rotation?: number;
  /** Epoch ms after which no new request is started (Lambda time budget). */
  deadline?: number;
}

export interface PlayriftboundResult {
  events: (ScrapedEvent & { storeInfo: StoreInfo })[];
  /** Total anchors covering all known event locations. */
  anchorsAvailable: number;
  anchorsQueried: number;
  anchorsFailed: number;
  requests: number;
  /** Events seen more than once because anchor cells overlap. */
  duplicatesWithinSource: number;
  /** True when the source could not run at all (e.g. the query hash is unresolvable). */
  failed: boolean;
  /** True when only part of the anchor set was swept (the normal case). */
  partial: boolean;
  /**
   * Anchors whose results were read to the end (no error, no page cap, no
   * deadline cut). Every event within their radius and horizon was returned.
   */
  completedAnchors: Anchor[];
  /** Events starting after this were not collected. */
  horizon: Date;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Persisted query hash resolution (self-healing)
// ---------------------------------------------------------------------------

let cachedQueryHash: string | null = null;

/**
 * Chunk filename this *process* found the manifest in. Unlike
 * LAST_MEASURED_MANIFEST_CHUNK this is a name we have just seen serve the
 * manifest, so a second rediscovery in the same Lambda costs one request
 * instead of a crawl.
 */
let learnedManifestChunk: string | null = null;

/** Exported for tests - resets the module level hash cache. */
export function resetQueryHashCache(): void {
  cachedQueryHash = null;
  learnedManifestChunk = null;
}

/**
 * Pull the persisted query id for CompeteTournamentSearch out of a JS chunk.
 * Manifest entries look like: {"id":"<64 hex>","name":"CompeteTournamentSearch",...}
 */
export function extractQueryHashFromChunk(chunk: string, operationName = OPERATION_NAME): string | null {
  const escaped = operationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idFirst = new RegExp(`"id"\\s*:\\s*"([0-9a-f]{64})"\\s*,\\s*"name"\\s*:\\s*"${escaped}"`);
  const idFirstMatch = chunk.match(idFirst);
  if (idFirstMatch) return idFirstMatch[1];

  // Tolerate the other key order in case Riot's bundler reorders the manifest.
  const nameFirst = new RegExp(`"name"\\s*:\\s*"${escaped}"\\s*,\\s*"id"\\s*:\\s*"([0-9a-f]{64})"`);
  const nameFirstMatch = chunk.match(nameFirst);
  return nameFirstMatch ? nameFirstMatch[1] : null;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** Chunk filenames referenced from a page or from inside another chunk. */
export function chunkNamesIn(source: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      names.push(match[1]);
    }
  }
  return names;
}

/** Fetch one chunk and return the persisted query id if it is the manifest. */
async function probeChunkForHash(name: string): Promise<string | null> {
  const body = await fetchText(`${CHUNK_URL_BASE}${name}`);
  return body ? extractQueryHashFromChunk(body) : null;
}

type CrawlOutcome =
  /** Found it. `chunk` is remembered so the next rediscovery is one request. */
  | { kind: 'found'; hash: string; chunk: string; probed: number }
  /** The events page itself could not be read - nothing to crawl from. */
  | { kind: 'unavailable' }
  /** Ran out of chunks (or of the probe budget) without finding the manifest. */
  | { kind: 'exhausted'; probed: number }
  /** The caller's time budget ran out mid-crawl. */
  | { kind: 'deadline'; probed: number };

/**
 * Crawl Riot's own events page for the persisted-query manifest.
 *
 * This is the live path, because every *name* in the chain rotates and only the
 * shape does not. Measured against the 2026-10-25 build:
 *
 * - The events page HTML references **36** `_next/static/chunks/*.js` files and
 *   contains no 64-hex id, no `persistedQuery` and not even the operation name,
 *   so the hash is never in the HTML itself.
 * - **None** of those 36 chunks is the manifest. The manifest lives in
 *   `3ljhtmeypccge.js`, which the HTML never mentions: it is lazily loaded, and
 *   the only reference to it anywhere is a Turbopack loader call inside
 *   `1x7ey3ub0c35t.js` (`e.v(t=>Promise.all(["static/chunks/3ljhtmeypccge.js"]
 *   .map(t=>e.l(t)))…)`), the 11th chunk in HTML document order.
 * - Across all 36 chunks there are exactly **2** chunk names that the HTML does
 *   not already list (the manifest, and one other lazy chunk).
 *
 * That last number is what makes this cheap: a chunk name discovered *inside*
 * another chunk but absent from the page is a lazily-loaded chunk, and the
 * manifest is one of a mere handful of those. So lazy names jump the queue
 * ahead of the page's own chunks, which finds the manifest on probe **12** of a
 * possible 60 rather than on probe 31 (what plain FIFO order cost).
 */
async function crawlForQueryHash(requestDelayMs: number, deadline?: number): Promise<CrawlOutcome> {
  const html = await fetchText(EVENTS_PAGE_URL);
  if (!html) return { kind: 'unavailable' };

  const fromPage = chunkNamesIn(html);
  const pageChunks = new Set(fromPage);

  // Page chunks keep document order; lazily-referenced chunks are unshifted in
  // front of them as they are discovered.
  const queue = [...fromPage];
  const discovered = new Set(fromPage);

  console.warn(
    `[playriftbound] crawling ${EVENTS_PAGE_URL} for the persisted query manifest ` +
      `(${fromPage.length} chunks referenced, lazily-loaded chunks probed first, ` +
      `${MAX_CHUNKS_TO_PROBE} probe budget)`
  );

  let probed = 0;
  while (queue.length > 0 && probed < MAX_CHUNKS_TO_PROBE) {
    if (deadline !== undefined && Date.now() >= deadline) return { kind: 'deadline', probed };

    const name = queue.shift() as string;
    await sleep(requestDelayMs);
    probed++;
    const body = await fetchText(`${CHUNK_URL_BASE}${name}`);
    if (!body) continue;

    const hash = extractQueryHashFromChunk(body);
    if (hash) return { kind: 'found', hash, chunk: name, probed };

    if (body.includes(MANIFEST_FORMAT_MARKER)) {
      // The manifest moved but no longer lists this operation - worth saying out
      // loud, because it means Riot renamed the query rather than rotated its id.
      console.error(
        `[playriftbound] chunk ${name} is an Apollo persisted-query manifest but has no ${OPERATION_NAME} entry`
      );
    }

    // A nested name the page does not list is a lazily-loaded chunk: the
    // manifest is one of those, so jump the queue.
    for (const nested of chunkNamesIn(body)) {
      if (discovered.has(nested) || discovered.size >= MAX_CHUNKS_TO_PROBE) continue;
      discovered.add(nested);
      if (pageChunks.has(nested)) queue.push(nested);
      else queue.unshift(nested);
    }
  }

  return { kind: 'exhausted', probed };
}

/**
 * Re-discover the current persisted query hash.
 *
 * 1. A manifest chunk name this process already learned (one request, and a name
 *    we have actually seen live - unlike a hardcoded one).
 * 2. Crawl the live events page for the manifest (see crawlForQueryHash).
 * 3. Long shot: the chunk name measured when this file was last updated. Only
 *    reached when the crawl could not run at all, since that name rotates.
 *
 * Every failure is non-fatal and loud; the caller retries once and then skips
 * the source for the run.
 */
export async function rediscoverQueryHash(requestDelayMs: number, deadline?: number): Promise<string | null> {
  if (learnedManifestChunk) {
    const hash = await probeChunkForHash(learnedManifestChunk);
    if (hash) return hash;
    console.warn(
      `[playriftbound] chunk ${learnedManifestChunk} no longer serves the manifest (Riot redeployed), re-crawling`
    );
    learnedManifestChunk = null;
  }

  const crawl = await crawlForQueryHash(requestDelayMs, deadline);
  if (crawl.kind === 'found') {
    learnedManifestChunk = crawl.chunk;
    console.warn(
      `[playriftbound] found the persisted query manifest in chunk ${crawl.chunk} after ${crawl.probed} probes`
    );
    return crawl.hash;
  }

  if (crawl.kind === 'deadline') {
    console.error(
      `[playriftbound] time budget reached after probing ${crawl.probed} chunks for the persisted query manifest`
    );
    return null;
  }

  if (crawl.kind === 'exhausted') {
    console.error(
      `[playriftbound] crawled ${crawl.probed} chunks from ${EVENTS_PAGE_URL} without finding the ` +
        `${OPERATION_NAME} persisted query id`
    );
  } else {
    console.error(`[playriftbound] could not fetch ${EVENTS_PAGE_URL} to crawl for the persisted query manifest`);
  }

  if (deadline !== undefined && Date.now() >= deadline) return null;

  await sleep(requestDelayMs);
  const fallback = await probeChunkForHash(LAST_MEASURED_MANIFEST_CHUNK);
  if (fallback) {
    console.warn(
      `[playriftbound] crawl failed but the last measured manifest chunk ${LAST_MEASURED_MANIFEST_CHUNK} is still live`
    );
    learnedManifestChunk = LAST_MEASURED_MANIFEST_CHUNK;
    return fallback;
  }

  console.error(
    `[playriftbound] no persisted query hash could be resolved (last measured chunk ` +
      `${LAST_MEASURED_MANIFEST_CHUNK} is gone too). Set PLAYRIFTBOUND_QUERY_HASH to unblock.`
  );
  return null;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Riot's complete `tournamentType` enum, read out of their web bundle.
 *
 * Measured 2026-10-26 from chunk `0zmnko3-hmh1v.js` (787,431 bytes, 9th of the
 * 36 chunks the events page references), which carries the generated TypeScript
 * enum verbatim. **Eleven values**, in the bundle's own order:
 *
 * ```
 * CHALLENGE_SERIES  CONTINENTAL  LEARN_TO_PLAY  NEXUS_CUP  NEXUS_NIGHT
 * OPEN_PLAY  PRE_RIFT  REGIONAL  SHOWDOWN_SERIES  SUMMONER_SKIRMISH
 * WORLD_CHAMPIONSHIP
 * ```
 *
 * Two things worth knowing before building on it:
 *
 * - **There is no `RC` or `RQ`.** The championship and qualifier tiers are
 *   spelled `WORLD_CHAMPIONSHIP`, `CONTINENTAL` and `REGIONAL`, with
 *   `CHALLENGE_SERIES`, `SHOWDOWN_SERIES` and `NEXUS_CUP` as the series tiers
 *   between those and `SUMMONER_SKIRMISH`. Any weighting table keyed on
 *   invented literals would silently match nothing.
 * - **Riot's own filter UI exposes only five of the eleven**, grouped as
 *   *Local* (`LEARN_TO_PLAY`, `NEXUS_NIGHT`, `OPEN_PLAY`, `PRE_RIFT`) and
 *   *Premier* (`SUMMONER_SKIRMISH`). The six competitive tiers above that are
 *   in the schema and not yet filterable, which is consistent with no such
 *   event having been scheduled.
 *
 * This list rotates like everything else in Riot's bundle. Re-derive it the
 * same way (crawl the chunks the events page names and grep for
 * `NEXUS_NIGHT`); the enum sits beside the `CONSTRUCTED` / `LIMITED_DRAFT` /
 * `LIMITED_SEALED` format enum in the same object literal.
 */
export const RIOT_TOURNAMENT_TYPES = [
  'CHALLENGE_SERIES',
  'CONTINENTAL',
  'LEARN_TO_PLAY',
  'NEXUS_CUP',
  'NEXUS_NIGHT',
  'OPEN_PLAY',
  'PRE_RIFT',
  'REGIONAL',
  'SHOWDOWN_SERIES',
  'SUMMONER_SKIRMISH',
  'WORLD_CHAMPIONSHIP',
] as const;

/**
 * Riot's tournamentType enum -> the human strings the UVS source produces and
 * the frontend event-type filter expects.
 *
 * All eleven enum values are mapped. Before 2026-10-26 only three were, and
 * the other eight collapsed into `Other` - which made a casual Open Play
 * indistinguishable from a World Championship in our own data, and therefore
 * made any tier-keyed rating weight impossible to express. Two live measurements
 * fixed the vocabulary: 200 upcoming events across San Francisco and New York
 * returned `NEXUS_NIGHT` 188, `OPEN_PLAY` 9, `LEARN_TO_PLAY` 3, so two of the
 * previously-unmapped values are in the feed *today*.
 *
 * The labels are Riot's own, from the filter UI, except that `NEXUS_NIGHT`
 * keeps the singular `Nexus Night` this codebase and the frontend filter have
 * always used rather than Riot's plural "Nexus Nights".
 *
 * An unknown value still falls through to `Other`, and must: the enum
 * demonstrably grows, and a record is never dropped for carrying a value we do
 * not recognise.
 */
export function mapEventType(tournamentType: string | null | undefined): string {
  switch (tournamentType) {
    // Local tiers, as Riot's own filter groups them.
    case 'LEARN_TO_PLAY':
      return 'Learn to Play';
    case 'OPEN_PLAY':
      return 'Open Play';
    case 'NEXUS_NIGHT':
      return 'Nexus Night';
    case 'PRE_RIFT':
      return 'Pre-Rift';
    // Premier.
    case 'SUMMONER_SKIRMISH':
      return 'Summoner Skirmish';
    // Competitive tiers: in the schema, not yet in Riot's filter and not yet
    // observed in the feed.
    case 'NEXUS_CUP':
      return 'Nexus Cup';
    case 'CHALLENGE_SERIES':
      return 'Challenge Series';
    case 'SHOWDOWN_SERIES':
      return 'Showdown Series';
    case 'REGIONAL':
      return 'Regional';
    case 'CONTINENTAL':
      return 'Continental';
    case 'WORLD_CHAMPIONSHIP':
      return 'World Championship';
    default:
      return 'Other';
  }
}

const COUNTRY_CODES: Record<string, string> = {
  'USA': 'US',
  'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US',
  'CANADA': 'CA',
  'MEXICO': 'MX',
  'BRAZIL': 'BR',
  'UNITED KINGDOM': 'GB',
  'UK': 'GB',
  'ENGLAND': 'GB',
  'SCOTLAND': 'GB',
  'WALES': 'GB',
  'FRANCE': 'FR',
  'GERMANY': 'DE',
  'SPAIN': 'ES',
  'ITALY': 'IT',
  'NETHERLANDS': 'NL',
  'BELGIUM': 'BE',
  'POLAND': 'PL',
  'PORTUGAL': 'PT',
  'AUSTRALIA': 'AU',
  'NEW ZEALAND': 'NZ',
  'JAPAN': 'JP',
  'SINGAPORE': 'SG',
  'PHILIPPINES': 'PH',
  'MALAYSIA': 'MY',
  'INDONESIA': 'ID',
  'THAILAND': 'TH',
  'VIETNAM': 'VN',
  'TAIWAN': 'TW',
  'HONG KONG': 'HK',
  'SOUTH KOREA': 'KR',
  'KOREA': 'KR',
};

/**
 * Riot only gives a formatted address string, so the country is the last comma
 * separated segment. Normalised to the ISO-ish codes the UVS source stores so
 * the backend's country filter keeps matching across sources.
 */
export function parseCountry(formattedAddress: string | null | undefined): string | null {
  if (!formattedAddress) return null;
  const parts = formattedAddress.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const last = parts[parts.length - 1];
  // Some countries put the postcode in the same segment as the country name,
  // e.g. "10 Sinaran Dr, Singapore 307506".
  const withoutPostcode = last.replace(/\s+[\d][\d\s-]*$/, '').trim();
  const candidate = withoutPostcode || last;

  return COUNTRY_CODES[candidate.toUpperCase()] ?? candidate;
}

/**
 * Deterministic numeric shop id derived from the organizer's UUID.
 * The shops table keys on an integer external_id, and Riot uses UUIDs.
 */
export function organizerExternalId(organizerId: string): number {
  // FNV-1a, 32 bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < organizerId.length; i++) {
    hash ^= organizerId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ORGANIZER_ID_OFFSET + (hash % ORGANIZER_ID_SPACE);
}

function registeredPlayerCount(counts: PrbTournament['registrantCounts']): number | null {
  if (!counts || counts.length === 0) return null;
  const registered = counts.find(c => c.status === 'REGISTERED');
  return registered ? registered.count : null;
}

function eventPrice(tournament: PrbTournament): string | null {
  if (tournament.pricing === 'FREE') return 'Free';
  const fee = tournament.entryFee;
  if (!fee || fee.minorUnits === null || fee.minorUnits === undefined) return null;
  return formatPrice(fee.minorUnits, fee.currency ?? '');
}

/**
 * Convert a search result node into the scraper's unified event shape.
 * Returns null for nodes we cannot place on the map or the calendar.
 */
export function convertTournamentNode(node: PrbTournamentNode): (ScrapedEvent & { storeInfo: StoreInfo }) | null {
  const tournament = node?.tournament;
  if (!tournament?.id || !tournament.startsAt) return null;
  // Ids are numeric today; anything else would end up in a URL we build.
  if (!/^\d+$/.test(String(tournament.id))) return null;

  const startDate = new Date(tournament.startsAt);
  if (Number.isNaN(startDate.getTime())) return null;

  const organizer = node.organizer;
  // Which field carries the address depends on which persisted document the
  // current hash resolves to: Riot's 2026-10 build moved it from
  // organizer.physicalAddress to tournament.tournamentLocation. Accept either,
  // or a rediscovered hash would "work" and then silently convert zero events
  // because every node lost its coordinates.
  const address = tournament.tournamentLocation ?? organizer?.physicalAddress ?? null;
  const latitude = address?.latitude ?? null;
  const longitude = address?.longitude ?? null;

  // Without coordinates the event cannot be placed on the calendar's map/radius
  // search, and it cannot participate in cross-source de-duplication either.
  if (latitude === null || longitude === null) return null;

  // Riot's live feed currently carries a stored-XSS payload in organizer.name
  // ('…Collectibles Inc<script src="…"></script>'), so organizer names are
  // stripped here as well as at the DB boundary - the cleaned name is what
  // gets compared, logged and stored.
  const organizerName = sanitizeText(organizer?.name);
  const country = parseCountry(address?.formattedAddress);

  const storeInfo: StoreInfo = sanitizeStoreInfo({
    id: organizerExternalId(organizer?.id ?? `${tournament.id}`),
    name: organizerName ?? 'Unknown organizer',
    full_address: address?.formattedAddress ?? '',
    city: address?.city ?? '',
    state: address?.adminArea1 ?? '',
    country: country ?? '',
    latitude,
    longitude,
    website: null,
    email: null,
  });

  return sanitizeScrapedEvent({
    externalId: `${PLAYRIFTBOUND_ID_PREFIX}${tournament.id}`,
    name: tournament.name,
    description: null,
    location: organizerName,
    address: address?.formattedAddress ?? null,
    city: address?.city ?? null,
    state: address?.adminArea1 ?? null,
    country,
    latitude,
    longitude,
    startDate,
    startTime: null, // frontend converts from the UTC startDate, same as the UVS source
    endDate: null, // Riot's search API does not expose an end time
    eventType: mapEventType(tournament.config?.tournamentType),
    // Riot's RiftboundTournamentConfig.format, verbatim and un-normalised (see
    // ScrapedEvent.playFormat). Captured here because this is the only place it
    // is ever available: the search API is upcoming-only and the event detail
    // page carries no format field, so an event that passes without it can never
    // be backfilled.
    playFormat: sanitizeText(tournament.config?.format),
    organizer: organizerName,
    playerCount: registeredPlayerCount(tournament.registrantCounts),
    capacity: tournament.config?.participantCapacity ?? null,
    price: eventPrice(tournament),
    url: `${EVENT_URL_BASE}/${tournament.id}`,
    imageUrl: null,
    sources: [SOURCE_PLAYRIFTBOUND],
    storeInfo,
  });
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function buildSearchUrl(
  anchor: { latitude: number; longitude: number },
  hash: string,
  after: string | null
): string {
  const variables: Record<string, unknown> = {
    sport: 'rb',
    first: PAGE_SIZE,
    filter: {
      rb: {
        coords: { latitude: anchor.latitude, longitude: anchor.longitude },
        distanceMeters: ANCHOR_RADIUS_METERS,
      },
    },
    sortBy: { rb: 'DATE' },
  };
  if (after) variables.after = after;

  const extensions = { persistedQuery: { version: 1, sha256Hash: hash } };

  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    extensions: JSON.stringify(extensions),
  });

  return `${GQL_ENDPOINT}?${params.toString()}`;
}

async function requestSearchPage(
  anchor: { latitude: number; longitude: number },
  hash: string,
  after: string | null
): Promise<PrbSearchResponse> {
  const response = await fetch(buildSearchUrl(anchor, hash, after), {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'apollo-require-preflight': 'true',
      'apollographql-client-name': CLIENT_NAME,
      'apollographql-client-version': '1.0.0',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Rate limited, blocked or Riot is having a bad time: stop the whole source
  // for this run rather than keep hammering it anchor after anchor.
  if (response.status === 429 || response.status === 403 || response.status >= 500) {
    throw new BackoffError(`HTTP ${response.status}${response.headers.get('retry-after') ? ` (retry-after ${response.headers.get('retry-after')})` : ''}`);
  }

  // A stale persisted query hash comes back as HTTP 404 with a GraphQL error
  // body, so parse the body before deciding the request failed.
  const text = await response.text();
  let parsed: PrbSearchResponse;
  try {
    parsed = JSON.parse(text) as PrbSearchResponse;
  } catch {
    throw new Error(`HTTP ${response.status}: unparseable response (${text.slice(0, 200)})`);
  }

  if (!response.ok && !parsed.errors) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return parsed;
}

class BackoffError extends Error {}

function isStaleHashError(response: PrbSearchResponse): boolean {
  return (response.errors ?? []).some(
    e =>
      e.extensions?.code === 'PERSISTED_QUERY_NOT_IN_LIST' ||
      e.extensions?.code === 'PERSISTED_QUERY_ID_REQUIRED' ||
      /persisted query/i.test(e.message ?? '')
  );
}

/**
 * Fetch every upcoming Riftbound event Riot knows about, by sweeping the anchor
 * set and merging the results.
 *
 * Never throws: on failure it logs and returns whatever it managed to collect so
 * the UVS source still runs.
 */
export async function fetchPlayriftboundEvents(options: PlayriftboundOptions = {}): Promise<PlayriftboundResult> {
  const requestDelayMs = Math.max(0, options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS);
  const anchorDelayMs = Math.max(0, options.anchorDelayMs ?? Math.max(DEFAULT_ANCHOR_DELAY_MS, requestDelayMs * 2));
  const daysForward = options.daysForward ?? DAYS_FORWARD;
  const maxAnchorsPerRun = options.maxAnchorsPerRun ?? DEFAULT_MAX_ANCHORS_PER_RUN;
  // Where we are in the sweep cycle, straight off the wall clock: stateless, and
  // independent of how often the scraper happens to run.
  const rotation = options.rotation ?? (Date.now() % ROTATION_PERIOD_MS) / ROTATION_PERIOD_MS;

  const allAnchors =
    options.anchors ??
    (options.coordinates?.length ? anchorsFromCoordinates(options.coordinates) : SEED_ANCHORS);
  const anchors = selectAnchorBatch(allAnchors, maxAnchorsPerRun, rotation);

  const horizon = new Date();
  horizon.setDate(horizon.getDate() + daysForward);

  const result: PlayriftboundResult = {
    events: [],
    anchorsAvailable: allAnchors.length,
    anchorsQueried: 0,
    anchorsFailed: 0,
    requests: 0,
    duplicatesWithinSource: 0,
    failed: false,
    partial: anchors.length < allAnchors.length,
    completedAnchors: [],
    horizon,
  };

  // Configured override wins, then the cached/rediscovered hash, then the default.
  let hash = options.queryHash || cachedQueryHash || DEFAULT_QUERY_HASH;
  let hashRefreshed = false;

  const byExternalId = new Map<string, ScrapedEvent & { storeInfo: StoreInfo }>();

  console.log(
    `[playriftbound] sweeping ${anchors.length}/${allAnchors.length} anchors ` +
      `(${ANCHOR_RADIUS_METERS / 1000}km radius each - the API caps it at ~161km - ` +
      `${requestDelayMs}ms between requests, rotation ${rotation.toFixed(3)})`
  );

  let consecutiveFailures = 0;

  for (const anchor of anchors) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      console.warn(
        `[playriftbound] time budget reached after ${result.anchorsQueried} anchors - ` +
          `remaining anchors roll over to the next run`
      );
      result.partial = true;
      break;
    }

    result.anchorsQueried++;
    let after: string | null = null;
    let pages = 0;
    let anchorEvents = 0;
    let anchorComplete = false;

    try {
      while (pages < MAX_PAGES_PER_ANCHOR) {
        if (options.deadline !== undefined && Date.now() >= options.deadline) {
          result.partial = true;
          break;
        }

        if (result.requests > 0) {
          await sleep(after === null ? anchorDelayMs : requestDelayMs);
        }

        result.requests++;
        let response = await requestSearchPage(anchor, hash, after);

        if (isStaleHashError(response)) {
          if (hashRefreshed) {
            console.error('[playriftbound] persisted query hash still rejected after refresh, giving up on this run');
            result.failed = true;
            return finalise(result, byExternalId);
          }
          console.warn(
            `[playriftbound] persisted query hash ${hash} rejected by the API - refreshing from Riot's manifest`
          );
          hashRefreshed = true;
          const refreshed = await rediscoverQueryHash(requestDelayMs, options.deadline);
          if (!refreshed) {
            console.error(
              '[playriftbound] could not resolve a persisted query hash; skipping this source for this run. ' +
                'Set PLAYRIFTBOUND_QUERY_HASH to unblock.'
            );
            result.failed = true;
            return finalise(result, byExternalId);
          }
          console.warn(`[playriftbound] resolved new persisted query hash ${refreshed}`);
          hash = refreshed;
          cachedQueryHash = refreshed;
          result.requests++;
          response = await requestSearchPage(anchor, hash, after);
        }

        if (response.errors?.length) {
          throw new Error(response.errors.map(e => e.message).join('; '));
        }

        const search = response.data?.competeTournamentSearch;
        if (!search) {
          throw new Error('response missing competeTournamentSearch');
        }

        const edges = search.edges ?? [];
        let lastStart: Date | null = null;

        for (const edge of edges) {
          const converted = convertTournamentNode(edge.node);
          if (!converted) continue;
          lastStart = converted.startDate;
          if (converted.startDate > horizon) continue;
          if (byExternalId.has(converted.externalId)) {
            result.duplicatesWithinSource++;
            continue;
          }
          byExternalId.set(converted.externalId, converted);
          anchorEvents++;
        }

        pages++;

        // Results are ordered by date, so once a page ends past the calendar
        // horizon there is nothing left worth paging for at this anchor.
        if ((lastStart && lastStart > horizon) || !search.pageInfo?.hasNextPage || !search.pageInfo.endCursor) {
          anchorComplete = true;
          break;
        }
        after = search.pageInfo.endCursor;
      }

      if (anchorComplete) {
        result.completedAnchors.push(anchor);
      } else if (pages >= MAX_PAGES_PER_ANCHOR) {
        console.warn(`[playriftbound]   ${anchor.name}: hit the ${MAX_PAGES_PER_ANCHOR}-page cap, results truncated`);
      }
      if (anchorEvents > 0) {
        console.log(`[playriftbound]   ${anchor.name}: ${anchorEvents} new events over ${pages} page(s)`);
      }
      consecutiveFailures = 0;
    } catch (error) {
      result.anchorsFailed++;
      consecutiveFailures++;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BackoffError || consecutiveFailures >= MAX_CONSECUTIVE_ANCHOR_FAILURES) {
        console.error(`[playriftbound]   ${anchor.name}: failed (${message}) - backing off, stopping this source for the run`);
        result.failed = true;
        result.partial = true;
        return finalise(result, byExternalId);
      }
      console.error(`[playriftbound]   ${anchor.name}: failed (${message}) - continuing with remaining anchors`);
    }
  }

  return finalise(result, byExternalId);
}

function finalise(
  result: PlayriftboundResult,
  byExternalId: Map<string, ScrapedEvent & { storeInfo: StoreInfo }>
): PlayriftboundResult {
  result.events = [...byExternalId.values()];
  console.log(
    `[playriftbound] ${result.events.length} unique events from ${result.anchorsQueried - result.anchorsFailed}/` +
      `${result.anchorsQueried} anchors (of ${result.anchorsAvailable} total) in ${result.requests} requests ` +
      `(${result.duplicatesWithinSource} overlapping hits collapsed)`
  );
  return result;
}
