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

/** Chunk that currently holds the persisted-query manifest. Verified 2026-09-15. */
const MANIFEST_CHUNK_URL = 'https://events.playriftbound.com/_next/static/chunks/00kyxx5y6b23i.js';
const CHUNK_URL_BASE = 'https://events.playriftbound.com/_next/static/chunks/';

const OPERATION_NAME = 'CompeteTournamentSearch';

/** Known-good persisted query hash. Rotates on Riot deploys; see rediscoverQueryHash. */
const DEFAULT_QUERY_HASH = 'acbcbba681a9c9a8063f792f7d665ba1eda81b19528b6af19e523f0c2061bec2';

const PAGE_SIZE = 100;

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
const DEFAULT_MAX_ANCHORS_PER_RUN = 150; // ~3 minutes of requests per cycle
const ROTATION_PERIOD_MS = 24 * 60 * 60 * 1000; // one full pass over all anchors per day
const MAX_PAGES_PER_ANCHOR = 12; // safety valve (1,200 events within one cell)
const MAX_CHUNKS_TO_PROBE = 60; // safety valve for manifest rediscovery
const DAYS_FORWARD = 90; // match the UVS source / calendar display range

/** Prefix on externalId so Riot events never collide with UVS numeric event ids. */
export const PLAYRIFTBOUND_ID_PREFIX = 'prb-';

/**
 * Offset applied to synthesised shop external ids. UVS store ids are small
 * integers; keeping Riot organizers in their own numeric band avoids collisions.
 */
const ORGANIZER_ID_OFFSET = 2_000_000_000;
const ORGANIZER_ID_SPACE = 1_000_000_000;

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
  physicalAddress: PrbLocation | null;
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
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Persisted query hash resolution (self-healing)
// ---------------------------------------------------------------------------

let cachedQueryHash: string | null = null;

/** Exported for tests - resets the module level hash cache. */
export function resetQueryHashCache(): void {
  cachedQueryHash = null;
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
        'User-Agent': 'Riftfound/1.0 (Event Aggregator)',
        'Accept': '*/*',
      },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Re-discover the current persisted query hash.
 *
 * 1. Read the known manifest chunk.
 * 2. If that 404s (the chunk filename rotates too), read the events page HTML,
 *    collect the chunk URLs it references, and probe them. The webpack runtime
 *    chunk names the lazily-loaded manifest chunk, so nested chunk references
 *    are harvested and probed as well.
 */
async function rediscoverQueryHash(requestDelayMs: number): Promise<string | null> {
  const direct = await fetchText(MANIFEST_CHUNK_URL);
  if (direct) {
    const hash = extractQueryHashFromChunk(direct);
    if (hash) return hash;
    console.warn(`[playriftbound] manifest chunk fetched but ${OPERATION_NAME} not found in it`);
  } else {
    console.warn(`[playriftbound] manifest chunk ${MANIFEST_CHUNK_URL} unavailable, crawling events page for chunks`);
  }

  const html = await fetchText(EVENTS_PAGE_URL);
  if (!html) {
    console.error('[playriftbound] could not fetch events page to rediscover persisted query manifest');
    return null;
  }

  const queue: string[] = [];
  const seen = new Set<string>();
  const enqueue = (name: string) => {
    if (!seen.has(name) && queue.length + seen.size < MAX_CHUNKS_TO_PROBE) {
      seen.add(name);
      queue.push(name);
    }
  };

  for (const match of html.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)) {
    enqueue(match[1]);
  }

  let probed = 0;
  while (queue.length > 0 && probed < MAX_CHUNKS_TO_PROBE) {
    const name = queue.shift() as string;
    await sleep(requestDelayMs);
    probed++;
    const body = await fetchText(`${CHUNK_URL_BASE}${name}`);
    if (!body) continue;

    const hash = extractQueryHashFromChunk(body);
    if (hash) {
      console.warn(`[playriftbound] found persisted query manifest in rotated chunk ${name}`);
      return hash;
    }

    // Harvest chunk names referenced from inside this chunk (webpack runtime map).
    for (const match of body.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)) {
      enqueue(match[1]);
    }
  }

  console.error(`[playriftbound] exhausted ${probed} chunks without finding the ${OPERATION_NAME} persisted query id`);
  return null;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Riot's tournamentType enum -> the human strings the UVS source produces and
 * the frontend event-type filter expects.
 */
export function mapEventType(tournamentType: string | null | undefined): string {
  switch (tournamentType) {
    case 'NEXUS_NIGHT':
      return 'Nexus Night';
    case 'PRE_RIFT':
      return 'Pre-Rift';
    case 'SUMMONER_SKIRMISH':
      return 'Summoner Skirmish';
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

  const startDate = new Date(tournament.startsAt);
  if (Number.isNaN(startDate.getTime())) return null;

  const organizer = node.organizer;
  const address = organizer?.physicalAddress ?? null;
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
      'User-Agent': 'Riftfound/1.0 (Event Aggregator)',
      'Accept': 'application/json',
      'apollo-require-preflight': 'true',
      'apollographql-client-name': 'Esports Web',
      'apollographql-client-version': '1.0.0',
    },
  });

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
          const refreshed = await rediscoverQueryHash(requestDelayMs);
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
        if (lastStart && lastStart > horizon) break;
        if (!search.pageInfo?.hasNextPage || !search.pageInfo.endCursor) break;
        after = search.pageInfo.endCursor;
      }

      if (anchorEvents > 0) {
        console.log(`[playriftbound]   ${anchor.name}: ${anchorEvents} new events over ${pages} page(s)`);
      }
    } catch (error) {
      result.anchorsFailed++;
      const message = error instanceof Error ? error.message : String(error);
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
