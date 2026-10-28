import { describe, it, expect } from 'vitest';
import { ratingDisplay, sceneTooSmallExplanation, UNRANKED_LABEL } from '../ranking';
import type {
  TournamentField,
  TournamentMatch,
  TournamentPlayer,
  TournamentResults,
  TournamentRoster,
  TournamentRound,
  TournamentScene,
} from '../../types/tournament';
import {
  fieldComposition,
  fieldStrength,
  formatPercent,
  gameOutcomeForTeam,
  matchDecided,
  matchHasPlay,
  matchScore,
  playedGames,
  NOT_FINAL_REASON,
  rosterColumns,
  rosterNote,
  sceneLine,
  type SceneLine,
  roundIsFinal,
  roundStatusLabel,
  sectionLabel,
  orderedMatches,
  sideOutcome,
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

describe('how a field player\'s rating is shown', () => {
  // This page used to keep its own three-state vocabulary, whose third state
  // printed "No record yet" for `known: false`. The distinction was real in
  // principle and false in practice - a 25-hour-stale engine reported
  // `known: false` for 22 players whose games were on the same page - so it
  // was collapsed into `Unranked`, and the page now reads the site-wide rule.
  it('shows the number whenever the engine will quote one', () => {
    expect(ratingDisplay(player())).toBe('rated');
    expect(ratingDisplay(player({ provisional: true, rating: 1204 }))).toBe('unsettled');
  });

  it('withholds the word for the rows that genuinely have no number', () => {
    expect(ratingDisplay(player({ provisional: true, rating: null }))).toBe('none');
    expect(ratingDisplay(player({ known: false, provisional: true, rating: null }))).toBe('none');
    expect(ratingDisplay(null)).toBe('none');
  });

  it('does not key off `known`, which has been wrong on live data', () => {
    // A player the engine has rated is shown as rated even if the roster's
    // `known` flag disagrees.
    expect(ratingDisplay(player({ known: false, rating: 1361, provisional: false }))).toBe('rated');
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

  it('counts the field in two groups, since the third lost its own word', () => {
    // Was ['Rated', 'Unranked', 'No record'] = [4, 5, 15]. Once the last two
    // print the same word everywhere else, two legend rows both reading
    // "Unranked" would be a puzzle rather than a breakdown.
    const segments = fieldComposition(field());
    expect(segments.map((segment) => segment.count)).toEqual([4, 20]);
    expect(segments.map((segment) => segment.label)).toEqual(['Rated', UNRANKED_LABEL]);
    expect(segments[0].percent).toBeCloseTo((4 / 24) * 100);
    expect(segments[1].percent).toBeCloseTo((20 / 24) * 100);
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

// ---------------------------------------------------------------------------
// Which scene the event belongs to
// ---------------------------------------------------------------------------

/**
 * The shape production actually produced, which is why these tests exist.
 *
 * The component really is `ce3da9bead6`: 1,688 players over 110 venues with a
 * 1,514km spread, labelled `New York, New York`, with all five of its busiest
 * stores in California. The event is at a store on the San Francisco
 * Peninsula. So the component fields and the scene fields disagree here on
 * purpose - a line that reads the wrong one is visibly wrong, and that is the
 * bug this fixture reproduces.
 */
function scene(overrides: Partial<TournamentScene> = {}): TournamentScene {
  return {
    status: 'scene',
    shopExternalId: 1826,
    sceneId: 's4f1c2a0b19',
    sceneLabel: 'Peninsula',
    scenePurity: 0.85,
    sceneVenues: 3,
    scenePlayers: 49,
    sceneRatedPlayers: 4,
    matchPlayers: 14,
    placedPlayers: 14,
    componentCount: 1,
    componentId: 'ce3da9bead6',
    regionLabel: 'New York, New York',
    componentSize: 1688,
    ratedPlayers: 6,
    comparable: true,
    playersInScene: 14,
    ...overrides,
  };
}

/**
 * `sceneLine` is a discriminated union, so a test reads the branch it means
 * rather than a field that may not be there - which is the whole point of the
 * union: there is no name on a line that has no scene.
 */
function asScene(line: SceneLine) {
  if (line.kind !== 'scene') throw new Error(`expected a scene, got ${line.kind}`);
  return line;
}

function asPending(line: SceneLine) {
  if (line.kind !== 'pending') throw new Error(`expected pending, got ${line.kind}`);
  return line;
}

describe('the scene line', () => {
  it('names the venue scene, never the component', () => {
    const line = asScene(sceneLine(scene(), 8));
    // The regression. The component is labelled `New York, New York` and this
    // event is on the San Francisco Peninsula; naming it off the component is
    // exactly the bug a reader reported, so the name must come off the store.
    expect(line.name).toBe('Peninsula');
    expect(line.name).not.toContain('New York');
  });

  it('sizes the line by the scene, not by the component or the event', () => {
    const line = asScene(sceneLine(scene(), 8));
    // 49 is the scene, 1,688 the component, 14 this event's field. Printing
    // the component's size beside the scene's name would overstate the scene
    // by a factor of 34 - the same error as the name, in numbers.
    expect(line.summary).toBe('49 players · 4 rated · 3 stores');
    expect(line.summary).not.toContain('1,688');
    expect(line.partial).toBe(false);
  });

  it('links the ladder at the component, and says that is what it is', () => {
    const line = asScene(sceneLine(scene(), 8));
    // A ladder is only meaningful over one rating scale, and a component is
    // what defines one, so the link stays component-scoped. The hint has to
    // carry that, or the link silently asserts the scene and the pool are the
    // same set of people.
    expect(line.componentId).toBe('ce3da9bead6');
    expect(line.hint).toContain('This store belongs to this scene');
    expect(line.hint).toContain('wider pool of 1,688 players');
  });

  it('prints zero rated rather than omitting it', () => {
    // The common case at this coverage: a real scene with nobody over the bar.
    expect(asScene(sceneLine(scene({ sceneRatedPlayers: 0 }), 8)).summary).toBe(
      '49 players · 0 rated · 3 stores'
    );
  });

  it('falls back to the scene id, never to a home city or a component label', () => {
    // A scene whose stores are not reverse-geocoded has no name. The ladder's
    // own picker shows an id in that state; borrowing the component's label
    // would reintroduce the bug this line was changed to fix.
    expect(asScene(sceneLine(scene({ sceneLabel: null }), 8)).name).toBe('Scene s4f1c2a0b19');
    expect(asScene(sceneLine(scene({ sceneLabel: '   ' }), 8)).name).toBe('Scene s4f1c2a0b19');
  });

  it('still flags a split rating pool instead of asserting one', () => {
    // An event's pairings connect the players they pair, not all of them, and
    // the engine places a player from the history it last replayed - so this
    // state is reachable and must not read as unanimous. Note it is a fact
    // about the *pools*, not about the scene, which cannot be split.
    const line = asScene(sceneLine(scene({ componentCount: 2, playersInScene: 11 }), 8));
    expect(line.partial).toBe(true);
    expect(line.hint).toContain('2 different rating pools');
  });

  it('names the scene even when nobody who played here is placed', () => {
    // The whole point of reading the venue: the store's scene does not depend
    // on the ladder having replayed anybody. The name is printed and the link
    // is withheld, because there is no pool to link at.
    const line = asScene(
      sceneLine(
        scene({ placedPlayers: 0, componentCount: 0, componentId: null, componentSize: null }),
        8
      )
    );
    expect(line.name).toBe('Peninsula');
    expect(line.componentId).toBeNull();
    expect(line.hint).toContain('has not placed anybody who played here');
    // And no size caveat: there is no pool for one to be about.
    expect(line.hint).not.toContain('too small to order');
  });

  it('carries the pool-size caveat in the ladder own words', () => {
    // Verbatim `sceneTooSmallExplanation`, the sentence the ladder this line
    // links to already uses for the same fact - not a second wording of it.
    const line = asScene(sceneLine(scene({ componentSize: 4, comparable: false }), 8));
    expect(line.hint).toContain(sceneTooSmallExplanation(4, 8));
    expect(line.hint).toContain('too small to order anyone (8 players needed)');
    // The ratings are still real, which is the half a reader needs most.
    expect(line.hint).toContain('The rating itself stands');
  });

  it('adds no size caveat to a pool big enough to order', () => {
    expect(asScene(sceneLine(scene(), 8)).hint).not.toContain('too small to order');
  });

  it('says nothing at all when nothing was played', () => {
    // An upcoming event, and the ~29% of finished events whose organiser never
    // ran pairings. There is no scene, and a line saying so would be the same
    // absence the page already reports, twice.
    const line = sceneLine(
      scene({
        status: 'no-matches',
        matchPlayers: 0,
        placedPlayers: 0,
        componentCount: 0,
        componentId: null,
        sceneId: null,
        sceneLabel: null,
      }),
      8
    );
    expect(line.kind).toBe('none');
  });

  it('says nothing when the event has no resolved store', () => {
    // A Riot organiser that never matched a shop row has no venue item, so
    // there is nothing to carry a scene. A line about a store the event does
    // not name would have nothing to attach to.
    const line = sceneLine(
      scene({ status: 'no-venue', shopExternalId: null, sceneId: null, sceneLabel: null }),
      8
    );
    expect(line.kind).toBe('none');
  });

  it('tells no scene apart from a store not in a rankable scene yet', () => {
    // The common state today: the store is known, and the engine has not
    // grouped it with neighbours it plays often enough to rank against. Only
    // the second claim is true, and it is worth one line rather than silence.
    const line = asPending(
      sceneLine(scene({ status: 'unassigned', sceneId: null, sceneLabel: null }), 8)
    );
    expect(line.hint).toContain('not in a rankable scene yet');
    // It says why, rather than promising it will change: a scene is only drawn
    // where there is enough play between the stores to rank anybody.
    expect(line.hint).toContain('actually play each other');
    // And it does not tell the reader their games were wasted.
    expect(line.hint).toContain('still count');
    // No name at all: the union has none to read on this branch, which is what
    // stops a page printing an empty one.
    expect('name' in line).toBe(false);
  });

  it('treats a missing scene id as unassigned whatever the status says', () => {
    // Belt and braces across a deploy skew: an older API that still sends
    // `scene` with no scene fields must not produce a line reading
    // `Scene null`.
    const line = sceneLine(scene({ sceneId: null, sceneLabel: null }), 8);
    expect(line.kind).toBe('pending');
  });
});
