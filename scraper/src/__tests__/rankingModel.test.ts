import { describe, it, expect } from 'vitest';
import {
  MatchResult,
  ObservationBuilder,
  resolveMatchResult,
  sliceMatches,
} from '../ranking/observations.js';
import { buildEras } from '../ranking/sets.js';
import {
  DEFAULT_ELO_ORIGIN,
  ELO_PER_NAT,
  fitWhr,
  latestRating,
  natToElo,
  observationWeights,
  parseTierWeights,
  ratingOnDay,
  tierWeightFor,
  DEFAULT_TIER_WEIGHTS,
  DEFAULT_WHR_OPTIONS,
} from '../ranking/whr.js';
import { connectivityReport, findComponents } from '../ranking/graph.js';
import { validate } from '../ranking/validate.js';
import type { EventResults, EventRoster } from '../database.js';

/**
 * The rating model.
 *
 * The tests that matter here are the ones pinning down the properties the whole
 * design rests on:
 *
 * - **the prior keeps disconnected clusters from floating.** Two closed pools
 *   that never meet must both centre on the prior mean, with their internal
 *   order intact. This is the failure mode plain Elo dresses up as a result.
 * - **a known-answer fit.** A strict dominance order has to come out in order,
 *   symmetric about the anchor, and the strongest player's uncertainty must be
 *   the widest of the three (an unbeaten record is less informative per game).
 * - **byes never become games**, however they reach the fact row.
 * - **uncertainty tracks evidence**, so the publishing bar can rely on it.
 */

const eras = buildEras();

interface MatchSpec {
  /** Indices into the event's player list. */
  a: number;
  b: number;
  /** 'a' | 'b' | 'draw' */
  winner: 'a' | 'b' | 'draw';
  /** Per-game winners; defaults to a single game won by the match winner. */
  games?: ('a' | 'b')[];
  bye?: boolean;
  matchId?: string;
}

function results(options: {
  id: string;
  date: string;
  players: string[];
  matches: MatchSpec[];
  eventType?: string;
  shopExternalId?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  playerIds?: (string | null)[];
}): EventResults {
  const {
    id,
    date,
    players,
    matches,
    eventType = 'Nexus Night',
    shopExternalId = 1,
    latitude = 37.77,
    longitude = -122.42,
  } = options;
  const teamId = (index: number) => `t-${id}-${index}`;
  return {
    externalId: `prb-${id}`,
    tournamentId: id,
    eventStartDate: new Date(`${date}T18:00:00.000Z`),
    eventType,
    playFormat: null,
    shopExternalId,
    latitude,
    longitude,
    status: 'final',
    roundCount: 1,
    playerCount: players.length,
    openMatches: 0,
    players: players.map((playerId, index) => ({
      teamId: teamId(index),
      playerId: options.playerIds ? options.playerIds[index] : playerId,
      name: `Name ${playerId}`,
      tagLine: 'NA1',
    })),
    standings: players.map((_, index) => ({
      rank: index + 1,
      teamId: teamId(index),
      matchPoints: (players.length - index) * 3,
      matchWins: players.length - index - 1,
      matchLosses: index,
      matchDraws: 0,
      opponentMatchWinPct: 0.5,
      gameWinPct: 1 - index / players.length,
      opponentGameWinPct: 0.5,
    })),
    rounds: [
      {
        section: 0,
        roundNumber: 1,
        status: 'FINALIZED',
        byeTeamIds: [],
        matches: matches.map((match, index) => {
          const games = match.games ?? (match.winner === 'draw' ? [] : [match.winner]);
          return {
            matchId: match.matchId ?? `${id}-m${index}`,
            tableNumber: index + 1,
            status: 'COMPLETED',
            bye: match.bye ?? false,
            sides: [
              {
                teamId: teamId(match.a),
                outcome: match.winner === 'draw' ? 'DRAW' : match.winner === 'a' ? 'WIN' : 'LOSS',
                gameWins: games.filter(game => game === 'a').length,
              },
              {
                teamId: teamId(match.b),
                outcome: match.winner === 'draw' ? 'DRAW' : match.winner === 'b' ? 'WIN' : 'LOSS',
                gameWins: games.filter(game => game === 'b').length,
              },
            ],
            games: games.map((game, gameIndex) => ({
              number: gameIndex + 1,
              winnerTeamId: teamId(game === 'a' ? match.a : match.b),
            })),
          };
        }),
      },
    ],
    sourceUpdatedAt: null,
    capturedAt: '2026-10-25T00:00:00.000Z',
  };
}

/** A round robin where players[0] beats everyone, [1] beats all but [0], etc. */
function dominanceLadder(id: string, date: string, players: string[], shopExternalId = 1) {
  const matches: MatchSpec[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      matches.push({ a: i, b: j, winner: 'a', games: ['a', 'a'], matchId: `${id}-${i}-${j}` });
    }
  }
  return results({ id, date, players, matches, shopExternalId });
}

function build(facts: (EventResults | EventRoster)[], collectStandings = false) {
  const builder = new ObservationBuilder(eras, new Map(), Number.POSITIVE_INFINITY, collectStandings);
  for (const fact of facts) {
    if ('rounds' in fact) builder.addResults(fact);
    else builder.addRoster(fact);
  }
  return builder.finish();
}

describe('observation extraction', () => {
  it('turns pairings into paired comparisons and keeps per-game detail', () => {
    const observations = build([
      results({
        id: 'e1',
        date: '2026-10-20',
        players: ['p1', 'p2'],
        matches: [{ a: 0, b: 1, winner: 'a', games: ['a', 'b', 'a'] }],
      }),
    ]);

    expect(observations.stats.matchesUsed).toBe(1);
    expect(observations.stats.gamesUsed).toBe(3);
    expect(observations.result[0]).toBe(MatchResult.AWin);
    expect(observations.gameWinners[0]).toEqual([MatchResult.AWin, MatchResult.BWin, MatchResult.AWin]);
    expect(observations.players).toEqual(['p1', 'p2']);
  });

  it('never lets a bye become a game, by any route it can reach a fact row', () => {
    const flagged = results({
      id: 'e2',
      date: '2026-10-20',
      players: ['p1', 'p2'],
      matches: [{ a: 0, b: 1, winner: 'a', bye: true }],
    });

    // A bye-prefixed team id on a match the row does *not* flag: the upstream
    // filter is meant to make this impossible, so it is counted as a leak.
    const leaked = results({
      id: 'e3',
      date: '2026-10-21',
      players: ['p1', 'bye-player'],
      matches: [{ a: 0, b: 1, winner: 'a' }],
    });
    leaked.players[1] = { teamId: 'bye-team-9', playerId: 'bye-player', name: 'BYE', tagLine: null };
    leaked.rounds[0].matches[0].sides[1].teamId = 'bye-team-9';

    const observations = build([flagged, leaked]);
    expect(observations.stats.matchesUsed).toBe(0);
    // Both are skipped as byes: the flagged one by its flag, the leaked one by
    // the id check - which is the point of re-checking ids here at all.
    expect(observations.stats.byeMatchesSkipped).toBe(2);
    expect(observations.stats.byeLeaks).toBeGreaterThan(0);
    expect(observations.players).not.toContain('bye-player');
  });

  it('skips a pairing whose team has no player behind it rather than inventing one', () => {
    const orphan = results({
      id: 'e4',
      date: '2026-10-20',
      players: ['p1', 'p2'],
      matches: [{ a: 0, b: 1, winner: 'a' }],
      playerIds: ['p1', null],
    });
    const observations = build([orphan]);
    expect(observations.stats.matchesUsed).toBe(0);
    expect(observations.stats.unmappedTeamSkipped).toBe(1);
  });

  it('is keyed on the player UUID, not the display name', () => {
    const first = results({ id: 'e5', date: '2026-10-20', players: ['p1', 'p2'], matches: [{ a: 0, b: 1, winner: 'a' }] });
    const renamed = results({ id: 'e6', date: '2026-10-22', players: ['p1', 'p2'], matches: [{ a: 0, b: 1, winner: 'b' }] });
    renamed.players[0] = { ...renamed.players[0], name: 'Totally Different Name' };

    const observations = build([first, renamed]);
    expect(observations.players).toEqual(['p1', 'p2']);
    // Presentation data follows the most recent sighting.
    expect(observations.displayNames[0]).toBe('Totally Different Name');
  });

  it('ignores a repeated match id, so a fact row read twice cannot double-count', () => {
    const event = results({ id: 'e7', date: '2026-10-20', players: ['p1', 'p2'], matches: [{ a: 0, b: 1, winner: 'a' }] });
    const builder = new ObservationBuilder(eras);
    builder.addResults(event);
    builder.addResults({ ...event, externalId: 'prb-e7-copy' });
    expect(builder.finish().stats.duplicateMatchSkipped).toBe(1);
  });

  it('reads the winner from the game tally when the outcome strings are missing', () => {
    // Riot leaves matches IN_PROGRESS inside finalised rounds; the tally decides.
    expect(resolveMatchResult(null, null, 2, 0)).toBe(MatchResult.AWin);
    expect(resolveMatchResult(null, null, 0, 2)).toBe(MatchResult.BWin);
    expect(resolveMatchResult(null, null, 1, 1)).toBe(MatchResult.Draw);
    expect(resolveMatchResult(null, null, 0, 0)).toBeNull();
    expect(resolveMatchResult('WIN', 'LOSS', 0, 0)).toBe(MatchResult.AWin);
    expect(resolveMatchResult('DRAW', 'DRAW', 0, 0)).toBe(MatchResult.Draw);
  });

  it('takes a player firstSeen from a dated registration, not the event date', () => {
    const roster: EventRoster = {
      externalId: 'prb-e8',
      tournamentId: 'e8',
      eventStartDate: new Date('2026-10-20T18:00:00.000Z'),
      eventType: 'Nexus Night',
      playFormat: null,
      shopExternalId: 1,
      latitude: 37.77,
      longitude: -122.42,
      source: 'registrants',
      playerCount: 1,
      entries: [
        {
          playerId: 'p1',
          name: 'One',
          tagLine: 'NA1',
          teamId: null,
          status: 'ACCEPTED',
          checkedIn: true,
          waitlistPosition: null,
          registeredAt: '2026-10-01T12:00:00.000Z',
        },
      ],
      capturedAt: '2026-10-20T00:00:00.000Z',
    };
    const observations = build([roster]);
    expect(new Date(observations.firstSeen[0]).toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(observations.stats.rosterOnlyPlayers).toBe(1);
  });
});

describe('observation weights', () => {
  it('counts every recorded game in game mode', () => {
    expect(observationWeights(MatchResult.AWin, [1, 1], { observationLevel: 'game', weightScale: 1 })).toEqual([2, 0]);
    expect(observationWeights(MatchResult.AWin, [1, 2, 1], { observationLevel: 'game', weightScale: 1 })).toEqual([2, 1]);
  });

  it('keeps a match to one unit of evidence by default', () => {
    const [a, b] = observationWeights(MatchResult.AWin, [1, 2, 1], { observationLevel: 'game-shared', weightScale: 1 });
    expect(a + b).toBeCloseTo(1, 10);
    expect(a).toBeCloseTo(2 / 3, 10);
  });

  it('falls back to the match when no game winner was recorded', () => {
    // 3.2% of real matches: a result published with no per-game detail still
    // has to count exactly once rather than disappearing.
    expect(observationWeights(MatchResult.BWin, [], { observationLevel: 'game-shared', weightScale: 1 })).toEqual([0, 1]);
    expect(observationWeights(MatchResult.Draw, [], { observationLevel: 'game-shared', weightScale: 1 })).toEqual([0.5, 0.5]);
  });
});

describe('event tier weights', () => {
  /**
   * The mechanism, not the policy. The shipped table is empty on purpose - see
   * DEFAULT_TIER_WEIGHTS and "is an event tier worth a weight?" in
   * scraper/CLAUDE.md - so what has to be pinned is that the knob does exactly
   * what it claims when someone sets it, and nothing at all when they do not.
   */
  it('ships neutral: every tier counts the same until someone says otherwise', () => {
    expect(DEFAULT_TIER_WEIGHTS).toEqual({});
    expect(DEFAULT_WHR_OPTIONS.defaultTierWeight).toBe(1);
    expect(tierWeightFor('World Championship', DEFAULT_WHR_OPTIONS)).toBe(1);
    expect(tierWeightFor('Learn to Play', DEFAULT_WHR_OPTIONS)).toBe(1);
  });

  it('gives an unknown or future tier the default weight, never zero', () => {
    // Riot's enum grows - eight of its eleven values were unmapped here until
    // 2026-10-26 - so an unrecognised tier must not be silently discounted.
    const options = { tierWeights: { 'Nexus Night': 2 }, defaultTierWeight: 1 };
    expect(tierWeightFor('Some Future Tier', options)).toBe(1);
    expect(tierWeightFor(null, options)).toBe(1);
    expect(tierWeightFor('Nexus Night', options)).toBe(2);
  });

  it('scales a match\'s whole evidence, leaving the win/loss split alone', () => {
    const level = { observationLevel: 'game-shared' as const, weightScale: 1 };
    const [a1, b1] = observationWeights(MatchResult.AWin, [1, 2, 1], level, 1);
    const [a2, b2] = observationWeights(MatchResult.AWin, [1, 2, 1], level, 2);
    expect(a2).toBeCloseTo(a1 * 2, 10);
    expect(b2).toBeCloseTo(b1 * 2, 10);
    expect(a2 + b2).toBeCloseTo(2, 10);
    expect(observationWeights(MatchResult.AWin, [1, 2, 1], level, 0)).toEqual([0, 0]);
  });

  it('a weighted tier narrows the posterior, which is why it is not a free knob', () => {
    // Up-weighting a tier is arithmetically the same as having played those
    // matches more often, so it narrows the uncertainty the publishing bar is
    // set on - a rating can clear the bar on no extra real evidence.
    const observations = build([
      dominanceLadder('d1', '2026-10-01', ['p1', 'p2', 'p3', 'p4']),
      dominanceLadder('d2', '2026-10-02', ['p1', 'p2', 'p3', 'p4']),
    ]);
    const neutral = fitWhr(observations, {});
    const weighted = fitWhr(observations, { tierWeights: { 'Nexus Night': 3 } });
    const index = observations.players.indexOf('p2');
    expect(latestRating(weighted, index).sigma).toBeLessThan(latestRating(neutral, index).sigma);
    // The order is unchanged: a weight is evidence volume, not a thumb on one
    // player's side.
    const order = (fit: ReturnType<typeof fitWhr>) =>
      observations.players
        .map((_, p) => p)
        .sort((x, y) => latestRating(fit, y).rating - latestRating(fit, x).rating)
        .map(p => observations.players[p]);
    expect(order(weighted)).toEqual(order(neutral));
  });

  it('a tier with no events in the window cannot change the fit at all', () => {
    // The whole measured finding about the requested ordering: zero of 56,257
    // production matches are in any tier above Nexus Night, so a table keyed on
    // those tiers is a weight on an empty set.
    const observations = build([dominanceLadder('d1', '2026-10-01', ['p1', 'p2', 'p3', 'p4'])]);
    const neutral = fitWhr(observations, {});
    const absent = fitWhr(observations, {
      tierWeights: { 'World Championship': 4, Continental: 3, Regional: 2 },
    });
    for (let p = 0; p < observations.players.length; p++) {
      expect(latestRating(absent, p).rating).toBeCloseTo(latestRating(neutral, p).rating, 12);
      expect(latestRating(absent, p).sigma).toBeCloseTo(latestRating(neutral, p).sigma, 12);
    }
  });

  it('survives a malformed override rather than taking the pass down', () => {
    expect(parseTierWeights(undefined).weights).toEqual({});
    expect(parseTierWeights('').weights).toEqual({});
    expect(parseTierWeights('{"Nexus Night": 2}').weights).toEqual({ 'Nexus Night': 2 });

    const broken = parseTierWeights('not json');
    expect(broken.weights).toEqual({});
    expect(broken.warning).toMatch(/not valid JSON/);

    const array = parseTierWeights('[1,2]');
    expect(array.warning).toMatch(/not a JSON object/);

    // One bad entry is dropped individually; it cannot blank the whole table.
    const partial = parseTierWeights('{"Nexus Night": 2, "Pre-Rift": -1, "Open Play": "x"}');
    expect(partial.weights).toEqual({ 'Nexus Night': 2 });
    expect(partial.warning).toMatch(/Pre-Rift/);
    expect(partial.warning).toMatch(/Open Play/);
  });
});

describe('known-answer fit', () => {
  const observations = build([
    dominanceLadder('d1', '2026-10-01', ['A', 'B', 'C']),
    dominanceLadder('d2', '2026-10-02', ['A', 'B', 'C']),
    dominanceLadder('d3', '2026-10-03', ['A', 'B', 'C']),
    dominanceLadder('d4', '2026-10-04', ['A', 'B', 'C']),
  ]);
  const fit = fitWhr(observations);
  const index = (player: string) => observations.players.indexOf(player);
  const elo = (player: string) => natToElo(latestRating(fit, index(player)).rating);
  const sigma = (player: string) => latestRating(fit, index(player)).sigma * ELO_PER_NAT;

  it('converges', () => {
    expect(fit.converged).toBe(true);
    expect(fit.maxDelta).toBeLessThan(1e-4);
  });

  it('recovers the dominance order', () => {
    expect(elo('A')).toBeGreaterThan(elo('B'));
    expect(elo('B')).toBeGreaterThan(elo('C'));
  });

  it('is symmetric about the prior mean, because the evidence is', () => {
    // A beat B and C every time, C lost every time, B is exactly in between -
    // so the fit has no reason to put the group anywhere but the anchor.
    // Written against DEFAULT_ELO_ORIGIN rather than a literal, because the
    // anchor is a display offset: moving it must move these three together and
    // change nothing else.
    expect(elo('B')).toBeCloseTo(DEFAULT_ELO_ORIGIN, 1);
    expect(elo('A') - DEFAULT_ELO_ORIGIN).toBeCloseTo(DEFAULT_ELO_ORIGIN - elo('C'), 1);
    expect((elo('A') + elo('B') + elo('C')) / 3).toBeCloseTo(DEFAULT_ELO_ORIGIN, 1);
  });

  it('is least certain about the unbeaten player', () => {
    // An unbeaten record is less informative per game than an even one: the
    // Bradley-Terry information term p(1-p) is smallest at the extremes.
    expect(sigma('A')).toBeGreaterThan(sigma('B'));
    expect(sigma('C')).toBeGreaterThan(sigma('B'));
  });

  it('predicts the pairings it was fitted on', () => {
    const day = observations.events[0].day;
    const pA = 1 / (1 + Math.exp(-(ratingOnDay(fit, index('A'), day) - ratingOnDay(fit, index('C'), day))));
    expect(pA).toBeGreaterThan(0.8);
  });
});

describe('the global prior stops disconnected clusters floating', () => {
  // Two closed pools, at two venues, that never meet. Internally identical.
  const observations = build([
    dominanceLadder('x1', '2026-10-01', ['A', 'B', 'C'], 1),
    dominanceLadder('x2', '2026-10-02', ['A', 'B', 'C'], 1),
    dominanceLadder('x3', '2026-10-03', ['A', 'B', 'C'], 1),
    dominanceLadder('y1', '2026-10-01', ['X', 'Y', 'Z'], 2),
    dominanceLadder('y2', '2026-10-02', ['X', 'Y', 'Z'], 2),
    dominanceLadder('y3', '2026-10-03', ['X', 'Y', 'Z'], 2),
  ]);
  const fit = fitWhr(observations);
  const elo = (player: string) => natToElo(latestRating(fit, observations.players.indexOf(player)).rating);
  const mean = (players: string[]) => players.reduce((total, player) => total + elo(player), 0) / players.length;

  it('sees two components', () => {
    const components = findComponents(observations);
    expect(components.components).toHaveLength(2);
    expect(components.giantShare).toBeCloseTo(0.5, 10);
  });

  it('centres both clusters on the prior mean rather than letting them drift', () => {
    expect(mean(['A', 'B', 'C'])).toBeCloseTo(DEFAULT_ELO_ORIGIN, 1);
    expect(mean(['X', 'Y', 'Z'])).toBeCloseTo(DEFAULT_ELO_ORIGIN, 1);
  });

  it('keeps each cluster internal order, and gives identical evidence identical ratings', () => {
    expect(elo('A')).toBeGreaterThan(elo('B'));
    expect(elo('X')).toBeGreaterThan(elo('Y'));
    // Same evidence, different pool: the same answer. Which is exactly why a
    // cross-component comparison is meaningless and is not published as one.
    expect(elo('A')).toBeCloseTo(elo('X'), 6);
    expect(elo('C')).toBeCloseTo(elo('Z'), 6);
  });

  it('does not let a dominant cluster inflate above a weak one', () => {
    // The strong pool wins all of its games; so does the other. With no edge
    // between them there is no evidence either way, and the fit says so.
    const strong = build([
      dominanceLadder('s1', '2026-10-01', ['A', 'B', 'C'], 1),
      dominanceLadder('s2', '2026-10-02', ['A', 'B', 'C'], 1),
      // The second pool plays ten times as many games among themselves.
      ...Array.from({ length: 10 }, (_, i) =>
        dominanceLadder(`w${i}`, `2026-10-${String(i + 1).padStart(2, '0')}`, ['X', 'Y', 'Z'], 2)
      ),
    ]);
    const strongFit = fitWhr(strong);
    const topOfSmallPool = natToElo(latestRating(strongFit, strong.players.indexOf('A')).rating);
    const topOfBigPool = natToElo(latestRating(strongFit, strong.players.indexOf('X')).rating);
    // More internal games spread a pool out; they must not *lift* it.
    expect(topOfBigPool).toBeGreaterThan(topOfSmallPool);
    const bigMean = ['X', 'Y', 'Z']
      .map(player => natToElo(latestRating(strongFit, strong.players.indexOf(player)).rating))
      .reduce((total, value) => total + value, 0) / 3;
    expect(bigMean).toBeCloseTo(DEFAULT_ELO_ORIGIN, 1);
  });
});

describe('uncertainty tracks evidence', () => {
  it('leaves a player with no games at the prior', () => {
    const observations = build([]);
    const fit = fitWhr(observations, { priorSigmaElo: 150 });
    expect(fit.priorSigma * ELO_PER_NAT).toBeCloseTo(150, 6);
  });

  it('narrows as games accumulate, and never exceeds the prior', () => {
    const sigmas: number[] = [];
    for (const events of [1, 2, 4, 8]) {
      const observations = build(
        Array.from({ length: events }, (_, i) =>
          dominanceLadder(`u${i}`, `2026-10-${String(i + 1).padStart(2, '0')}`, ['A', 'B', 'C'])
        )
      );
      const fit = fitWhr(observations);
      sigmas.push(latestRating(fit, observations.players.indexOf('B')).sigma * ELO_PER_NAT);
      expect(sigmas[sigmas.length - 1]).toBeLessThanOrEqual(150.0001);
    }
    for (let i = 1; i < sigmas.length; i++) expect(sigmas[i]).toBeLessThan(sigmas[i - 1]);
  });

  it('moves a single-game player only part way from the prior mean', () => {
    const observations = build([
      results({ id: 'one', date: '2026-10-20', players: ['A', 'B'], matches: [{ a: 0, b: 1, winner: 'a' }] }),
    ]);
    const fit = fitWhr(observations);
    const elo = natToElo(latestRating(fit, 0).rating);
    expect(elo).toBeGreaterThan(DEFAULT_ELO_ORIGIN);
    // One win is evidence, not a verdict: the prior still dominates.
    expect(elo).toBeLessThan(DEFAULT_ELO_ORIGIN + 60);
  });
});

describe('the co-play graph', () => {
  it('attributes cross-venue edges and measures what removing a tier costs', () => {
    // Two venues, each with its own regulars, plus one Pre-Rift that mixes them.
    const observations = build([
      dominanceLadder('v1', '2026-10-01', ['A', 'B', 'C'], 1),
      dominanceLadder('v2', '2026-10-01', ['X', 'Y', 'Z'], 2),
      results({
        id: 'bridge',
        date: '2026-10-05',
        players: ['A', 'X', 'B', 'Y'],
        matches: [
          { a: 0, b: 1, winner: 'a' },
          { a: 2, b: 3, winner: 'b' },
        ],
        eventType: 'Pre-Rift',
        shopExternalId: 3,
      }),
    ]);

    const report = connectivityReport(observations);
    expect(report.componentCount).toBe(1);
    expect(report.giantComponentShare).toBeCloseTo(1, 10);
    expect(report.crossVenueMatches).toBe(2);

    const preRift = report.bridgingByType.find(row => row.tournamentType === 'Pre-Rift');
    expect(preRift?.crossVenueMatches).toBe(2);
    expect(preRift?.shareOfCrossVenue).toBeCloseTo(1, 10);

    // Remove the bridging tier and the scene splits in two again. This is the
    // direct, falsifiable form of "the tier ladder is what connects venues".
    const removed = report.leaveOneTypeOut.find(row => row.removedType === 'Pre-Rift');
    expect(removed?.componentCount).toBe(2);
    expect(removed?.giantShare).toBeLessThan(report.giantComponentShare);
  });

  it('gives a component the same id whatever order the replay saw it in', () => {
    const forward = build([dominanceLadder('o1', '2026-10-01', ['A', 'B', 'C'])]);
    const reverse = build([dominanceLadder('o1', '2026-10-01', ['C', 'B', 'A'])]);
    expect(findComponents(forward).components[0].id).toBe(findComponents(reverse).components[0].id);
  });

  it('counts a player at two venues as multi-venue', () => {
    const observations = build([
      dominanceLadder('m1', '2026-10-01', ['A', 'B', 'C'], 1),
      dominanceLadder('m2', '2026-10-02', ['A', 'B', 'C'], 2),
    ]);
    const report = connectivityReport(observations);
    expect(report.multiVenuePlayers).toBe(3);
    expect(report.multiVenueShare).toBeCloseTo(1, 10);
    expect(report.venueComponentCount).toBe(1);
  });
});

describe('held-out validation', () => {
  it('beats a coin flip on data with a real signal, and reports its coverage', () => {
    // A stable dominance order over many days: a fit on the first days should
    // predict the last ones.
    const observations = build(
      Array.from({ length: 10 }, (_, i) =>
        dominanceLadder(`h${i}`, `2026-10-${String(i + 1).padStart(2, '0')}`, ['A', 'B', 'C', 'D'])
      ),
      true
    );
    const lastDay = Math.max(...observations.events.map(event => event.day));
    const result = validate(observations, lastDay);

    expect(result.evaluable).toBeGreaterThan(0);
    const whr = result.scores.find(score => score.name.startsWith('WHR'))!;
    const coin = result.scores.find(score => score.name === 'Coin flip')!;
    expect(whr.accuracy).toBeGreaterThan(coin.accuracy);
    expect(whr.logLoss).toBeLessThan(coin.logLoss);
  });

  it('does not score a held-out match against a player it has never seen', () => {
    const observations = build([
      dominanceLadder('p1', '2026-10-01', ['A', 'B', 'C']),
      // Two complete newcomers on the held-out day.
      results({ id: 'p2', date: '2026-10-05', players: ['N1', 'N2'], matches: [{ a: 0, b: 1, winner: 'a' }] }),
    ]);
    const result = validate(observations, observations.events[1].day);
    expect(result.testMatches).toBe(1);
    expect(result.evaluable).toBe(0);
    expect(result.coldStartShare).toBe(1);
  });
});

describe('slicing', () => {
  it('keeps player indices aligned so an all-time and a per-set fit are comparable', () => {
    const observations = build([
      dominanceLadder('s1', '2026-10-01', ['A', 'B', 'C']),
      dominanceLadder('s2', '2026-10-20', ['A', 'B', 'C']),
    ]);
    const slice = sliceMatches(observations, i => observations.events[observations.event[i]].day === observations.events[1].day);
    expect(slice.players).toBe(observations.players);
    expect(slice.playerA).toHaveLength(3);
    expect(observations.playerA).toHaveLength(6);
    const fit = fitWhr(slice);
    expect(fit.matchesPlayed[observations.players.indexOf('A')]).toBe(2);
  });
});
