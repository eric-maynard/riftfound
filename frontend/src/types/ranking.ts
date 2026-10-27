/**
 * Mirrors the ranking API's responses (see backend/src/models/ranking.ts).
 *
 * `provisional` / `provisionalReason` / `comparable` are derived by the API
 * from the contract's `gamesPlayed`, `uncertainty` and `componentSize`: the
 * rating engine stores no "publishable" flag, so the API works one out and
 * says why. The UI never shows a rating without showing that verdict.
 */

export type ProvisionalReason = 'too-few-games' | 'uncertainty-too-wide' | 'no-rating';

export type Scope = {
  raw: string;
  setId: string | null;
  componentId: string | null;
};

export interface SetRating {
  setId: string;
  setName: string | null;
  /** null when no release date has been published for the set (sets 1-3). */
  releaseDate: string | null;
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  /** This set's own figure - not the all-time one, which can differ. */
  gamesUntilRated: number;
}

export interface PlayerProfile {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  componentId: string | null;
  componentSize: number | null;
  regionLabel: string | null;
  comparable: boolean;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  gamesUntilRated: number;
  setRatings: SetRating[];
}

export interface LeaderboardEntry {
  rank: number | null;
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  componentId: string | null;
  componentSize: number | null;
  regionLabel: string | null;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  gamesUntilRated: number;
}

export interface RankingCoverage {
  totalPlayers: number;
  ratedPlayers: number;
  provisionalPlayers: number;
  totalGames: number | null;
  minGamesForRating: number;
  maxUncertaintyForRating: number;
  minComponentSize: number;
  lastUpdated: string | null;
  coverageComplete: boolean;
}

export interface ComponentSummary {
  componentId: string;
  regionLabel: string | null;
  componentSize: number | null;
  ratedPlayers: number;
  comparable: boolean;
}

export interface RankingsResponse {
  data: {
    scope: Scope;
    entries: LeaderboardEntry[];
    coverage: RankingCoverage;
    component: {
      componentId: string | null;
      componentSize: number | null;
      regionLabel: string | null;
      comparable: boolean;
    } | null;
    components: ComponentSummary[];
  };
  pagination: { limit: number; cursor: string | null; hasMore: boolean };
}

export type GameOutcome = 'win' | 'loss' | 'draw' | 'unknown';

export interface MatchGame {
  gameNumber: number;
  outcome: GameOutcome;
}

export interface PlayerMatch {
  matchId: string;
  playedAt: string;
  opponentId: string | null;
  opponentDisplayName: string | null;
  outcome: GameOutcome;
  games: MatchGame[];
  eventExternalId: string | null;
  eventName: string | null;
  shopId: string | null;
  latitude: number | null;
  longitude: number | null;
  eventDate: string | null;
  tournamentType: string | null;
  setId: string | null;
}

export interface PlayerMatchesResponse {
  data: PlayerMatch[];
  pagination: { limit: number; cursor: string | null; hasMore: boolean };
}

export interface RatingPoint {
  date: string;
  rating: number;
  uncertainty: number | null;
  gamesPlayed: number | null;
}

export interface RatingSeriesResponse {
  data: {
    scope: Scope;
    points: RatingPoint[];
    provisional: boolean;
    provisionalReason: ProvisionalReason | null;
    gamesUntilRated: number;
    /**
     * True when points were withheld because the rating is not published -
     * distinct from a player who simply has no history, which is identical on
     * the wire and wants different copy.
     */
    pointsWithheld: boolean;
    minGamesForRating: number;
    maxUncertaintyForRating: number;
  };
}

export interface PlayerProfileResponse {
  data: PlayerProfile;
}

export interface SetInfo {
  setId: string;
  name: string | null;
  releaseDate: string | null;
  endDate: string | null;
  hasRatingData: boolean;
}

export interface SetsResponse {
  data: SetInfo[];
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

export interface PlayerSearchResponse {
  data: PlayerSearchHit[];
}
