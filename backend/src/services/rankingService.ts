import { env } from '../config/env.js';
import { useDynamoDB } from '../config/database.js';
import { dynamoRankingStore } from '../adapters/rankingDynamoAdapter.js';
import { fixtureRankingStore } from '../adapters/rankingFixtureAdapter.js';
import type { PlayerRecord, RankingStore, SetRatingRecord } from '../adapters/rankingStore.js';
import {
  resolveVerdict,
  isComparable,
  CONFIDENCE,
  type ComponentSummary,
  type LeaderboardEntry,
  type PlayerMatch,
  type PlayerProfile,
  type RankingCoverage,
  type ProvisionalReason,
  type RatingPoint,
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
  const needsHydration = [...page.items, ...sample.items]
    .filter((entry) => entry.displayName == null || entry.rating === undefined || entry.componentId == null)
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

  // Rank densely among the players whose rating is fit to publish, so a
  // provisional player never occupies a ladder position. Ranks come from the
  // whole sample, so they stay right across pages.
  const ranked = sampleEntries
    .filter((entry) => !entry.provisional && entry.rating !== null)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const rankByPlayer = new Map<string, number>();
  ranked.forEach((entry, index) => rankByPlayer.set(entry.playerId, index + 1));

  /**
   * The gate, enforced here rather than left to the UI: a provisional player's
   * rating number does not leave this process. Everything that explains the
   * state - the margin, the game counts, how many games are still needed -
   * stays, because a width and a count are not a position.
   */
  const publish = (entry: ReturnType<typeof merge>): LeaderboardEntry => ({
    ...entry,
    rating: entry.provisional ? null : entry.rating,
    rank: rankByPlayer.get(entry.playerId) ?? null,
  });

  const entries: LeaderboardEntry[] = page.items.map(merge).map(publish);

  const ratedPlayers = ranked.length;
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
    rating: verdict.provisional ? null : record.rating,
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
    // The gate: a withheld rating is withheld, not shipped with a flag beside
    // it. Same rule, same shape as `/api/events/:id/tournament`.
    rating: verdict.provisional ? null : record.rating,
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
   */
  pointsWithheld: boolean;
  minGamesForRating: number;
  maxUncertaintyForRating: number;
}

export async function getPlayerRatings(playerId: string, scope: Scope, limit: number): Promise<RatingSeries> {
  const store = getRankingStore();
  const [points, profile] = await Promise.all([
    store.getRatingHistory(playerId, scope, limit),
    store.getPlayer(playerId),
  ]);

  // The verdict is the profile's (the engine's own, for this scope) - not one
  // re-derived from the last point, which carries no verdict and whose rating
  // is published whether or not the player cleared the bar. The last point is
  // only a fallback for a player with history but no profile.
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

  return {
    scope,
    points: verdict.provisional ? [] : points,
    provisional: verdict.provisional,
    provisionalReason: verdict.provisionalReason,
    gamesUntilRated: verdict.gamesUntilRated,
    pointsWithheld: verdict.provisional && points.length > 0,
    minGamesForRating: CONFIDENCE.minGames,
    maxUncertaintyForRating: CONFIDENCE.maxUncertainty,
  };
}

export interface PlayerSearchHit {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  /** Publishable rating: null whenever `provisional`. */
  rating: number | null;
  gamesPlayed: number | null;
  regionLabel: string | null;
  provisional: boolean;
}

export async function searchPlayers(query: string, limit: number): Promise<PlayerSearchHit[]> {
  const records = await getRankingStore().searchPlayers(query, limit);
  return records.map((record) => {
    const verdict = resolveVerdict(record);
    return {
      playerId: record.playerId,
      displayName: record.displayName,
      tagLine: record.tagLine,
      rating: verdict.provisional ? null : record.rating,
      gamesPlayed: record.gamesPlayed,
      regionLabel: record.regionLabel,
      provisional: verdict.provisional,
    };
  });
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
