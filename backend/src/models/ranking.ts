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
 * The publishing bar, as numbers this API can quote back to a caller.
 *
 * The engine now writes its own verdict onto each item and these match the
 * thresholds it used (8 / 120 / 8, measured from its posterior SD
 * distribution - see the scraper's "Publishing honestly"), so they are reported
 * in `coverage` and used by `assessConfidence` only as the fallback for an item
 * that carries no verdict. At launch (Radiance shipped 2026-10-23, the backfill
 * reaches ~21 days) almost every player sits below them, and that is the honest
 * answer rather than a defect.
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

/**
 * The verdict the rating engine writes onto its own items
 * (`scraper/src/ranking/items.ts`).
 *
 * It is the authority: the thresholds behind it are measured from the posterior
 * SD distribution the engine fitted, so re-deriving one here from `gamesPlayed`
 * and `uncertainty` can only ever agree by coincidence. Every field is optional
 * because an item written before the engine emitted them carries none of them,
 * and because the leaderboard rows carry none at all.
 *
 * Its reason vocabulary is the engine's, not ours: `too-uncertain` rather than
 * `uncertainty-too-wide`, plus `component-too-small`, which the engine reports
 * alongside a *published* rating (the internal order is real; only the position
 * is suppressed, which this API expresses as `comparable: false`).
 */
export interface EngineVerdict {
  provisional?: boolean | null;
  provisionalReason?: string | null;
  gamesUntilRated?: number | null;
}

/** The engine's reason names, mapped onto the ones this API publishes. */
const ENGINE_REASONS: Record<string, ProvisionalReason> = {
  'too-few-games': 'too-few-games',
  'too-uncertain': 'uncertainty-too-wide',
  'uncertainty-too-wide': 'uncertainty-too-wide',
  'no-rating': 'no-rating',
};

export interface ConfidenceVerdict {
  provisional: boolean;
  /** Why the rating is withheld; null when it is fit to show. */
  provisionalReason: ProvisionalReason | null;
  /** How many more games until this player clears the games gate. */
  gamesUntilRated: number;
}

/**
 * The fallback verdict, derived from the numbers alone. Prefer
 * `resolveVerdict`, which uses the engine's own verdict when the item has one.
 */
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
 * The verdict to publish for one rating: the engine's own when the item carries
 * it, `assessConfidence` only as a fallback.
 *
 * Two invariants hold whichever source wins, because both are about what may
 * leave this process rather than about statistics:
 *
 *  - a rating that does not exist is never publishable, however the item is
 *    flagged - that is `no-rating`, not "rated";
 *  - a provisional verdict always carries a reason, so a caller never has to
 *    render "withheld, no idea why". An unmapped engine reason (today only
 *    `component-too-small`, which the engine never pairs with
 *    `provisional: true`) falls back to the derived reason and then to
 *    `uncertainty-too-wide`: a comparison problem, which is what it is, rather
 *    than `too-few-games`, which would put a full progress meter beside the
 *    word "Unranked".
 */
export function resolveVerdict(input: {
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
} & EngineVerdict): ConfidenceVerdict {
  const derived = assessConfidence(input);
  if (typeof input.provisional !== 'boolean') return derived;

  if (input.rating === null || input.rating === undefined) {
    return { provisional: true, provisionalReason: 'no-rating', gamesUntilRated: derived.gamesUntilRated };
  }
  if (!input.provisional) {
    return { provisional: false, provisionalReason: null, gamesUntilRated: 0 };
  }

  const mapped = input.provisionalReason ? ENGINE_REASONS[input.provisionalReason] ?? null : null;
  const gamesUntilRated =
    typeof input.gamesUntilRated === 'number' && Number.isFinite(input.gamesUntilRated)
      ? Math.max(0, Math.round(input.gamesUntilRated))
      : derived.gamesUntilRated;

  return {
    provisional: true,
    provisionalReason: mapped ?? derived.provisionalReason ?? 'uncertainty-too-wide',
    gamesUntilRated,
  };
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

/**
 * One set era's rating for a player, with its **own** verdict: a player can be
 * rated all-time and provisional within a set, or the reverse (a set slice has
 * fewer games and so a wider sigma), so each entry is gated independently.
 *
 * `rating` is null whenever `provisional` is true - the number is withheld, not
 * shipped with a flag beside it.
 */
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
  /** Games still needed in this set's slice; 0 when it is not games that block it. */
  gamesUntilRated: number;
}

/**
 * A player's profile. `rating` is the **publishable** rating: null whenever
 * `provisional` is true, exactly as `TournamentPlayer.rating` is. `uncertainty`,
 * `gamesPlayed`, `matchesPlayed` and `gamesUntilRated` are always carried - a
 * margin and a game count are not a position, and they are what lets a page
 * explain the state instead of just asserting it.
 */
export interface PlayerProfile extends PlayerIdentity, ComponentInfo {
  /**
   * The rating engine has an item for this player.
   *
   * False means "we have never recorded a game for this id", which is **not**
   * the same as "no such player": most of a tournament field is in that state
   * (every one of 5 on one live upcoming event, 15 of 22 on another), and those
   * are real registrants on a real roster. Everything else on the profile is
   * null and the verdict is `no-rating`, so a page says "No record yet" rather
   * than "No player with that id".
   *
   * Same field, same meaning, as `TournamentPlayer.known`.
   */
  known: boolean;
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
  /** Publishable rating: null whenever `provisional`, never a withheld number. */
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

/**
 * The one outcome vocabulary this API publishes, for a game or for a match.
 *
 * Lower case and English, deliberately not Riot's enum: upstream words are a
 * moving target and every endpoint that carries an outcome has to agree on one
 * of them. `/api/players/:id/matches` has always published these; since
 * `TournamentMatchSide.outcome` was normalised too (see
 * `models/tournament.ts`), there is exactly one spelling of a draw in this API.
 *
 * `unknown` means a word arrived that this list does not cover - never that
 * nothing arrived. An absent outcome is `null` at the field that carries it.
 */
export type GameOutcome = 'win' | 'loss' | 'draw' | 'unknown';
export type MatchOutcome = GameOutcome;

/**
 * Every upstream word measured or plausibly emitted, mapped onto the vocabulary
 * above. One table, consulted by both the ranking adapter and the tournament
 * service, so the two can never spell a draw differently.
 *
 * **Riot emits `TIE`, not `DRAW`.** Measured over 30 live captures
 * (722 matches / 1,444 sides): `WIN` 686, `LOSS` 686, `TIE` 72, `DRAW` **zero**.
 * Both are mapped, because the vocabulary that produced `TIE` can produce
 * `DRAW` next deploy and a renderer must not have to care.
 *
 * What is deliberately *not* here: `FORFEIT`, `DISQUALIFIED`, `NO_SHOW` and
 * friends. A forfeit is administratively a loss, but recording it as one would
 * be this API inventing a result it was not given - the same class of mistake
 * as mapping only `DRAW` was. Anything unlisted becomes `unknown` and travels
 * beside the verbatim upstream word, so it reads as "not recorded here" and is
 * diagnosable rather than silently wrong.
 */
const OUTCOME_WORDS: Record<string, GameOutcome> = {
  w: 'win', win: 'win', wins: 'win', won: 'win', victory: 'win', '1': 'win',
  l: 'loss', loss: 'loss', losses: 'loss', lose: 'loss', lost: 'loss', defeat: 'loss', '0': 'loss',
  d: 'draw', draw: 'draw', drawn: 'draw', tie: 'draw', tied: 'draw', ties: 'draw',
};

/**
 * One upstream outcome word (or flag, or 1/0) as this API's vocabulary.
 * Anything unrecognised is `unknown` - never guessed at, never dropped.
 */
export function normaliseOutcome(value: unknown): GameOutcome {
  if (typeof value === 'string') return OUTCOME_WORDS[value.trim().toLowerCase()] ?? 'unknown';
  if (typeof value === 'boolean') return value ? 'win' : 'loss';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return OUTCOME_WORDS[String(value)] ?? 'unknown';
  }
  return 'unknown';
}

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
