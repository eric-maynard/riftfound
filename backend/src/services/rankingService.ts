import { env } from '../config/env.js';
import { useDynamoDB } from '../config/database.js';
import { dynamoRankingStore } from '../adapters/rankingDynamoAdapter.js';
import { fixtureRankingStore } from '../adapters/rankingFixtureAdapter.js';
import type { PlayerRecord, RankingStore } from '../adapters/rankingStore.js';
import {
  assessConfidence,
  isComparable,
  CONFIDENCE,
  type ComponentSummary,
  type LeaderboardEntry,
  type PlayerMatch,
  type PlayerProfile,
  type RankingCoverage,
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

  const merge = (entry: (typeof page.items)[number]) => {
    const profile = profiles.get(entry.playerId);
    const setRating = scope.setId
      ? profile?.setRatings.find((candidate) => candidate.setId === scope.setId)
      : undefined;
    const rating = entry.rating ?? setRating?.rating ?? (scope.setId ? null : profile?.rating ?? null);
    const uncertainty = entry.uncertainty ?? setRating?.uncertainty ?? (scope.setId ? null : profile?.uncertainty ?? null);
    const gamesPlayed = entry.gamesPlayed ?? setRating?.gamesPlayed ?? (scope.setId ? null : profile?.gamesPlayed ?? null);
    const verdict = assessConfidence({ rating, uncertainty, gamesPlayed });
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
      rank: null as number | null,
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

  const entries: LeaderboardEntry[] = page.items.map(merge).map((entry) => ({
    ...entry,
    rank: rankByPlayer.get(entry.playerId) ?? null,
  }));

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

function toSetRating(record: { setId: string; rating: number | null; uncertainty: number | null; gamesPlayed: number | null; matchesPlayed: number | null }): SetRating {
  const verdict = assessConfidence(record);
  return {
    setId: record.setId,
    setName: setDisplayName(record.setId),
    releaseDate: setReleaseDate(record.setId),
    rating: record.rating,
    uncertainty: record.uncertainty,
    gamesPlayed: record.gamesPlayed,
    matchesPlayed: record.matchesPlayed,
    provisional: verdict.provisional,
    provisionalReason: verdict.provisionalReason,
  };
}

export async function getPlayer(playerId: string): Promise<PlayerProfile | null> {
  const record = await getRankingStore().getPlayer(playerId);
  if (!record) return null;

  const verdict = assessConfidence(record);
  return {
    playerId: record.playerId,
    displayName: record.displayName,
    tagLine: record.tagLine,
    rating: record.rating,
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
  points: RatingPoint[];
  /** The latest point's confidence verdict, so the chart can label itself. */
  provisional: boolean;
  provisionalReason: ReturnType<typeof assessConfidence>['provisionalReason'];
  minGamesForRating: number;
  maxUncertaintyForRating: number;
}

export async function getPlayerRatings(playerId: string, scope: Scope, limit: number): Promise<RatingSeries> {
  const store = getRankingStore();
  const [points, profile] = await Promise.all([
    store.getRatingHistory(playerId, scope, limit),
    store.getPlayer(playerId),
  ]);

  const last = points[points.length - 1];
  const setRating = scope.setId ? profile?.setRatings.find((entry) => entry.setId === scope.setId) : undefined;
  const verdict = assessConfidence({
    rating: last?.rating ?? setRating?.rating ?? profile?.rating ?? null,
    uncertainty: last?.uncertainty ?? setRating?.uncertainty ?? profile?.uncertainty ?? null,
    gamesPlayed: last?.gamesPlayed ?? setRating?.gamesPlayed ?? profile?.gamesPlayed ?? null,
  });

  return {
    scope,
    points,
    provisional: verdict.provisional,
    provisionalReason: verdict.provisionalReason,
    minGamesForRating: CONFIDENCE.minGames,
    maxUncertaintyForRating: CONFIDENCE.maxUncertainty,
  };
}

export interface PlayerSearchHit {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  rating: number | null;
  gamesPlayed: number | null;
  regionLabel: string | null;
  provisional: boolean;
}

export async function searchPlayers(query: string, limit: number): Promise<PlayerSearchHit[]> {
  const records = await getRankingStore().searchPlayers(query, limit);
  return records.map((record) => ({
    playerId: record.playerId,
    displayName: record.displayName,
    tagLine: record.tagLine,
    rating: record.rating,
    gamesPlayed: record.gamesPlayed,
    regionLabel: record.regionLabel,
    provisional: assessConfidence(record).provisional,
  }));
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
