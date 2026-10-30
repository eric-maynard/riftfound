import { resolveVerdict } from '../models/ranking.js';
import type { PlayerMatch, RatingPoint, Scope } from '../models/ranking.js';
import {
  MIN_NEEDLE_LENGTH,
  buildNameIndex,
  normaliseNeedle,
  searchNameIndex,
} from './playerNameIndex.js';
import type {
  LeaderboardPage,
  LeaderboardRecord,
  Page,
  PlayerRecord,
  PlayerSearchResult,
  RankingStore,
  SceneCatalogueEntry,
  SceneDirectoryEntry,
  SetRatingRecord,
  VenueCatalogueEntry,
} from './rankingStore.js';

/**
 * In-memory ranking store.
 *
 * The rating engine is being written in parallel and the production backfill is
 * still running, so this adapter stands in for it in dev and in tests. It
 * implements `RankingStore` exactly as the DynamoDB adapter does, and its data
 * deliberately models the *launch* state rather than a healthy ladder:
 * Radiance shipped 2026-10-23, the backfill reaches ~21 days, so most players
 * have one to three matches and only a handful clear any confidence gate. That
 * sparse case is the one the UI has to look right in.
 *
 * The dataset is generated from the match log outwards, so a player's
 * `gamesPlayed`, `matchesPlayed` and per-set numbers always agree with the
 * matches the API serves for them - the same invariant the real engine has to
 * hold.
 */

export interface FixtureData {
  players: PlayerRecord[];
  matches: Record<string, PlayerMatch[]>;
  ratings: Record<string, Record<string, RatingPoint[]>>;
  /** playerId order per scope, as the engine's leaderboard pages would hold it. */
  boards: Record<string, string[]>;
}

export const EMPTY_FIXTURE_DATA: FixtureData = { players: [], matches: {}, ratings: {}, boards: { all: [] } };

/** Stands in for the engine's `generatedAt` on a fixture catalogue item. */
const FIXTURE_GENERATED_AT = '2026-10-27T00:00:00.000Z';

/** A venue mid-tally while the fixture's scene catalogue is being derived. */
interface FixtureVenueTally {
  shopExternalId: number | null;
  latitude: number | null;
  longitude: number | null;
  /**
   * Match *participations*: each match is in both players' logs, so this is
   * twice the match count and is halved at the end.
   */
  halfMatches: number;
}

/**
 * A match-weighted spherical centroid and spread, for the fixture only.
 *
 * The engine's version (`scraper/src/ranking/sceneMap.ts`) is the real one and
 * carries the refusals - no located venue, half a coordinate pair, an
 * antipodal cancellation - with tests for each. This is the arithmetic alone,
 * on data that has none of those cases in it, so the fixture's map agrees with
 * the fixture's matches. Unit vectors rather than a mean of degrees even here,
 * so the two cannot disagree by construction on anything real.
 */
function fixtureCentroid(
  venues: { latitude: number; longitude: number; matchCount: number }[]
): { latitude: number | null; longitude: number | null; spreadKm: number | null; nearestVenueKm: number | null } {
  if (venues.length === 0) {
    return { latitude: null, longitude: null, spreadKm: null, nearestVenueKm: null };
  }

  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  let x = 0;
  let y = 0;
  let z = 0;
  let weight = 0;
  for (const venue of venues) {
    const w = Math.max(1, venue.matchCount);
    const lat = rad(venue.latitude);
    const lon = rad(venue.longitude);
    x += w * Math.cos(lat) * Math.cos(lon);
    y += w * Math.cos(lat) * Math.sin(lon);
    z += w * Math.sin(lat);
    weight += w;
  }
  const latitude = (Math.atan2(z / weight, Math.hypot(x / weight, y / weight)) * 180) / Math.PI;
  const longitude = (Math.atan2(y / weight, x / weight) * 180) / Math.PI;

  const distance = (lat: number, lon: number) => {
    const dLat = rad(lat - latitude);
    const dLon = rad(lon - longitude);
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(rad(latitude)) * Math.cos(rad(lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
  };
  const spread =
    venues.reduce((total, venue) => total + Math.max(1, venue.matchCount) * distance(venue.latitude, venue.longitude), 0) /
    weight;

  const nearest = Math.min(...venues.map((venue) => distance(venue.latitude, venue.longitude)));

  const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
  return {
    latitude: round(latitude, 6),
    longitude: round(longitude, 6),
    spreadKm: round(spread, 1),
    nearestVenueKm: round(nearest, 1),
  };
}

// --- the sparse launch dataset ---------------------------------------------

const BAY = { componentId: 'c-bay', componentSize: 23, regionLabel: 'San Francisco Bay Area' };
const SEA = { componentId: 'c-sea', componentSize: 5, regionLabel: 'Puget Sound' };

interface Seed {
  id: string;
  name: string;
  tag: string;
  /** All-sets rating; null for a player the engine has seen but not rated. */
  rating: number | null;
  uncertainty: number | null;
  /** Matches to generate. Four or more clears the eight-game confidence gate. */
  matches: number;
  component: typeof BAY | typeof SEA;
  /** Played before Radiance shipped, so they have an Origins slice too. */
  playedOrigins?: boolean;
}

const SEEDS: Seed[] = [
  // Rated: four or more matches inside the backfill window.
  { id: 'p-kira', name: 'Kirabosc', tag: 'NA1', rating: 1588, uncertainty: 86, matches: 6, component: BAY, playedOrigins: true },
  { id: 'p-volto', name: 'Voltomancer', tag: 'EUW', rating: 1542, uncertainty: 94, matches: 5, component: BAY, playedOrigins: true },
  { id: 'p-mari', name: 'Marigold', tag: 'NA1', rating: 1515, uncertainty: 101, matches: 5, component: BAY },
  { id: 'p-tess', name: 'Tessellate', tag: 'NA1', rating: 1498, uncertainty: 112, matches: 4, component: BAY },
  { id: 'p-ruan', name: 'Ruan', tag: 'NA2', rating: 1471, uncertainty: 118, matches: 4, component: BAY },
  { id: 'p-pell', name: 'Pellingard', tag: 'NA1', rating: 1442, uncertainty: 119, matches: 4, component: BAY },
  // Enough games, but sigma is still too wide to publish a number from.
  { id: 'p-sable', name: 'Sablewing', tag: 'NA1', rating: 1604, uncertainty: 168, matches: 5, component: BAY },
  // Provisional: one to three matches, which is most of the player base at launch.
  { id: 'p-juno', name: 'Junobell', tag: 'NA1', rating: 1561, uncertainty: 203, matches: 3, component: BAY },
  { id: 'p-oriel', name: 'Oriel', tag: 'NA1', rating: 1527, uncertainty: 214, matches: 3, component: BAY },
  { id: 'p-haruk', name: 'Haruko', tag: 'NA1', rating: 1503, uncertainty: 228, matches: 2, component: BAY },
  { id: 'p-breva', name: 'Brevan', tag: 'NA1', rating: 1489, uncertainty: 241, matches: 2, component: BAY },
  { id: 'p-cyn', name: 'Cynosure', tag: 'NA1', rating: 1476, uncertainty: 259, matches: 1, component: BAY },
  { id: 'p-lark', name: 'Larkspur', tag: 'NA1', rating: 1460, uncertainty: 262, matches: 1, component: BAY },
  { id: 'p-mott', name: 'Mottle', tag: 'NA1', rating: 1444, uncertainty: 274, matches: 1, component: BAY },
  { id: 'p-ovra', name: 'Ovranne', tag: 'NA1', rating: 1431, uncertainty: 276, matches: 1, component: BAY },
  // A player the engine has seen but has no rating for at all.
  { id: 'p-quill', name: 'Quillon', tag: 'NA1', rating: null, uncertainty: null, matches: 0, component: BAY },
  // A second, much smaller component: too small for its order to mean anything.
  { id: 'p-adria', name: 'Adrian', tag: 'NA1', rating: 1533, uncertainty: 221, matches: 2, component: SEA },
  { id: 'p-wyl', name: 'Wylden', tag: 'NA1', rating: 1498, uncertainty: 248, matches: 2, component: SEA },
  { id: 'p-nori', name: 'Norinori', tag: 'NA1', rating: 1472, uncertainty: 266, matches: 2, component: SEA },
];

/**
 * The fixture's stores, and the scene each one belongs to.
 *
 * The scene fields are the point of this table, not decoration. The engine
 * assigns a scene to a **venue** and the event page reads it from there, so a
 * fixture that had no venue scenes could not exercise the path at all - and
 * the arrangement here is chosen to make the three states the page has to
 * render reachable:
 *
 * - **Two stores sharing a scene** (Berkeley and San Francisco, 17km apart,
 *   inside the engine's 30km diameter cap).
 * - **A store in a scene of its own** (Cupertino, 48km from San Francisco, so
 *   a separate scene however connected its players are).
 * - **A store with no scene at all** (Bellevue). Null is the *normal* value -
 *   every venue carries it until an operator accepts a re-clustering, and a
 *   store whose cluster fails the rankability gate keeps carrying it - so the
 *   fixture has to hold one or the page's honest empty state is untested.
 *
 * Note what this makes true, because it is the whole argument for the change:
 * the Bay component spans all three Bay venues, so its players sit in **two**
 * scenes and one component. A scene read off the component would give the
 * Cupertino store San Francisco's name.
 */
const VENUES = [
  {
    shopId: '1041',
    lat: 37.8716,
    lng: -122.2727,
    name: 'Berkeley, CA',
    sceneId: 'sf-berkeley',
    sceneLabel: 'San Francisco & Berkeley',
    scenePurity: 0.94,
  },
  {
    shopId: '1088',
    lat: 37.7749,
    lng: -122.4394,
    name: 'San Francisco, CA',
    sceneId: 'sf-berkeley',
    sceneLabel: 'San Francisco & Berkeley',
    scenePurity: 0.97,
  },
  {
    shopId: '1132',
    lat: 37.3688,
    lng: -122.0363,
    name: 'Cupertino, CA',
    sceneId: 'south-bay',
    sceneLabel: 'South Bay',
    scenePurity: 1,
  },
  {
    shopId: '2210',
    lat: 47.6101,
    lng: -122.2015,
    name: 'Bellevue, WA',
    sceneId: null,
    sceneLabel: null,
    scenePurity: null,
  },
] satisfies {
  shopId: string;
  lat: number;
  lng: number;
  name: string;
  sceneId: string | null;
  sceneLabel: string | null;
  scenePurity: number | null;
}[];

interface FixtureEvent {
  externalId: string;
  name: string;
  date: string;
  type: string;
  setId: string;
  venue: number;
}

const RADIANCE_EVENTS: FixtureEvent[] = [
  { externalId: 'prb-rad-prerift-berkeley-1', name: 'Radiance Pre-Rift Event', date: '2026-10-17', type: 'Pre-Rift', setId: 'radiance', venue: 0 },
  { externalId: 'prb-rad-prerift-sf-1', name: 'Radiance Pre-Rift Event', date: '2026-10-18', type: 'Pre-Rift', setId: 'radiance', venue: 1 },
  { externalId: '48812', name: 'Thursday Nexus Nights', date: '2026-10-22', type: 'Nexus Night', setId: 'radiance', venue: 2 },
  { externalId: '48907', name: 'Summoner Skirmish', date: '2026-10-24', type: 'Summoner Skirmish', setId: 'radiance', venue: 0 },
];

const SEATTLE_EVENTS: FixtureEvent[] = [
  { externalId: '48666', name: 'Bellevue Nexus Night', date: '2026-10-21', type: 'Nexus Night', setId: 'radiance', venue: 3 },
  { externalId: '48701', name: 'Bellevue Summoner Skirmish', date: '2026-10-24', type: 'Summoner Skirmish', setId: 'radiance', venue: 3 },
];

const ORIGINS_EVENTS: FixtureEvent[] = [
  { externalId: '48511', name: 'Origins Nexus Night', date: '2026-10-08', type: 'Nexus Night', setId: 'ogn', venue: 1 },
  { externalId: '48540', name: 'Origins Nexus Night', date: '2026-10-15', type: 'Nexus Night', setId: 'ogn', venue: 0 },
];

/** Small deterministic PRNG so the fixture is byte-stable across runs. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Four matches is where a player first clears the eight-game gate. */
const RATED_MATCH_FLOOR = 4;

function buildLaunchFixture(): FixtureData {
  const random = mulberry32(20261025);
  const matches: Record<string, PlayerMatch[]> = {};
  let matchCounter = 0;

  const components = new Map<string, Seed[]>();
  for (const seed of SEEDS) {
    const list = components.get(seed.component.componentId) ?? [];
    list.push(seed);
    components.set(seed.component.componentId, list);
  }

  for (const [componentId, group] of components) {
    // Pair players off against the quota each one is seeded with, always
    // inside their own component - which is what keeps the co-play graph
    // disconnected in the first place.
    const quota = new Map(group.map((seed) => [seed.id, seed.matches]));
    const originsQuota = new Map(group.map((seed) => [seed.id, seed.playedOrigins ? 2 : 0]));
    const seedById = new Map(group.map((seed) => [seed.id, seed]));

    for (;;) {
      const available = [...quota.entries()]
        .filter(([, left]) => left > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (available.length < 2) break;

      const [aId] = available[0];
      const [bId] = available[1];
      const a = seedById.get(aId)!;
      const b = seedById.get(bId)!;
      quota.set(aId, quota.get(aId)! - 1);
      quota.set(bId, quota.get(bId)! - 1);

      const bothOrigins = (originsQuota.get(aId) ?? 0) > 0 && (originsQuota.get(bId) ?? 0) > 0;
      if (bothOrigins) {
        originsQuota.set(aId, originsQuota.get(aId)! - 1);
        originsQuota.set(bId, originsQuota.get(bId)! - 1);
      }

      const pool = bothOrigins
        ? ORIGINS_EVENTS
        : componentId === SEA.componentId
          ? SEATTLE_EVENTS
          : RADIANCE_EVENTS;
      const event = pool[matchCounter % pool.length];
      const venue = VENUES[event.venue];

      matchCounter += 1;
      const matchId = `m-${String(matchCounter).padStart(4, '0')}`;
      const playedAt = `${event.date}T${String(18 + (matchCounter % 3)).padStart(2, '0')}:${String((matchCounter * 11) % 60).padStart(2, '0')}:00.000Z`;

      // A player with fewer than four matches must stay under the eight-game
      // gate, so their matches never go to three games.
      const canGoThree = a.matches >= RATED_MATCH_FLOOR && b.matches >= RATED_MATCH_FLOOR;
      const aWins = random() < 0.5;
      const threeGames = canGoThree && random() < 0.45;
      const aGames = threeGames
        ? ([aWins ? 'win' : 'loss', aWins ? 'loss' : 'win', aWins ? 'win' : 'loss'] as const)
        : ([aWins ? 'win' : 'loss', aWins ? 'win' : 'loss'] as const);

      const flip = (outcome: 'win' | 'loss') => (outcome === 'win' ? ('loss' as const) : ('win' as const));
      const shared = {
        matchId,
        playedAt,
        eventExternalId: event.externalId,
        eventName: event.name,
        shopId: venue.shopId,
        latitude: venue.lat,
        longitude: venue.lng,
        eventDate: event.date,
        tournamentType: event.type,
        setId: event.setId,
      };

      (matches[aId] ??= []).push({
        ...shared,
        opponentId: bId,
        opponentDisplayName: b.name,
        outcome: aWins ? 'win' : 'loss',
        games: aGames.map((outcome, index) => ({ gameNumber: index + 1, outcome })),
      });
      (matches[bId] ??= []).push({
        ...shared,
        opponentId: aId,
        opponentDisplayName: a.name,
        outcome: aWins ? 'loss' : 'win',
        games: aGames.map((outcome, index) => ({ gameNumber: index + 1, outcome: flip(outcome) })),
      });
    }
  }

  for (const list of Object.values(matches)) {
    list.sort((a, b) => b.playedAt.localeCompare(a.playedAt));
  }

  // Profiles, with every count derived from the match log above.
  const players: PlayerRecord[] = SEEDS.map((seed) => {
    const own = matches[seed.id] ?? [];
    const gamesPlayed = own.reduce((sum, match) => sum + match.games.length, 0);

    const setIds = [...new Set(own.map((match) => match.setId).filter((id): id is string => id !== null))];
    const setRatings: SetRatingRecord[] = setIds
      .map((setId): SetRatingRecord | null => {
        const inSet = own.filter((match) => match.setId === setId);
        const setGames = inSet.reduce((sum, match) => sum + match.games.length, 0);
        if (seed.rating === null) return null;
        // Fewer games in a slice means a wider sigma for that slice.
        const widening = gamesPlayed > 0 ? Math.sqrt(gamesPlayed / Math.max(1, setGames)) : 1;
        return {
          setId,
          rating: seed.rating + ((setId.charCodeAt(0) + seed.id.length) % 31) - 15,
          uncertainty: Math.round((seed.uncertainty ?? 250) * widening),
          gamesPlayed: setGames,
          matchesPlayed: inSet.length,
        };
      })
      .filter((entry): entry is SetRatingRecord => entry !== null)
      // Radiance first, then older sets.
      .sort((a, b) => (a.setId === 'radiance' ? -1 : b.setId === 'radiance' ? 1 : a.setId.localeCompare(b.setId)));

    const dates = own.map((match) => match.playedAt).sort();

    return {
      playerId: seed.id,
      displayName: seed.name,
      tagLine: seed.tag,
      rating: seed.rating,
      uncertainty: seed.uncertainty,
      gamesPlayed,
      matchesPlayed: own.length,
      firstSeen: dates[0]?.slice(0, 10) ?? null,
      lastSeen: dates[dates.length - 1]?.slice(0, 10) ?? null,
      componentId: seed.component.componentId,
      componentSize: seed.component.componentSize,
      regionLabel: seed.component.regionLabel,
      setRatings,
      updatedAt: '2026-10-25T06:00:00.000Z',
    };
  });

  // Rating history: one point per day the player actually played in that
  // scope, so a player with one match has a single-point series and a player
  // with two has a two-point one - the cases the chart has to survive.
  const ratings: Record<string, Record<string, RatingPoint[]>> = {};
  for (const player of players) {
    if (player.rating === null) continue;
    const own = matches[player.playerId] ?? [];
    if (own.length === 0) continue;

    const series = (
      finalRating: number,
      finalUncertainty: number,
      finalGames: number,
      setId?: string
    ): RatingPoint[] => {
      const relevant = own.filter((match) => !setId || match.setId === setId);
      const days = [...new Set(relevant.map((match) => match.playedAt.slice(0, 10)))].sort();
      if (days.length === 0) return [];
      return days.map((date, index) => {
        const progress = days.length === 1 ? 1 : index / (days.length - 1);
        // Earlier points sit off the final rating and carry a wider sigma.
        const drift = (1 - progress) * (random() * 70 - 35);
        return {
          date,
          rating: Math.round(finalRating - drift),
          uncertainty: Math.round(finalUncertainty + (1 - progress) * 130),
          gamesPlayed: Math.max(1, Math.round(finalGames * ((index + 1) / days.length))),
        };
      });
    };

    const scopes: Record<string, RatingPoint[]> = {
      all: series(player.rating, player.uncertainty ?? 250, player.gamesPlayed ?? 0),
    };
    for (const setRating of player.setRatings) {
      scopes[`set:${setRating.setId}`] = series(
        setRating.rating ?? player.rating,
        setRating.uncertainty ?? 250,
        setRating.gamesPlayed ?? 0,
        setRating.setId
      );
    }
    ratings[player.playerId] = scopes;
  }

  // Boards, in the order the engine would have written them: best rating
  // first, players with no rating last.
  const order = (candidates: PlayerRecord[], setId?: string) =>
    [...candidates]
      .sort((a, b) => {
        const ratingOf = (player: PlayerRecord) =>
          setId
            ? player.setRatings.find((entry) => entry.setId === setId)?.rating ?? -Infinity
            : player.rating ?? -Infinity;
        return ratingOf(b) - ratingOf(a) || a.playerId.localeCompare(b.playerId);
      })
      .map((player) => player.playerId);

  const boards: Record<string, string[]> = { all: order(players) };
  for (const [componentId, group] of components) {
    const inComponent = players.filter((player) => player.componentId === componentId);
    boards[`component:${componentId}`] = order(inComponent);
    void group;
  }
  const allSetIds = [...new Set(players.flatMap((player) => player.setRatings.map((entry) => entry.setId)))];
  for (const setId of allSetIds) {
    const inSet = players.filter((player) => player.setRatings.some((entry) => entry.setId === setId));
    boards[`set:${setId}`] = order(inSet, setId);
    for (const componentId of components.keys()) {
      const both = inSet.filter((player) => player.componentId === componentId);
      if (both.length > 0) boards[`set:${setId}#component:${componentId}`] = order(both, setId);
    }
  }

  return { players, matches, ratings, boards };
}

export const LAUNCH_FIXTURE_DATA: FixtureData = buildLaunchFixture();

// --- the adapter ------------------------------------------------------------

function encodeCursor(index: number): string {
  return Buffer.from(`i:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^i:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

export function createFixtureRankingStore(data: FixtureData = LAUNCH_FIXTURE_DATA): RankingStore {
  const byId = new Map(data.players.map((player) => [player.playerId, player]));

  // Named rather than returned inline so one method can call another -
  // `getComponent` reads `listSceneCatalogue`, because the one thing a fixture
  // must not do is derive the same answer twice.
  const store: RankingStore = {
    kind: 'fixture',

    async getLeaderboard(scope: Scope, limit: number, cursor?: string): Promise<LeaderboardPage> {
      const ids = data.boards[scope.raw] ?? [];
      const start = decodeCursor(cursor);
      const slice = ids.slice(start, start + limit);

      const items: LeaderboardRecord[] = slice.map((playerId) => {
        const player = byId.get(playerId);
        // In a set scope the engine's board carries that set's own numbers -
        // and, where the fixture states one, that scope's own verdict.
        const setRating = scope.setId
          ? player?.setRatings.find((entry) => entry.setId === scope.setId)
          : undefined;
        const source = scope.setId ? setRating : player;
        return {
          playerId,
          provisional: source?.provisional ?? undefined,
          provisionalReason: source?.provisionalReason ?? undefined,
          gamesUntilRated: source?.gamesUntilRated ?? undefined,
          rating: scope.setId ? setRating?.rating ?? null : player?.rating ?? null,
          uncertainty: scope.setId ? setRating?.uncertainty ?? null : player?.uncertainty ?? null,
          gamesPlayed: scope.setId ? setRating?.gamesPlayed ?? null : player?.gamesPlayed ?? null,
          matchesPlayed: scope.setId ? setRating?.matchesPlayed ?? null : player?.matchesPlayed ?? null,
          displayName: player?.displayName ?? null,
          tagLine: player?.tagLine ?? null,
          componentId: player?.componentId ?? null,
          componentSize: player?.componentSize ?? null,
          regionLabel: player?.regionLabel ?? null,
        };
      });

      return {
        items,
        cursor: start + limit < ids.length ? encodeCursor(start + limit) : null,
        updatedAt: ids.length > 0 ? '2026-10-25T06:00:00.000Z' : null,
        totalPlayers: ids.length,
      };
    },

    async getPlayer(playerId: string) {
      return byId.get(playerId) ?? null;
    },

    async getPlayers(playerIds: string[]) {
      const out = new Map<string, PlayerRecord>();
      for (const id of playerIds) {
        const player = byId.get(id);
        if (player) out.set(id, player);
      }
      return out;
    },

    async getMatches(playerId: string, limit: number, cursor?: string, setId?: string): Promise<Page<PlayerMatch>> {
      const all = (data.matches[playerId] ?? []).filter((match) => !setId || match.setId === setId);
      const start = decodeCursor(cursor);
      return {
        items: all.slice(start, start + limit),
        cursor: start + limit < all.length ? encodeCursor(start + limit) : null,
      };
    },

    async getRatingHistory(playerId: string, scope: Scope, limit: number) {
      return (data.ratings[playerId]?.[scope.raw] ?? []).slice(0, limit);
    },

    /**
     * Search over the whole fixture, through the **same** matcher the
     * DynamoDB store uses.
     *
     * It used to be its own `includes` over the fixture list, which happened
     * to agree with the real store because the real store was also doing a
     * substring test - and that is exactly how a search bug stays invisible in
     * a test suite. Sharing `searchNameIndex` means the ranking and the tiers
     * are pinned here too, and that `./dev.sh` behaves the way production
     * does rather than merely producing results.
     *
     * Always `complete: true`: a fixture is small enough to compare in full,
     * which is the property the real store now has as well.
     */
    async searchPlayers(query: string, limit: number): Promise<PlayerSearchResult> {
      const needle = normaliseNeedle(query);
      if (needle.length < MIN_NEEDLE_LENGTH) {
        return { records: [], complete: true, searchedPlayers: data.players.length, matched: 0 };
      }

      const { playerIds, matched } = searchNameIndex(buildNameIndex(data.players), needle, limit);
      const byId = new Map(data.players.map((player) => [player.playerId, player]));
      return {
        records: playerIds
          .map((playerId) => byId.get(playerId))
          .filter((player): player is PlayerRecord => player !== undefined),
        complete: true,
        searchedPlayers: data.players.length,
        matched,
      };
    },

    async listSetIds() {
      const ids = new Set<string>();
      for (const player of data.players) {
        for (const setRating of player.setRatings) ids.add(setRating.setId);
      }
      for (const scope of Object.keys(data.boards)) {
        const match = /^set:([^#]+)/.exec(scope);
        if (match) ids.add(match[1]);
      }
      return [...ids];
    },

    /**
     * The scene catalogue, derived from this fixture's own match log.
     *
     * Derived rather than declared, for the reason the whole fixture is
     * generated from the match log outwards: a hand-written place would drift
     * away from the matches the API serves beside it, and a map that disagreed
     * with its own leaderboard is exactly the bug this adapter exists to catch
     * before production does.
     *
     * The arithmetic mirrors the engine's (`scraper/src/ranking/sceneMap.ts`,
     * where it is tested against the antimeridian and the refusals): a
     * match-weighted spherical centroid over the venues, with a weighted mean
     * distance as the spread. It is duplicated rather than shared because the
     * two packages do not import each other and this is a stand-in for the
     * engine by definition - and it is kept to the one case the fixture needs,
     * so there is no second implementation of the refusals to go stale. A
     * venue with no coordinates still counts towards `venueCount` and not
     * towards the centroid, which is the one behaviour a reader could get
     * wrong.
     */
    async listSceneCatalogue(): Promise<SceneCatalogueEntry[]> {
      const byComponent = new Map<
        string,
        { regionLabel: string | null; componentSize: number | null; venues: Map<string, FixtureVenueTally> }
      >();

      for (const player of data.players) {
        if (!player.componentId) continue;
        const bucket =
          byComponent.get(player.componentId) ??
          { regionLabel: player.regionLabel, componentSize: player.componentSize, venues: new Map() };
        byComponent.set(player.componentId, bucket);

        for (const match of data.matches[player.playerId] ?? []) {
          // Each match appears in both players' logs, so a venue's tally is
          // halved to count matches rather than participations - the figure
          // the engine's `matchCount` holds.
          const key = match.shopId ?? `geo:${match.latitude},${match.longitude}`;
          const tally = bucket.venues.get(key) ?? {
            shopExternalId: match.shopId === null ? null : Number(match.shopId),
            latitude: match.latitude,
            longitude: match.longitude,
            halfMatches: 0,
          };
          tally.halfMatches += 1;
          bucket.venues.set(key, tally);
        }
      }

      return [...byComponent.entries()]
        .map(([componentId, bucket]) => {
          const venues = [...bucket.venues.values()]
            .map((tally) => ({ ...tally, matchCount: Math.round(tally.halfMatches / 2) }))
            .sort((a, b) => b.matchCount - a.matchCount);
          const located = venues.filter(
            (venue): venue is (typeof venues)[number] & { latitude: number; longitude: number } =>
              venue.latitude !== null && venue.longitude !== null
          );
          const inComponent = data.players.filter((player) => player.componentId === componentId);
          const matchCount = venues.reduce((total, venue) => total + venue.matchCount, 0);
          const place = fixtureCentroid(located);

          return {
            componentId,
            regionLabel: bucket.regionLabel,
            componentSize: bucket.componentSize,
            playerCount: inComponent.length,
            ratedCount: inComponent.filter((player) => !resolveVerdict(player).provisional).length,
            matchCount,
            venueCount: venues.length,
            isGiant: false,
            ...place,
            locatedVenues: located.length,
            locatedMatches: located.reduce((total, venue) => total + venue.matchCount, 0),
            topVenues: located.slice(0, 5).map((venue) => ({
              shopExternalId: venue.shopExternalId,
              latitude: venue.latitude,
              longitude: venue.longitude,
              matchCount: venue.matchCount,
            })),
            generatedAt: FIXTURE_GENERATED_AT,
          };
        })
        // Biggest first, and `isGiant` on the biggest: the engine marks the
        // largest component and the page reads that flag.
        .sort((a, b) => (b.componentSize ?? 0) - (a.componentSize ?? 0))
        .map((entry, index) => ({ ...entry, isGiant: index === 0 }));
    },

    /**
     * One scene's catalogue entry, read off the same derivation the catalogue
     * uses rather than a second one.
     *
     * The catalogue is a handful of entries here, so filtering it costs
     * nothing and - more to the point - guarantees the two cannot disagree.
     * In the DynamoDB adapter these are genuinely two reads (a GetItem against
     * a Query) of one stored item; here they are two readings of one
     * computation, which is the same promise by the only means a fixture has.
     */
    async getComponent(componentId: string): Promise<SceneCatalogueEntry | null> {
      const catalogue = await store.listSceneCatalogue!();
      return catalogue.find((entry) => entry.componentId === componentId) ?? null;
    },

    /**
     * One store's item, including the scene it belongs to.
     *
     * The aggregates are tallied off the fixture's own match log rather than
     * written down beside the store, for the same reason the whole dataset is
     * generated from the log outwards: a count here that disagreed with the
     * matches the API serves would be a fixture that cannot catch the bug it
     * exists to catch.
     */
    async getVenue(shopExternalId: number): Promise<VenueCatalogueEntry | null> {
      const venue = VENUES.find((row) => Number(row.shopId) === shopExternalId);
      if (!venue) return null;

      const players = new Set<string>();
      const rated = new Set<string>();
      const events = new Set<string>();
      let halfMatches = 0;
      for (const player of data.players) {
        for (const match of data.matches[player.playerId] ?? []) {
          if (match.shopId !== venue.shopId) continue;
          halfMatches += 1;
          players.add(player.playerId);
          if (!resolveVerdict(player).provisional) rated.add(player.playerId);
          if (match.eventExternalId !== null) events.add(match.eventExternalId);
        }
      }

      return {
        shopExternalId,
        name: venue.name,
        latitude: venue.lat,
        longitude: venue.lng,
        players: players.size,
        ratedPlayers: rated.size,
        // Halved for the reason `listSceneCatalogue` halves: each match sits
        // in both players' logs, so the raw tally counts participations.
        matches: Math.round(halfMatches / 2),
        events: events.size,
        sceneId: venue.sceneId,
        sceneLabel: venue.sceneLabel,
        scenePurity: venue.scenePurity,
        generatedAt: FIXTURE_GENERATED_AT,
      };
    },

    /**
     * One scene's directory row, summed over the venues assigned to it.
     *
     * A player belongs to a scene through their **home** venue - the store
     * they played the most matches at - so scenes partition the players rather
     * than double-counting a visitor. That is the engine's own rule
     * (`scraper/src/ranking/snapshot.ts`), and getting it wrong here would
     * make the fixture's scene bigger than the fixture.
     */
    async getScene(sceneId: string): Promise<SceneDirectoryEntry | null> {
      const shops = VENUES.filter((row) => row.sceneId === sceneId);
      if (shops.length === 0) return null;
      const shopIds = new Set(shops.map((row) => row.shopId));

      let halfMatches = 0;
      const players = new Set<string>();
      const rated = new Set<string>();
      for (const player of data.players) {
        const matches = data.matches[player.playerId] ?? [];
        const perShop = new Map<string, number>();
        for (const match of matches) {
          if (match.shopId === null) continue;
          perShop.set(match.shopId, (perShop.get(match.shopId) ?? 0) + 1);
          if (shopIds.has(match.shopId)) halfMatches += 1;
        }
        // Home venue: most matches, ties on the shop id, exactly as the engine
        // breaks them, so the choice cannot depend on iteration order.
        let home: string | null = null;
        let best = -1;
        for (const [shopId, count] of perShop) {
          if (count > best || (count === best && home !== null && shopId < home)) {
            home = shopId;
            best = count;
          }
        }
        if (home === null || !shopIds.has(home)) continue;
        players.add(player.playerId);
        if (!resolveVerdict(player).provisional) rated.add(player.playerId);
      }

      const purities = shops
        .map((row) => row.scenePurity)
        .filter((purity): purity is number => purity !== null)
        .sort((a, b) => a - b);

      return {
        sceneId,
        label: shops[0].sceneLabel,
        venueCount: shops.length,
        playerCount: players.size,
        ratedCount: rated.size,
        matchCount: Math.round(halfMatches / 2),
        medianPurity: purities.length === 0 ? null : purities[purities.length >> 1],
        assignedAt: FIXTURE_GENERATED_AT,
      };
    },

    async listComponents() {
      const out = new Map<string, { regionLabel: string | null; componentSize: number | null; ratedPlayers: number; totalPlayers: number }>();
      for (const player of data.players) {
        if (!player.componentId) continue;
        const existing = out.get(player.componentId) ?? {
          regionLabel: player.regionLabel,
          componentSize: player.componentSize,
          ratedPlayers: 0,
          totalPlayers: 0,
        };
        existing.totalPlayers += 1;
        if (!resolveVerdict(player).provisional) existing.ratedPlayers += 1;
        out.set(player.componentId, existing);
      }
      return out;
    },
  };

  return store;
}

export const fixtureRankingStore = createFixtureRankingStore();
