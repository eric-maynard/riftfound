import { describe, it, expect } from 'vitest';
import { UNRANKED_LABEL } from '../ranking';
import type {
  TournamentField,
  TournamentMatch,
  TournamentPlayer,
  TournamentResults,
  TournamentRoster,
  TournamentRound,
} from '../../types/tournament';
import {
  NO_RECORD_LABEL,
  fieldComposition,
  fieldStrength,
  formatPercent,
  gameOutcomeForTeam,
  matchDecided,
  matchHasPlay,
  matchScore,
  playedGames,
  ratingStanding,
  NOT_FINAL_REASON,
  rosterColumns,
  rosterNote,
  roundIsFinal,
  roundStatusLabel,
  sectionLabel,
  orderedMatches,
  sideOutcome,
  standingLabel,
  standingRecord,
  titleCaseEnum,
  TRIMMED_LABEL,
  trimmedReason,
  unlistedByes,
} from '../tournament';

/**
 * The event page's load-bearing rules, tested without a DOM.
 *
 * These are the five things the contract warns about and one copy rule, so a
 * change that quietly re-learns any of them fails here rather than on a page.
 */

function player(overrides: Partial<TournamentPlayer> = {}): TournamentPlayer {
  return {
    playerId: 'p-1',
    teamId: 't-1',
    displayName: 'Kirabosc',
    tagLine: 'NA1',
    known: true,
    rating: 1361,
    uncertainty: 118,
    gamesPlayed: 8,
    matchesPlayed: 4,
    provisional: false,
    provisionalReason: null,
    gamesUntilRated: 0,
    componentId: 'c-1',
    componentSize: 14,
    regionLabel: 'Colorado Springs, CO',
    comparable: true,
    ...overrides,
  };
}

function field(overrides: Partial<TournamentField> = {}): TournamentField {
  return {
    totalPlayers: 24,
    knownPlayers: 9,
    ratedPlayers: 4,
    provisionalPlayers: 5,
    unknownPlayers: 15,
    ratedSample: 4,
    ratedShare: 0.167,
    meanRating: 1536,
    medianRating: 1522,
    topRating: 1690,
    minGamesForRating: 8,
    maxUncertaintyForRating: 120,
    minComponentSize: 8,
    ...overrides,
  };
}

function results(overrides: Partial<TournamentResults> = {}): TournamentResults {
  return {
    status: 'final',
    roundCount: 4,
    playerCount: 14,
    openMatches: 22,
    trimmed: false,
    sourceUpdatedAt: null,
    capturedAt: '2026-10-25T21:45:14.081Z',
    standings: [],
    rounds: [],
    ...overrides,
  };
}

function round(overrides: Partial<TournamentRound> = {}): TournamentRound {
  return {
    section: 0,
    roundNumber: 1,
    status: 'FINALIZED',
    byeTeamIds: [],
    byes: [],
    matches: [],
    ...overrides,
  };
}

describe('ratingStanding', () => {
  it('separates a player with no profile from one below the gate', () => {
    expect(ratingStanding(player())).toBe('rated');
    expect(ratingStanding(player({ provisional: true, rating: null }))).toBe('unranked');
    // The engine has never seen them. Not the same thing, and the difference
    // is the whole point: "Unranked" would claim they failed a bar.
    expect(ratingStanding(player({ known: false, provisional: true, rating: null }))).toBe(
      'no-record'
    );
    expect(ratingStanding(null)).toBe('no-record');
  });

  it('gives the two withheld states different words', () => {
    expect(standingLabel('unranked')).toBe(UNRANKED_LABEL);
    expect(standingLabel('no-record')).toBe(NO_RECORD_LABEL);
    expect(standingLabel('unranked')).not.toBe(standingLabel('no-record'));
    expect(standingLabel('rated')).toBe('');
  });
});

describe('fieldStrength', () => {
  it('never offers a mean without the sample it was taken over', () => {
    const strength = fieldStrength(field());
    expect(strength.hasRating).toBe(true);
    expect(strength.mean).toBe(1536);
    expect(strength.basis).toBe('across the 4 rated players of 24');
    expect(strength.emptyReason).toBeNull();
  });

  it('says why there is no number when nothing cleared the gate', () => {
    const strength = fieldStrength(
      field({ ratedPlayers: 0, ratedSample: 0, ratedShare: 0, meanRating: null, medianRating: null, topRating: null, knownPlayers: 7, provisionalPlayers: 7, unknownPlayers: 15, totalPlayers: 22 })
    );
    expect(strength.hasRating).toBe(false);
    expect(strength.mean).toBeNull();
    expect(strength.emptyReason).toContain('7 of 22');
    expect(strength.emptyReason).toContain('8 recorded games');
  });

  it('distinguishes a field nobody has played in from one nobody has finished', () => {
    const none = fieldStrength(
      field({
        totalPlayers: 12,
        knownPlayers: 0,
        ratedPlayers: 0,
        provisionalPlayers: 0,
        unknownPlayers: 12,
        ratedSample: 0,
        ratedShare: 0,
        meanRating: null,
      })
    );
    expect(none.emptyReason).toContain('has a recorded game yet');
  });

  it('counts the three groups of the field', () => {
    const segments = fieldComposition(field());
    expect(segments.map((segment) => segment.count)).toEqual([4, 5, 15]);
    expect(segments.map((segment) => segment.label)).toEqual(['Rated', UNRANKED_LABEL, 'No record']);
    expect(segments[0].percent).toBeCloseTo((4 / 24) * 100);
  });

  it('does not divide by zero on an empty field', () => {
    const segments = fieldComposition(
      field({ totalPlayers: 0, knownPlayers: 0, ratedPlayers: 0, provisionalPlayers: 0, unknownPlayers: 0, ratedSample: 0, meanRating: null })
    );
    expect(segments.every((segment) => segment.percent === 0)).toBe(true);
  });
});

describe('round finality', () => {
  it('reads finality off the round, not off the matches inside it', () => {
    // The live case: every match reads IN_PROGRESS inside a FINALIZED round.
    const finalised = round({ status: 'FINALIZED' });
    expect(roundIsFinal(finalised, results({ openMatches: 22 }))).toBe(true);
    expect(roundStatusLabel(finalised, results())).toBe('');
  });

  it('falls back to the capture when a round carries no status', () => {
    expect(roundIsFinal(round({ status: null }), results({ status: 'final' }))).toBe(true);
    expect(roundIsFinal(round({ status: null }), results({ status: 'partial' }))).toBe(false);
    expect(roundStatusLabel(round({ status: null }), results({ status: 'partial' }))).toBe(
      'In progress'
    );
  });

  it('reads an unfinished round as what it says', () => {
    expect(roundStatusLabel(round({ status: 'IN_PROGRESS' }), results())).toBe('In progress');
  });

  it('labels only the stages past the swiss', () => {
    expect(sectionLabel(0)).toBe('');
    expect(sectionLabel(1)).toBe('Stage 2');
  });

  it('reads Riot enums as English', () => {
    expect(titleCaseEnum('IN_PROGRESS')).toBe('In progress');
    expect(titleCaseEnum('CONSTRUCTED')).toBe('Constructed');
  });
});

describe('matches', () => {
  const match: TournamentMatch = {
    matchId: 'm-1',
    tableNumber: 7,
    status: 'IN_PROGRESS',
    bye: false,
    sides: [
      { teamId: 'a', outcome: 'WIN', gameWins: 2, player: null },
      { teamId: 'b', outcome: 'LOSS', gameWins: 0, player: null },
    ],
    // Riot pre-creates the third game of a Bo3, so a 2-0 arrives with a null.
    games: [
      { number: 1, winnerTeamId: 'a' },
      { number: 2, winnerTeamId: 'a' },
      { number: 3, winnerTeamId: null },
    ],
  };

  it('drops the games that were never played', () => {
    expect(playedGames(match).map((game) => game.number)).toEqual([1, 2]);
  });

  it('is decided by its sides, not by its status', () => {
    expect(match.status).toBe('IN_PROGRESS');
    expect(matchDecided(match)).toBe(true);
    expect(
      matchDecided({
        ...match,
        sides: match.sides.map((side) => ({ ...side, outcome: null })),
      })
    ).toBe(false);
  });

  it('treats a bye as settled', () => {
    expect(matchDecided({ ...match, bye: true, sides: [] })).toBe(true);
  });

  it('reads a game from each side', () => {
    expect(gameOutcomeForTeam('a', 'a')).toBe('win');
    expect(gameOutcomeForTeam('a', 'b')).toBe('loss');
    expect(gameOutcomeForTeam(null, 'a')).toBe('unknown');
  });

  it('maps Riot outcomes onto the site vocabulary, TIE included', () => {
    expect(sideOutcome(match.sides[0])).toBe('win');
    expect(sideOutcome(match.sides[1])).toBe('loss');
    // Riot sends TIE, not DRAW. Missing it turned a recorded draw into a `?`
    // badge over "No result", on a 1-1 the standings already counted as 1D.
    expect(sideOutcome({ teamId: 'c', outcome: 'TIE', gameWins: 1, player: null })).toBe('draw');
    expect(sideOutcome({ teamId: 'c', outcome: 'DRAW', gameWins: 1, player: null })).toBe('draw');
    expect(sideOutcome({ teamId: 'c', outcome: null, gameWins: 0, player: null })).toBe('unknown');
    expect(sideOutcome(null)).toBe('unknown');
  });

  it('knows a match was played even when no verdict was recorded', () => {
    const noVerdict = { ...match, sides: match.sides.map((s) => ({ ...s, outcome: null })) };
    expect(matchDecided(noVerdict)).toBe(false);
    expect(matchHasPlay(noVerdict)).toBe(true);
    expect(
      matchHasPlay({ ...noVerdict, games: [], sides: noVerdict.sides.map((s) => ({ ...s, gameWins: 0 })) })
    ).toBe(false);
  });

  it('puts a round in table order', () => {
    const mk = (id: string, table: number | null) => ({ ...match, matchId: id, tableNumber: table });
    const r = round({ matches: [mk('a', 7), mk('b', 1), mk('c', null), mk('d', 5)] });
    expect(orderedMatches(r).map((m) => m.matchId)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('scores a match in the order its sides are listed', () => {
    expect(matchScore(match)).toBe('2 - 0');
    expect(matchScore({ ...match, sides: [] })).toBe('--');
  });
});

describe('byes', () => {
  const player = { playerId: 'p-1', displayName: 'Ilyris', tagLine: 'NA1', rating: null, provisional: true };

  it('does not print a bye twice when the capture carries it both ways', () => {
    // A bye arrives once as a synthesised match and again in `byes`.
    const r = round({
      byeTeamIds: ['t-9'],
      byes: [player],
      matches: [
        {
          matchId: 'bye-t-9-r2',
          tableNumber: null,
          status: null,
          bye: true,
          sides: [{ teamId: 't-9', outcome: null, gameWins: 0, player }],
          games: [],
        },
      ],
    });
    expect(unlistedByes(r)).toEqual([]);
  });

  it('still prints a bye the capture gave no row for', () => {
    expect(unlistedByes(round({ byeTeamIds: ['t-9'], byes: [player] }))).toEqual([player]);
    expect(unlistedByes(round())).toEqual([]);
  });

  // The API is dropping one half of the duplication. Either half can go first,
  // and our deploy and theirs are not ordered, so both shapes have to work.
  it('prints the bye once when only the synthesised match arrives', () => {
    const r = round({
      byeTeamIds: [],
      byes: [],
      matches: [
        {
          matchId: 'bye-t-9-r2',
          tableNumber: null,
          status: null,
          bye: true,
          sides: [{ teamId: 't-9', outcome: null, gameWins: 0, player }],
          games: [],
        },
      ],
    });
    // Nothing is left over: the match itself is the row.
    expect(unlistedByes(r)).toEqual([]);
  });

  it('survives the bye fields going missing rather than empty', () => {
    const r = round({ byeTeamIds: ['t-9'], byes: [player] });
    // A dropped field arrives as undefined, and `undefined.map` is a blank
    // page rather than a missing bye.
    const noByes = { ...r, byes: undefined } as unknown as typeof r;
    const noTeamIds = { ...r, byeTeamIds: undefined } as unknown as typeof r;
    const noMatches = { ...r, matches: undefined } as unknown as typeof r;
    expect(unlistedByes(noByes)).toEqual([]);
    expect(unlistedByes(noTeamIds)).toEqual([player]);
    expect(unlistedByes(noMatches)).toEqual([player]);
  });
});

describe('standings', () => {
  it('writes a record the way the rest of the site does', () => {
    expect(standingRecord({ matchWins: 4, matchLosses: 0, matchDraws: 0 })).toBe('4-0');
    expect(standingRecord({ matchWins: 3, matchLosses: 1, matchDraws: 1 })).toBe('3-1-1');
    expect(standingRecord({ matchWins: null, matchLosses: null, matchDraws: null })).toBe('0-0');
  });

  it('formats Riot tiebreaker fractions', () => {
    expect(formatPercent(0.5825)).toBe('58.3%');
    expect(formatPercent(1)).toBe('100.0%');
    expect(formatPercent(null)).toBe('--');
  });
});

describe('capture copy', () => {
  it('states missing pairings once, in a line, with the reason as a hint', () => {
    // The storage limit is plumbing, so it lives in the hint, not in prose -
    // and not in a banner at the top of the page as well.
    expect(TRIMMED_LABEL).toBe('Pairings not stored for this event.');

    const reason = trimmedReason(results({ trimmed: true, playerCount: 512, roundCount: 9 }));
    expect(reason).toContain('512');
    expect(reason).toContain('9 rounds');
  });

  it('keeps the reason a standings capture is not final out of the page body', () => {
    // It is the hint on the "Not final" chip, which sits on the thing it
    // qualifies. openMatches is a data-quality signal, not a finality gate,
    // so a final capture with 22 of them raises nothing at all.
    expect(NOT_FINAL_REASON).toContain('still running');
    expect(results({ openMatches: 22 }).status).toBe('final');
  });
});

describe('roster', () => {
  function roster(overrides: Partial<TournamentRoster> = {}): TournamentRoster {
    return {
      source: 'registrants',
      playerCount: 1,
      capturedAt: '2026-10-25T20:15:38.664Z',
      entries: [
        {
          playerId: 'p-1',
          displayName: 'dan',
          tagLine: 'qqqqq',
          teamId: null,
          status: 'REGISTERED',
          checkedIn: false,
          waitlistPosition: null,
          registeredAt: '2026-10-25T04:31:09.637Z',
          player: player({ known: false, provisional: true, rating: null }),
        },
      ],
      ...overrides,
    };
  }

  it('offers only the columns the source can fill', () => {
    expect(rosterColumns(roster())).toEqual({
      registeredAt: true,
      checkIn: true,
      waitlist: false,
    });

    const recovered = roster({
      source: 'participants',
      entries: roster().entries.map((entry) => ({
        ...entry,
        registeredAt: null,
        checkedIn: null,
        status: 'PLAYED',
      })),
    });
    expect(rosterColumns(recovered)).toEqual({
      registeredAt: false,
      checkIn: false,
      waitlist: false,
    });
  });

  it('says where the list came from in one line', () => {
    expect(rosterNote(roster(), results())).toBe('Sign-ups recorded before the event.');
    expect(rosterNote(roster({ source: 'participants' }), results())).toBe(
      'Recovered from the field that played.'
    );
  });

  it('qualifies a list of ratings nobody earned here', () => {
    // An upcoming event, and a finished one whose pairings were never run:
    // both show ratings that this event did not produce.
    expect(rosterNote(roster(), null)).toContain('counts towards a rating');
    expect(rosterNote(roster(), results({ status: 'none' }))).toContain('no games were recorded');
  });
});
