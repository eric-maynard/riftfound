/**
 * Mirrors the tournament-facts API (see `backend/src/models/tournament.ts`).
 *
 * Two endpoints, two jobs:
 *
 *  - `/api/events/tournament-availability?ids=…` answers "is there anything to
 *    show here?" for up to 50 events at once. It is what decides whether a day
 *    list offers a trophy.
 *  - `/api/events/:externalId/tournament` is the page: standings, pairings and
 *    roster, with every player's rating already joined on.
 *
 * Three rules this contract enforces that the UI must not undo:
 *
 *  1. **`rating` is null whenever `provisional`.** Stricter than
 *     `/api/rankings`. A withheld rating never reaches the client, so the UI
 *     prints `UNRANKED_LABEL` and cannot leak a number nobody should act on.
 *  2. **`known: false` is not the same as provisional.** Most of a field has no
 *     profile at all - the engine has never seen them play. That is "no record
 *     yet", not "failed a bar".
 *  3. **A match's `status` is not a finality signal.** Riot's software leaves
 *     matches reading `IN_PROGRESS` inside rounds it has `FINALIZED` (22 of 22
 *     in the live event this page was built against). Read the round's status,
 *     or the capture's.
 */

import type { ProvisionalReason } from './ranking';

export type EventResultsStatus = 'final' | 'partial' | 'none';
export type RosterSource = 'registrants' | 'participants';

/** One event's answer to "is there anything to show here?". */
export interface TournamentAvailability {
  /** A results capture exists *and holds content* - status is not `none`. */
  hasResults: boolean;
  resultsStatus: EventResultsStatus | null;
  hasRoster: boolean;
  /**
   * `hasResults || hasRoster`. **The only field a trophy may read.** A results
   * item with status `none` is a page not worth opening, and deriving the
   * affordance from `hasResults` alone would light a trophy on the ~29% of
   * finished events whose organiser never ran pairings through Riot's software.
   */
  hasTournament: boolean;
  playerCount: number | null;
}

export interface TournamentAvailabilityResponse {
  data: Record<string, TournamentAvailability>;
  meta: { requested: number; limit: number };
}

/**
 * The event context, denormalised onto the fact rather than read off the event
 * row - the facts carry no TTL and outlive the calendar rows, so a tournament
 * page still renders for an event the calendar has long forgotten.
 */
export interface TournamentEventContext {
  externalId: string;
  tournamentId: string | null;
  startDate: string | null;
  eventType: string | null;
  /** Riot's own format enum. Null on every event discovered before it shipped. */
  playFormat: string | null;
  shopExternalId: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface TournamentPlayer {
  playerId: string;
  teamId: string | null;
  displayName: string | null;
  tagLine: string | null;
  /** The engine has a profile for this player at all. */
  known: boolean;
  /** Publishable rating, or null when `provisional`. Never a withheld number. */
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  gamesUntilRated: number;
  componentId: string | null;
  componentSize: number | null;
  regionLabel: string | null;
  comparable: boolean;
}

/** The compact form carried on a pairing, so a table renders without a lookup. */
export interface TournamentSidePlayer {
  playerId: string | null;
  displayName: string | null;
  tagLine: string | null;
  rating: number | null;
  provisional: boolean;
}

export interface TournamentStanding {
  rank: number;
  teamId: string;
  matchPoints: number | null;
  matchWins: number | null;
  matchLosses: number | null;
  matchDraws: number | null;
  opponentMatchWinPct: number | null;
  gameWinPct: number | null;
  opponentGameWinPct: number | null;
  player: TournamentPlayer | null;
}

export interface TournamentGame {
  number: number;
  /** Null for a game that was never played, or never recorded. */
  winnerTeamId: string | null;
}

export interface TournamentMatchSide {
  teamId: string;
  /**
   * The outcome in this API's own vocabulary: `win` | `loss` | `draw` |
   * `unknown`, or null.
   *
   * Riot's own words used to come through verbatim, and a draw arrived as
   * `TIE` - 72 of 1,444 sides on the live corpus, `DRAW` never once. The API
   * normalises now, and `FORFEIT` / `DISQUALIFIED` / `NO_SHOW` map to
   * `unknown` rather than being guessed at as a win or a loss. `sideOutcome`
   * still matches case-insensitively against both vocabularies, so either
   * deploy order reads correctly.
   */
  outcome: string | null;
  /** Riot's verbatim word, kept for reference. Never matched on. */
  rawOutcome?: string | null;
  gameWins: number;
  player: TournamentSidePlayer | null;
}

export interface TournamentMatch {
  matchId: string;
  tableNumber: number | null;
  /** Riot's raw status. **Not** a finality signal - see the file header. */
  status: string | null;
  bye: boolean;
  sides: TournamentMatchSide[];
  games: TournamentGame[];
}

export interface TournamentRound {
  /** Index of the stage section this round belongs to (swiss, top cut, …). */
  section: number;
  roundNumber: number;
  status: string | null;
  byeTeamIds: string[];
  byes: TournamentSidePlayer[];
  matches: TournamentMatch[];
}

export interface TournamentResults {
  status: EventResultsStatus;
  roundCount: number;
  playerCount: number;
  /** Matches not yet `COMPLETED`. A data-quality signal, not a finality gate. */
  openMatches: number;
  /** Pairings were dropped to fit the item limit: `rounds` is empty, standings are not. */
  trimmed: boolean;
  sourceUpdatedAt: string | null;
  capturedAt: string | null;
  /** Already sorted by rank. */
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
  /** Null on every entry of a `participants` roster. */
  registeredAt: string | null;
  player: TournamentPlayer;
}

export interface TournamentRoster {
  source: RosterSource;
  playerCount: number;
  capturedAt: string | null;
  entries: TournamentRosterEntry[];
}

/**
 * Strength of field, over the **rated** players only.
 *
 * `ratedSample` is always smaller than `totalPlayers` at launch, and the rated
 * subset is systematically the regulars, so a mean over them overstates the
 * room. `ratedShare` exists so the copy can say which players the number
 * describes instead of implying it describes the field.
 */
export interface TournamentField {
  totalPlayers: number;
  knownPlayers: number;
  ratedPlayers: number;
  provisionalPlayers: number;
  unknownPlayers: number;
  ratedSample: number;
  ratedShare: number;
  meanRating: number | null;
  medianRating: number | null;
  topRating: number | null;
  minGamesForRating: number;
  maxUncertaintyForRating: number;
  minComponentSize: number;
}

/**
 * Why this event has a scene, or why it has not. None is an error.
 *
 * - `scene` - someone who played a recorded pairing here is placed in a scene.
 * - `no-matches` - nothing was paired here: an upcoming event, an event with
 *   no capture, or the ~29% of finished ones whose organiser never ran
 *   pairings through Riot's software.
 * - `unplaced` - pairings exist and no player in them is placed yet. The
 *   engine refits daily, so this is the normal state of a fresh capture.
 */
export type TournamentSceneStatus = 'scene' | 'no-matches' | 'unplaced';

/**
 * The scene this event belongs to.
 *
 * A scene is a connected component of the co-play graph, and an event's own
 * matches are edges in it, so the scene is **read off the players who played
 * here** rather than voted on - the API does the counting (see
 * `backend/src/models/tournament.ts`). Two fields carry the parts of that
 * which are not certain:
 *
 * - `matchPlayers` / `placedPlayers` - the roster is deliberately not counted.
 *   A player who signed up and never sat down contributed no edge, so this
 *   event says nothing about which scene they are in.
 * - `componentCount` - normally 1. It can be more, because an event's pairings
 *   connect the players they pair rather than all of them, and because the
 *   engine places a player from the history it last replayed. Verified against
 *   production: 7 played events across 2 scenes, 5 to 53 players each, all
 *   unanimous.
 *
 * `regionLabel` is the **component's own** name, not any player's: members of
 * one scene carry different home labels (one 5,405-player scene's players span
 * four of them), so naming the scene from whoever turned up would give it a
 * different name on every event page and a different name again on the ladder
 * this links to.
 */
export interface TournamentScene {
  status: TournamentSceneStatus;
  /** Players who played at least one recorded pairing here. */
  matchPlayers: number;
  /** Of those, how many the engine has placed in a scene. */
  placedPlayers: number;
  /** Distinct scenes among the placed players. 1 is the normal case. */
  componentCount: number;
  componentId: string | null;
  regionLabel: string | null;
  /** Players in the whole scene, not at this event. */
  componentSize: number | null;
  ratedPlayers: number | null;
  /** The scene is big enough for its own ladder to be ordered. */
  comparable: boolean;
  /** Of `placedPlayers`, how many are in `componentId`. */
  playersInScene: number;
}

export interface TournamentDetail {
  event: TournamentEventContext;
  /** Null when no results capture exists - the normal upcoming case. */
  results: TournamentResults | null;
  roster: TournamentRoster | null;
  players: TournamentPlayer[];
  field: TournamentField;
  /** Always present, carrying its own reason when there is no scene. */
  scene: TournamentScene;
}

export interface TournamentDetailResponse {
  data: TournamentDetail;
}
