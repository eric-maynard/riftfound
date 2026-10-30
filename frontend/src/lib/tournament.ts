import type { GameOutcome } from '../types/ranking';
import type {
  TournamentField,
  TournamentMatch,
  TournamentMatchSide,
  TournamentResults,
  TournamentRound,
  TournamentRoster,
  TournamentScene,
  TournamentSidePlayer,
} from '../types/tournament';
// `sceneTooSmallExplanation` is the ladder's own sentence for a scene too
// small to order, reused verbatim: the event line links to that ladder, so a
// second wording of the same caveat would be a second answer. Deliberately
// *not* the map's `sceneComparableHint`, which says the same thing - the map
// module is lazy-loaded and importing from it would drag it into the eager
// bundle (see `scenePath` in ./ranking).
import { ratingDisplay, sceneTooSmallExplanation, UNRANKED_LABEL } from './ranking';

/**
 * Pure helpers behind the event page.
 *
 * Everything the page has to get *right* rather than merely pretty lives here,
 * so it is tested without a DOM: the known/provisional distinction, the
 * strength-of-field copy, and reading finality off a round instead of off a
 * match whose status lies.
 */

// ---------------------------------------------------------------------------
// A player's rating, as the page is allowed to say it
// ---------------------------------------------------------------------------
//
// This page used to keep its own three-state vocabulary - `rated`,
// `unranked`, `no-record` - and the last of those printed "No record yet" to
// distinguish a player the engine had never seen from one who had not cleared
// the gate. The distinction was real in principle and a lie in practice: a
// 25-hour-stale engine reported `known: false` for 22 players whose games were
// rendered on the same page. It is collapsed into `Unranked`, and what the
// page shows is decided by `ratingDisplay` in lib/ranking.ts, the same rule
// the ladder and the player page use.

// ---------------------------------------------------------------------------
// Strength of field
// ---------------------------------------------------------------------------

/**
 * Strength of field, as **one word**.
 *
 * ## Why a word and not a figure with a bar
 *
 * The block used to print `1,276 mean`, a coverage meter and a line of prose
 * saying which players the mean described. Three surfaces for a number that
 * turns out not to vary: measured over every production event with a captured
 * field (11,946 of them, 2026-09-25..2026-10-31), a one-way variance
 * decomposition of rated players' ratings over events gives
 * **within-event SD 84.2, between-event SD 0.0, ICC 0.000**. Events do not
 * differ in strength by more than the noise of sampling a few of their
 * players, and the 418 events where *every* player in the field is rated make
 * the same point without any sampling argument: their means have SD 30.4
 * against the 31.8 that drawing the same number of players from one pool
 * predicts.
 *
 * So the figure was precision the data does not support, and the word is the
 * right grain. What the word says is where this event's mean sits **among
 * other events' means** - a true statement about an observed number - and
 * `FIELD_BAND_HINT` carries the caveat that the spread between events is
 * within sampling noise. Printing it with its caveat rather than withholding
 * it is the same call the ladder already made for Global positions.
 *
 * ## The bands are measured, not chosen
 *
 * `FIELD_BAND_EDGES` are the quartiles of that distribution, rounded to the
 * nearest ten because the published mean carries one decimal and a quartile
 * quoted to 0.1 would claim a stability the next refit does not have. They are
 * flat across every floor tried - q1 1201.3 -> 1206.0, q2 1220.5 -> 1220.3,
 * q3 1242.5 -> 1237.0 as the rated-sample floor moves from 3 to 8 - so the
 * edges are a property of the corpus rather than of the pool they were cut
 * from. Occupancy at the floor below: 20 / 30 / 27 / 24%.
 *
 * ## The floor, which is the part the data forces
 *
 * One rated player's own published margin may be as wide as
 * `maxUncertaintyForRating` (120). Their contribution to a mean over `k`
 * players is that margin over `k`, so below `ceil(120 / 20) = 6` rated players
 * **one person's uncertainty spans more than a whole band** and the word is
 * their margin rather than the field's level. Below the floor there is no
 * band: `kind: 'thin'`, and the hint says how many players were rated.
 *
 * The live case this was reported against is exactly that - `mean 1,276` over
 * **3 rated players of 13**, which would have read `Very high`.
 */
export const FIELD_BAND_EDGES = [1200, 1220, 1240] as const;

/** Low to high, one per quartile. */
export const FIELD_BAND_LABELS = ['Low', 'Medium', 'High', 'Very high'] as const;

/**
 * The narrowest band, and therefore the yardstick the floor is derived from.
 * The two inner bands are 20 points wide; the outer two are open-ended.
 */
export const FIELD_BAND_WIDTH = FIELD_BAND_EDGES[1] - FIELD_BAND_EDGES[0];

export const FIELD_BAND_HINT =
  "Where this event's mean rating sits among all events we have a field for - the bands are the " +
  'quartiles of 11,946 of them. It is not a claim that this event is harder: measured over the same ' +
  'corpus, event means vary no more than drawing a few players at random from one pool would make ' +
  'them (within-event SD 84, between-event SD 0).';

/**
 * How many rated players a band needs: enough that one player's own margin
 * cannot move it a whole band.
 *
 * Read off the payload rather than hardcoded, so the floor follows the gate if
 * the gate moves. Two is the lower bound whatever the arithmetic says, because
 * a "mean" over one person is that person.
 */
export function minRatedForBand(field: TournamentField): number {
  return Math.max(2, Math.ceil(field.maxUncertaintyForRating / FIELD_BAND_WIDTH));
}

export type FieldBand =
  /** One of `FIELD_BAND_LABELS`. */
  | { kind: 'band'; label: string; hint: string }
  /**
   * A rated sample too small to carry a band - including none at all. One
   * state rather than two, because the page has one slot for a word and the
   * difference between "nobody rated" and "two rated" belongs in the hint.
   */
  | { kind: 'thin'; label: string; hint: string };

/** The band this event's mean falls in, as an index into `FIELD_BAND_LABELS`. */
export function fieldBandIndex(mean: number): number {
  let index = 0;
  while (index < FIELD_BAND_EDGES.length && mean >= FIELD_BAND_EDGES[index]) index += 1;
  return index;
}

export function fieldBand(field: TournamentField): FieldBand {
  const floor = minRatedForBand(field);
  const { ratedSample, totalPlayers, knownPlayers, meanRating, minGamesForRating } = field;

  if (ratedSample < floor || meanRating === null) {
    return {
      kind: 'thin',
      label: 'Not enough rated players',
      hint:
        ratedSample === 0
          ? knownPlayers === 0
            ? `None of these ${totalPlayers} ${plural(totalPlayers, 'player')} has a recorded game yet, so there is nothing to average.`
            : `${knownPlayers} of ${totalPlayers} have played before, but none has reached ${minGamesForRating} recorded games, so there is nothing to average.`
          : `${ratedSample} of ${totalPlayers} ${plural(totalPlayers, 'player')} ${
              ratedSample === 1 ? 'is' : 'are'
            } rated. Over fewer than ${floor} of them one player's own margin moves the mean a whole band, ` +
            `so the word would report that player's uncertainty rather than this field.`,
    };
  }

  return {
    kind: 'band',
    label: FIELD_BAND_LABELS[fieldBandIndex(meanRating)],
    hint: FIELD_BAND_HINT,
  };
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

export interface FieldSegment {
  key: 'rated' | 'unsettled' | 'none';
  label: string;
  count: number;
  percent: number;
}

/**
 * The field's groups, as counts - **three of them, because the table prints
 * three things**.
 *
 * This is the bug the block was reported for. It counted two groups, `Rated`
 * and `Unranked`, and the live page read "3 Rated, 10 Unranked" over a roster
 * showing **six** rating numbers. Both figures were right and the pair was
 * unreadable, because one word was doing the work of two different thresholds:
 *
 * | threshold | what it decides |
 * |---|---|
 * | display floor, 3 recorded games | whether a **number** is shown |
 * | rank gate, 8 games / margin <= 120 / scene >= 8 | whether a **position** is held |
 *
 * Three of those ten "Unranked" players sat between the two - 1,188 +/-128 on
 * 4 games, 1,250 +/-122 on 3, 1,174 +/-122 on 3 - so the table printed their
 * rating right beside the word saying they had none.
 *
 * **The counts come from the players, through `ratingDisplay`.** Not from
 * `field`, and that is the whole repair: `ratingDisplay` is the function the
 * table cells themselves branch on, so a reader who counts the numbers in the
 * table cannot get a different answer from the legend. Counting the middle
 * group off `field.provisionalPlayers` would be wrong in the same direction
 * again - a known player with two recorded games is provisional *and* has no
 * number, so they belong with the third group and not the second.
 *
 * `field.ratedPlayers` is still the authority on the first group and agrees
 * with it by construction (the API applies the same test); a test pins that.
 *
 * Deliberately *not* drawn as a segmented meter: in this theme the fills would
 * have to sit above 3:1 on the panel and still be told apart from each other,
 * and the best available pair measures 1.08:1. `percent` is kept for anything
 * that wants the proportion.
 */
export function fieldComposition(
  players: { rating?: number | null; provisional?: boolean }[]
): FieldSegment[] {
  const total = players.length;
  const share = (count: number) => (total > 0 ? (count / total) * 100 : 0);

  let rated = 0;
  let unsettled = 0;
  let none = 0;
  for (const player of players) {
    const display = ratingDisplay(player);
    if (display === 'rated') rated += 1;
    else if (display === 'unsettled') unsettled += 1;
    else none += 1;
  }

  return [
    { key: 'rated', label: 'Rated', count: rated, percent: share(rated) },
    // A number, with a record short enough or a margin wide enough that it is
    // not a position yet. The ladder already shows this state as a muted
    // rating; this is the word for it.
    { key: 'unsettled', label: 'Still settling', count: unsettled, percent: share(unsettled) },
    // No number at all - which is what `Unranked` means in the table, and the
    // only group that word may be counted over.
    { key: 'none', label: 'No rating yet', count: none, percent: share(none) },
  ];
}

/** The hover hint on each legend row, so each one says which state it is. */
export function fieldSegmentHint(key: FieldSegment['key'], field: TournamentField): string {
  switch (key) {
    case 'rated':
      return (
        `Settled: ${field.minGamesForRating} or more recorded games with a margin inside ` +
        `+/-${field.maxUncertaintyForRating}, in a scene of at least ${field.minComponentSize}. ` +
        `These hold a position on the ladder.`
      );
    case 'unsettled':
      return (
        `A rating, shown with its margin, that is not a position yet - fewer than ` +
        `${field.minGamesForRating} recorded games, or a margin wider than ` +
        `+/-${field.maxUncertaintyForRating}. The table prints their number.`
      );
    default:
      return (
        `No rating to print: fewer than ${field.minGamesToPublishRating} recorded games, where the ` +
        `estimate still echoes the starting average rather than describing the player. The table ` +
        `reads ${UNRANKED_LABEL}.`
      );
  }
}

// ---------------------------------------------------------------------------
// Results, rounds and matches
// ---------------------------------------------------------------------------

/**
 * Riot's match `status` is not a finality signal.
 *
 * In the live event this page was built against, 21 of 22 matches read
 * `IN_PROGRESS` inside rounds Riot had marked `FINALIZED`, on a capture whose
 * own status was `final`. So finality is read off the round, and failing that
 * off the capture - never off the match.
 */
export function roundIsFinal(round: TournamentRound, results: TournamentResults): boolean {
  if (round.status) return round.status.toUpperCase() === 'FINALIZED';
  return results.status === 'final';
}

/** A short label for a round that has not been finalised, or '' when it has. */
export function roundStatusLabel(round: TournamentRound, results: TournamentResults): string {
  if (roundIsFinal(round, results)) return '';
  if (!round.status) return 'In progress';
  return titleCaseEnum(round.status);
}

/** `IN_PROGRESS` -> `In progress`. Riot's enums, read as English. */
export function titleCaseEnum(value: string): string {
  const words = value.replace(/_/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Section 0 is the swiss; anything after it is a cut. */
export function sectionLabel(section: number): string {
  return section === 0 ? '' : `Stage ${section + 1}`;
}

/**
 * Riot's side outcome enum, as the outcome vocabulary the rest of the UI uses.
 *
 * A drawn match comes back as **`TIE`**, not `DRAW` - the live event this page
 * was built against has two of them. Mapping only `DRAW` turned a recorded
 * draw into an unrecorded match: a `?` badge and "Not recorded" over a 1-1 the
 * standings had already counted as `1D`.
 */
/**
 * A side's result, in this page's vocabulary.
 *
 * Matched case-insensitively against both vocabularies on purpose. The API
 * normalises to lowercase `win`/`loss`/`draw`/`unknown` now, but Riot's own
 * words used to come through verbatim and a draw arrived as `TIE` - never
 * `DRAW`. Keeping both means the page reads an old capture and a new one the
 * same way, in either deploy order. Anything else - `FORFEIT`,
 * `DISQUALIFIED`, `NO_SHOW` - is `unknown` rather than guessed at.
 */
export function sideOutcome(side: TournamentMatchSide | null | undefined): GameOutcome {
  switch (side?.outcome?.toUpperCase()) {
    case 'WIN':
      return 'win';
    case 'LOSS':
      return 'loss';
    case 'TIE':
    case 'DRAW':
    case 'DRAWN':
      return 'draw';
    default:
      return 'unknown';
  }
}

/**
 * Games that were actually played.
 *
 * Riot pre-creates a Bo3's third game slot, so a 2-0 arrives with a third game
 * whose `winnerTeamId` is null. Rendering it would invent a game that never
 * happened.
 */
export function playedGames(match: TournamentMatch): TournamentMatch['games'] {
  return match.games.filter((game) => game.winnerTeamId !== null);
}

/** A played game, from one side's point of view. */
export function gameOutcomeForTeam(winnerTeamId: string | null, teamId: string): GameOutcome {
  if (winnerTeamId === null) return 'unknown';
  return winnerTeamId === teamId ? 'win' : 'loss';
}

/** Whether a match has a recorded verdict - read off the sides, not the status. */
export function matchDecided(match: TournamentMatch): boolean {
  if (match.bye) return true;
  return match.sides.some((side) => sideOutcome(side) !== 'unknown');
}

/** Whether anything was played, even if nobody recorded who won the match. */
export function matchHasPlay(match: TournamentMatch): boolean {
  return playedGames(match).length > 0 || match.sides.some((side) => side.gameWins > 0);
}

/**
 * The matches of a round in table order.
 *
 * The capture used to list them in whatever order Riot's software returned -
 * round 1 of the live event arrived 7, 6, 4, 3, 2, 1, 5, and 21 of the
 * corpus's 87 rounds were out of order - and a reader looking for their table
 * should not have to scan for it. The API sorts server-side now, so this is a
 * no-op re-sort; it is kept because a stable client-side order costs nothing
 * and the page should not go back to depending on upstream order. Byes carry
 * no table and go last.
 */
export function orderedMatches(round: TournamentRound): TournamentMatch[] {
  return [...round.matches].sort((a, b) => {
    const left = a.tableNumber ?? Number.MAX_SAFE_INTEGER;
    const right = b.tableNumber ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.matchId.localeCompare(b.matchId);
  });
}

/**
 * The byes that are not already a row.
 *
 * A bye used to arrive **twice** - once synthesised as a match with
 * `bye: true`, and again in `byes` / `byeTeamIds` - which printed every bye
 * player twice, in 42 of the live corpus's 87 rounds. The API sends it once
 * now, in `byes` only, and no `bye-` prefixed match id leaves it at all.
 *
 * This de-dupe is kept rather than deleted, because it is what makes the page
 * read correctly under either shape and in either deploy order:
 *   - no bye matches (the shape now) -> nothing is covered, so every listed
 *     bye is returned, exactly once;
 *   - both shapes (the older one) -> the match is the row and nothing is
 *     printed a second time;
 *   - `byes`/`byeTeamIds` gone instead -> there is nothing left to list, and
 *     the byes come from the matches alone;
 *   - a field dropped entirely rather than emptied -> the `?? []` below,
 *     because `undefined.map` is a blank page, not a missing bye.
 */
export function unlistedByes(round: TournamentRound): TournamentSidePlayer[] {
  const covered = new Set(
    (round.matches ?? [])
      .filter((match) => match.bye)
      .flatMap((match) => (match.sides ?? []).map((side) => side.teamId))
  );
  const byes = round.byes ?? [];
  const byeTeamIds = round.byeTeamIds ?? [];
  const byTeam = new Map(byeTeamIds.map((teamId, index) => [teamId, byes[index] ?? null]));
  if (byTeam.size === 0) return byes.filter(() => covered.size === 0);
  return [...byTeam.entries()]
    .filter(([teamId]) => !covered.has(teamId))
    .map(([, player]) => player)
    .filter((player): player is TournamentSidePlayer => player !== null);
}

/** "2 - 0" from the sides' game wins, in the order the sides are listed. */
export function matchScore(match: TournamentMatch): string {
  if (match.sides.length === 0) return '--';
  return match.sides.map((side) => side.gameWins).join(' - ');
}

/** A standing's record as the site writes records: `4-0` or `3-1-1`. */
export function standingRecord(standing: {
  matchWins: number | null;
  matchLosses: number | null;
  matchDraws: number | null;
}): string {
  const wins = standing.matchWins ?? 0;
  const losses = standing.matchLosses ?? 0;
  const draws = standing.matchDraws ?? 0;
  return draws > 0 ? `${wins}-${losses}-${draws}` : `${wins}-${losses}`;
}

/** Riot's tiebreakers arrive as fractions rounded to 4 places. */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined) return '--';
  return `${(fraction * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// What to say about a capture
// ---------------------------------------------------------------------------

/**
 * Why standings are not final, as the hint on the "Not final" chip.
 *
 * The chip is the signal and it sits on the thing it qualifies, so there is
 * no banner as well.
 */
export const NOT_FINAL_REASON =
  'This event was still running when its standings were recorded.';

/**
 * Why there are no pairings, as one line.
 *
 * `trimmed: true` means `rounds` is empty while `standings` is complete - the
 * round-by-round detail was dropped to fit the stored item. The page states
 * that there are no pairings and stops; the reason is the hover hint, not
 * prose beside it, and the storage limit is our plumbing either way.
 */
export const TRIMMED_LABEL = 'Pairings not stored for this event.';

/** The reason, as the hint on that line. */
export function trimmedReason(results: TournamentResults): string {
  return `${results.playerCount} players over ${results.roundCount} ${plural(results.roundCount, 'round')} was too much round-by-round detail to keep. The standings are complete.`;
}

/**
 * What this list is, in one line.
 *
 * A qualifier on the data shown, not exposition: where the names came from,
 * and - when no games were recorded - that none of it earned anybody
 * anything, because a table of ratings under a finished event otherwise
 * implies it did.
 */
export function rosterNote(
  roster: TournamentRoster,
  results: TournamentResults | null
): string {
  const source =
    roster.source === 'registrants'
      ? 'Sign-ups recorded before the event'
      : 'Recovered from the field that played';
  const noGames = !results || results.status === 'none';
  return noGames
    ? `${source}; no games were recorded, so nothing here counts towards a rating.`
    : `${source}.`;
}

/**
 * The rows a roster table should actually offer columns for.
 *
 * A played event's entries carry no waitlist state, so offering the column
 * would be a column of em-dashes.
 *
 * **`checkedIn` and `registeredAt` are no longer offered as columns**, and the
 * difference between the two absences matters:
 *
 *  - **Check-in is not kept anywhere else, and nothing wanted it.** It is a
 *    door-management state on Riot's side, true of a roster for a few hours
 *    around one event, and it told a reader of this page nothing about the
 *    field.
 *  - **The sign-up time is load-bearing data and is only dropped from this
 *    view.** `acceptedTermsAt` is what reconstructs an event's whole signup
 *    curve from a single snapshot, which is the reason the scraper fetches a
 *    roster once instead of polling - and a *dated* roster exists only on an
 *    event that has not started yet, so it is unrecoverable afterwards (see
 *    scraper/CLAUDE.md, "Rosters are a different story, and worse"). So
 *    nothing in the scraper, the stored fact or the API payload changed:
 *    `TournamentRosterEntry.registeredAt` still travels, and
 *    `formatClock` below still formats it for the capture line. This table
 *    simply stops being the place it is read, because a column of
 *    minute-precision timestamps is not what anyone opens a roster for.
 */
export function rosterColumns(roster: TournamentRoster): {
  waitlist: boolean;
} {
  return {
    waitlist: roster.entries.some((entry) => entry.waitlistPosition !== null),
  };
}

/** A capture or sign-up time, to the minute. Dates are elsewhere on the page. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '--';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '--';
  return value.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Which scene the event belongs to
// ---------------------------------------------------------------------------

/**
 * A discriminated union rather than one shape with empty strings in it, so the
 * page cannot read a name off a state that has none, and so the scene case
 * carries its `componentId` as a plain string - the one the two links are
 * built from - instead of making the caller assert that a nullable field is
 * not null.
 */
export type SceneLine =
  /** Render nothing. */
  | { kind: 'none' }
  /** Render one muted line; `hint` says why there is no scene yet. */
  | { kind: 'pending'; hint: string }
  | {
      kind: 'scene';
      /**
       * The **component** to link the ladder and the map at, or null when the
       * engine has placed nobody who played here.
       *
       * Deliberately not the scene id, and the distinction is the whole point
       * of this type. The name above is the scene's; this is the rating pool
       * those players sit in, which is what a ladder is scoped to - there is
       * no scene-scoped ladder to link at, because a scene does not define a
       * rating scale and `componentId` does. The hint says so in words rather
       * than letting the link imply the two are one thing.
       */
      componentId: string | null;
      /** The scene's name, or `Scene <id>` when the engine has no label. */
      name: string;
      /** `62 players · 8 rated · 4 stores` - the scene's size, not this event's. */
      summary: string;
      /** The hover hint: what the claim rests on, and any caveat on it. */
      hint: string;
      /** True when the event's placed players do not all agree on the component. */
      partial: boolean;
    };

/**
 * The scene line, decided once.
 *
 * ## What the line asserts, and what it must not
 *
 * **The scene is the store's**, not the attending players'. A scene is a set
 * of stores near enough to each other that their players genuinely play each
 * other, the engine assigns one to each store, and this event was held at a
 * store - so the claim is a lookup rather than an inference, and it does not
 * depend on who turned up or on whether the ladder has replayed them.
 *
 * The line used to name the connected component of the players who played
 * here, and that was wrong in a way a reader could see. Reachability is a
 * transitive closure, so one travelling player merges two cities into a single
 * component and no amount of coverage ever separates them again: a measured
 * production component held 1,688 players over 110 venues across 1,514km,
 * carried the label `New York, New York`, and had all five of its busiest
 * stores in California. A shop in Redwood City read "Scene: New York, New
 * York" on its own page. This is the fix for that.
 *
 * ## The link still goes to the component, and the hint says so
 *
 * A ladder is scoped to a `componentId`, because a component is what makes two
 * ratings comparable - a scene does not define a rating scale, so there is no
 * scene-scoped ladder to link at. The name is therefore the scene's and the
 * link is the rating pool's, which is two facts rather than one, so the hint
 * states both instead of letting the link imply they are the same thing.
 * `partial` keeps its old meaning: the placed players do not all share one
 * component, which happens when an event's pairings did not connect everyone,
 * or when the engine has not replayed this event yet.
 *
 * ## Why there are four answers and not two
 *
 * `null` would collapse genuinely different states into one silence:
 *
 * - **no matches**, and **no venue.** Nothing to say, and the page says
 *   nothing. A line reading "no scene" where no game was ever played is the
 *   same absence twice - the page already says the event has no standings -
 *   and a line about a store the event does not name has nothing to attach to.
 * - **unassigned.** The store is known and is not in a scene yet. Worth one
 *   muted line, because "this event has no scene" and "this store is not in a
 *   rankable scene yet" are different claims and only the second is true. It
 *   is also the common case today.
 * - **a scene.**
 *
 * The caller still decides whether to render any of it: Rankings is unlisted,
 * so this line exists only inside the preview flag.
 */
export function sceneLine(scene: TournamentScene, minComponentSize: number): SceneLine {
  if (scene.status === 'no-matches' || scene.status === 'no-venue') {
    return { kind: 'none' };
  }

  if (scene.status === 'unassigned' || scene.sceneId === null) {
    return {
      kind: 'pending',
      // Said as a fact about our map of the scenes rather than about the
      // event: the games happened, and what is missing is that this store has
      // not been grouped with its neighbours. A scene is only drawn where the
      // stores in it play each other enough for a ladder to mean anything, so
      // "not yet" is sometimes permanent and the wording promises nothing.
      hint:
        'This store is not in a rankable scene yet. A scene pools nearby stores whose players ' +
        'actually play each other, so one is only drawn where there is enough play between them ' +
        'to rank anybody - the games here still count towards every ladder they belong to.',
    };
  }

  // A scene whose stores are not reverse-geocoded yet has no name, and that is
  // the engine's normal output rather than a gap to paper over - so the id
  // stands in, the way the ladder's own picker does it, and nothing is
  // invented from a player's home city.
  const name =
    scene.sceneLabel && scene.sceneLabel.trim().length > 0
      ? scene.sceneLabel.trim()
      : `Scene ${scene.sceneId}`;

  // The scene's own size, from the scene - never this event's field, and never
  // the component's, which spans several scenes and would overstate it by an
  // order of magnitude.
  const parts: string[] = [];
  if (scene.scenePlayers !== null) {
    parts.push(`${scene.scenePlayers.toLocaleString()} ${plural(scene.scenePlayers, 'player')}`);
  }
  if (scene.sceneRatedPlayers !== null) {
    // Printed even at zero: at this coverage that is the common case and it is
    // informative, exactly as it is on the map's own scene summary.
    parts.push(`${scene.sceneRatedPlayers.toLocaleString()} rated`);
  }
  if (scene.sceneVenues !== null) {
    parts.push(`${scene.sceneVenues.toLocaleString()} ${plural(scene.sceneVenues, 'store')}`);
  }

  const partial = scene.componentCount > 1;
  const basis =
    'This store belongs to this scene - a group of nearby stores whose players play each other. ' +
    (scene.placedPlayers > 0
      ? `The ladder it links to is the wider pool of ${
          scene.componentSize === null
            ? 'players'
            : `${scene.componentSize.toLocaleString()} players`
        } whose ratings are on one scale with the ${scene.matchPlayers.toLocaleString()} ` +
        `${plural(scene.matchPlayers, 'player')} who played here.`
      : 'The ladder has not placed anybody who played here yet, so there is no rating pool to ' +
        'link to.');

  // The size caveat, in the ladder's own words, and still about the component:
  // it is the component's size that decides whether an order is a placement.
  // Asked only when it is genuinely too small - a settled rating in a pool of
  // four is a real number with no position behind it, which is a different
  // thing from the evidence problems `ratingExplanation` covers.
  const tooSmall =
    scene.placedPlayers === 0 || scene.comparable
      ? null
      : sceneTooSmallExplanation(scene.componentSize, minComponentSize);

  const split = partial
    ? ` Those players sit in ${scene.componentCount.toLocaleString()} different rating pools, ` +
      'which happens when the ladder has not replayed this event yet.'
    : '';

  return {
    kind: 'scene',
    componentId: scene.componentId,
    name,
    summary: parts.join(' · '),
    hint: [basis + split, tooSmall].filter((part): part is string => part !== null).join(' '),
    partial,
  };
}
