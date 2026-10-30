import { env } from '../config/env.js';
import { useDynamoDB } from '../config/database.js';
import { dynamoRankingStore } from '../adapters/rankingDynamoAdapter.js';
import { fixtureRankingStore } from '../adapters/rankingFixtureAdapter.js';
import type { PlayerRecord, RankingStore, SetRatingRecord } from '../adapters/rankingStore.js';
import {
  resolveVerdict,
  earnsPosition,
  isComparable,
  publishesRating,
  CONFIDENCE,
  SCENE_CENTROID_MAX_KM,
  type ComponentSummary,
  type LeaderboardEntry,
  type PlayerMatch,
  type PlayerProfile,
  type RankingCoverage,
  type ProvisionalReason,
  type RatingPoint,
  type SceneMapEntry,
  type SceneMapResult,
  type Scope,
  type SetInfo,
  type SetRating,
} from '../models/ranking.js';
import { describeSet, setDisplayName, setReleaseDate, sortSets } from '../models/sets.js';

/**
 * How many leaderboard rows the service reads to work out coverage and ranks.
 * At launch a whole scope is far smaller than this; past it the response says
 * the counts are a floor rather than a total.
 */
const COVERAGE_LIMIT = 200;

/**
 * Recorded games needed before a rating number is published. One place, read
 * from `RANKING_MIN_GAMES_TO_PUBLISH`, so the floor cannot differ between two
 * endpoints.
 */
export function minGamesToPublish(): number {
  return env.RANKING_MIN_GAMES_TO_PUBLISH;
}

/**
 * The rating as published: the number itself once there is a little evidence,
 * null below the display floor.
 *
 * **This is no longer the confidence gate, and that is the point.** Withholding
 * every provisional rating produced a column of "Unranked" that read as a
 * broken page, and it withheld the wrong thing: the honest answer to "how much
 * should I trust this?" is the number *with its margin*, not the absence of a
 * number. So `uncertainty` now carries that weight - it travels with every
 * rating and is what separates a settled figure from an unsettled one - and
 * `provisional` / `provisionalReason` / `gamesUntilRated` still say, in words,
 * that the player has no *position* yet.
 *
 * What is still withheld is a rating that is merely the prior: below the floor
 * the posterior has barely moved off 1200, so there is no information to show
 * (see `DEFAULT_MIN_GAMES_TO_PUBLISH`).
 *
 * Ranks and aggregates are unaffected - they are computed over the rated
 * players before anything here runs.
 */
export function publishableRating(
  rating: number | null | undefined,
  gamesPlayed: number | null | undefined,
  uncertainty: number | null | undefined
): number | null {
  if (rating === null || rating === undefined) return null;
  // The pairing is structural, not a convention. The decision was to publish
  // the rating *together with* its uncertainty, so a number whose margin is
  // missing is not a publishable rating - it is the bare figure the margin was
  // meant to qualify. Nothing upstream guarantees the two arrive together
  // (`rating` and `uncertainty` are separate attributes with separate fallback
  // chains), so the invariant is enforced at the one place that publishes.
  if (uncertainty === null || uncertainty === undefined || !Number.isFinite(uncertainty)) return null;
  return publishesRating(gamesPlayed, minGamesToPublish()) ? rating : null;
}

let override: RankingStore | null = null;

/** Swap the store, for tests. Pass null to go back to the configured one. */
export function setRankingStore(store: RankingStore | null): void {
  override = store;
}

export function getRankingStore(): RankingStore {
  if (override) return override;
  if (env.RANKING_SOURCE === 'fixture') return fixtureRankingStore;
  if (env.RANKING_SOURCE === 'dynamodb') return dynamoRankingStore;
  return useDynamoDB() ? dynamoRankingStore : fixtureRankingStore;
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

export interface RankingResult {
  scope: Scope;
  entries: LeaderboardEntry[];
  coverage: RankingCoverage & { coverageComplete: boolean };
  component: {
    componentId: string | null;
    componentSize: number | null;
    regionLabel: string | null;
    comparable: boolean;
  } | null;
  components: ComponentSummary[];
  pagination: { limit: number; cursor: string | null; hasMore: boolean };
}

export async function getRankings(scope: Scope, limit: number, cursor?: string): Promise<RankingResult> {
  const store = getRankingStore();

  const [page, sample] = await Promise.all([
    store.getLeaderboard(scope, limit, cursor),
    store.getLeaderboard(scope, COVERAGE_LIMIT),
  ]);

  // The contract does not pin down what a leaderboard row carries, so fill any
  // gap from the player's PROFILE rather than reporting a null we can avoid.
  // `uncertainty == null` is in here deliberately: the margin is now what makes
  // a rating publishable, so a row that arrives without one would lose its
  // number rather than merely lose a detail. Fill it from the profile first.
  const needsHydration = [...page.items, ...sample.items]
    .filter(
      (entry) =>
        entry.displayName == null ||
        entry.rating === undefined ||
        entry.uncertainty == null ||
        entry.componentId == null
    )
    .map((entry) => entry.playerId);
  const profiles = needsHydration.length > 0 ? await store.getPlayers(needsHydration) : new Map<string, PlayerRecord>();

  /**
   * One row with its rating still on it.
   *
   * Ordering, ranks and coverage are worked out over these, and the withheld
   * numbers are stripped afterwards in `publish`. The sequence is the point: a
   * rank or an average that came out differently because a number was withheld
   * would be a different answer rather than a safer one.
   */
  const merge = (entry: (typeof page.items)[number]) => {
    const profile = profiles.get(entry.playerId);
    const setRating = scope.setId
      ? profile?.setRatings.find((candidate) => candidate.setId === scope.setId)
      : undefined;
    const rating = entry.rating ?? setRating?.rating ?? (scope.setId ? null : profile?.rating ?? null);
    const uncertainty = entry.uncertainty ?? setRating?.uncertainty ?? (scope.setId ? null : profile?.uncertainty ?? null);
    const gamesPlayed = entry.gamesPlayed ?? setRating?.gamesPlayed ?? (scope.setId ? null : profile?.gamesPlayed ?? null);
    // The engine's own verdict for *this* scope: the row's, else the set entry's
    // in a set scope, else the profile's. Derived from the numbers only when
    // none of them carries one.
    const stated = entry.provisional !== undefined
      ? entry
      : scope.setId
        ? setRating ?? profile
        : profile;
    const verdict = resolveVerdict({
      rating,
      uncertainty,
      gamesPlayed,
      provisional: stated?.provisional,
      provisionalReason: stated?.provisionalReason,
      gamesUntilRated: stated?.gamesUntilRated,
    });
    return {
      playerId: entry.playerId,
      displayName: entry.displayName ?? profile?.displayName ?? null,
      tagLine: entry.tagLine ?? profile?.tagLine ?? null,
      rating,
      uncertainty,
      gamesPlayed,
      matchesPlayed: entry.matchesPlayed ?? setRating?.matchesPlayed ?? profile?.matchesPlayed ?? null,
      componentId: entry.componentId ?? profile?.componentId ?? null,
      componentSize: entry.componentSize ?? profile?.componentSize ?? null,
      regionLabel: entry.regionLabel ?? profile?.regionLabel ?? null,
      ...verdict,
    };
  };

  const sampleEntries = sample.items.map(merge);

  // Everyone whose rating is fit to publish. This is the coverage population:
  // "rated" is a statement about evidence, so it must not move because of a
  // comparability rule applied below.
  const rated = sampleEntries.filter((entry) => !entry.provisional && entry.rating !== null);

  /**
   * Positions, densely, over the rated players who earn one - on **every**
   * scope, Global included.
   *
   * Global used to come back with ranks only by accident. Nothing here gated
   * on `comparable`, so the numbers were computed; the client then dropped the
   * whole column whenever the scope mixed scenes, and the engine's own board
   * rows say to (`suppressPosition` is true on all 6,117 rows of the live
   * `RANKING#all`, because the global scope ORs a scope-wide flag into every
   * row). The decision is now taken deliberately and in one place: a weakly
   * identified order is reported with its caveat rather than withheld. See
   * `LeaderboardEntry.rank`, and `sceneComparable` for what the caveat is and
   * why it is not a number.
   *
   * The engine's per-row flag is deliberately *not* read for this. On a global
   * board it carries no per-player information at all - it is true for
   * everyone - so the per-row test is `earnsPosition`, which re-applies the
   * same measured threshold (component >= 8) to the `componentSize` the row
   * already carries. That is what keeps the promise that a player who would
   * get no position in their own scene gets none globally either: 29 of the
   * live board's 6,117 rated players sit in a scene below 8 and are placed by
   * the engine's global rank field today.
   *
   * Ranks come from the whole coverage sample, not the page, so they stay right
   * across pages.
   */
  const placed = sampleEntries
    .filter((entry) => earnsPosition(entry))
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const rankByPlayer = new Map<string, number>();
  placed.forEach((entry, index) => rankByPlayer.set(entry.playerId, index + 1));

  /**
   * The row as published: the rating travels with its margin, and the rank is
   * the thing a provisional player does not get.
   *
   * Note what has *already* happened above and does not depend on this step:
   * `rated`, `placed`, `rankByPlayer` and every count below are computed over
   * `sampleEntries` with their ratings intact. The sequence is still the point
   * - a rank or an average that came out differently because of a display rule
   * would be a different answer rather than a safer one.
   */
  const publish = (entry: ReturnType<typeof merge>): LeaderboardEntry => ({
    ...entry,
    rating: publishableRating(entry.rating, entry.gamesPlayed, entry.uncertainty),
    rank: rankByPlayer.get(entry.playerId) ?? null,
    sceneComparable: isComparable(entry.componentSize),
  });

  const entries: LeaderboardEntry[] = page.items.map(merge).map(publish);

  const ratedPlayers = rated.length;
  const totalPlayers = sample.totalPlayers ?? sampleEntries.length;
  const totalGames = sampleEntries.reduce<number | null>(
    (sum, entry) => (entry.gamesPlayed === null ? sum : (sum ?? 0) + entry.gamesPlayed),
    null
  );

  // The scope's own component info, when the scope names one.
  const scopeComponent = scope.componentId
    ? sampleEntries.find((entry) => entry.componentId === scope.componentId) ?? null
    : null;

  const componentMap = await store.listComponents();
  const components: ComponentSummary[] = [...componentMap.entries()]
    .map(([componentId, info]) => ({
      componentId,
      regionLabel: info.regionLabel,
      componentSize: info.componentSize,
      ratedPlayers: info.ratedPlayers,
      comparable: isComparable(info.componentSize),
    }))
    .sort((a, b) => (b.componentSize ?? 0) - (a.componentSize ?? 0));

  return {
    scope,
    entries,
    coverage: {
      totalPlayers,
      ratedPlayers,
      provisionalPlayers: Math.max(0, sampleEntries.length - ratedPlayers),
      totalGames,
      minGamesForRating: CONFIDENCE.minGames,
      minGamesToPublishRating: minGamesToPublish(),
      maxUncertaintyForRating: CONFIDENCE.maxUncertainty,
      minComponentSize: CONFIDENCE.minComponentSize,
      lastUpdated: page.updatedAt ?? sample.updatedAt,
      coverageComplete: sampleEntries.length < COVERAGE_LIMIT,
    },
    component: scope.componentId
      ? {
          componentId: scope.componentId,
          componentSize: scopeComponent?.componentSize ?? componentMap.get(scope.componentId)?.componentSize ?? null,
          regionLabel: scopeComponent?.regionLabel ?? componentMap.get(scope.componentId)?.regionLabel ?? null,
          comparable: isComparable(scopeComponent?.componentSize ?? componentMap.get(scope.componentId)?.componentSize ?? null),
        }
      : null,
    components,
    pagination: { limit, cursor: page.cursor, hasMore: page.cursor !== null },
  };
}

// ---------------------------------------------------------------------------
// The scene map
// ---------------------------------------------------------------------------

/**
 * Every scene, with a place where one could be derived.
 *
 * **One Query.** The engine's `COMPONENT#<id>` items carry GSI1 keys so the
 * whole catalogue reads as a single Query against one partition - 1,235 items
 * on production, no scan, no profile fetches, no leaderboard pages. That is
 * the entire cost of this endpoint, and it is why the place is published *on*
 * the catalogue item rather than assembled here: the alternative join is
 * unaffordable. Coordinates live on the per-player match items
 * (`PLAYER#<uuid>` / `MATCH#…`, which denormalise `shopId` and lat/lon), and
 * there is no index from a component to its matches - so locating 1,235 scenes
 * at request time would mean reading every match item of every player, which
 * is a table walk over ~110k event rows' worth of derived data on an
 * on-demand table. The engine already has every coordinate in hand during its
 * replay; it does the arithmetic once a day and writes the answer.
 *
 * **Nothing is placed at a guessed point.** A scene is located only if its own
 * venues carried coordinates, and the two fallbacks that would fill the map in
 * are both refused:
 *
 * - *the region label's city.* `regionLabel` is a modal city name, so
 *   forward-geocoding it would put the scene at a city centre and present that
 *   with the same authority as a venue-weighted centroid - a different and
 *   weaker precision claim wearing the same clothes. It would also be a Mapbox
 *   call per unlocated scene.
 * - *`0, 0`.* A coordinate is only ever read as a pair (see the adapter), so a
 *   half-written item reports unlocated rather than landing in the Gulf of
 *   Guinea.
 *
 * So the answer separates the two populations rather than mixing them: the map
 * draws `scenes`, the page accounts for `unlocated`, and `coverage` carries
 * the ratio so a reader is told why there are fewer pins than scenes.
 */
export async function getSceneMap(): Promise<SceneMapResult> {
  const store = getRankingStore();

  // A store with no catalogue reader at all - which is every store older than
  // the GSI1 keys on those items - is "cannot tell", not "nothing is located".
  if (!store.listSceneCatalogue) {
    return { scenes: [], unlocated: [], coverage: emptySceneCoverage(true) };
  }

  const catalogue = await store.listSceneCatalogue();
  if (catalogue.length === 0) {
    return { scenes: [], unlocated: [], coverage: emptySceneCoverage(true) };
  }

  const entries: SceneMapEntry[] = catalogue.map((scene) => {
    // `componentSize` and `playerCount` are the same number under the two
    // names the contract allows; take whichever the item carries.
    const playerCount = scene.playerCount ?? scene.componentSize ?? 0;
    const hasCentroid = scene.latitude !== null && scene.longitude !== null;
    // A centroid that sits further than this from every venue of its own
    // scene is arithmetic rather than a place - see SCENE_CENTROID_MAX_KM for
    // the measurement, and note it costs 40% of the players. A missing
    // `nearestVenueKm` is treated as near rather than far: an item written
    // before that field existed should not have its pin withdrawn by a
    // deploy.
    const dispersed =
      hasCentroid && scene.nearestVenueKm !== null && scene.nearestVenueKm > SCENE_CENTROID_MAX_KM;
    const located = hasCentroid && !dispersed;
    return {
      componentId: scene.componentId,
      regionLabel: scene.regionLabel,
      playerCount,
      ratedPlayers: scene.ratedCount ?? 0,
      matchCount: scene.matchCount ?? 0,
      venueCount: scene.venueCount ?? 0,
      isGiant: scene.isGiant,
      // The same gate as the ladder's, from the same place: a position inside
      // a scene of three is not a position. It is a property of the scene, so
      // the map can say which pins lead to an orderable board.
      comparable: isComparable(scene.componentSize ?? playerCount),
      latitude: located ? scene.latitude : null,
      longitude: located ? scene.longitude : null,
      // The spread and the distance to the nearest venue travel on a
      // dispersed scene too: there they are not a detail of the pin, they are
      // the reason there is none, and "the nearest store is 2,080 km away" is
      // what the page says instead of a coordinate.
      spreadKm: hasCentroid ? scene.spreadKm : null,
      nearestVenueKm: hasCentroid ? scene.nearestVenueKm : null,
      dispersed,
      locatedVenues: scene.locatedVenues ?? 0,
      locatedMatches: scene.locatedMatches ?? 0,
      // Kept on a dispersed scene, dropped on one with no geography at all: a
      // scene that is real and well mapped but not in one place can still be
      // shown *as its venues*, which is the honest picture of it.
      topVenues: hasCentroid ? scene.topVenues : [],
    };
  });

  const located = entries.filter((scene) => scene.latitude !== null && scene.longitude !== null);
  const unlocated = entries.filter((scene) => scene.latitude === null || scene.longitude === null);

  // Biggest first in both lists. The map does not care, but a legend, a
  // sorted side panel and a z-order all do, and sorting once here means no
  // reader has to - the same reasoning as sorting the pairings server-side.
  const bySize = (a: SceneMapEntry, b: SceneMapEntry) =>
    b.playerCount - a.playerCount || a.componentId.localeCompare(b.componentId);
  located.sort(bySize);
  unlocated.sort(bySize);

  return {
    scenes: located,
    unlocated,
    coverage: {
      totalScenes: entries.length,
      locatedScenes: located.length,
      dispersedScenes: entries.filter((scene) => scene.dispersed).length,
      locatedPlayers: located.reduce((total, scene) => total + scene.playerCount, 0),
      totalPlayers: entries.reduce((total, scene) => total + scene.playerCount, 0),
      comparableScenes: entries.filter((scene) => scene.comparable).length,
      minComponentSize: CONFIDENCE.minComponentSize,
      lastUpdated: catalogue.reduce<string | null>(
        (latest, scene) =>
          scene.generatedAt !== null && (latest === null || scene.generatedAt > latest)
            ? scene.generatedAt
            : latest,
        null
      ),
      catalogueUnavailable: false,
    },
  };
}

function emptySceneCoverage(catalogueUnavailable: boolean) {
  return {
    totalScenes: 0,
    locatedScenes: 0,
    dispersedScenes: 0,
    locatedPlayers: 0,
    totalPlayers: 0,
    comparableScenes: 0,
    minComponentSize: CONFIDENCE.minComponentSize,
    lastUpdated: null,
    catalogueUnavailable,
  };
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/**
 * One set era's entry, gated on its **own** evidence.
 *
 * A player can be rated all-time and provisional within a set, or the reverse:
 * a set slice holds fewer games, so its sigma is wider, and the engine writes a
 * separate verdict for each era. So each entry is assessed independently and
 * each withholds its own number.
 */
function toSetRating(record: SetRatingRecord): SetRating {
  const verdict = resolveVerdict(record);
  return {
    setId: record.setId,
    setName: setDisplayName(record.setId),
    releaseDate: setReleaseDate(record.setId),
    rating: publishableRating(record.rating, record.gamesPlayed, record.uncertainty),
    uncertainty: record.uncertainty,
    gamesPlayed: record.gamesPlayed,
    matchesPlayed: record.matchesPlayed,
    provisional: verdict.provisional,
    provisionalReason: verdict.provisionalReason,
    gamesUntilRated: verdict.gamesUntilRated,
  };
}

/**
 * The profile for an id the engine has never seen: everything null, the verdict
 * `no-rating`, `known: false`.
 *
 * This is why the endpoint no longer 404s. Three reasons, in order of weight:
 *
 * 1. **The API contradicted itself.** For the same player id,
 *    `/api/players/:id/matches` answers 200 with `data: []` and
 *    `/api/players/:id/ratings` answers 200 with `points: []`,
 *    `provisionalReason: 'no-rating'`, `gamesUntilRated: 8` - while
 *    `/api/players/:id` answered 404. Verified live on three ids off one
 *    upcoming event's roster. A resource whose two sub-resources exist is not
 *    absent.
 * 2. **A bookmarked link should not change meaning.** A player with no games
 *    today has a profile the moment the engine next sees them. Under the 404
 *    that URL was dead and then alive; a `no-rating` profile is the same page
 *    throughout, and it fills in.
 * 3. **Enumeration.** Anything listing a field (the tournament page's roster,
 *    15 of 22 unknown on the live event it was built against) can now point at
 *    every player uniformly instead of branching on whether a link would 404.
 *
 * What the 404 carried is not lost, it moved into `known: false` - which is
 * where the rest of this API already puts that distinction
 * (`TournamentPlayer.known`). Nothing is asserted that we do not know: the
 * body says "no rating here for this id", exactly as the sibling endpoints do,
 * and never that a player exists.
 */
function unknownProfile(playerId: string): PlayerProfile {
  const verdict = resolveVerdict({ rating: null, uncertainty: null, gamesPlayed: null });
  return {
    playerId,
    displayName: null,
    tagLine: null,
    known: false,
    rating: null,
    uncertainty: null,
    gamesPlayed: null,
    matchesPlayed: null,
    firstSeen: null,
    lastSeen: null,
    componentId: null,
    componentSize: null,
    regionLabel: null,
    comparable: isComparable(null),
    provisional: verdict.provisional,
    provisionalReason: verdict.provisionalReason,
    gamesUntilRated: verdict.gamesUntilRated,
    setRatings: [],
  };
}

export async function getPlayer(playerId: string): Promise<PlayerProfile> {
  const record = await getRankingStore().getPlayer(playerId);
  if (!record) return unknownProfile(playerId);

  const verdict = resolveVerdict(record);
  return {
    playerId: record.playerId,
    displayName: record.displayName,
    tagLine: record.tagLine,
    known: true,
    // The number with its margin, once there is a little evidence. Same rule,
    // same shape as `/api/events/:id/tournament`.
    rating: publishableRating(record.rating, record.gamesPlayed, record.uncertainty),
    uncertainty: record.uncertainty,
    gamesPlayed: record.gamesPlayed,
    matchesPlayed: record.matchesPlayed,
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
    componentId: record.componentId,
    componentSize: record.componentSize,
    regionLabel: record.regionLabel,
    comparable: isComparable(record.componentSize),
    provisional: verdict.provisional,
    provisionalReason: verdict.provisionalReason,
    gamesUntilRated: verdict.gamesUntilRated,
    setRatings: sortSets(
      record.setRatings.map((setRating) => describeSet(setRating.setId, true))
    ).map((info) => toSetRating(record.setRatings.find((entry) => entry.setId === info.setId)!)),
  };
}

export async function getPlayerMatches(
  playerId: string,
  limit: number,
  cursor?: string,
  setId?: string
): Promise<{ matches: PlayerMatch[]; cursor: string | null; hasMore: boolean }> {
  const page = await getRankingStore().getMatches(playerId, limit, cursor, setId);
  return { matches: page.items, cursor: page.cursor, hasMore: page.cursor !== null };
}

export interface RatingSeries {
  scope: Scope;
  /**
   * The series, or **empty** when the player is provisional in this scope.
   *
   * The engine writes a history point per day of play whatever the verdict
   * (`PlayerRatingPoint.rating` is always a number), so serving the history of
   * a provisional player reconstructs the withheld rating exactly - its last
   * point *is* the number. Suppressing the headline and shipping the series
   * would withhold nothing at all.
   *
   * Empty rather than points with null ratings: a series of nulls is a chart of
   * nothing, and it would also strand `date` and `gamesPlayed` rows that invite
   * the same reading. The verdict travels alongside, so the caller can say why
   * there is nothing to draw rather than guessing.
   */
  points: RatingPoint[];
  /** This scope's confidence verdict, so the chart can label itself. */
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  /** Games still needed to clear the games gate; 0 when that is not what blocks it. */
  gamesUntilRated: number;
  /**
   * True when points exist but are being withheld, as opposed to a player who
   * simply has no history yet. The two read identically on the wire otherwise,
   * and they want different copy.
   *
   * It no longer fires for a provisional player: a provisional rating is
   * published now, so there is nothing for its history to reconstruct. The only
   * thing that still withholds a series is the **display floor** - below it
   * every point is the prior and the chart would be a flat line through 1200.
   * Kept rather than removed because it is the field that tells "we have
   * history you cannot see yet" from "no history", and the floor still produces
   * the first of those.
   */
  pointsWithheld: boolean;
  minGamesForRating: number;
  maxUncertaintyForRating: number;
  /** The display floor these points are subject to. */
  minGamesToPublishRating: number;
}

export async function getPlayerRatings(playerId: string, scope: Scope, limit: number): Promise<RatingSeries> {
  const store = getRankingStore();
  const [points, profile] = await Promise.all([
    store.getRatingHistory(playerId, scope, limit),
    store.getPlayer(playerId),
  ]);

  // The verdict is the profile's (the engine's own, for this scope), with the
  // last point only as a fallback for a player with history but no profile.
  const last = points[points.length - 1];
  const setRating = scope.setId ? profile?.setRatings.find((entry) => entry.setId === scope.setId) : undefined;
  const stated = scope.setId ? setRating ?? profile : profile;
  const verdict = resolveVerdict({
    rating: stated?.rating ?? last?.rating ?? null,
    uncertainty: stated?.uncertainty ?? last?.uncertainty ?? null,
    gamesPlayed: stated?.gamesPlayed ?? last?.gamesPlayed ?? null,
    provisional: stated?.provisional,
    provisionalReason: stated?.provisionalReason,
    gamesUntilRated: stated?.gamesUntilRated,
  });

  // The series is published for a provisional player now - the headline rating
  // is, so the history reconstructs nothing that is being withheld. Only the
  // display floor still holds points back, and on the same grounds as the
  // headline: below it the curve is the prior, not a record of play.
  const games = stated?.gamesPlayed ?? last?.gamesPlayed ?? null;
  const floored = !publishesRating(games, minGamesToPublish());

  return {
    scope,
    points: floored ? [] : points,
    provisional: verdict.provisional,
    provisionalReason: verdict.provisionalReason,
    gamesUntilRated: verdict.gamesUntilRated,
    pointsWithheld: floored && points.length > 0,
    minGamesForRating: CONFIDENCE.minGames,
    maxUncertaintyForRating: CONFIDENCE.maxUncertainty,
    minGamesToPublishRating: minGamesToPublish(),
  };
}

export interface PlayerSearchHit {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  /** Publishable rating: null only below the display floor. */
  rating: number | null;
  /**
   * The margin on that rating. Carried here because `uncertainty` is now the
   * signal that separates a settled rating from an unsettled one, so a hit that
   * showed a number without it would be the one place in this API where a
   * rating arrives unqualified.
   */
  uncertainty: number | null;
  gamesPlayed: number | null;
  regionLabel: string | null;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  gamesUntilRated: number;
}

/**
 * What a search answered *over*, published beside the hits.
 *
 * The reason this exists is the bug it closes. An empty `data` used to mean
 * either "no player by that name" or "the 0.43% of players this query happened
 * to examine contained nobody by that name", and the response had no field
 * that told them apart - so the ladder page printed "No player by that name."
 * over a rated player it was simultaneously listing. Same reasoning as
 * `coverage.catalogueUnavailable` on the scene map: "we cannot tell" is not
 * "there is none", and a page cannot render the difference it is not told.
 */
export interface PlayerSearchCoverage {
  /** True when every known player was compared against the query. */
  complete: boolean;
  /** Players compared, or null when the store cannot say. */
  searchedPlayers: number | null;
  /** Matches before the cap. */
  matched: number;
  /** True when `matched` exceeded the cap, so the list is the best of more. */
  truncated: boolean;
  /** The cap in force, so a page need not hardcode it. */
  maxResults: number;
}

export interface PlayerSearchResponse {
  hits: PlayerSearchHit[];
  coverage: PlayerSearchCoverage;
}

export async function searchPlayers(
  query: string,
  limit: number
): Promise<PlayerSearchResponse> {
  const result = await getRankingStore().searchPlayers(query, limit);
  const hits = result.records.map((record) => {
    const verdict = resolveVerdict(record);
    return {
      playerId: record.playerId,
      displayName: record.displayName,
      tagLine: record.tagLine,
      rating: publishableRating(record.rating, record.gamesPlayed, record.uncertainty),
      uncertainty: record.uncertainty,
      gamesPlayed: record.gamesPlayed,
      regionLabel: record.regionLabel,
      provisional: verdict.provisional,
      provisionalReason: verdict.provisionalReason,
      gamesUntilRated: verdict.gamesUntilRated,
    };
  });

  return {
    hits,
    coverage: {
      complete: result.complete,
      searchedPlayers: result.searchedPlayers,
      matched: result.matched,
      truncated: result.matched > hits.length,
      maxResults: limit,
    },
  };
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

export async function listSets(): Promise<SetInfo[]> {
  const store = getRankingStore();

  // The engine's own SET# items are authoritative: it derives the eras, so it
  // knows their names and boundaries, and it writes an item per era including
  // ones with no play yet (a set that released days ago). Discovery below can
  // only ever see eras some player already has a rating in, so it silently
  // omits the newest set - exactly the one a reader is most likely to want.
  const catalogue = (await store.listSetCatalogue?.()) ?? [];
  if (catalogue.length > 0) {
    return sortSets(
      catalogue.map((entry) => {
        const fallback = describeSet(entry.setId, entry.hasRatingData);
        return {
          setId: entry.setId,
          name: entry.name ?? fallback.name,
          releaseDate: entry.releaseDate ?? fallback.releaseDate,
          endDate: entry.endDate ?? fallback.endDate,
          hasRatingData: entry.hasRatingData,
        };
      })
    );
  }

  // Fallback: an engine that has not written the catalogue index yet.
  const ids = await store.listSetIds();
  return sortSets(ids.map((id) => describeSet(id, true)));
}
