import type { GameOutcome } from '../types/ranking';
import type {
  TournamentField,
  TournamentMatch,
  TournamentMatchSide,
  TournamentPlayer,
  TournamentResults,
  TournamentRound,
  TournamentRoster,
  TournamentSidePlayer,
} from '../types/tournament';
import { NO_RECORD_LABEL, UNRANKED_LABEL } from './ranking';

// Declared in lib/ranking.ts - the player page needs them too - and re-exported
// here so the event page's callers keep importing them from one place.
export { NO_RECORD_LABEL, NO_RECORD_EXPLANATION } from './ranking';

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

/**
 * Three states, not two.
 *
 * `rated`       - a publishable number.
 * `unranked`    - the engine has a profile but it has not cleared the gate.
 * `no-record`   - the engine has never seen this player play at all.
 *
 * The last two are the ones it is easy to collapse, and collapsing them tells
 * a first-time player they failed a bar they never stood at. `known: false` is
 * most of a field at launch: 15 of the 22 signups on the event this page was
 * built against.
 */
export type RatingStanding = 'rated' | 'unranked' | 'no-record';

export function ratingStanding(
  player: Pick<TournamentPlayer, 'known' | 'provisional'> | null | undefined
): RatingStanding {
  if (!player) return 'no-record';
  if (!player.known) return 'no-record';
  return player.provisional ? 'unranked' : 'rated';
}

/** The label for a standing, for the one or two places that need it as text. */
export function standingLabel(standing: RatingStanding): string {
  switch (standing) {
    case 'unranked':
      return UNRANKED_LABEL;
    case 'no-record':
      return NO_RECORD_LABEL;
    default:
      return '';
  }
}

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
  key: 'rated' | 'provisional' | 'unknown';
  label: string;
  count: number;
  percent: number;
}

/**
 * The field's three groups, as counts.
 *
 * Deliberately *not* drawn as a three-segment meter: in this theme the three
 * fills would have to sit above 3:1 on the panel and still be told apart from
 * each other, and the best available pair measures 1.08:1 - two shades nobody
 * could separate. So the page draws the ranking section's one-fill coverage
 * meter for the rated share and prints all three counts in words beside it.
 * `percent` is kept for anything that wants the proportion.
 */
export function fieldComposition(field: TournamentField): FieldSegment[] {
  const total = field.totalPlayers;
  const share = (count: number) => (total > 0 ? (count / total) * 100 : 0);
  return [
    { key: 'rated', label: 'Rated', count: field.ratedPlayers, percent: share(field.ratedPlayers) },
    {
      key: 'provisional',
      label: UNRANKED_LABEL,
      count: field.provisionalPlayers,
      percent: share(field.provisionalPlayers),
    },
    {
      key: 'unknown',
      label: 'No record',
      count: field.unknownPlayers,
      percent: share(field.unknownPlayers),
    },
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
 * The capture lists them in whatever order Riot's software returned - round 1
 * of the live event arrives 7, 6, 4, 3, 2, 1, 5 - and a reader looking for
 * their table should not have to scan for it. Byes carry no table and go last.
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
 * A bye arrives **twice**: once synthesised as a match with `bye: true`, and
 * again in `byes` / `byeTeamIds`. Rendering both printed every bye player
 * twice, so this returns only the ones no match already covers.
 *
 * It has to survive either half of that duplication going away, in either
 * deploy order:
 *   - the synthesised match dropped -> nothing is covered, so every listed
 *     bye is returned;
 *   - `byes`/`byeTeamIds` dropped -> there is nothing left to list, and the
 *     byes come from the matches alone;
 *   - the field dropped entirely rather than emptied -> the `?? []` below,
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
