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
  /**
   * The scene this player's **home venue** belongs to, and its name.
   *
   * This is the field a roster's place column should print, and the other two
   * are the reasons why. `regionLabel` is the player's own home city, so a
   * column of it names as many places as the field has home stores - measured
   * on `prb-117397899890353177`, six known players carried `Redwood City, CA`
   * x3, `San Carlos, California` x2 and `Sunnyvale, California`, where the
   * scene answer is `Peninsula` x5 and `South Bay` x1. `componentId` is a
   * connected component of the co-play graph and spans several scenes, so its
   * label names none of them in particular (the Redwood City store that read
   * "Scene: New York, New York" is the receipt).
   *
   * Null for a player whose home venue is in no scene - 196 of 7,411 sampled
   * production profiles, 2.6%, against 99.9% carrying a `regionLabel`. That is
   * a normal state and a reader must say so rather than falling back to the
   * city, which is the fallback that made the column wrong in the first place.
   *
   * Free: these come off the same `PLAYER#<id>/PROFILE` items the field's one
   * BatchGet already fetches.
   */
  sceneId: string | null;
  sceneLabel: string | null;
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

/**
 * Why an event has a scene, or why it has not.
 *
 * Three answers, and none of them is an error:
 *
 * - `scene` - at least one player who played a recorded pairing here is placed
 *   in a connected component, so the event has a scene.
 * - `no-matches` - nothing was ever paired here. The ~29% of finished events
 *   whose organiser never ran pairings through Riot's software
 *   (`results.status === 'none'`), an event with no results capture at all, and
 *   every upcoming event, which has a roster and nothing else.
 * - `unplaced` - pairings exist, and not one of the players in them carries a
 *   `componentId`. The engine refits daily and only places a player it has
 *   replayed, so this is the normal state of an event captured since the last
 *   refit.
 */
/**
 * Why there is, or is not, a scene on this event.
 *
 * - `scene` - the event's store belongs to a scene, and it is named.
 * - `no-matches` - nothing was played here, so there is nothing to say. An
 *   upcoming event, or one of the ~29% of finished ones whose organiser never
 *   ran pairings.
 * - `no-venue` - matches were played, but the event has no resolved store. A
 *   Riot organiser that `shopMatch.ts` has not tied to a shop row has no
 *   venue item and therefore no scene, and that is a real state rather than a
 *   failure.
 * - `unassigned` - the store is known and has no scene **yet**. This is the
 *   normal value, not an edge: `sceneId` is null on every venue until an
 *   operator accepts a re-clustering, and a store whose cluster cannot support
 *   a ladder keeps it null afterwards. "This venue is not in a rankable scene
 *   yet" is the honest sentence, and it is a different claim from "this event
 *   has no scene".
 */
export type TournamentSceneStatus = 'scene' | 'no-matches' | 'no-venue' | 'unassigned';

/**
 * Which scene this event belongs to.
 *
 * ## It is read off the **venue**, not off the players
 *
 * A scene is a set of stores near enough to each other that their players
 * genuinely play each other, assigned to each store by the engine and stored
 * on its `VENUE#<shopExternalId>` item. An event carries a `shopExternalId`,
 * so this is **one GetItem** on the store the event was held at.
 *
 * It used to be derived instead by tallying the `componentId`s of the players
 * who attended, and that was wrong in a way a reader could see. A component is
 * a connected component of the co-play graph: reachability is a transitive
 * closure, so one travelling player welds two cities into one component
 * permanently and no amount of coverage ever separates them again. Measured on
 * production, component `ce3da9bead6` held 1,688 players across 110 venues
 * with a 1,514km spread, was labelled `New York, New York`, and its five
 * busiest venues were all in California - so a shop in Redwood City, CA
 * displayed "Scene: New York, New York" on its own event page. The venue's own
 * scene cannot do that, because it is bounded geographically by construction.
 *
 * ## `componentId` still means a connected component
 *
 * The component fields below are **unchanged and still computed the old way**,
 * and that is deliberate rather than leftover. `componentId` has a statistical
 * job no other field can do - `crossComponentUncertainty` is only correct for
 * a connected component, because the floating rating offset it corrects for is
 * a property of reachability and nothing else - so `comparable` is still a
 * statement about the component. Scenes are **additive**; redefining the
 * component to mean a scene would silently corrupt that number.
 *
 * What changed is which of them the page *names*. Two facts travel side by
 * side: "this event was held in the South Bay scene" and "these players'
 * ratings are on one scale with these other players'".
 *
 * ## Three honest absences
 *
 * `status` carries the reason rather than leaving a reader to branch on a
 * null - see `TournamentSceneStatus`. Only one of the three prints a line.
 */
export interface TournamentScene {
  status: TournamentSceneStatus;

  // --- the scene, off the event's own venue --------------------------------

  /** The store this event was held at, or null when none is resolved. */
  shopExternalId: number | null;
  /** The venue's scene, or null unless `status === 'scene'`. */
  sceneId: string | null;
  /**
   * The **scene's own** name, off the engine's `SCENE#` item, falling back to
   * the copy denormalised onto the venue.
   *
   * Deliberately not any player's `regionLabel`, which is that player's home
   * city and differs between members of one scene - on the live board one
   * component held players labelled `Central Singapore …, 01`, `North West …,
   * 03`, `South West …, 05` and `South East …, 04`. Null when the scene's
   * stores are not reverse-geocoded yet, which is normal.
   */
  sceneLabel: string | null;
  /**
   * How true "this store belongs to one scene" is, as a share of the store's
   * own play. A low number is a genuinely split store - worth showing rather
   * than hiding - not an error.
   */
  scenePurity: number | null;
  /** Stores in the whole scene, not at this event. */
  sceneVenues: number | null;
  /** Players whose home venue is in the scene. Not this event's field. */
  scenePlayers: number | null;
  /** Of those, how many clear the publishing bar. */
  sceneRatedPlayers: number | null;

  // --- the component, unchanged, for scale honesty -------------------------

  /** Distinct players who played at least one recorded pairing at this event. */
  matchPlayers: number;
  /** Of those, how many the engine has placed in a component. */
  placedPlayers: number;
  /**
   * Distinct components among the placed players. 1 is the normal case.
   *
   * Not guaranteed to be 1, and the hole is worth knowing: an event's matches
   * connect the players they *pair*, not all of them - one round of eight
   * players is four disjoint edges - and the engine places a player from the
   * history it last replayed, so a capture newer than the last refit can leave
   * two players here carrying the components they had before it.
   */
  componentCount: number;
  /** The dominant component's id. Still a connected component, never a scene. */
  componentId: string | null;
  /**
   * The **component's own** region label, off the engine's `COMPONENT#` item.
   *
   * Kept, and no longer what the page calls the scene: a component spans
   * several scenes, so this label answers a different question. Null when the
   * catalogue has no item, no label, or could not be read.
   */
  regionLabel: string | null;
  /** Players in the whole component, not at this event. */
  componentSize: number | null;
  /** Rated players in the whole component, when the catalogue knows. */
  ratedPlayers: number | null;
  /**
   * The **component** is big enough (`CONFIDENCE.minComponentSize`) for its
   * order to be a placement. A statement about the rating scale, not about the
   * scene.
   */
  comparable: boolean;
  /** Of `placedPlayers`, how many are in `componentId`. */
  playersInScene: number;
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
  /**
   * Which scene this event belongs to. **Always present**, carrying its own
   * reason when there is no scene, so a reader branches on a field rather than
   * on a null and can tell "nobody played here" from "nobody here is placed
   * yet" - which read completely differently on a page.
   */
  scene: TournamentScene;
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
