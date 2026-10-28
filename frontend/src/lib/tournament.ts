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
import { sceneTooSmallExplanation, UNRANKED_LABEL } from './ranking';

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

export interface FieldStrength {
  /** Whether there is a number to show at all. */
  hasRating: boolean;
  mean: number | null;
  median: number | null;
  top: number | null;
  /**
   * Who the number describes - never omitted beside the number.
   *
   * "across the 4 rated players of 24" rather than a bare figure. The rated
   * subset is systematically the regulars (8+ recorded games), so a mean over
   * them overstates the room, and `ratedShare` is exactly what lets the copy
   * say so instead of implying otherwise.
   */
  basis: string;
  /** The honest headline when nothing has cleared the gate. */
  emptyReason: string | null;
}

export function fieldStrength(field: TournamentField): FieldStrength {
  const { ratedSample, totalPlayers, knownPlayers, minGamesForRating } = field;

  if (ratedSample === 0 || field.meanRating === null) {
    return {
      hasRating: false,
      mean: null,
      median: null,
      top: null,
      basis: `0 of ${totalPlayers} ${plural(totalPlayers, 'player')} rated`,
      emptyReason:
        knownPlayers === 0
          ? `None of these ${totalPlayers} ${plural(totalPlayers, 'player')} has a recorded game yet, so there is no rating to average.`
          : `${knownPlayers} of ${totalPlayers} have played before, but none has reached ${minGamesForRating} recorded games, so there is no rating to average.`,
    };
  }

  return {
    hasRating: true,
    mean: field.meanRating,
    median: field.medianRating,
    top: field.topRating,
    basis: `across the ${ratedSample} rated ${plural(ratedSample, 'player')} of ${totalPlayers}`,
    emptyReason: null,
  };
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

export interface FieldSegment {
  key: 'rated' | 'unranked';
  label: string;
  count: number;
  percent: number;
}

/**
 * The field's groups, as counts.
 *
 * **Two groups, not three.** It used to separate "Unranked" from "No record",
 * and once those two print the same word in every other place on the site, two
 * legend rows reading `Unranked` would be a puzzle rather than a breakdown.
 * The split was never load-bearing here anyway - what the block is for is the
 * rated share.
 *
 * Deliberately *not* drawn as a segmented meter: in this theme the fills would
 * have to sit above 3:1 on the panel and still be told apart from each other,
 * and the best available pair measures 1.08:1 - two shades nobody could
 * separate. So the page draws the ranking section's one-fill coverage meter
 * for the rated share and prints the counts in words beside it. `percent` is
 * kept for anything that wants the proportion.
 */
export function fieldComposition(field: TournamentField): FieldSegment[] {
  const total = field.totalPlayers;
  const share = (count: number) => (total > 0 ? (count / total) * 100 : 0);
  const unranked = field.provisionalPlayers + field.unknownPlayers;
  return [
    { key: 'rated', label: 'Rated', count: field.ratedPlayers, percent: share(field.ratedPlayers) },
    { key: 'unranked', label: UNRANKED_LABEL, count: unranked, percent: share(unranked) },
  ];
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
 * A `participants` roster has no sign-up times and a played event's entries
 * carry no check-in or waitlist state, so offering those columns would be
 * three columns of em-dashes.
 */
export function rosterColumns(roster: TournamentRoster): {
  registeredAt: boolean;
  checkIn: boolean;
  waitlist: boolean;
} {
  return {
    registeredAt: roster.entries.some((entry) => entry.registeredAt !== null),
    checkIn: roster.entries.some((entry) => entry.checkedIn !== null),
    waitlist: roster.entries.some((entry) => entry.waitlistPosition !== null),
  };
}

/** Sign-up time, to the minute. Dates are elsewhere on the page. */
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
