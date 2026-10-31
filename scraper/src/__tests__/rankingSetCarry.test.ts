import { describe, it, expect } from 'vitest';
import { ObservationBuilder, sliceMatches } from '../ranking/observations.js';
import { buildEras, SET_TABLE } from '../ranking/sets.js';
import {
  DEFAULT_ELO_ORIGIN,
  ELO_PER_NAT,
  fitWhr,
  latestRating,
  natToElo,
  ratingOnDay,
  DEFAULT_WHR_OPTIONS,
} from '../ranking/whr.js';
import {
  DEFAULT_SET_CARRY_OPTIONS,
  SetCarry,
  parseSetCarryOptions,
} from '../ranking/carry.js';
import { buildSnapshot, DEFAULT_SNAPSHOT_OPTIONS, type SnapshotOptions } from '../ranking/snapshot.js';
import type { EventResults } from '../database.js';

/**
 * Carrying a rating across a set rotation.
 *
 * The properties pinned here are the ones the design rests on, and each of them
 * is a way the obvious implementation would be wrong:
 *
 * - **a player with no previous era still gets the global prior**, so the first
 *   era - and the whole model as it was - is unchanged;
 * - **the carried prior is never wider than the global one**, so a thin record
 *   last era degrades back to "new player" rather than to something worse;
 * - **the anchor stays a display offset.** The carry is in natural units, so
 *   moving `eloOrigin` must still shift every published number by exactly the
 *   offset and change nothing else. This is the check that would fail if a
 *   carried *Elo* value had been stored anywhere;
 * - **the `all` scope does not move.** It already fits one curve over the whole
 *   history and the Wiener process already links days across a boundary, so
 *   carrying there would double-count. The per-era loop is the only caller;
 * - **`componentId` keeps its meaning.** Components are found once on the whole
 *   co-play graph, and the carry must not change that partition or the sizes
 *   `crossComponentUncertainty` and the publishing bar are read from.
 */

const eras = buildEras();

interface MatchSpec {
  a: number;
  b: number;
  winner: 'a' | 'b';
  matchId: string;
}

function results(options: {
  id: string;
  date: string;
  players: string[];
  matches: MatchSpec[];
  shopExternalId?: number | null;
}): EventResults {
  const { id, date, players, matches, shopExternalId = 1 } = options;
  const teamId = (index: number) => `t-${id}-${index}`;
  return {
    externalId: `prb-${id}`,
    tournamentId: id,
    eventStartDate: new Date(`${date}T18:00:00.000Z`),
    eventType: 'Nexus Night',
    playFormat: null,
    shopExternalId,
    latitude: 37.77,
    longitude: -122.42,
    status: 'final',
    roundCount: 1,
    playerCount: players.length,
    openMatches: 0,
    players: players.map((playerId, index) => ({
      teamId: teamId(index),
      playerId,
      name: `Name ${playerId}`,
      tagLine: 'NA1',
    })),
    standings: [],
    rounds: [
      {
        section: 0,
        roundNumber: 1,
        status: 'FINALIZED',
        byeTeamIds: [],
        matches: matches.map((match, index) => ({
          matchId: match.matchId,
          tableNumber: index + 1,
          status: 'COMPLETED',
          bye: false,
          sides: [
            {
              teamId: teamId(match.a),
              outcome: match.winner === 'a' ? 'WIN' : 'LOSS',
              gameWins: match.winner === 'a' ? 2 : 0,
            },
            {
              teamId: teamId(match.b),
              outcome: match.winner === 'b' ? 'WIN' : 'LOSS',
              gameWins: match.winner === 'b' ? 2 : 0,
            },
          ],
          games: [1, 2].map(number => ({
            number,
            winnerTeamId: teamId(match.winner === 'a' ? match.a : match.b),
          })),
        })),
      },
    ],
    sourceUpdatedAt: null,
    capturedAt: '2026-10-31T00:00:00.000Z',
  };
}

/** A round robin where players[0] beats everyone, [1] beats all but [0], etc. */
function ladder(id: string, date: string, players: string[], shopExternalId = 1): EventResults {
  const matches: MatchSpec[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      matches.push({ a: i, b: j, winner: 'a', matchId: `${id}-${i}-${j}` });
    }
  }
  return results({ id, date, players, matches, shopExternalId });
}

function build(facts: EventResults[]) {
  const builder = new ObservationBuilder(eras, new Map(), Number.POSITIVE_INFINITY, false);
  for (const fact of facts) builder.addResults(fact);
  return builder.finish();
}

/**
 * Two eras over the same people.
 *
 * `vendetta` is a deep Vendetta-era record - eight players, two full round
 * robins a week apart, so the top of it finishes with a real measured rating
 * and a narrow posterior. `radiance` is one thin Radiance-era event: the same
 * eight play a single round robin after the rotation. That is the shape the
 * whole idea is about - a new set's ladder with almost no evidence in it.
 */
function twoEras() {
  const players = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  return {
    players,
    observations: build([
      // Vendetta runs 2026-07-31..2026-10-22.
      ladder('v1', '2026-08-05', players),
      ladder('v2', '2026-08-12', players),
      ladder('v3', '2026-08-19', players),
      // Radiance opens 2026-10-23.
      ladder('r1', '2026-10-28', players),
    ]),
  };
}

const VENDETTA_ERA = 's4';
const RADIANCE_ERA = 's5';

function eraSlice(observations: ReturnType<typeof build>, eraId: string) {
  return sliceMatches(observations, i => observations.events[observations.event[i]].eraId === eraId);
}

describe('the carried prior', () => {
  it('leaves a player with no previous era on the global prior', () => {
    const { observations } = twoEras();
    const vendetta = eraSlice(observations, VENDETTA_ERA);

    // The first era has nothing to carry from, so SetCarry hands back null and
    // the fit is the one that ships today.
    const carry = new SetCarry(observations.players.length, {
      ...DEFAULT_SET_CARRY_OPTIONS,
      enabled: true,
    });
    const opened = carry.priorFor(0, DEFAULT_WHR_OPTIONS.priorSigmaElo / ELO_PER_NAT);
    expect(opened.prior).toBeNull();
    expect(opened.counts.carried).toBe(0);
    expect(opened.counts.fresh).toBe(observations.players.length);

    const withPrior = fitWhr(vendetta, {}, opened.prior);
    const without = fitWhr(vendetta);
    for (let p = 0; p < observations.players.length; p++) {
      expect(latestRating(withPrior, p).rating).toBeCloseTo(latestRating(without, p).rating, 12);
      expect(latestRating(withPrior, p).sigma).toBeCloseTo(latestRating(without, p).sigma, 12);
    }
  });

  it('leaves a player absent from the previous era on the global prior when others carry', () => {
    const players = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
    const newcomer = 'q0';
    const observations = build([
      ladder('v1', '2026-08-05', players),
      ladder('v2', '2026-08-12', players),
      // A Radiance event the newcomer plays in, alongside the Vendetta regulars.
      ladder('r1', '2026-10-28', [...players, newcomer]),
    ]);
    const carry = new SetCarry(observations.players.length, {
      ...DEFAULT_SET_CARRY_OPTIONS,
      enabled: true,
    });
    const vendettaFit = fitWhr(eraSlice(observations, VENDETTA_ERA));
    carry.record(vendettaFit, 0);
    const opened = carry.priorFor(1, vendettaFit.priorSigma);

    const newcomerIndex = observations.players.indexOf(newcomer);
    expect(newcomerIndex).toBeGreaterThanOrEqual(0);
    // Sigma 0 is the sentinel for "fall back to the global prior".
    expect(opened.prior!.sigma[newcomerIndex]).toBe(0);
    expect(opened.prior!.mean[newcomerIndex]).toBe(0);
    expect(opened.counts.carried).toBe(players.length);

    // And the model honours it: the newcomer opens from 0, not from anyone's
    // carried rating.
    const radiance = fitWhr(eraSlice(observations, RADIANCE_ERA), {}, opened.prior);
    const veteranIndex = observations.players.indexOf('p0');
    expect(Math.abs(latestRating(radiance, newcomerIndex).rating)).toBeLessThan(
      Math.abs(latestRating(radiance, veteranIndex).rating)
    );
  });

  it('starts the new era near the carried mean rather than the global mean', () => {
    const { observations, players } = twoEras();
    const vendettaFit = fitWhr(eraSlice(observations, VENDETTA_ERA));
    const carry = new SetCarry(observations.players.length, {
      ...DEFAULT_SET_CARRY_OPTIONS,
      enabled: true,
    });
    carry.record(vendettaFit, 0);
    const opened = carry.priorFor(1, vendettaFit.priorSigma);

    const radiance = eraSlice(observations, RADIANCE_ERA);
    const carried = fitWhr(radiance, {}, opened.prior);
    const independent = fitWhr(radiance);

    const top = observations.players.indexOf(players[0]);
    const bottom = observations.players.indexOf(players[players.length - 1]);

    // The thin Radiance event already has the order right; carrying a deep
    // Vendetta record pushes the fit further in the direction the carried mean
    // points, because prior and likelihood agree.
    expect(latestRating(carried, top).rating).toBeGreaterThan(latestRating(independent, top).rating);
    expect(latestRating(carried, bottom).rating).toBeLessThan(latestRating(independent, bottom).rating);
    // Note the carried rating may sit *above* the carried mean: a narrow prior
    // plus a winning record is more evidence than either alone, so it is not a
    // bound on the posterior. What the carry narrows is the *prior* width, and
    // the posterior need not follow - an unbeaten player's likelihood terms
    // carry less information the further above their opponents they sit, which
    // is the same effect rankingModel.test.ts pins as "the strongest player is
    // the least certain".
    expect(opened.prior!.sigma[top]).toBeLessThan(vendettaFit.priorSigma);
    expect(opened.prior!.sigma[bottom]).toBeLessThan(vendettaFit.priorSigma);
    // And the dominance order survives, which is the property the whole model
    // is tested on elsewhere.
    for (let i = 1; i < players.length; i++) {
      const stronger = observations.players.indexOf(players[i - 1]);
      const weaker = observations.players.indexOf(players[i]);
      expect(latestRating(carried, stronger).rating).toBeGreaterThan(latestRating(carried, weaker).rating);
    }
  });

  it('never carries a prior wider than the global one, and says when it capped', () => {
    const { observations } = twoEras();
    const vendettaFit = fitWhr(eraSlice(observations, VENDETTA_ERA));
    const globalSigma = vendettaFit.priorSigma;

    for (const rotationSigmaElo of [0, 50, 100, 150, 1000]) {
      const carry = new SetCarry(observations.players.length, {
        enabled: true,
        rotationSigmaElo,
        mode: 'last-seen',
      });
      carry.record(vendettaFit, 0);
      const opened = carry.priorFor(1, globalSigma);
      for (let p = 0; p < observations.players.length; p++) {
        expect(opened.prior!.sigma[p]).toBeLessThanOrEqual(globalSigma + 1e-12);
      }
      if (rotationSigmaElo >= DEFAULT_WHR_OPTIONS.priorSigmaElo) {
        // A rotation at or above the prior SD cannot carry any precision.
        expect(opened.counts.capped).toBe(opened.counts.carried);
      }
    }
  });

  it('widens once per era boundary crossed, and `previous-only` resets a returner', () => {
    const { observations } = twoEras();
    const vendettaFit = fitWhr(eraSlice(observations, VENDETTA_ERA));
    const globalSigma = vendettaFit.priorSigma;

    const lastSeen = new SetCarry(observations.players.length, {
      enabled: true,
      rotationSigmaElo: 10,
      mode: 'last-seen',
    });
    lastSeen.record(vendettaFit, 0);
    const oneBoundary = lastSeen.priorFor(1, globalSigma);
    const threeBoundaries = lastSeen.priorFor(3, globalSigma);

    const closing = latestRating(vendettaFit, 0).sigma;
    const rotation = 10 / ELO_PER_NAT;
    expect(oneBoundary.prior!.sigma[0]).toBeCloseTo(Math.sqrt(closing ** 2 + rotation ** 2), 12);
    expect(threeBoundaries.prior!.sigma[0]).toBeCloseTo(Math.sqrt(closing ** 2 + 3 * rotation ** 2), 12);
    // The mean travels unchanged; only the width decays.
    expect(threeBoundaries.prior!.mean[0]).toBeCloseTo(oneBoundary.prior!.mean[0], 12);

    const previousOnly = new SetCarry(observations.players.length, {
      enabled: true,
      rotationSigmaElo: 10,
      mode: 'previous-only',
    });
    previousOnly.record(vendettaFit, 0);
    expect(previousOnly.priorFor(1, globalSigma).counts.carried).toBeGreaterThan(0);
    // Two boundaries on is a new player under this mode.
    const skipped = previousOnly.priorFor(2, globalSigma);
    expect(skipped.prior).toBeNull();
    expect(skipped.counts.carried).toBe(0);
  });

  it('is disabled to exactly the old behaviour', () => {
    const { observations } = twoEras();
    const vendettaFit = fitWhr(eraSlice(observations, VENDETTA_ERA));
    const carry = new SetCarry(observations.players.length, { ...DEFAULT_SET_CARRY_OPTIONS, enabled: false });
    carry.record(vendettaFit, 0);
    const opened = carry.priorFor(1, vendettaFit.priorSigma);
    expect(opened.prior).toBeNull();
    expect(opened.counts.carried).toBe(0);
  });

  it('answers for a player the new era never saw, at the carried mean and width', () => {
    const players = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
    const observations = build([
      ladder('v1', '2026-08-05', players),
      ladder('v2', '2026-08-12', players),
      // Only four of the six turn up in Radiance.
      ladder('r1', '2026-10-28', players.slice(0, 4)),
    ]);
    const vendettaFit = fitWhr(eraSlice(observations, VENDETTA_ERA));
    const carry = new SetCarry(observations.players.length, {
      ...DEFAULT_SET_CARRY_OPTIONS,
      enabled: true,
    });
    carry.record(vendettaFit, 0);
    const opened = carry.priorFor(1, vendettaFit.priorSigma);
    const radiance = fitWhr(eraSlice(observations, RADIANCE_ERA), {}, opened.prior);

    const absent = observations.players.indexOf('p5');
    expect(radiance.days[absent].length).toBe(0);
    // Their honest Radiance rating is where they finished Vendetta, at the
    // widened width - not the global mean.
    expect(latestRating(radiance, absent).rating).toBeCloseTo(opened.prior!.mean[absent], 12);
    expect(latestRating(radiance, absent).sigma).toBeCloseTo(opened.prior!.sigma[absent], 12);
    expect(ratingOnDay(radiance, absent, 99_999)).toBeCloseTo(opened.prior!.mean[absent], 12);
    // Without a carry the same player is at the global prior, as before.
    const independent = fitWhr(eraSlice(observations, RADIANCE_ERA));
    expect(latestRating(independent, absent).rating).toBe(0);
    expect(latestRating(independent, absent).sigma).toBe(independent.priorSigma);
  });
});

describe('the anchor stays a display offset under a carried prior', () => {
  /**
   * The failure this guards: a carried *Elo* number anywhere in the chain. The
   * carry is read off the previous fit in natural units, where 0 is the prior
   * mean, so the anchor cannot reach it. If it ever did, the carried mean would
   * shift with the anchor while the likelihood did not, and the deviation below
   * would not be float noise.
   */
  function snapshotAt(eloOrigin: number) {
    const { observations } = twoEras();
    const options: SnapshotOptions = {
      ...DEFAULT_SNAPSHOT_OPTIONS,
      eras,
      setTable: SET_TABLE,
      venueLabels: new Map(),
      sceneAssignment: null,
      matchLogEvents: new Set(),
      whr: { eloOrigin },
      generatedAt: new Date('2026-10-31T00:00:00.000Z'),
      setCarry: { ...DEFAULT_SET_CARRY_OPTIONS, enabled: true },
      // Keep every player on the board so the comparison covers all of them.
      minGames: 0,
      maxUncertaintyElo: 1000,
      minComponentSize: 1,
      // The fixture's eras are 84 and 28 matches; the production floor of 50
      // would skip the Radiance era outright and the comparison would be
      // two empty ladders agreeing with each other.
      minSetMatches: 1,
    };
    return buildSnapshot(observations, options).snapshot;
  }

  it('shifts every published number by exactly the offset and nothing else', () => {
    const base = snapshotAt(DEFAULT_ELO_ORIGIN);
    const shifted = snapshotAt(DEFAULT_ELO_ORIGIN + 300);
    expect(base.profiles.length).toBeGreaterThan(0);

    const byId = new Map(shifted.profiles.map(profile => [profile.playerId, profile]));
    for (const profile of base.profiles) {
      const other = byId.get(profile.playerId)!;
      expect(other.provisionalRating - profile.provisionalRating).toBeCloseTo(300, 6);
      expect(other.rating! - profile.rating!).toBeCloseTo(300, 6);
      expect(other.uncertainty).toBeCloseTo(profile.uncertainty, 9);
      expect(other.crossComponentUncertainty).toBeCloseTo(profile.crossComponentUncertainty, 9);
      expect(other.rated).toBe(profile.rated);
      expect(other.provisionalReason).toBe(profile.provisionalReason);
      expect(other.componentId).toBe(profile.componentId);
      expect(other.componentSize).toBe(profile.componentSize);

      // The per-era scopes are where the carry lives, so they matter most.
      for (const [scope, rating] of Object.entries(profile.setRatings)) {
        const otherRating = other.setRatings[scope];
        expect(otherRating).toBeDefined();
        expect(otherRating.provisionalRating - rating.provisionalRating).toBeCloseTo(300, 6);
        expect(otherRating.uncertainty).toBeCloseTo(rating.uncertainty, 9);
        expect(otherRating.rated).toBe(rating.rated);
      }
    }

    // Rank order, which is what a reader sees, is untouched.
    expect(shifted.rankings.map(row => `${row.scope}|${row.rank}|${row.playerId}`)).toEqual(
      base.rankings.map(row => `${row.scope}|${row.rank}|${row.playerId}`)
    );
  });

  it('keeps the anchor out of the carried prior itself', () => {
    const { observations } = twoEras();
    const vendetta = eraSlice(observations, VENDETTA_ERA);
    const atDefault = fitWhr(vendetta, { eloOrigin: DEFAULT_ELO_ORIGIN });
    const atShifted = fitWhr(vendetta, { eloOrigin: DEFAULT_ELO_ORIGIN + 300 });

    const carryAt = (fit: typeof atDefault) => {
      const carry = new SetCarry(observations.players.length, {
        ...DEFAULT_SET_CARRY_OPTIONS,
        enabled: true,
      });
      carry.record(fit, 0);
      return carry.priorFor(1, fit.priorSigma).prior!;
    };

    const left = carryAt(atDefault);
    const right = carryAt(atShifted);
    for (let p = 0; p < observations.players.length; p++) {
      expect(right.mean[p]).toBeCloseTo(left.mean[p], 12);
      expect(right.sigma[p]).toBeCloseTo(left.sigma[p], 12);
    }
    // Sanity: the *display* conversion does move, which is the only thing that
    // should.
    expect(natToElo(left.mean[0], DEFAULT_ELO_ORIGIN + 300) - natToElo(left.mean[0], DEFAULT_ELO_ORIGIN))
      .toBeCloseTo(300, 9);
  });
});

describe('the carry touches per-era scopes only', () => {
  function snapshotWith(enabled: boolean) {
    const { observations } = twoEras();
    const options: SnapshotOptions = {
      ...DEFAULT_SNAPSHOT_OPTIONS,
      eras,
      setTable: SET_TABLE,
      venueLabels: new Map(),
      sceneAssignment: null,
      matchLogEvents: new Set(),
      whr: {},
      generatedAt: new Date('2026-10-31T00:00:00.000Z'),
      setCarry: { ...DEFAULT_SET_CARRY_OPTIONS, enabled },
      minGames: 0,
      maxUncertaintyElo: 1000,
      minComponentSize: 1,
      // The fixture's eras are 84 and 28 matches; the production floor of 50
      // would skip the Radiance era outright and the comparison would be
      // two empty ladders agreeing with each other.
      minSetMatches: 1,
    };
    return buildSnapshot(observations, options);
  }

  it('leaves the all-time scope byte-identical', () => {
    const off = snapshotWith(false);
    const on = snapshotWith(true);

    const allRows = (result: typeof off) =>
      result.snapshot.rankings
        .filter(row => row.scope === 'all' || row.scope.startsWith('component:'))
        .map(row => JSON.stringify(row));
    expect(allRows(on)).toEqual(allRows(off));

    const allHistory = (result: typeof off) =>
      result.snapshot.history.filter(point => point.scope === 'all').map(point => JSON.stringify(point));
    expect(allHistory(on)).toEqual(allHistory(off));

    const allProfileFields = (result: typeof off) =>
      result.snapshot.profiles.map(profile =>
        JSON.stringify({
          playerId: profile.playerId,
          rating: profile.rating,
          provisionalRating: profile.provisionalRating,
          uncertainty: profile.uncertainty,
          crossComponentUncertainty: profile.crossComponentUncertainty,
          rated: profile.rated,
          provisional: profile.provisional,
          provisionalReason: profile.provisionalReason,
          gamesUntilRated: profile.gamesUntilRated,
          componentId: profile.componentId,
          componentSize: profile.componentSize,
        })
      );
    expect(allProfileFields(on)).toEqual(allProfileFields(off));

    // And the all-time scope's own rated count is identical.
    const allScope = (result: typeof off) => result.diagnostics.scopes.find(scope => scope.scope === 'all');
    expect(allScope(on)).toEqual(allScope(off));
  });

  it('leaves the first era identical and moves only the later one', () => {
    const off = snapshotWith(false);
    const on = snapshotWith(true);

    const scopeOf = (result: typeof off, scope: string) =>
      result.diagnostics.scopes.find(entry => entry.scope === scope);
    expect(scopeOf(on, `set:${VENDETTA_ERA}`)).toEqual(scopeOf(off, `set:${VENDETTA_ERA}`));

    const eraRows = (result: typeof off, scope: string) =>
      result.snapshot.rankings.filter(row => row.scope === scope).map(row => JSON.stringify(row));
    expect(eraRows(on, `set:${VENDETTA_ERA}`)).toEqual(eraRows(off, `set:${VENDETTA_ERA}`));
    expect(eraRows(on, `set:${RADIANCE_ERA}`)).not.toEqual(eraRows(off, `set:${RADIANCE_ERA}`));

    // Counts only, and only for the eras that carried something.
    expect(off.diagnostics.setCarry).toEqual([]);
    expect(on.diagnostics.setCarry.map(row => row.eraId)).toEqual([VENDETTA_ERA, RADIANCE_ERA]);
    expect(on.diagnostics.setCarry[0].carried).toBe(0);
    expect(on.diagnostics.setCarry[1].carried).toBeGreaterThan(0);
    for (const row of on.diagnostics.setCarry) {
      expect(Object.keys(row).sort()).toEqual(['capped', 'carried', 'eraId', 'fresh']);
    }
  });

  it('keeps componentId and componentSize meaning what they meant', () => {
    // Two scenes that never meet: the component partition is the thing
    // `crossComponentUncertainty` and the publishing bar are read from, and a
    // carried prior must not touch it.
    const north = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
    const south = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'];
    const observations = build([
      ladder('vn', '2026-08-05', north, 1),
      ladder('vs', '2026-08-05', south, 2),
      ladder('rn', '2026-10-28', north, 1),
      ladder('rs', '2026-10-28', south, 2),
    ]);
    const options = (enabled: boolean): SnapshotOptions => ({
      ...DEFAULT_SNAPSHOT_OPTIONS,
      eras,
      setTable: SET_TABLE,
      venueLabels: new Map(),
      sceneAssignment: null,
      matchLogEvents: new Set(),
      whr: {},
      generatedAt: new Date('2026-10-31T00:00:00.000Z'),
      setCarry: { ...DEFAULT_SET_CARRY_OPTIONS, enabled },
      minGames: 0,
      maxUncertaintyElo: 1000,
      minComponentSize: 1,
      // The fixture's eras are 84 and 28 matches; the production floor of 50
      // would skip the Radiance era outright and the comparison would be
      // two empty ladders agreeing with each other.
      minSetMatches: 1,
    });
    const off = buildSnapshot(observations, options(false));
    const on = buildSnapshot(observations, options(true));

    expect(on.components.componentIds).toEqual(off.components.componentIds);
    expect(on.components.componentSizes).toEqual(off.components.componentSizes);
    expect(on.diagnostics.componentCount).toBe(off.diagnostics.componentCount);
    expect(on.diagnostics.componentCount).toBe(2);

    const byId = new Map(off.snapshot.profiles.map(profile => [profile.playerId, profile]));
    for (const profile of on.snapshot.profiles) {
      const other = byId.get(profile.playerId)!;
      expect(profile.componentId).toBe(other.componentId);
      expect(profile.componentSize).toBe(other.componentSize);
      // The per-era scope's cross-component uncertainty is still built from the
      // whole-history component, not from anything the carry changed.
      for (const [scope, rating] of Object.entries(profile.setRatings)) {
        const offset = DEFAULT_WHR_OPTIONS.priorSigmaElo / Math.sqrt(profile.componentSize);
        // Within rounding: the published uncertainty is rounded to 0.1 while the
        // cross-component figure is built from the unrounded one. The point of
        // the check is the *component size* it was built from - reading the
        // wrong partition would move this by several points, not by 0.1.
        expect(rating.crossComponentUncertainty).toBeCloseTo(
          Math.sqrt(rating.uncertainty ** 2 + offset ** 2),
          0
        );
        expect(other.setRatings[scope]).toBeDefined();
      }
    }
  });
});

describe('RANKING_SET_CARRY parsing', () => {
  it('falls back and warns rather than taking the pass down', () => {
    expect(parseSetCarryOptions({}).options).toEqual(DEFAULT_SET_CARRY_OPTIONS);

    const bad = parseSetCarryOptions({ enabled: 'maybe', rotationSigmaElo: '-5', mode: 'teleport' });
    expect(bad.options).toEqual(DEFAULT_SET_CARRY_OPTIONS);
    expect(bad.warning).toContain('RANKING_SET_CARRY');
    expect(bad.warning).toContain('RANKING_SET_CARRY_ROTATION_ELO');
    expect(bad.warning).toContain('RANKING_SET_CARRY_MODE');
  });

  it('reads a well-formed override', () => {
    expect(parseSetCarryOptions({ enabled: 'false' }).options.enabled).toBe(false);
    expect(parseSetCarryOptions({ enabled: '1' }).options.enabled).toBe(true);
    expect(parseSetCarryOptions({ rotationSigmaElo: '0' }).options.rotationSigmaElo).toBe(0);
    expect(parseSetCarryOptions({ mode: 'previous-only' }).options.mode).toBe('previous-only');
    expect(parseSetCarryOptions({ enabled: 'true', rotationSigmaElo: '75' }).warning).toBeUndefined();
  });
});
