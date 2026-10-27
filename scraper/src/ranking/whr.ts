/**
 * Whole-History Rating with a global prior.
 *
 * The model, and why each piece is there:
 *
 * **Bradley-Terry likelihood.** P(A beats B) = sigmoid(r_A - r_B), with ratings
 * in natural units. One game is one observation; a draw is half a win each.
 *
 * **A rating *curve* per player, not a number.** Each player has one rating per
 * day they played, and consecutive days are tied by a Wiener process with
 * variance `w^2 * dt`. This is Coulom's Whole-History Rating (2008). It is
 * chosen over storing sequential Elo snapshots for two reasons: the whole past
 * curve is revised when new evidence arrives (beating someone who later turns
 * out to be strong retroactively improves your rating *at the time*), and
 * "rating over time" is a product requirement that falls out natively instead of
 * being reconstructed from an append-only log.
 *
 * **A global prior on each player's first rating:** r_p(t_1) ~ N(0, sigma0^2).
 * This is the piece that makes clustered play survivable. Without it, ratings
 * are identified only up to an additive constant *per connected component* of
 * the co-play graph, and a scene that never plays anyone else has a freely
 * floating scale. With it, a component's common offset has posterior
 * N(0, sigma0^2 / n) - so its mean sits at the prior mean, and the answer for a
 * disconnected cluster is "we have no evidence it is above or below average",
 * expressed as a rating near the prior with wide per-player uncertainty. That is
 * the honest answer. Sequential Elo gives the same *number* for a closed pool
 * but with no uncertainty attached and no way to tell it apart from a measured
 * result, which is the failure this design is built to avoid.
 *
 * Note the direction of the shrinkage: a *larger* disconnected component is
 * pinned *harder* to the prior mean, because its offset is the average of more
 * independent prior draws. That is correct under an exchangeable prior and it is
 * why cross-component comparison is not published as a global ladder - see
 * scraper/CLAUDE.md.
 *
 * **Fitting.** Newton's method, one player at a time (block Gauss-Seidel over
 * players, as in Coulom's paper). A single player's Hessian is tridiagonal - the
 * likelihood terms are diagonal, the Wiener prior couples adjacent days only -
 * so each player's Newton step is an O(T) tridiagonal solve. Per-player
 * uncertainty is the square root of the diagonal of the inverse of that same
 * matrix, so it is a by-product of the fit rather than a separate estimate.
 *
 * No runtime dependency: this is ~200 lines of arithmetic over typed arrays.
 * `scraper/package.json` has no linear-algebra or optimisation library and does
 * not need one.
 */

import { MatchResult, type ObservationSet } from './observations.js';

/** Elo points per natural (logistic) rating unit: 400 / ln(10). */
export const ELO_PER_NAT = 400 / Math.LN10;

/**
 * Default midpoint of the published scale: where an unrated player sits.
 *
 * The prior mean is 0 in natural units, so this constant is **only** a display
 * offset. Every quantity the model actually fits - rating *differences*, the
 * prior SD, the drift, the posterior SDs - is invariant under changing it, so
 * moving the anchor cannot change a single prediction. Held-out accuracy, log
 * loss and Brier are identical before and after; see scraper/CLAUDE.md,
 * "Where the scale is anchored".
 *
 * Configurable as `RANKING_ELO_ORIGIN` for the same reason the other knobs are:
 * it is a product decision (1200 reads as "new player" in the TCG/chess idiom
 * that most Riftbound players will arrive with) and not a measured value.
 */
export const DEFAULT_ELO_ORIGIN = 1200;

export function natToElo(rating: number, origin: number = DEFAULT_ELO_ORIGIN): number {
  return origin + rating * ELO_PER_NAT;
}

export function eloToNat(elo: number, origin: number = DEFAULT_ELO_ORIGIN): number {
  return (elo - origin) / ELO_PER_NAT;
}

export interface WhrOptions {
  /**
   * Prior SD of a player's first rating, in Elo points.
   *
   * The single most consequential knob: it sets how far one game can move a
   * newcomer and how hard a disconnected cluster is pinned to the anchor. See
   * scraper/CLAUDE.md for how the default was picked and its sensitivity.
   */
  priorSigmaElo: number;
  /**
   * Midpoint of the published scale - the rating of a player with no evidence.
   *
   * Carried on the options so the fit can hand it to whoever converts natural
   * units to published ones, and so a refit records the anchor it was written
   * with. It takes no part in the fit: see `DEFAULT_ELO_ORIGIN`.
   */
  eloOrigin: number;
  /** Rating drift, in Elo per sqrt(day). Controls how fast the curve may bend. */
  driftEloPerSqrtDay: number;
  /**
   * What counts as one observation.
   *
   * - `game-shared` (default): the match's weight is split equally across the
   *   games Riot recorded a winner for, so margin of victory is carried but a
   *   match stays *one* unit of evidence. A 2-0 gives the winner 1.0 and the
   *   loser 0; a 2-1 gives 0.67/0.33.
   * - `game`: every recorded game is a full, independent observation. A 2-0
   *   therefore counts twice as hard as a 1-0 report.
   * - `match`: one observation per match, margin ignored.
   *
   * All three **measure the same**: on the complete California sample the
   * held-out log losses are 0.6390 (`game-shared`), 0.6404 (`game`) and 0.6405
   * (`match`) - a spread of 0.0015 nats, well inside the noise.
   *
   * `game-shared` is the default because it ties for best *and* is the
   * conservative choice on uncertainty: games inside one match share the
   * players, the decks and the hour, so treating them as independent (`game`)
   * understates the posterior SD by roughly 8%. Since the publishing bar is set
   * on measured SD, understating it would quietly admit players who have not
   * earned a rating.
   *
   * Note that the independence objection gets *stronger* as organizer reporting
   * improves, so this default ages correctly. How much per-game detail exists is
   * strongly type-dependent - Nexus Night records 1.67 games per match, Pre-Rift
   * 1.01 - so any pooled figure is an artifact of the window's event mix. See
   * scraper/CLAUDE.md.
   */
  observationLevel: 'game' | 'game-shared' | 'match';
  /** Total weight of one match. 1 by default; swept against held-out log loss. */
  weightScale: number;
  /**
   * Per-tier multiplier on a match's total evidence, keyed on our `eventType`
   * label (the mapped form of Riot's `tournamentType` - see
   * sources/playriftbound.ts).
   *
   * The intuition is sound: a result at a Championship ought to say more about
   * true skill than a casual Learn to Play, and the model otherwise treats
   * every match as one observation. Mechanically this is just a scale on the
   * match's observation weight, so a tier at 2 moves both players' ratings
   * roughly as if the match had been played twice, and *narrows* their
   * posterior SD accordingly - which is why it is not a free knob: it also
   * decides who clears the publishing bar.
   *
   * **The default is all-ones, i.e. off, and that is a measurement not a
   * placeholder.** See DEFAULT_TIER_WEIGHTS.
   */
  tierWeights: Record<string, number>;
  /**
   * Weight for a tier absent from `tierWeights`, including `Other` and every
   * value Riot adds to the enum after this was written.
   *
   * 1 on purpose. The alternative - defaulting an unknown tier low - would
   * silently discount a whole new tier of real competitive play the first time
   * Riot ships one, and the enum demonstrably grows (eight of its eleven values
   * were unmapped here until 2026-10-26).
   */
  defaultTierWeight: number;
  maxIterations: number;
  /** Convergence tolerance on the largest rating change in one sweep, in natural units. */
  tolerance: number;
  /** Largest single Newton step per day, in natural units (damping). */
  maxStep: number;
}

/**
 * Tier weights, shipped **neutral**: every tier counts the same.
 *
 * This is the honest default, not an un-finished one, and the reasoning is
 * worth keeping because the knob looks obviously right:
 *
 * 1. **The tiers the ordering is about do not exist in the data yet.** Riot's
 *    enum has eleven values and six of them are competitive tiers
 *    (`NEXUS_CUP`, `CHALLENGE_SERIES`, `SHOWDOWN_SERIES`, `REGIONAL`,
 *    `CONTINENTAL`, `WORLD_CHAMPIONSHIP`). Counted across 47,179 stored `prb-`
 *    events spanning -59/+90 days on 2026-10-26: **zero** of any of them. A
 *    weight on `World Championship` is a weight on an empty set.
 * 2. **For the tiers that do exist, weighting measured worse.** See
 *    `./ranking-metrics.sh validate`, which sweeps this table against held-out
 *    accuracy, log loss and Brier. The numbers and the reason are in
 *    scraper/CLAUDE.md under "Measured: is an event tier worth a weight?".
 * 3. **It interacts with sparsity, not just with ordering.** The median player
 *    has 5 matches. Up-weighting a rare tier means a handful of matches
 *    dominate a few players' curves and narrow their posterior SD - which can
 *    move them past the publishing bar on *less* real evidence. Higher variance
 *    reads as a sharper ladder and is not one.
 *
 * `RANKING_TIER_WEIGHTS` sets it without a code change, so the table can be
 * turned on the day the competitive tiers have finished events to measure it
 * on. The ordering to try then is the product one -
 * World Championship > Continental > Regional > the series tiers >
 * Summoner Skirmish > Nexus Night > Open Play / Learn to Play - and the gate is
 * the same validate run, not the intuition.
 */
export const DEFAULT_TIER_WEIGHTS: Record<string, number> = {};

export const DEFAULT_WHR_OPTIONS: WhrOptions = {
  priorSigmaElo: 150,
  eloOrigin: DEFAULT_ELO_ORIGIN,
  driftEloPerSqrtDay: 4,
  observationLevel: 'game-shared',
  weightScale: 1,
  tierWeights: DEFAULT_TIER_WEIGHTS,
  defaultTierWeight: 1,
  maxIterations: 60,
  tolerance: 1e-4,
  maxStep: 2,
};

/**
 * The multiplier for one event's tier.
 *
 * Keyed on the mapped `eventType`, not on Riot's raw enum, because that is what
 * the fact rows carry - a results fact denormalises `eventType` off the event
 * row precisely so a replay can see it after the row is gone.
 */
export function tierWeightFor(
  eventType: string | null | undefined,
  options: Pick<WhrOptions, 'tierWeights' | 'defaultTierWeight'>
): number {
  if (!eventType) return options.defaultTierWeight;
  const weight = options.tierWeights[eventType];
  return typeof weight === 'number' && Number.isFinite(weight) && weight >= 0
    ? weight
    : options.defaultTierWeight;
}

/**
 * Parse a `RANKING_TIER_WEIGHTS` override: `{"World Championship": 2, ...}`.
 *
 * A malformed override logs and falls back rather than taking the pass down,
 * the same rule `RANKING_SET_TABLE` follows. A negative or non-finite weight is
 * dropped individually, so one bad entry cannot blank the table.
 */
export function parseTierWeights(
  raw: string | undefined
): { weights: Record<string, number>; warning?: string } {
  if (!raw || raw.trim() === '') return { weights: DEFAULT_TIER_WEIGHTS };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { weights: DEFAULT_TIER_WEIGHTS, warning: 'RANKING_TIER_WEIGHTS is not a JSON object' };
    }
    const weights: Record<string, number> = {};
    const bad: string[] = [];
    for (const [tier, value] of Object.entries(parsed as Record<string, unknown>)) {
      const weight = Number(value);
      if (Number.isFinite(weight) && weight >= 0) weights[tier] = weight;
      else bad.push(tier);
    }
    return {
      weights,
      warning: bad.length > 0 ? `RANKING_TIER_WEIGHTS ignored for ${bad.join(', ')}` : undefined,
    };
  } catch (error) {
    return {
      weights: DEFAULT_TIER_WEIGHTS,
      warning: `RANKING_TIER_WEIGHTS is not valid JSON (${error instanceof Error ? error.message : error})`,
    };
  }
}

/** One likelihood term in a player's own block. */
interface Term {
  /** Index into this player's day list. */
  timeIndex: number;
  opponent: number;
  opponentTimeIndex: number;
  /** Total weight of observations this player won. */
  winWeight: number;
  /** Total weight of observations this player lost. */
  loseWeight: number;
}

export interface WhrFit {
  /** Player indices are the ObservationSet's. */
  days: Int32Array[];
  /** Rating curve per player, natural units, aligned with `days`. */
  ratings: Float64Array[];
  /** Posterior SD per curve point, natural units. */
  sigmas: Float64Array[];
  matchesPlayed: Int32Array;
  gamesPlayed: Int32Array;
  /** Observation weight behind each player - what the uncertainty really tracks. */
  weight: Float64Array;
  iterations: number;
  converged: boolean;
  maxDelta: number;
  options: WhrOptions;
  /** Natural-unit prior SD, i.e. the rating of a player with no games at all. */
  priorSigma: number;
}

function sigmoid(x: number): number {
  // Stable both ways: exp of a large positive argument would overflow.
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/**
 * Accumulate per-match observation weights.
 *
 * Returns [weightToA, weightToB]. A match with no per-game winner recorded -
 * 3.2% of them, measured - falls back to a match-level observation, so a result
 * Riot published without game detail still counts exactly once rather than
 * disappearing from the fit.
 *
 * `tierWeight` scales the whole match (see WhrOptions.tierWeights). A weight of
 * 0 contributes no likelihood term, so `fitWhr` skips the match rather than
 * recording a zero-information one - but the match and game *counters* have
 * already been incremented by then, so such a player reads as having played
 * while sitting at the prior with prior-width uncertainty. That is a coherent
 * state (attendance recorded, no evidence used) and it fails the publishing
 * bar, which is the right outcome; it is still a reason not to use 0 as a way
 * of excluding a tier.
 */
export function observationWeights(
  result: number,
  gameWinners: number[],
  options: Pick<WhrOptions, 'observationLevel' | 'weightScale'>,
  tierWeight = 1
): [number, number] {
  const scale = options.weightScale * tierWeight;
  if (scale === 0) return [0, 0];
  if (options.observationLevel !== 'match' && gameWinners.length > 0) {
    const perGame = options.observationLevel === 'game-shared' ? scale / gameWinners.length : scale;
    let a = 0;
    let b = 0;
    for (const winner of gameWinners) {
      if (winner === MatchResult.AWin) a += perGame;
      else b += perGame;
    }
    return [a, b];
  }
  if (result === MatchResult.Draw) return [scale / 2, scale / 2];
  return result === MatchResult.AWin ? [scale, 0] : [0, scale];
}

/**
 * Solve a symmetric positive-definite tridiagonal system in place (Thomas).
 *
 * `diag` and `rhs` are destroyed. `off[k]` is A[k][k+1] = A[k+1][k].
 */
function solveTridiagonal(diag: Float64Array, off: Float64Array, rhs: Float64Array, n: number, out: Float64Array) {
  for (let i = 1; i < n; i++) {
    const factor = off[i - 1] / diag[i - 1];
    diag[i] -= factor * off[i - 1];
    rhs[i] -= factor * rhs[i - 1];
  }
  out[n - 1] = rhs[n - 1] / diag[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    out[i] = (rhs[i] - off[i] * out[i + 1]) / diag[i];
  }
}

/**
 * Fit rating curves to the whole history.
 *
 * Deterministic: the same ObservationSet and options give the same numbers, so a
 * refit from scratch is reproducible and the derived items are idempotent.
 */
export function fitWhr(observations: ObservationSet, overrides: Partial<WhrOptions> = {}): WhrFit {
  const options: WhrOptions = { ...DEFAULT_WHR_OPTIONS, ...overrides };
  const playerCount = observations.players.length;
  const matchCount = observations.playerA.length;

  // An SD, not a position on the scale, so the anchor cancels out of it. Written
  // as a plain division rather than `eloToNat(origin + sigma)` precisely so that
  // the anchor cannot creep into the fit by accident.
  const priorSigma = options.priorSigmaElo / ELO_PER_NAT;
  const priorPrecision = 1 / (priorSigma * priorSigma);
  const driftNat = options.driftEloPerSqrtDay / ELO_PER_NAT;
  const driftVariancePerDay = driftNat * driftNat;

  // 1. Each player's distinct play days, ascending.
  const daySets: (Set<number> | null)[] = new Array(playerCount).fill(null);
  const matchesPlayed = new Int32Array(playerCount);
  const gamesPlayed = new Int32Array(playerCount);
  const weight = new Float64Array(playerCount);

  const addDay = (player: number, day: number) => {
    let set = daySets[player];
    if (!set) daySets[player] = set = new Set<number>();
    set.add(day);
  };

  for (let i = 0; i < matchCount; i++) {
    const day = observations.events[observations.event[i]].day;
    addDay(observations.playerA[i], day);
    addDay(observations.playerB[i], day);
    matchesPlayed[observations.playerA[i]]++;
    matchesPlayed[observations.playerB[i]]++;
    const games = observations.gameWinners[i].length;
    gamesPlayed[observations.playerA[i]] += games;
    gamesPlayed[observations.playerB[i]] += games;
  }

  const days: Int32Array[] = new Array(playerCount);
  const dayIndex: Map<number, number>[] = new Array(playerCount);
  const ratings: Float64Array[] = new Array(playerCount);
  const sigmas: Float64Array[] = new Array(playerCount);
  let maxPoints = 1;
  for (let p = 0; p < playerCount; p++) {
    const sorted = daySets[p] ? [...daySets[p]!].sort((a, b) => a - b) : [];
    days[p] = Int32Array.from(sorted);
    const index = new Map<number, number>();
    sorted.forEach((day, i) => index.set(day, i));
    dayIndex[p] = index;
    ratings[p] = new Float64Array(sorted.length);
    sigmas[p] = new Float64Array(sorted.length);
    if (sorted.length > maxPoints) maxPoints = sorted.length;
    daySets[p] = null; // release
  }

  // 2. Likelihood terms, mirrored into both players' blocks.
  const terms: Term[][] = new Array(playerCount);
  for (let p = 0; p < playerCount; p++) terms[p] = [];

  for (let i = 0; i < matchCount; i++) {
    const a = observations.playerA[i];
    const b = observations.playerB[i];
    const day = observations.events[observations.event[i]].day;
    const ta = dayIndex[a].get(day)!;
    const tb = dayIndex[b].get(day)!;
    const [wa, wb] = observationWeights(
      observations.result[i],
      observations.gameWinners[i],
      options,
      tierWeightFor(observations.events[observations.event[i]].tournamentType, options)
    );
    if (wa === 0 && wb === 0) continue;
    weight[a] += wa + wb;
    weight[b] += wa + wb;
    terms[a].push({ timeIndex: ta, opponent: b, opponentTimeIndex: tb, winWeight: wa, loseWeight: wb });
    terms[b].push({ timeIndex: tb, opponent: a, opponentTimeIndex: ta, winWeight: wb, loseWeight: wa });
  }

  // 3. Newton sweeps, one player-block at a time.
  const diag = new Float64Array(maxPoints);
  const off = new Float64Array(Math.max(1, maxPoints - 1));
  const grad = new Float64Array(maxPoints);
  const step = new Float64Array(maxPoints);
  const workDiag = new Float64Array(maxPoints);
  const workOff = new Float64Array(Math.max(1, maxPoints - 1));
  const workRhs = new Float64Array(maxPoints);

  // Players with no games never move; skipping them keeps the sweep O(games).
  const active: number[] = [];
  for (let p = 0; p < playerCount; p++) if (days[p].length > 0) active.push(p);

  let maxDelta = 0;
  let iterations = 0;
  let converged = false;

  for (let iteration = 0; iteration < options.maxIterations; iteration++) {
    iterations = iteration + 1;
    maxDelta = 0;

    for (const p of active) {
      const n = days[p].length;
      const r = ratings[p];

      grad.fill(0, 0, n);
      diag.fill(0, 0, n);
      if (n > 1) off.fill(0, 0, n - 1);

      for (const term of terms[p]) {
        const d = r[term.timeIndex] - ratings[term.opponent][term.opponentTimeIndex];
        const pWin = sigmoid(d);
        const total = term.winWeight + term.loseWeight;
        grad[term.timeIndex] += term.winWeight - total * pWin;
        diag[term.timeIndex] += total * pWin * (1 - pWin);
      }

      // Global prior on the first point.
      grad[0] -= r[0] * priorPrecision;
      diag[0] += priorPrecision;

      // Wiener prior between consecutive play days.
      for (let k = 0; k + 1 < n; k++) {
        const dt = days[p][k + 1] - days[p][k];
        const precision = 1 / (driftVariancePerDay * Math.max(1, dt));
        const delta = r[k + 1] - r[k];
        grad[k] += delta * precision;
        grad[k + 1] -= delta * precision;
        diag[k] += precision;
        diag[k + 1] += precision;
        off[k] -= precision;
      }

      workDiag.set(diag.subarray(0, n));
      workRhs.set(grad.subarray(0, n));
      if (n > 1) workOff.set(off.subarray(0, n - 1));
      solveTridiagonal(workDiag, workOff, workRhs, n, step);

      for (let k = 0; k < n; k++) {
        let delta = step[k];
        if (!Number.isFinite(delta)) delta = 0;
        if (delta > options.maxStep) delta = options.maxStep;
        else if (delta < -options.maxStep) delta = -options.maxStep;
        r[k] += delta;
        const magnitude = Math.abs(delta);
        if (magnitude > maxDelta) maxDelta = magnitude;
      }
    }

    if (maxDelta < options.tolerance) {
      converged = true;
      break;
    }
  }

  // 4. Posterior SD per curve point: sqrt of the inverse Hessian's diagonal.
  const unit = new Float64Array(maxPoints);
  for (const p of active) {
    const n = days[p].length;
    const r = ratings[p];
    diag.fill(0, 0, n);
    if (n > 1) off.fill(0, 0, n - 1);

    for (const term of terms[p]) {
      const d = r[term.timeIndex] - ratings[term.opponent][term.opponentTimeIndex];
      const pWin = sigmoid(d);
      diag[term.timeIndex] += (term.winWeight + term.loseWeight) * pWin * (1 - pWin);
    }
    diag[0] += priorPrecision;
    for (let k = 0; k + 1 < n; k++) {
      const dt = days[p][k + 1] - days[p][k];
      const precision = 1 / (driftVariancePerDay * Math.max(1, dt));
      diag[k] += precision;
      diag[k + 1] += precision;
      off[k] -= precision;
    }

    for (let t = 0; t < n; t++) {
      workDiag.set(diag.subarray(0, n));
      if (n > 1) workOff.set(off.subarray(0, n - 1));
      unit.fill(0, 0, n);
      unit[t] = 1;
      workRhs.set(unit.subarray(0, n));
      solveTridiagonal(workDiag, workOff, workRhs, n, step);
      sigmas[p][t] = Math.sqrt(Math.max(0, step[t]));
    }
  }

  return {
    days,
    ratings,
    sigmas,
    matchesPlayed,
    gamesPlayed,
    weight,
    iterations,
    converged,
    maxDelta,
    options,
    priorSigma,
  };
}

/** A player's rating and uncertainty at their last recorded time point. */
export function latestRating(fit: WhrFit, player: number): { rating: number; sigma: number; day: number | null } {
  const n = fit.days[player]?.length ?? 0;
  if (n === 0) return { rating: 0, sigma: fit.priorSigma, day: null };
  return { rating: fit.ratings[player][n - 1], sigma: fit.sigmas[player][n - 1], day: fit.days[player][n - 1] };
}

/**
 * A player's rating as of a given day, for prediction and for the chart.
 *
 * Before the first point the prior mean is the honest answer; after the last
 * point the curve is flat (the Wiener prior adds variance, not drift, so the
 * expected rating does not move).
 */
export function ratingOnDay(fit: WhrFit, player: number, day: number): number {
  const points = fit.days[player];
  if (!points || points.length === 0) return 0;
  if (day <= points[0]) return fit.ratings[player][0];
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i] <= day) return fit.ratings[player][i];
  }
  return fit.ratings[player][0];
}

/** P(A beats B) under the fit, as of `day`. */
export function winProbability(fit: WhrFit, a: number, b: number, day: number): number {
  return sigmoid(ratingOnDay(fit, a, day) - ratingOnDay(fit, b, day));
}
