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
  /**
   * The player's own home city. **Not what a place column on this page
   * prints** - see `sceneLabel`.
   */
  regionLabel: string | null;
  /**
   * The scene this player's **home venue** belongs to: the engine's cluster of
   * stores whose players really play each other.
   *
   * This is what the roster's Scene column shows. `regionLabel` names as many
   * places as the field has home stores - on the live page six known players
   * carried `Redwood City, CA`, `San Carlos, California` and
   * `Sunnyvale, California` where the scene answer is `Peninsula` x5 and
   * `South Bay` x1 - and `componentId` spans several scenes, so neither is a
   * scene.
   *
   * Null for a player whose home venue is in no scene (2.6% of sampled
   * production profiles, against 99.9% that carry a region). The column has to
   * say so rather than falling back to the city.
   */
  sceneId: string | null;
  sceneLabel: string | null;
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
  /** The **rank gate**: recorded games before a player holds a position. */
  minGamesForRating: number;
  maxUncertaintyForRating: number;
  minComponentSize: number;
  /**
   * The **display floor**: recorded games before the rating *number* is shown
   * at all. A different and much lower threshold than `minGamesForRating`, and
   * conflating the two is what made "3 Rated, 10 Unranked" sit under a table
   * printing six ratings.
   */
  minGamesToPublishRating: number;
}

/**
 * Why this event has a scene, or why it has not. None of them is an error.
 *
 * - `scene` - the store this event was held at belongs to a scene.
 * - `no-matches` - nothing was paired here: an upcoming event, an event with
 *   no capture, or the ~29% of finished ones whose organiser never ran
 *   pairings through Riot's software.
 * - `no-venue` - games were played, and no store is resolved for the event, so
 *   there is nothing to carry a scene.
 * - `unassigned` - the store is known and is not in a scene **yet**. The
 *   normal value rather than an edge case: no store has a scene until an
 *   operator accepts a re-clustering, and a store whose neighbours do not play
 *   it often enough to rank against stays without one afterwards.
 */
export type TournamentSceneStatus = 'scene' | 'no-matches' | 'no-venue' | 'unassigned';

/**
 * The scene this event belongs to.
 *
 * ## It is the **venue's** scene
 *
 * A scene is a set of stores close enough together that their players really
 * do play each other, and the engine assigns one to each *store*. An event has
 * a store, so the API reads the answer off that store - one item, with no
 * inference about who attended.
 *
 * It used to be derived by tallying the connected components of the players
 * who played here, and that produced a wrong answer a reader could see.
 * Reachability is a transitive closure, so one travelling player welds two
 * cities into a single component permanently. Measured on production, one
 * component held 1,688 players across 110 venues with a 1,514km spread,
 * carried the label `New York, New York`, and its five busiest stores were all
 * in California - which is why a shop in Redwood City, CA displayed
 * "Scene: New York, New York" on its own event page.
 *
 * ## The component fields remain, and still mean a component
 *
 * They are not leftovers. `componentId` is the set of players whose ratings are
 * on one scale, which is what a ladder position rests on, and `comparable` is a
 * statement about that scale rather than about the scene. The ladder this page
 * links to is still scoped to the component, so the two travel together and
 * answer different questions.
 */
export interface TournamentScene {
  status: TournamentSceneStatus;

  /** The store this event was held at, or null when none is resolved. */
  shopExternalId: number | null;
  /** The store's scene, or null unless `status === 'scene'`. */
  sceneId: string | null;
  /**
   * The **scene's own** name, never a player's home city: members of one scene
   * carry different home labels, so naming it from whoever turned up would
   * give one scene a different name on every event page.
   */
  sceneLabel: string | null;
  /** How much of this store's own play is by players who live in its scene. */
  scenePurity: number | null;
  /** Stores in the whole scene, not at this event. */
  sceneVenues: number | null;
  /** Players whose home store is in the scene. Never this event's field. */
  scenePlayers: number | null;
  sceneRatedPlayers: number | null;

  /** Players who played at least one recorded pairing here. */
  matchPlayers: number;
  /**
   * Of those, how many the engine has placed in a component. The roster is
   * deliberately not counted: a player who signed up and never sat down
   * contributed no edge.
   */
  placedPlayers: number;
  /**
   * Distinct components among the placed players. Normally 1; more when an
   * event's pairings did not connect everyone, or when the engine has not
   * replayed this event yet.
   */
  componentCount: number;
  /** The dominant component - the rating pool, not the scene. */
  componentId: string | null;
  /** The **component's** own label. Not what this page calls the scene. */
  regionLabel: string | null;
  /** Players in the whole component. */
  componentSize: number | null;
  ratedPlayers: number | null;
  /** The component is big enough for its order to be a placement. */
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
