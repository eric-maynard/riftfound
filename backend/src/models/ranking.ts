import { z } from 'zod';

/**
 * Ranking / rating domain model.
 *
 * The rating engine (in the scraper) writes derived items into the same
 * DynamoDB table the calendar uses:
 *
 *   PLAYER#<uuid> / PROFILE                        - one per player
 *   PLAYER#<uuid> / RATING#<scope>#<iso-date>      - rating history points
 *   PLAYER#<uuid> / MATCH#<iso-timestamp>#<matchId> - match log
 *   RANKING#<scope>                                - leaderboard pages
 *
 * `scope` is one of: `all`, `set:<id>`, `component:<id>`, `set:<id>#component:<id>`.
 *
 * Nothing in this file writes those items - the API only reads them.
 */

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface Scope {
  /** Canonical string form, exactly as it appears in the item key. */
  raw: string;
  setId: string | null;
  componentId: string | null;
}

/** Set / component ids are opaque to us; keep them to a safe key-ish charset. */
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Parse a scope string into its parts. Returns null when the string is not a
 * shape the contract defines, so callers can answer 400 rather than query a
 * key that cannot exist.
 */
export function parseScope(input: string | undefined | null): Scope | null {
  const raw = (input ?? 'all').trim();
  if (raw === '' || raw === 'all') {
    return { raw: 'all', setId: null, componentId: null };
  }

  let setId: string | null = null;
  let componentId: string | null = null;

  for (const part of raw.split('#')) {
    const [kind, ...rest] = part.split(':');
    const value = rest.join(':');
    if (!SCOPE_ID.test(value)) return null;
    if (kind === 'set' && setId === null) setId = value;
    else if (kind === 'component' && componentId === null) componentId = value;
    else return null;
  }

  if (setId === null && componentId === null) return null;

  // Rebuild rather than trusting the input's ordering: `set:` always first,
  // so one logical scope only ever has one key.
  const canonical = [
    setId !== null ? `set:${setId}` : null,
    componentId !== null ? `component:${componentId}` : null,
  ].filter(Boolean).join('#');

  return { raw: canonical, setId, componentId };
}

/** The scope used for a player's rating history when none is given. */
export const DEFAULT_SCOPE: Scope = { raw: 'all', setId: null, componentId: null };

// ---------------------------------------------------------------------------
// Confidence: when is a rating fit to show?
// ---------------------------------------------------------------------------

/**
 * These thresholds are ours, not the engine's - the contract carries
 * `gamesPlayed` and `uncertainty` but no "is this rating publishable" flag, so
 * the API derives one and says why. At launch (Radiance shipped 2026-10-23,
 * the backfill reaches ~21 days) almost every player sits below them, and that
 * is the honest answer rather than a defect.
 */
export const CONFIDENCE = {
  /** Fewer games than this and the rating is noise, whatever its sigma. */
  minGames: 8,
  /** A sigma this wide spans most of the ladder; the number says nothing. */
  maxUncertainty: 120,
  /**
   * Ratings are only comparable inside a connected component of the co-play
   * graph. A component this small has not mixed enough to order anyone.
   */
  minComponentSize: 8,
} as const;

export type ProvisionalReason = 'too-few-games' | 'uncertainty-too-wide' | 'no-rating';

export interface ConfidenceVerdict {
  provisional: boolean;
  /** Why the rating is withheld; null when it is fit to show. */
  provisionalReason: ProvisionalReason | null;
  /** How many more games until this player clears the games gate. */
  gamesUntilRated: number;
}

export function assessConfidence(input: {
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
}): ConfidenceVerdict {
  const games = input.gamesPlayed ?? 0;
  const gamesUntilRated = Math.max(0, CONFIDENCE.minGames - games);

  if (input.rating === null || input.rating === undefined) {
    return { provisional: true, provisionalReason: 'no-rating', gamesUntilRated };
  }
  if (games < CONFIDENCE.minGames) {
    return { provisional: true, provisionalReason: 'too-few-games', gamesUntilRated };
  }
  if (input.uncertainty !== null && input.uncertainty > CONFIDENCE.maxUncertainty) {
    return { provisional: true, provisionalReason: 'uncertainty-too-wide', gamesUntilRated };
  }
  return { provisional: false, provisionalReason: null, gamesUntilRated: 0 };
}

/**
 * A rating is only meaningful against the players it was earned among. A
 * component below `minComponentSize` is reported as not comparable so the UI
 * never presents it as a ladder.
 */
export function isComparable(componentSize: number | null | undefined): boolean {
  return (componentSize ?? 0) >= CONFIDENCE.minComponentSize;
}

// ---------------------------------------------------------------------------
// Shapes returned to the client
// ---------------------------------------------------------------------------

export interface PlayerIdentity {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
}

export interface ComponentInfo {
  componentId: string | null;
  componentSize: number | null;
  regionLabel: string | null;
  /** Derived: componentSize is large enough for the ordering to mean something. */
  comparable: boolean;
}

export interface SetRating {
  setId: string;
  setName: string | null;
  /** null when the set has no published release date (true of sets 1-3). */
  releaseDate: string | null;
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
}

export interface PlayerProfile extends PlayerIdentity, ComponentInfo {
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  gamesUntilRated: number;
  setRatings: SetRating[];
}

export interface LeaderboardEntry extends PlayerIdentity {
  /** Dense rank among rated players only; null for a provisional player. */
  rank: number | null;
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
  /** Players present in this scope, rated or not. */
  totalPlayers: number;
  ratedPlayers: number;
  provisionalPlayers: number;
  /** Games recorded across the players in this scope, when known. */
  totalGames: number | null;
  minGamesForRating: number;
  maxUncertaintyForRating: number;
  minComponentSize: number;
  lastUpdated: string | null;
}

export interface ComponentSummary {
  componentId: string;
  regionLabel: string | null;
  componentSize: number | null;
  ratedPlayers: number;
  comparable: boolean;
}

export type GameOutcome = 'win' | 'loss' | 'draw' | 'unknown';
export type MatchOutcome = GameOutcome;

export interface MatchGame {
  gameNumber: number;
  outcome: GameOutcome;
}

export interface PlayerMatch {
  matchId: string;
  /** Timestamp from the item's sort key - when the match was played. */
  playedAt: string;
  opponentId: string | null;
  opponentDisplayName: string | null;
  outcome: MatchOutcome;
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

export interface RatingPoint {
  date: string;
  rating: number;
  uncertainty: number | null;
  gamesPlayed: number | null;
}

export interface SetInfo {
  setId: string;
  name: string | null;
  /** null when no release date has been published for the set. */
  releaseDate: string | null;
  endDate: string | null;
  /** The rating engine has written at least one item under `set:<id>`. */
  hasRatingData: boolean;
}

// ---------------------------------------------------------------------------
// Query schemas (same Zod-validated pattern as EventQuerySchema)
// ---------------------------------------------------------------------------

const MAX_PAGE_LIMIT = 100;

const limitParam = (fallback: string) =>
  z
    .string()
    .transform(Number)
    .refine((n) => Number.isFinite(n) && n >= 1 && n <= MAX_PAGE_LIMIT, {
      message: `limit must be between 1 and ${MAX_PAGE_LIMIT}`,
    })
    .default(fallback);

/** Opaque, URL-safe pagination cursor. */
const cursorParam = z
  .string()
  .max(2048)
  .regex(/^[A-Za-z0-9+/=_.:#|-]*$/, 'malformed cursor')
  .optional();

const scopeParam = z.string().max(160).optional();

export const RankingQuerySchema = z.object({
  scope: scopeParam,
  limit: limitParam('25'),
  cursor: cursorParam,
});
export type RankingQuery = z.infer<typeof RankingQuerySchema>;

export const PlayerMatchesQuerySchema = z.object({
  limit: limitParam('25'),
  cursor: cursorParam,
  /** Optional: only matches from this set. */
  setId: z.string().max(64).optional(),
});
export type PlayerMatchesQuery = z.infer<typeof PlayerMatchesQuerySchema>;

export const PlayerRatingsQuerySchema = z.object({
  scope: scopeParam,
  limit: limitParam('100'),
});
export type PlayerRatingsQuery = z.infer<typeof PlayerRatingsQuerySchema>;

export const PlayerSearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'q must be at least 2 characters').max(64),
  limit: limitParam('10'),
});
export type PlayerSearchQuery = z.infer<typeof PlayerSearchQuerySchema>;

/**
 * Player ids are Riot uuids in production. Accept the uuid shape plus the
 * fixture ids used in dev, but nothing that could escape a DynamoDB key.
 */
export const PLAYER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidPlayerId(id: string | undefined): boolean {
  return typeof id === 'string' && PLAYER_ID.test(id);
}
