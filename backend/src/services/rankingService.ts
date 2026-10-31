import { env } from '../config/env.js';
import { useDynamoDB } from '../config/database.js';
import { dynamoRankingStore } from '../adapters/rankingDynamoAdapter.js';
import { fixtureRankingStore } from '../adapters/rankingFixtureAdapter.js';
import type {
  LeaderboardRecord,
  PlayerRecord,
  RankingStore,
  SceneBoardRead,
  SceneCoverageCounts,
  SetRatingRecord,
} from '../adapters/rankingStore.js';
import {
  resolveVerdict,
  earnsPosition,
  isComparable,
  poolScope,
  publishesRating,
  CONFIDENCE,
  SCENE_BOARD_MAX_ROWS,
  SCENE_CENTROID_MAX_KM,
  type ComponentSummary,
  type LeaderboardEntry,
  type SceneBoardInfo,
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
  /**
   * The scene header, on a `scene:<id>` scope only, and null on every other.
   *
   * It travels beside `component` rather than instead of it, because the two
   * are the pair this section has always had to state as two facts: *this is
   * the Peninsula scene*, and *these players' ratings are on one scale with
   * these others'*. The difference from before is only which of them the link
   * lands on.
   */
  scene: SceneBoardInfo | null;
  components: ComponentSummary[];
  pagination: { limit: number; cursor: string | null; hasMore: boolean };
}

/** One leaderboard row with its rating still on it; see `rowMerger`. */
type MergedRow = ReturnType<Awaited<ReturnType<typeof rowMerger>>>;

/**
 * Fill the gaps in a batch of leaderboard rows from the players' profiles, and
 * hand back the function that reads one.
 *
 * Shared by the board paths - the stored-scope one and the scene filter - so
 * the two can never disagree about what a row carries or which verdict applies
 * to it. One `getPlayers` for the whole batch, as before.
 *
 * The returned rows keep their ratings: ordering, ranks and coverage are worked
 * out over them and the withheld numbers are stripped afterwards in `publish`.
 * The sequence is the point - a rank or an average that came out differently
 * because a number was withheld would be a different answer rather than a
 * safer one.
 */
async function rowMerger(store: RankingStore, scope: Scope, records: LeaderboardRecord[]) {
  // The contract does not pin down what a leaderboard row carries, so fill any
  // gap from the player's PROFILE rather than reporting a null we can avoid.
  // `uncertainty == null` is in here deliberately: the margin is now what makes
  // a rating publishable, so a row that arrives without one would lose its
  // number rather than merely lose a detail. Fill it from the profile first.
  const needsHydration = records
    .filter(
      (entry) =>
        entry.displayName == null ||
        entry.rating === undefined ||
        entry.uncertainty == null ||
        entry.componentId == null
    )
    .map((entry) => entry.playerId);
  const profiles =
    needsHydration.length > 0 ? await store.getPlayers(needsHydration) : new Map<string, PlayerRecord>();

  return (entry: LeaderboardRecord) => {
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
      // The row's own scene, else the profile's. Both are written by the
      // engine off the player's *home* store, so they are the same fact read
      // from two items rather than two facts.
      sceneId: entry.sceneId ?? profile?.sceneId ?? null,
      sceneLabel: entry.sceneLabel ?? profile?.sceneLabel ?? null,
      // The engine's own rank on the board this row came off. Carried through
      // untouched and published as `poolRank` on a scene board only; `rank` is
      // always re-derived here, never read from this.
      storedRank: entry.rank ?? null,
      ...verdict,
    };
  };
}

/**
 * Positions, densely, over the rows that earn one.
 *
 * Shared by both paths so "dense over `earnsPosition`" has exactly one
 * implementation. On a stored scope the population is the coverage sample; on
 * a scene scope it is the scene's own rows, which is what makes a scene board's
 * `#1` mean "first here" rather than "the highest-placed of the pool's rows we
 * kept".
 */
/**
 * The row as published: the rating travels with its margin, and the rank is
 * the thing a provisional player does not get.
 *
 * Note what has *already* happened before this step and does not depend on it:
 * the rated count, the placings and every coverage figure are computed over
 * rows with their ratings intact. The sequence is the point - a rank or an
 * average that came out differently because of a display rule would be a
 * different answer rather than a safer one.
 */
function publishRow(
  entry: MergedRow,
  rankByPlayer: Map<string, number>,
  options: { poolRank: boolean }
): LeaderboardEntry {
  const { storedRank, ...rest } = entry;
  const rank = rankByPlayer.get(entry.playerId) ?? null;
  return {
    ...rest,
    rating: publishableRating(entry.rating, entry.gamesPlayed, entry.uncertainty),
    rank,
    // Only on a scene board, and only for a row that holds a position: the
    // pool's own number, exactly as the engine wrote it on the row. A row with
    // no position in the scene has none in the pool either - the gate is the
    // pool's `componentSize` in both cases - so publishing one here would be a
    // placement this API has just declined to give.
    poolRank: options.poolRank && rank !== null ? storedRank : null,
    sceneComparable: isComparable(entry.componentSize),
  };
}

function densePositions(rows: MergedRow[]): Map<string, number> {
  const placed = rows
    .filter((entry) => earnsPosition(entry))
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const rankByPlayer = new Map<string, number>();
  placed.forEach((entry, index) => rankByPlayer.set(entry.playerId, index + 1));
  return rankByPlayer;
}

export async function getRankings(scope: Scope, limit: number, cursor?: string): Promise<RankingResult> {
  // A scene is a filter over one pool's board, not a stored partition, so it
  // takes a different read. Branched here rather than inside the read, because
  // what differs is the whole shape: no cursor on the way in, no `Limit` at
  // all, and the ranks mean something else when it comes back.
  if (scope.sceneId !== null) {
    return getSceneRankings(scope, scope.sceneId, limit, cursor);
  }

  const store = getRankingStore();

  const [page, sample] = await Promise.all([
    store.getLeaderboard(scope, limit, cursor),
    store.getLeaderboard(scope, COVERAGE_LIMIT),
  ]);

  const merge = await rowMerger(store, scope, [...page.items, ...sample.items]);

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
  const rankByPlayer = densePositions(sampleEntries);

  const entries: LeaderboardEntry[] = page.items
    .map(merge)
    // `poolRank` is a scene-board field: on a stored scope `rank` already *is*
    // the board's own position, so a second column saying the same number
    // would be furniture.
    .map((entry) => publishRow(entry, rankByPlayer, { poolRank: false }));

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
    scene: null,
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
// The scene board
// ---------------------------------------------------------------------------

/**
 * One scene's ladder: the scene's rows out of one pool's board, re-ranked
 * among themselves.
 *
 * ## The bug this answers
 *
 * *"when i click peninsula in the map i expect it to go to that scene but its
 * on like northw est community ..."* - and that was exactly what the code did.
 * A scene's pin linked to `component:<the pool those players sit in>`, and a
 * pool's `regionLabel` is the modal city name of a reachability closure, so a
 * San Francisco scene opened a board headed `North West Community Development
 * Council` - a Singapore CDC label. Each half was honest; the pair was not a
 * product behaviour anybody could defend.
 *
 * ## Why a filter and not a fit
 *
 * Nothing is re-fitted and nothing is redefined. `componentId` keeps its
 * meaning permanently, `crossComponentUncertainty` is still claimed only for a
 * connected component, and the engine writes no `RANKING#scene:<id>` item. The
 * storage contract is what makes this available: every ladder row already
 * carries `sceneId`, "denormalised so a board can be filtered without profile
 * fetches". So the scene's rows come out of its pool's board, and because a
 * scene's players are a **subset of one component**, they were already on one
 * scale before the filter - which is the statistical difference between this
 * and the cross-component board the ladder declines to call a placement.
 *
 * ## What it costs, per request
 *
 * One `GetItem` on `SCENE#<sceneId>` (~1 read unit) to learn the pool, then the
 * pool's board **in full**, because a scene board cannot be served by a
 * `Limit`ed, filtered Query - `Limit` caps items examined before a filter, so
 * on a rank-ordered board it would return the scene's best players and call it
 * the scene. See `RankingStore.getSceneBoard`.
 *
 * Derived from the two measured figures the repo already holds (6,117 rated
 * rows on the live global board, 97.4% of them in the giant component; ~305
 * bytes an item from the 46-read-unit measurement on the 1,235-item
 * `COMPONENT#` catalogue), that is ~2MB over 2-3 Query pages and **~250
 * eventually-consistent read units** - against ~46 for the whole scene map and
 * ~2 for a 25-row page of a stored board. The engine writes at most
 * `RANKING_MAX_COMPONENT_LADDERS` (50) component boards, so for most of the
 * 1,235 pools there is no component partition and the read falls back to the
 * set-wide one, which is why that figure is ~6,000 rows either way rather than
 * the pool's own size. `SCENE_BOARD_MAX_ROWS` bounds it; `cacheRanking` (one
 * hour at the edge against a daily refit) is what keeps it to roughly one
 * origin read per scene per hour.
 *
 * Note the one place this is dearer than the rest of the API: **page two of a
 * scene board costs the same pool read as page one**, because the filtered list
 * is held in memory for the length of one request and a cursor is an offset
 * into it. It is left that way rather than papered over, because the alternative
 * is `Limit` + filter and that is the correctness bug above. In practice it
 * almost never happens - a scene's rated population is tens of players against
 * a page size of 25.
 *
 * ## What was declined
 *
 * A stored `RANKING#scene:<id>` board in the engine would make this ~2 read
 * units. It costs, per refit: one row per rated player per scene, plus one
 * `RANKING_META#` header per scene. Scenes partition players by home store, so
 * that is ~6,100 rows and ~1,123 headers - about **7,200 extra writes on a
 * refit that already writes ~27,000 profiles and ~17,000 rating points**, i.e.
 * ~15% more write traffic, and it would need a scraper change plus a refit
 * before a single scene board existed. The storage contract already says this
 * is the API's call to make ("whether scenes deserve ladders of their own is a
 * decision to take with the API rather than by writing them"), and at this read
 * volume behind an hour of edge cache the filter is the cheaper of the two. If
 * `SCENE_BOARD_MAX_ROWS` ever binds, that is the trade to revisit - not a
 * bigger cap.
 */
async function getSceneRankings(
  scope: Scope,
  sceneId: string,
  limit: number,
  cursor?: string
): Promise<RankingResult> {
  const store = getRankingStore();

  // Read before anything else, because it names the pool everything else
  // depends on. A store with no scene reader at all, or an engine that has not
  // refitted since the assignment was accepted, reports `known: false` - not a
  // 404, on the same grounds as "Never seen is not absent": that is also the
  // state of every scene id for up to `RANKING_REFIT_INTERVAL_HOURS` after a
  // deploy, and a shared `?scene=` link must not die for a deploy order.
  const scene = store.getScene ? await store.getScene(sceneId).catch(() => null) : null;
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

  const poolComponentId = scene?.componentId ?? null;
  const componentCount = scene?.componentCount ?? 0;
  const comparable = poolComponentId !== null && isComparable(scene?.componentSize ?? null);

  // Three reasons there is no board to read, and all three are normal states
  // rather than errors: the engine has no item for this scene, the store
  // cannot filter a board, or nobody who plays in the scene has been replayed
  // so there is no pool to filter.
  let read: SceneBoardRead | null = null;
  if (scene !== null && poolComponentId !== null && store.getSceneBoard) {
    const preferred = poolScope(scope, poolComponentId);
    read = await store.getSceneBoard(preferred, sceneId, poolComponentId, SCENE_BOARD_MAX_ROWS);
    // The engine publishes a component ladder only for the largest 50 pools of
    // at least `minComponentSize`, so for most pools `RANKING#component:<id>`
    // simply does not exist - and an empty partition is told from an empty
    // *scene* by whether anything was read at all, not by the row count. The
    // set-wide board always exists and carries every component, which is why
    // `getSceneBoard` filters on the pool as well as on the scene.
    if (read.poolRowsRead === 0 && preferred.componentId !== null) {
      read = await store.getSceneBoard(
        poolScope(scope, null),
        sceneId,
        poolComponentId,
        SCENE_BOARD_MAX_ROWS
      );
    }
  }

  const records = read?.items ?? [];
  const merge = await rowMerger(store, scope, records);
  const rows = records.map(merge);

  // "Rated" is a statement about evidence, so it is counted before any
  // comparability or display rule is applied - exactly as on a stored board.
  const rated = rows.filter((entry) => !entry.provisional && entry.rating !== null);

  /**
   * **A scene board's positions are a dense re-rank inside the scene**, 1..N
   * over its own rows that earn one - not the pool's ranks with the other
   * scenes' rows cut out, which would open on `#37` and climb in gaps.
   *
   * It is the right answer and it is also the only sound one. The restriction
   * is order-preserving: the scene's rows are a subset of one component, sorted
   * on the same posterior mean the pool board sorts on, so the scene's order
   * can never contradict the pool's about who is ahead of whom. `poolRank`
   * travels beside it so a reader can see both numbers and check one against
   * the other.
   *
   * **The gate is unchanged, and it still measures the component.**
   * `earnsPosition` tests `isComparable(componentSize)`, and
   * `CONFIDENCE.minComponentSize` is a threshold on the pool - so a 3-store
   * scene inside a 2,000-player pool gets positions and a 40-player scene whose
   * pool is 6 gets none. Re-pointing that threshold at the scene's own
   * `playerCount` would be a different claim about identifiability, measured
   * from nothing, and it is not made here.
   */
  const rankByPlayer = densePositions(rows);

  const published = rows.map((entry) => publishRow(entry, rankByPlayer, { poolRank: true }));
  const start = decodeOffset(cursor);
  const slice = published.slice(start, start + limit);
  const nextOffset = start + limit;

  const totalPlayers = scene?.playerCount ?? rows.length;
  const totalGames = rows.reduce<number | null>(
    (sum, entry) => (entry.gamesPlayed === null ? sum : (sum ?? 0) + entry.gamesPlayed),
    null
  );

  const poolInfo = poolComponentId !== null ? componentMap.get(poolComponentId) : undefined;
  const poolSize = scene?.componentSize ?? poolInfo?.componentSize ?? null;

  return {
    scope,
    entries: slice,
    coverage: {
      // The scene's **own** population, off its `SCENE#` item: players whose
      // home store is in it, rated or not. The board itself cannot say this -
      // the engine writes a row only for a rated player - and it is the figure
      // the event page's scene line already prints, so the two agree.
      totalPlayers,
      ratedPlayers: rated.length,
      provisionalPlayers: Math.max(0, totalPlayers - rated.length),
      totalGames,
      minGamesForRating: CONFIDENCE.minGames,
      minGamesToPublishRating: minGamesToPublish(),
      maxUncertaintyForRating: CONFIDENCE.maxUncertainty,
      // The pool's threshold, published unchanged: it is what gated these rows
      // and a page quoting it is quoting the right number.
      minComponentSize: CONFIDENCE.minComponentSize,
      lastUpdated: read?.updatedAt ?? scene?.generatedAt ?? null,
      // Two different incompletenesses, reported as one verdict because a page
      // can only say "these counts are a floor" once: the pool's board was cut
      // short by the cap, or there is no scene item to count against.
      coverageComplete: scene !== null && (read?.complete ?? true),
    },
    scene: {
      sceneId,
      label: scene?.label ?? null,
      known: scene !== null,
      playerCount: scene?.playerCount ?? null,
      ratedPlayers: scene?.ratedCount ?? null,
      venueCount: scene?.venueCount ?? null,
      componentId: poolComponentId,
      componentSize: poolSize,
      componentCount,
      // A scene whose players sit in one pool is the normal case and the one
      // this board is complete for. `componentCount` of 0 is an engine that
      // does not publish the figure, which is not evidence of a split.
      singlePool: componentCount <= 1,
      omittedPoolRows: read?.omittedPoolRows ?? 0,
      comparable,
      poolScope: read?.poolScope ?? null,
      poolRowsRead: read?.poolRowsRead ?? 0,
      poolComplete: read?.complete ?? true,
    },
    // The pool, carried beside the scene rather than instead of it. This is
    // what keeps the component board reachable - it is still the honest answer
    // to "who else is on this scale" - without being the thing a scene link
    // lands on.
    component:
      poolComponentId !== null
        ? {
            componentId: poolComponentId,
            componentSize: poolSize,
            regionLabel: poolInfo?.regionLabel ?? rows[0]?.regionLabel ?? null,
            comparable,
          }
        : null,
    components,
    pagination: {
      limit,
      // An offset rather than a storage cursor, because the filtered list only
      // exists for the length of this request. See the cost note above: the
      // next page re-reads the pool, which is the one place in this API where
      // a cursor is not cheaper than the first page.
      cursor: nextOffset < published.length ? encodeOffset(nextOffset) : null,
      hasMore: nextOffset < published.length,
    },
  };
}

function encodeOffset(offset: number): string {
  return Buffer.from(`i:${offset}`, 'utf8').toString('base64url');
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const match = /^i:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// The scene map
// ---------------------------------------------------------------------------

/**
 * Every scene, with a place where one could be derived.
 *
 * **It reads `SCENE#`, not `COMPONENT#`, and that is the whole point of this
 * endpoint.** It used to serve the component catalogue, and a component is a
 * reachability closure of the co-play graph: one travelling player welds two
 * cities into one permanently and no amount of coverage separates them again.
 * The measured consequence was a map whose list read `Karlsruhe, Deutschland`
 * and `Paris, France` while `Peninsula`, `South Bay` and the rest of the names
 * a reader was actually looking for were not selectable anywhere on it - and a
 * `?scene=<sceneId>` link, the kind the event page hands out, resolved to
 * nothing because the ids were from a different partition. A scene is a cluster
 * of **stores**, capped at 30km across, named the way a local names it.
 *
 * **One Query.** The engine's `SCENE#<sceneId>` items carry GSI1 keys so the
 * whole directory reads as a single Query against one partition - 1,123 scenes
 * on the live assignment, the same order as the 1,235 components this replaced
 * and therefore the same cost. Plus **one GetItem** on the scope directory, for
 * the figure a list of scenes structurally cannot carry: how much is in no
 * scene at all. Still no scan, no profile fetches and no leaderboard pages.
 *
 * The place is read, never derived here, for the same reason as before: a
 * scene's coordinates live on the per-player `MATCH#` items and there is no
 * index from a scene to its matches, so locating them at request time would be
 * a walk of the derived data. The engine does it during its replay with
 * `scenePlace`, which takes venue tallies and knows nothing about which
 * partition produced them - so the derivation moved from components to scenes
 * without a line of arithmetic changing.
 *
 * **A scene is not a rating scale, and this endpoint says so in its field
 * names.** `componentId` keeps its meaning permanently: it answers "are these
 * two ratings on one scale", and `crossComponentUncertainty` is only correct
 * for a connected component. A scene's pin links at `scene:<id>` now, which is
 * this pool's board *filtered* to the scene and re-ranked - a filter, not a
 * fit, so nothing here was redefined to allow it (see `getSceneRankings`). The
 * entry still carries the **pool** its home players sit on as `componentId` /
 * `componentSize` / `componentCount`, and `comparable` is a statement about
 * that pool's board rather than about the scene. A caller presents them as two
 * facts, never as one.
 *
 * **Nothing is placed at a guessed point.** A scene is located only if its own
 * venues carried coordinates, and the two fallbacks that would fill the map in
 * are both refused:
 *
 * - *the scene's label's city.* The label is a modal city name, so
 *   forward-geocoding it would put the scene at a city centre and present that
 *   with the same authority as a venue-weighted centroid - a different and
 *   weaker precision claim wearing the same clothes. It would also be a Mapbox
 *   call per unlocated scene.
 * - *`0, 0`.* A coordinate is only ever read as a pair (see the adapter), so a
 *   half-written item reports unlocated rather than landing in the Gulf of
 *   Guinea.
 *
 * So the answer separates the two populations rather than mixing them: the map
 * draws `scenes`, the page accounts for `unlocated`, and `coverage` carries the
 * ratios - including the venues and players in no scene - so a reader is told
 * why there are fewer pins than stores.
 */
export async function getSceneMap(): Promise<SceneMapResult> {
  const store = getRankingStore();

  // A store with no directory reader at all is "cannot tell", not "nothing is
  // located". Same rule as the catalogue reader it replaced.
  if (!store.listSceneDirectory) {
    return { scenes: [], unlocated: [], coverage: emptySceneCoverage(true) };
  }

  const [catalogue, counts] = await Promise.all([
    store.listSceneDirectory(),
    store.getSceneCoverage ? store.getSceneCoverage().catch(() => null) : Promise.resolve(null),
  ]);

  // An empty directory is "no scene is assigned yet", which is the normal state
  // until an operator accepts a re-clustering *and* a refit runs after it - but
  // it is indistinguishable here from a reader that failed, so it is reported
  // the same careful way: as "cannot tell" rather than "there are no scenes".
  if (catalogue.length === 0) {
    return { scenes: [], unlocated: [], coverage: emptySceneCoverage(true, counts) };
  }

  const entries: SceneMapEntry[] = catalogue.map((scene) => {
    const playerCount = scene.playerCount ?? 0;
    const hasCentroid = scene.latitude !== null && scene.longitude !== null;
    // Kept, and expected never to fire on a scene: a cluster capped at 30km
    // across has its centroid within 30km of every one of its own stores, so
    // the 100km gate cannot be crossed. See SCENE_CENTROID_MAX_KM and the note
    // beside it for why it stays - the cap is a knob, and the Louvain method
    // has no geometric bound at all. A missing `nearestVenueKm` is treated as
    // near rather than far: an item written before that field existed should
    // not have its pin withdrawn by a deploy.
    const dispersed =
      hasCentroid && scene.nearestVenueKm !== null && scene.nearestVenueKm > SCENE_CENTROID_MAX_KM;
    const located = hasCentroid && !dispersed;
    return {
      sceneId: scene.sceneId,
      label: scene.label,
      playerCount,
      ratedPlayers: scene.ratedCount ?? 0,
      matchCount: scene.matchCount ?? 0,
      venueCount: scene.venueCount ?? 0,
      medianPurity: scene.medianPurity,
      // Deliberately not `isGiant` off the item: a component's `isGiant` is a
      // statistical fact about the giant component, and a scene has no such
      // thing. This is the plain reading - the scene with the most recorded
      // players - decided once below so the flag and the sort cannot disagree.
      isGiant: false,
      componentId: scene.componentId,
      componentSize: scene.componentSize,
      componentCount: scene.componentCount ?? 0,
      // The ladder's own gate, applied to the ladder's own scope. Never to
      // `playerCount`: a scene of 40 players whose pool is 6 still has no
      // orderable board, and a scene of 3 inside a 2,000-player pool does.
      comparable: scene.componentId !== null && isComparable(scene.componentSize),
      latitude: located ? scene.latitude : null,
      longitude: located ? scene.longitude : null,
      // The spread and the distance to the nearest venue travel on a dispersed
      // scene too: there they are not a detail of the pin, they are the reason
      // there is none.
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

  // Biggest first in both lists. The map does not care, but a legend, a sorted
  // side panel and a z-order all do, and sorting once here means no reader has
  // to - the same reasoning as sorting the pairings server-side.
  const bySize = (a: SceneMapEntry, b: SceneMapEntry) =>
    b.playerCount - a.playerCount || a.sceneId.localeCompare(b.sceneId);
  located.sort(bySize);
  unlocated.sort(bySize);

  // The largest scene by recorded players, flagged once over the whole
  // catalogue rather than per list, so the tag means "largest in the corpus"
  // and not "largest of the ones that happen to have a pin".
  let biggest: SceneMapEntry | null = null;
  for (const scene of entries) {
    if (biggest === null || scene.playerCount > biggest.playerCount) biggest = scene;
  }
  if (biggest !== null && biggest.playerCount > 0) biggest.isGiant = true;

  return {
    scenes: located,
    unlocated,
    coverage: {
      totalScenes: entries.length,
      locatedScenes: located.length,
      dispersedScenes: entries.filter((scene) => scene.dispersed).length,
      unassignedVenues: counts?.unassignedVenues ?? null,
      unassignedPlayers: counts?.unassignedPlayers ?? null,
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

function emptySceneCoverage(
  catalogueUnavailable: boolean,
  counts?: SceneCoverageCounts | null
) {
  return {
    totalScenes: 0,
    locatedScenes: 0,
    dispersedScenes: 0,
    // Carried even with no scenes, because this is exactly the state in which
    // it is the only number there is: before a re-clustering is accepted every
    // store is in no scene, and the page should say that rather than nothing.
    unassignedVenues: counts?.unassignedVenues ?? null,
    unassignedPlayers: counts?.unassignedPlayers ?? null,
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
