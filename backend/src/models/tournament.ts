import { z } from 'zod';
import type { MatchOutcome, ProvisionalReason } from './ranking.js';

/**
 * Tournament facts domain model.
 *
 * The scraper's third pass (`scraper/src/sources/playriftboundResults.ts`)
 * stores, per event, who registered for it and what happened in it:
 *
 *   RESULTS#<externalId> / SK: RESULTS#<externalId>   - standings + pairings
 *   ROSTER#<externalId>  / SK: ROSTER#<externalId>    - dated registrations
 *
 * Both are **immutable captures**. Nothing in this file or in anything that
 * reads it writes them; the API only reads.
 *
 * The facts are keyed on Riot's stable player UUID (`playerId`), never on a
 * display name, so joining them to the rating engine's `PLAYER#<uuid>/PROFILE`
 * items is exact. Display names and tag lines are mutable presentation data,
 * carried for rendering only.
 */

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Event external ids are either a UVS numeric id (`48812`) or a playriftbound
 * id (`prb-117209411862156256`). Keep them to a charset that cannot escape a
 * DynamoDB key, exactly as `PLAYER_ID` does for player ids.
 */
export const EVENT_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidEventExternalId(id: string | undefined): boolean {
  return typeof id === 'string' && EVENT_EXTERNAL_ID.test(id);
}

/** `prb-117209411862156256` -> `117209411862156256`; a UVS id is left alone. */
const PLAYRIFTBOUND_ID_PREFIX = 'prb-';

export function tournamentIdFromExternalId(externalId: string): string | null {
  return externalId.startsWith(PLAYRIFTBOUND_ID_PREFIX)
    ? externalId.slice(PLAYRIFTBOUND_ID_PREFIX.length)
    : null;
}

/**
 * Riot synthesises the empty half of a bye pairing with `bye-`-prefixed match,
 * team and player ids (`bye-117384287147695375-r2`,
 * `bye-opponent-117384287147695375`). The scraper's third pass keeps the prefix
 * so nothing synthetic can become a rated player; this API needs the same test
 * to tell a real team on a bye row from the placeholder opposite it.
 */
const BYE_ID_PREFIX = 'bye-';

export function isSyntheticByeId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(BYE_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// Query schemas (same Zod-validated pattern as EventQuerySchema)
// ---------------------------------------------------------------------------

/**
 * The calendar's day list asks about every event in one day at once. Twenty is
 * the busy case; the cap is a hard ceiling so one request can never fan out
 * into an unbounded BatchGet.
 */
export const MAX_AVAILABILITY_IDS = 50;

export const TournamentAvailabilityQuerySchema = z.object({
  ids: z
    .string()
    .max(4096, 'ids is too long')
    .transform((raw) =>
      raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    )
    .refine((ids) => ids.length > 0, { message: 'ids must list at least one event id' })
    .refine((ids) => ids.length <= MAX_AVAILABILITY_IDS, {
      message: `ids must list at most ${MAX_AVAILABILITY_IDS} event ids`,
    })
    .refine((ids) => ids.every(isValidEventExternalId), { message: 'ids contains a malformed event id' }),
});

export type TournamentAvailabilityQuery = z.infer<typeof TournamentAvailabilityQuerySchema>;

// ---------------------------------------------------------------------------
// Shapes returned to the client
// ---------------------------------------------------------------------------

export type EventResultsStatus = 'final' | 'partial' | 'none';
export type RosterSource = 'registrants' | 'participants';

/**
 * The event context the facts denormalise.
 *
 * It comes off the *fact*, not off the event row, because the facts outlive the
 * event rows (events age out after 60-90 days, the facts carry no TTL). So a
 * tournament page still renders for an event whose calendar row is long gone.
 */
export interface TournamentEventContext {
  externalId: string;
  /** Riot's tournament id, for linking out; null for a UVS-only event. */
  tournamentId: string | null;
  startDate: string | null;
  eventType: string | null;
  /**
   * Riot's own format enum (`CONSTRUCTED`, `SEALED`, …), stored verbatim.
   * Null on every event discovered before the field shipped - permanently.
   */
  playFormat: string | null;
  shopExternalId: number | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * One player in an event's field, with whatever the rating engine knows about
 * them attached.
 *
 * **A rating is published with its uncertainty, not withheld.** A column of
 * "Unranked" read as a broken page, and it withheld the wrong thing: the honest
 * answer to "how much should I trust this?" is the number and its margin
 * together. So `rating` and `uncertainty` travel as a pair, `provisional` /
 * `provisionalReason` / `gamesUntilRated` say in words that there is no
 * *position* yet, and the only rating still held back is one below the display
 * floor, where the figure is the prior rather than a measurement.
 */
export interface TournamentPlayer {
  /** Riot's stable UUID. The identity key, and the link target for /ranking/players/:playerId. */
  playerId: string;
  /** `esportsTeamId`: the join key from this player to their standings row and pairings. */
  teamId: string | null;
  displayName: string | null;
  tagLine: string | null;
  /** The rating engine has a profile for this player. False for most of a field at launch. */
  known: boolean;
  /**
   * The rating, published with its margin. Null only below the display floor
   * (`DEFAULT_MIN_GAMES_TO_PUBLISH`), where the posterior is still the prior.
   * A provisional player **does** carry a number - what they do not carry is a
   * rank.
   */
  rating: number | null;
  /** Always present when `rating` is. See `TournamentSidePlayer.uncertainty`. */
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  gamesUntilRated: number;
  componentId: string | null;
  componentSize: number | null;
  regionLabel: string | null;
  /** The component is large enough for its ordering to mean something. */
  comparable: boolean;
}

/** The compact form carried on a pairing, so a table renders without a lookup. */
export interface TournamentSidePlayer {
  playerId: string | null;
  displayName: string | null;
  tagLine: string | null;
  /** Publishable rating; null only below the display floor. */
  rating: number | null;
  /**
   * The margin on that rating, and never absent while the rating is present:
   * `uncertainty` is the signal that separates a settled rating from an
   * unsettled one, so a number without it would be the one unqualified rating
   * in this API.
   */
  uncertainty: number | null;
  provisional: boolean;
}

export interface TournamentStanding {
  rank: number;
  teamId: string;
  matchPoints: number | null;
  matchWins: number | null;
  matchLosses: number | null;
  matchDraws: number | null;
  /** Riot's Swiss tiebreakers, fractions rounded to 4 places. */
  opponentMatchWinPct: number | null;
  gameWinPct: number | null;
  opponentGameWinPct: number | null;
  /** Resolved from the capture's own team -> player map; null if it had no entry. */
  player: TournamentPlayer | null;
}

export interface TournamentGame {
  number: number;
  winnerTeamId: string | null;
}

export interface TournamentMatchSide {
  teamId: string;
  /**
   * The outcome in **this API's one vocabulary** - `win` / `loss` / `draw`, or
   * `unknown` for a word this API does not cover. Null when the capture carried
   * no outcome for this side at all, which is a different thing and reads as
   * "not recorded".
   *
   * **Riot emits `TIE`, never `DRAW`**, which is why this is normalised rather
   * than passed through: measured over 30 live captures (722 matches, 1,444
   * sides) the vocabulary is `WIN` 686 / `LOSS` 686 / `TIE` 72 and `DRAW` zero.
   * A consumer matching on `DRAW` therefore turned a recorded draw into an
   * unrecorded match - `prb-117293942130857502` round 2 printed "no result"
   * over a 1-1 whose own standings rows read `matchDraws: 1`, 4 match points.
   * Normalising here is what stops every consumer re-learning that.
   *
   * It is also the vocabulary `/api/players/:id/matches` already publishes, so
   * there is exactly one spelling of a draw across this API.
   */
  outcome: MatchOutcome | null;
  /**
   * The upstream word, verbatim (`WIN`, `TIE`, …). Nothing is lost by
   * normalising, and an enum value that arrives after this list was written is
   * visible here instead of only as `unknown`.
   */
  rawOutcome: string | null;
  gameWins: number;
  player: TournamentSidePlayer | null;
}

export interface TournamentMatch {
  matchId: string;
  tableNumber: number | null;
  /**
   * Riot's raw match status. Deliberately not a finality signal: Riot's
   * software routinely leaves matches reading `IN_PROGRESS` inside a round it
   * has `FINALIZED`, so read the round's status instead.
   */
  status: string | null;
  /**
   * **Always false.** A bye is not a match, so this API no longer publishes one
   * as a match - see `TournamentRound.byes`. The field stays because it is the
   * assertion: a consumer can keep reading it and will never again render the
   * same bye twice.
   */
  bye: boolean;
  sides: TournamentMatchSide[];
  games: TournamentGame[];
}

export interface TournamentRound {
  /** Index of the stage section this round belongs to (swiss, top cut, …). */
  section: number;
  roundNumber: number;
  status: string | null;
  /**
   * The teams that sat this round out. **The single representation of a bye**,
   * with `byes` below naming them.
   *
   * Riot publishes a bye twice: once here and again as a synthesised match
   * (`bye-<teamId>-r<n>`, `bye: true`, the empty half a `bye-opponent-…` team
   * with no player). Serving both made every bye player render twice. This is
   * the honest half - a bye is the *absence* of a match, it has no table and no
   * games, and `matches` is for pairings that were played. Measured over 87
   * live rounds, 42 carried a bye and every one of them agreed exactly across
   * the two shapes, so nothing is lost by dropping the match; a bye that
   * somehow arrived *only* as a match is folded in here rather than discarded.
   */
  byeTeamIds: string[];
  /** The bye teams resolved to players, so a pairings table can show them. */
  byes: TournamentSidePlayer[];
  /**
   * The played pairings, **in table order** - not the capture's order, which is
   * whatever Riot's software returned (round 1 of
   * `prb-117293942130857502` arrives 7, 6, 4, 3, 2, 1, 5; 21 of 87 live rounds
   * are out of order). Sorting here rather than in each consumer is the same
   * argument as normalising the outcome: table number is the capture's own
   * ordering field, so one order for everybody.
   */
  matches: TournamentMatch[];
}

export interface TournamentResults {
  /**
   * `final` - every round finalised. `partial` - a round was still live when we
   * looked. `none` - the event happened but no pairings were ever run through
   * Riot's software (~29% of finished events). `none` is a fact, not an error.
   */
  status: EventResultsStatus;
  roundCount: number;
  playerCount: number;
  /** Matches not yet `COMPLETED`. A data-quality signal, not a finality gate. */
  openMatches: number;
  /**
   * The pairings were dropped to keep the stored item inside DynamoDB's 400KB
   * item limit, so `rounds` is empty while `standings` is complete.
   */
  trimmed: boolean;
  /** Riot's own `updatedAt` on the tournament. */
  sourceUpdatedAt: string | null;
  capturedAt: string | null;
  standings: TournamentStanding[];
  rounds: TournamentRound[];
}

export interface TournamentRosterEntry {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  teamId: string | null;
  status: string | null;
  checkedIn: boolean | null;
  waitlistPosition: number | null;
  /** When this player signed up (Riot's `acceptedTermsAt`); null on a participants roster. */
  registeredAt: string | null;
  player: TournamentPlayer;
}

export interface TournamentRoster {
  /**
   * `registrants` - dated signups, captured before the event. `participants` -
   * recovered from a played event's field, so `registeredAt` is null on every
   * entry.
   */
  source: RosterSource;
  playerCount: number;
  capturedAt: string | null;
  entries: TournamentRosterEntry[];
}

/**
 * Strength of field, over the **rated** players only.
 *
 * `ratedSample` is the count the mean and median are computed from and is
 * always smaller than `totalPlayers` at launch. Both are null when nothing
 * cleared the gate, so a page can never present an average over 3 of 24
 * players as if it described the field.
 */
export interface TournamentField {
  /** Distinct players known for this event across both facts. */
  totalPlayers: number;
  /** Of those, how many the rating engine has a profile for at all. */
  knownPlayers: number;
  /** Of those, how many have a publishable rating. */
  ratedPlayers: number;
  /** Known to the engine but below the bar. */
  provisionalPlayers: number;
  /** No profile at all - the engine has never seen them play. */
  unknownPlayers: number;
  /** The count `meanRating` / `medianRating` are computed from. Equals `ratedPlayers`. */
  ratedSample: number;
  /** `ratedSample / totalPlayers`, 0 when the field is empty. Rounded to 3 places. */
  ratedShare: number;
  meanRating: number | null;
  medianRating: number | null;
  topRating: number | null;
  minGamesForRating: number;
  maxUncertaintyForRating: number;
  minComponentSize: number;
  /** Recorded games before a rating number is shown at all. */
  minGamesToPublishRating: number;
}

export interface TournamentDetail {
  event: TournamentEventContext;
  /** Null when no results capture exists - normal for an upcoming event. */
  results: TournamentResults | null;
  /** Null when no roster was ever captured. */
  roster: TournamentRoster | null;
  /** Every distinct player across both facts, enriched. The canonical list. */
  players: TournamentPlayer[];
  field: TournamentField;
}

/** One event's answer to "is there anything to show here?". */
export interface TournamentAvailability {
  /** A results capture exists **and holds content** (status is not `none`). */
  hasResults: boolean;
  /** Raw capture status; null when there is no results item at all. */
  resultsStatus: EventResultsStatus | null;
  hasRoster: boolean;
  /**
   * `hasResults || hasRoster`: the single field a trophy affordance should read.
   * A results item with status `none` is not a tournament page worth opening.
   */
  hasTournament: boolean;
  /** Field size, from whichever fact knows it. Null when neither does. */
  playerCount: number | null;
}
