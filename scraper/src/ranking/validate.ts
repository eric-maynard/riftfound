/**
 * Held-out validation.
 *
 * A rating system with no accuracy number is a vibe, not a measurement, so this
 * module is not optional decoration: `scripts/metrics/ranking-metrics.sh`
 * reports it, and the numbers quoted in scraper/CLAUDE.md come from here.
 *
 * The split is **temporal**, not random: the product question is "does this
 * predict the next match", and a random split leaks information backwards
 * through WHR's whole-history revision (a held-out match played by two players
 * whose later games are in the training set is much easier to call than a
 * genuinely future one). Matches on or after `cutoffDay` are held out, the fit
 * sees only what came before, and prediction uses each player's rating as of the
 * last training day.
 *
 * Three baselines, because "better than nothing" is not interesting:
 *
 * 1. **Riot's tiebreakers.** Each player's game-win percentage from their most
 *    recent *prior* event. This is genuinely independent signal that Riot
 *    already publishes - if a whole-history fit cannot beat "who had the better
 *    game-win rate last time out", it is not earning its complexity. (Using a
 *    tiebreaker from the same event would be leakage: it is computed from the
 *    very match being predicted.)
 * 2. **Experience.** Favour whoever has played more matches. Catches the case
 *    where a rating is really just an attendance count.
 * 3. **Coin flip.** The floor: accuracy 0.5, log loss ln 2 = 0.6931.
 */

import { MatchResult, sliceMatches, type ObservationSet } from './observations.js';
import { SetCarry, type SetCarryMode, type SetCarryOptions } from './carry.js';
import { ELO_PER_NAT, fitWhr, ratingOnDay, type PlayerPrior, type WhrOptions } from './whr.js';
import type { SetEra } from './sets.js';

export interface PredictorScore {
  name: string;
  /** Held-out matches this predictor could call at all. */
  covered: number;
  correct: number;
  accuracy: number;
  /** Mean negative log likelihood. Lower is better; a coin flip is 0.6931. */
  logLoss: number;
  /** Brier score. Lower is better; a coin flip is 0.25. */
  brier: number;
}

export interface ValidationResult {
  cutoffDay: number;
  cutoffDate: string;
  trainMatches: number;
  /** Decisive held-out matches (draws cannot be scored as a win/loss call). */
  testMatches: number;
  /** Held-out matches where both players were seen in training. */
  evaluable: number;
  /** Share of held-out matches that are between two players new to the fit. */
  coldStartShare: number;
  scores: PredictorScore[];
  options: WhrOptions;
  converged: boolean;
}

const MS_PER_DAY = 86_400_000;

class Scorer {
  covered = 0;
  correct = 0;
  logLoss = 0;
  brier = 0;

  constructor(readonly name: string) {}

  /** `probability` is P(A wins); `aWon` is the truth. */
  add(probability: number, aWon: boolean): void {
    // Clamp so a confident miss is penalised heavily but not infinitely.
    const p = Math.min(0.999, Math.max(0.001, probability));
    this.covered++;
    if ((aWon && p > 0.5) || (!aWon && p < 0.5)) this.correct++;
    else if (p === 0.5) this.correct += 0.5;
    this.logLoss += aWon ? -Math.log(p) : -Math.log(1 - p);
    const error = (aWon ? 1 : 0) - p;
    this.brier += error * error;
  }

  score(): PredictorScore {
    return {
      name: this.name,
      covered: this.covered,
      correct: this.correct,
      accuracy: this.covered > 0 ? this.correct / this.covered : 0,
      logLoss: this.covered > 0 ? this.logLoss / this.covered : 0,
      brier: this.covered > 0 ? this.brier / this.covered : 0,
    };
  }
}

/**
 * Fit on everything before the cutoff, score what comes after.
 *
 * `cutoffDay` is a whole-day number (see `dayNumber`). With a short history, the
 * caller usually picks it as "the last N days of data".
 */
export function validate(
  observations: ObservationSet,
  cutoffDay: number,
  overrides: Partial<WhrOptions> = {}
): ValidationResult {
  const train = sliceMatches(
    observations,
    i => observations.events[observations.event[i]].day < cutoffDay
  );
  const fit = fitWhr(train, overrides);
  const trainDay = cutoffDay - 1;

  // Matches played per player in training, for the experience baseline.
  const trainMatches = new Int32Array(observations.players.length);
  for (let i = 0; i < train.playerA.length; i++) {
    trainMatches[train.playerA[i]]++;
    trainMatches[train.playerB[i]]++;
  }

  // Latest pre-cutoff tiebreakers per player. standings are day-ascending, so
  // the last write before the cutoff wins.
  const lastGameWinPct = new Map<number, number>();
  for (const standing of observations.standings) {
    if (standing.day >= cutoffDay) break;
    if (standing.gameWinPct !== null) lastGameWinPct.set(standing.player, standing.gameWinPct);
  }

  const whr = new Scorer('WHR (this model)');
  const riot = new Scorer("Riot tiebreaker (prior event GW%)");
  const experience = new Scorer('Experience (more matches played)');
  const coin = new Scorer('Coin flip');

  let testMatches = 0;
  let evaluable = 0;
  let coldStart = 0;

  for (let i = 0; i < observations.playerA.length; i++) {
    const event = observations.events[observations.event[i]];
    if (event.day < cutoffDay) continue;
    // A draw has no winner to call; it is excluded from accuracy rather than
    // scored as half right for everyone, which would flatter every predictor.
    if (observations.result[i] === MatchResult.Draw) continue;
    testMatches++;

    const a = observations.playerA[i];
    const b = observations.playerB[i];
    const aWon = observations.result[i] === MatchResult.AWin;

    if (trainMatches[a] === 0 && trainMatches[b] === 0) coldStart++;
    if (trainMatches[a] === 0 || trainMatches[b] === 0) continue;
    evaluable++;

    const diff = ratingOnDay(fit, a, trainDay) - ratingOnDay(fit, b, trainDay);
    whr.add(1 / (1 + Math.exp(-diff)), aWon);
    coin.add(0.5, aWon);

    const gwA = lastGameWinPct.get(a);
    const gwB = lastGameWinPct.get(b);
    if (gwA !== undefined && gwB !== undefined) {
      // Map the GW% gap onto a probability with the same logistic shape, scaled
      // so a full 0..1 gap is a decisive call. No fitting: this is a baseline.
      riot.add(1 / (1 + Math.exp(-4 * (gwA - gwB))), aWon);
    }

    if (trainMatches[a] !== trainMatches[b]) {
      experience.add(trainMatches[a] > trainMatches[b] ? 0.6 : 0.4, aWon);
    }
  }

  return {
    cutoffDay,
    cutoffDate: new Date(cutoffDay * MS_PER_DAY).toISOString().slice(0, 10),
    trainMatches: train.playerA.length,
    testMatches,
    evaluable,
    coldStartShare: testMatches > 0 ? coldStart / testMatches : 0,
    scores: [whr.score(), riot.score(), experience.score(), coin.score()],
    options: fit.options,
    converged: fit.converged,
  };
}

/**
 * Sweep the prior strength against held-out log loss.
 *
 * The prior SD is the one knob that cannot be read off the data by inspection -
 * it encodes how spread out player strength really is - so it gets picked the
 * only defensible way: by out-of-sample fit. Reported by the metrics CLI.
 */
export function sweepPriorSigma(
  observations: ObservationSet,
  cutoffDay: number,
  candidatesElo: number[],
  overrides: Partial<WhrOptions> = {}
): { priorSigmaElo: number; result: ValidationResult }[] {
  return candidatesElo.map(priorSigmaElo => ({
    priorSigmaElo,
    result: validate(observations, cutoffDay, { ...overrides, priorSigmaElo }),
  }));
}

/** Sweep the observation level / game weight the same way. */
export function sweepObservationLevel(
  observations: ObservationSet,
  cutoffDay: number,
  overrides: Partial<WhrOptions> = {}
): { label: string; result: ValidationResult }[] {
  const variants: { label: string; options: Partial<WhrOptions> }[] = [
    { label: 'match level', options: { observationLevel: 'match' } },
    { label: 'game level (each game independent)', options: { observationLevel: 'game', weightScale: 1 } },
    { label: 'game level, scale 0.7', options: { observationLevel: 'game', weightScale: 0.7 } },
    { label: 'game-shared (DEFAULT)', options: { observationLevel: 'game-shared', weightScale: 1 } },
    { label: 'game-shared, scale 0.7', options: { observationLevel: 'game-shared', weightScale: 0.7 } },
    { label: 'game-shared, scale 1.4', options: { observationLevel: 'game-shared', weightScale: 1.4 } },
  ];
  return variants.map(variant => ({
    label: variant.label,
    result: validate(observations, cutoffDay, { ...overrides, ...variant.options }),
  }));
}

/**
 * Does pooling different kinds of event into one rating cost anything?
 *
 * The question behind this is whether skill at a Pre-Rift (sealed/limited, play
 * what you opened) is the same quantity as skill at a Summoner Skirmish or a
 * Nexus Night (constructed, play what you built). If it is not, one pooled
 * rating is averaging two different abilities and a `format` dimension would be
 * worth the plumbing.
 *
 * Riot does return a `format` field on its event search API, but **it is not
 * stored and cannot be recovered for past events** - the search API is
 * upcoming-only and the event detail page the results pass reads does not carry
 * it. So `tournamentType` is used as the proxy: Pre-Rift is the sealed tier,
 * Nexus Night and Summoner Skirmish are the constructed ones.
 *
 * Two comparisons per type, on the same held-out matches:
 *
 * - **pooled**: the model fitted on every match, scored on this type's matches.
 * - **restricted**: a model fitted on *only* this type's matches, scored on the
 *   same held-out matches.
 *
 * If restricted beats pooled, the types measure different things and pooling is
 * destroying signal. If pooled wins, pooling is buying evidence - which is the
 * expected result when most players have very few games, because a restricted
 * fit throws most of their record away.
 */
export interface TypeSplitRow {
  tournamentType: string;
  trainMatches: number;
  restrictedTrainMatches: number;
  heldOut: number;
  pooled: PredictorScore;
  restricted: PredictorScore;
  /** Pooled log loss minus restricted. Negative means pooling wins. */
  logLossDelta: number;
}

export function validateByType(
  observations: ObservationSet,
  cutoffDay: number,
  overrides: Partial<WhrOptions> = {},
  minMatches = 200
): TypeSplitRow[] {
  const typeOf = (matchIndex: number) =>
    observations.events[observations.event[matchIndex]].tournamentType ?? 'Unknown';

  const before = (matchIndex: number) => observations.events[observations.event[matchIndex]].day < cutoffDay;

  const counts = new Map<string, number>();
  for (let i = 0; i < observations.playerA.length; i++) {
    if (!before(i)) continue;
    const type = typeOf(i);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  const pooledTrain = sliceMatches(observations, before);
  const pooledFit = fitWhr(pooledTrain, overrides);
  const trainDay = cutoffDay - 1;

  const rows: TypeSplitRow[] = [];
  for (const [tournamentType, restrictedTrainMatches] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (restrictedTrainMatches < minMatches) continue;

    const restrictedTrain = sliceMatches(observations, i => before(i) && typeOf(i) === tournamentType);
    const restrictedFit = fitWhr(restrictedTrain, overrides);

    const pooled = new Scorer(`${tournamentType}: pooled fit`);
    const restricted = new Scorer(`${tournamentType}: ${tournamentType}-only fit`);

    // Seen-in-training counts, per fit, so neither is credited for a player it
    // never saw. Scored only where *both* fits can call the match, so the two
    // numbers are comparable on exactly the same rows.
    const pooledSeen = new Int32Array(observations.players.length);
    for (let i = 0; i < pooledTrain.playerA.length; i++) {
      pooledSeen[pooledTrain.playerA[i]]++;
      pooledSeen[pooledTrain.playerB[i]]++;
    }
    const restrictedSeen = new Int32Array(observations.players.length);
    for (let i = 0; i < restrictedTrain.playerA.length; i++) {
      restrictedSeen[restrictedTrain.playerA[i]]++;
      restrictedSeen[restrictedTrain.playerB[i]]++;
    }

    let heldOut = 0;
    for (let i = 0; i < observations.playerA.length; i++) {
      if (before(i)) continue;
      if (typeOf(i) !== tournamentType) continue;
      if (observations.result[i] === MatchResult.Draw) continue;
      const a = observations.playerA[i];
      const b = observations.playerB[i];
      if (pooledSeen[a] === 0 || pooledSeen[b] === 0) continue;
      if (restrictedSeen[a] === 0 || restrictedSeen[b] === 0) continue;
      heldOut++;
      const aWon = observations.result[i] === MatchResult.AWin;
      pooled.add(
        1 / (1 + Math.exp(-(ratingOnDay(pooledFit, a, trainDay) - ratingOnDay(pooledFit, b, trainDay)))),
        aWon
      );
      restricted.add(
        1 / (1 + Math.exp(-(ratingOnDay(restrictedFit, a, trainDay) - ratingOnDay(restrictedFit, b, trainDay)))),
        aWon
      );
    }

    const pooledScore = pooled.score();
    const restrictedScore = restricted.score();
    rows.push({
      tournamentType,
      trainMatches: pooledTrain.playerA.length,
      restrictedTrainMatches,
      heldOut,
      pooled: pooledScore,
      restricted: restrictedScore,
      logLossDelta: pooledScore.logLoss - restrictedScore.logLoss,
    });
  }
  return rows;
}

/**
 * Games actually recorded per match, by tournament type.
 *
 * Reported because it is strongly type-dependent and the pooled figure is a
 * composition artifact of whatever event mix the window happened to contain -
 * see scraper/CLAUDE.md.
 */
export function gamesPerMatchByType(
  observations: ObservationSet
): { tournamentType: string; matches: number; games: number; gamesPerMatch: number; histogram: number[] }[] {
  const byType = new Map<string, { matches: number; games: number; histogram: number[] }>();
  for (let i = 0; i < observations.playerA.length; i++) {
    const type = observations.events[observations.event[i]].tournamentType ?? 'Unknown';
    let row = byType.get(type);
    if (!row) byType.set(type, (row = { matches: 0, games: 0, histogram: [0, 0, 0, 0] }));
    const games = observations.gameWinners[i].length;
    row.matches++;
    row.games += games;
    if (games < row.histogram.length) row.histogram[games]++;
  }
  return [...byType.entries()]
    .map(([tournamentType, row]) => ({
      tournamentType,
      matches: row.matches,
      games: row.games,
      gamesPerMatch: row.matches > 0 ? row.games / row.matches : 0,
      histogram: row.histogram,
    }))
    .sort((a, b) => b.matches - a.matches);
}

/**
 * What a tier weight would actually be acting on.
 *
 * Reported *before* any sweep, because the distribution is the first thing that
 * decides whether weighting can help at all. Up-weighting a tier that holds 1%
 * of the matches cannot improve a ladder of players whose median record is 5
 * matches; it can only add variance to the few players who happened to attend.
 *
 * `playersAffected` is the number of players with at least one match in the
 * tier, and `exclusivePlayers` the number whose *whole* record is in it - those
 * are the players a tier weight simply rescales, with no effect on their rating
 * at all, because a rating is identified by differences.
 */
export function matchDistributionByTier(observations: ObservationSet): {
  tier: string;
  matches: number;
  matchShare: number;
  players: number;
  exclusivePlayers: number;
  medianMatchesPerPlayer: number;
}[] {
  const tiers = new Map<string, { matches: number; perPlayer: Map<number, number> }>();
  const totalPerPlayer = new Map<number, number>();
  for (let i = 0; i < observations.playerA.length; i++) {
    const tier = observations.events[observations.event[i]].tournamentType ?? 'Unknown';
    let row = tiers.get(tier);
    if (!row) tiers.set(tier, (row = { matches: 0, perPlayer: new Map() }));
    row.matches++;
    for (const player of [observations.playerA[i], observations.playerB[i]]) {
      row.perPlayer.set(player, (row.perPlayer.get(player) ?? 0) + 1);
      totalPerPlayer.set(player, (totalPerPlayer.get(player) ?? 0) + 1);
    }
  }
  const total = observations.playerA.length;
  return [...tiers.entries()]
    .map(([tier, row]) => {
      const counts = [...row.perPlayer.values()].sort((a, b) => a - b);
      let exclusive = 0;
      for (const [player, count] of row.perPlayer) {
        if (totalPerPlayer.get(player) === count) exclusive++;
      }
      return {
        tier,
        matches: row.matches,
        matchShare: total > 0 ? row.matches / total : 0,
        players: row.perPlayer.size,
        exclusivePlayers: exclusive,
        medianMatchesPerPlayer: counts.length > 0 ? counts[counts.length >> 1] : 0,
      };
    })
    .sort((a, b) => b.matches - a.matches);
}

/**
 * Sweep candidate tier-weight tables against held-out accuracy.
 *
 * This is the gate on the whole idea: weighting changes how far each result
 * moves a rating, so it changes calibration, and a table that feels principled
 * can still predict worse. The variants are built from whichever tiers are
 * actually present, so the sweep is meaningful on any window - including one
 * where the competitive tiers have no events at all, in which case the ladder
 * variants collapse to the neutral table and say so by scoring identically.
 */
export function sweepTierWeights(
  observations: ObservationSet,
  cutoffDay: number,
  overrides: Partial<WhrOptions> = {}
): { label: string; weights: Record<string, number>; result: ValidationResult }[] {
  // The product ordering, strongest evidence first. Tiers absent from the data
  // contribute nothing, which is exactly what makes the result honest.
  const ladder = [
    'World Championship',
    'Continental',
    'Regional',
    'Showdown Series',
    'Challenge Series',
    'Nexus Cup',
    'Summoner Skirmish',
    'Pre-Rift',
    'Nexus Night',
    'Open Play',
    'Learn to Play',
  ];
  const present = new Set(
    observations.events.map(event => event.tournamentType).filter((type): type is string => Boolean(type))
  );

  /** Geometric ladder: the top present tier gets `top`, each step down divides. */
  const ladderWeights = (top: number, step: number): Record<string, number> => {
    const weights: Record<string, number> = {};
    let rank = 0;
    for (const tier of ladder) {
      if (!present.has(tier)) continue;
      weights[tier] = Number((top / step ** rank).toFixed(4));
      rank++;
    }
    return weights;
  };

  const variants: { label: string; weights: Record<string, number> }[] = [
    { label: 'neutral (DEFAULT)', weights: {} },
    { label: 'ladder, 1.5x per tier', weights: ladderWeights(1, 1.5) },
    { label: 'ladder, 2x per tier', weights: ladderWeights(1, 2) },
    // The crudest version of the request: competitive play counts double,
    // casual play counts half, everything else as now.
    {
      label: 'competitive 2x / casual 0.5x',
      weights: {
        'World Championship': 2,
        Continental: 2,
        Regional: 2,
        'Showdown Series': 2,
        'Challenge Series': 2,
        'Nexus Cup': 2,
        'Summoner Skirmish': 1.5,
        'Open Play': 0.5,
        'Learn to Play': 0.5,
      },
    },
    // The sealed/constructed split as a weight rather than a dimension, for
    // comparison with the measured per-format result.
    { label: 'Pre-Rift 0.5x', weights: { 'Pre-Rift': 0.5 } },
  ];

  return variants.map(variant => ({
    label: variant.label,
    weights: variant.weights,
    result: validate(observations, cutoffDay, { ...overrides, tierWeights: variant.weights }),
  }));
}

/**
 * The gate on carrying a rating across a set rotation.
 *
 * The question: "we should have ample signal from the vendetta set already, if
 * we anchor starting elo in one set to closing elo in the last". The premise it
 * replaces - that a rotation is a metagame reset, so each era is fitted from
 * the global prior - is a *decision*, so this measures it rather than assuming
 * either way.
 *
 * The split is the same temporal one `validate` uses, and the comparison is
 * built to be fair in the way the per-format comparison was:
 *
 * - **Both variants are scored on exactly the same rows.** The common rows are
 *   the held-out matches in the target era where *both* players also appear in
 *   that era's pre-cutoff slice, so neither variant is credited for a player
 *   the other has never met. Without that the carried fit would score on extra
 *   rows and win on coverage rather than on calibration.
 * - **Coverage is reported separately, not folded in.** The carried prior can
 *   call a match where a player has no games in the new era at all, which is a
 *   real product gain and a different claim from "it predicts better". Those
 *   rows are scored in their own column.
 * - **It is broken out by how thin the new era's evidence is.** The whole point
 *   of carrying is that a new set's ladder is thin by construction, so the
 *   result that matters is whether the gain concentrates on players with few
 *   games in the new era. A uniform gain would be suspicious; a gain only on
 *   the thin buckets is the predicted shape.
 *
 * Each row is one candidate widening, with `rotationSigmaElo: null` as the
 * shipped baseline (no carry at all).
 */
export interface SetCarryBucket {
  /** The thinner of the two players had this many games in the era slice. */
  label: string;
  heldOut: number;
  accuracy: number;
  logLoss: number;
}

export interface SetCarryRow {
  /** Era whose held-out matches are being predicted. */
  eraId: string;
  /** Eras whose closing ratings were available to carry from. */
  priorEraIds: string[];
  /** null for the shipped baseline: no carry. */
  rotationSigmaElo: number | null;
  mode: SetCarryMode | null;
  /** Players whose prior was moved off the global one. */
  carriedPlayers: number;
  /** Of those, how many were capped at the global SD - mean only, no precision. */
  cappedPlayers: number;
  /** Matches in the target era before the cutoff: the era-scoped training set. */
  trainMatches: number;
  /** Rows every variant can call. Identical across the rows of one era. */
  heldOut: number;
  score: PredictorScore;
  /** Rows this variant can call at all, which the carry can extend. */
  covered: number;
  coverageScore: PredictorScore;
  /** Common rows split on the thinner player's game count in the era slice. */
  buckets: SetCarryBucket[];
}

/** Buckets on the *thinner* player's games in the new era's training slice. */
const CARRY_BUCKETS: { label: string; max: number }[] = [
  { label: '1-2', max: 2 },
  { label: '3-4', max: 4 },
  { label: '5-7', max: 7 },
  { label: '8+', max: Number.POSITIVE_INFINITY },
];

function bucketOf(games: number): string {
  for (const bucket of CARRY_BUCKETS) if (games <= bucket.max) return bucket.label;
  return CARRY_BUCKETS[CARRY_BUCKETS.length - 1].label;
}

/**
 * Fit every era up to `target` in order, chaining the carry through them.
 *
 * Returns the prior era `target` should open with. `target === 0` has nothing
 * before it, so it always gets null - which is the no-previous-era case, and
 * the reason a first era is fitted exactly as it is today.
 */
function carryChain(
  observations: ObservationSet,
  eraIds: readonly string[],
  target: number,
  keep: (matchIndex: number) => boolean,
  options: SetCarryOptions,
  overrides: Partial<WhrOptions>
): { prior: PlayerPrior | null; carried: number; capped: number } {
  const carry = new SetCarry(observations.players.length, options);
  const eraOf = (matchIndex: number) => observations.events[observations.event[matchIndex]].eraId;
  let globalSigma = Number.POSITIVE_INFINITY;
  for (let earlier = 0; earlier < target; earlier++) {
    const slice = sliceMatches(observations, i => keep(i) && eraOf(i) === eraIds[earlier]);
    const built = carry.priorFor(earlier, globalSigma);
    const fit = fitWhr(slice, overrides, built.prior);
    globalSigma = fit.priorSigma;
    carry.record(fit, earlier);
  }
  const built = carry.priorFor(target, globalSigma);
  return { prior: built.prior, carried: built.counts.carried, capped: built.counts.capped };
}

/**
 * Sweep the rotation widening against held-out log loss, per era.
 *
 * `eras` must be the chronological era table the observations were built with;
 * only eras with at least `minEraMatches` pre-cutoff matches are fitted, which
 * mirrors `RANKING_MIN_SET_MATCHES` in the snapshot - an era that is not a
 * ladder is not a rotation either.
 */
export function sweepSetCarry(
  observations: ObservationSet,
  cutoffDay: number,
  eras: readonly SetEra[],
  candidatesElo: (number | null)[] = [null, 0, 25, 50, 75, 100, 150, 200, 300, 600],
  overrides: Partial<WhrOptions> = {},
  mode: SetCarryMode = 'last-seen',
  minEraMatches = 50
): SetCarryRow[] {
  const playerCount = observations.players.length;
  const eraOf = (matchIndex: number) => observations.events[observations.event[matchIndex]].eraId;
  const before = (matchIndex: number) => observations.events[observations.event[matchIndex]].day < cutoffDay;
  const trainDay = cutoffDay - 1;

  const trainCounts = new Map<string, number>();
  const testCounts = new Map<string, number>();
  for (let i = 0; i < observations.playerA.length; i++) {
    const eraId = eraOf(i);
    if (!eraId) continue;
    const counts = before(i) ? trainCounts : testCounts;
    counts.set(eraId, (counts.get(eraId) ?? 0) + 1);
  }

  const fittable = eras.filter(era => (trainCounts.get(era.id) ?? 0) >= minEraMatches);
  const eraIds = fittable.map(era => era.id);
  const rows: SetCarryRow[] = [];

  for (let target = 1; target < fittable.length; target++) {
    const era = fittable[target];
    if ((testCounts.get(era.id) ?? 0) === 0) continue;

    const eraTrain = sliceMatches(observations, i => before(i) && eraOf(i) === era.id);
    // Games per player inside the era's training slice: both the "seen in this
    // era" test and the thin/thick split come off this.
    const eraTrainGames = new Int32Array(playerCount);
    for (let i = 0; i < eraTrain.playerA.length; i++) {
      const games = Math.max(1, eraTrain.gameWinners[i].length);
      eraTrainGames[eraTrain.playerA[i]] += games;
      eraTrainGames[eraTrain.playerB[i]] += games;
    }

    for (const rotationSigmaElo of candidatesElo) {
      const chain = rotationSigmaElo === null
        ? { prior: null, carried: 0, capped: 0 }
        : carryChain(observations, eraIds, target, before, { enabled: true, rotationSigmaElo, mode }, overrides);
      const prior = chain.prior;

      const fit = fitWhr(eraTrain, overrides, prior);
      const label = rotationSigmaElo === null
        ? `${era.id}: no carry (DEFAULT)`
        : `${era.id}: carry, rotation ${rotationSigmaElo}`;
      const common = new Scorer(label);
      const all = new Scorer(`${label} (all callable rows)`);
      const buckets = new Map<string, Scorer>();
      const callable = (player: number) =>
        eraTrainGames[player] > 0 || (prior !== null && prior.sigma[player] > 0);

      for (let i = 0; i < observations.playerA.length; i++) {
        if (before(i)) continue;
        if (eraOf(i) !== era.id) continue;
        if (observations.result[i] === MatchResult.Draw) continue;
        const a = observations.playerA[i];
        const b = observations.playerB[i];
        const aWon = observations.result[i] === MatchResult.AWin;
        const thin = Math.min(eraTrainGames[a], eraTrainGames[b]);
        const probability =
          1 / (1 + Math.exp(-(ratingOnDay(fit, a, trainDay) - ratingOnDay(fit, b, trainDay))));

        // Callable at all: the fit has a rating for both sides, which the
        // carried prior extends to a player with no games in this era.
        if (callable(a) && callable(b)) all.add(probability, aWon);

        // The comparable rows: both players present in the era's own slice.
        if (thin === 0) continue;
        common.add(probability, aWon);
        const key = bucketOf(thin);
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, (bucket = new Scorer(key)));
        bucket.add(probability, aWon);
      }

      const commonScore = common.score();
      const allScore = all.score();
      rows.push({
        eraId: era.id,
        priorEraIds: eraIds.slice(0, target),
        rotationSigmaElo,
        mode: rotationSigmaElo === null ? null : mode,
        carriedPlayers: chain.carried,
        cappedPlayers: chain.capped,
        trainMatches: eraTrain.playerA.length,
        heldOut: commonScore.covered,
        score: commonScore,
        covered: allScore.covered,
        coverageScore: allScore,
        buckets: CARRY_BUCKETS.map(bucket => {
          const scorer = buckets.get(bucket.label)?.score();
          return {
            label: bucket.label,
            heldOut: scorer?.covered ?? 0,
            accuracy: scorer?.accuracy ?? 0,
            logLoss: scorer?.logLoss ?? 0,
          };
        }),
      });
    }
  }

  return rows;
}

/**
 * How many players a carried prior would admit to each per-era ladder.
 *
 * Reported beside the sweep because the product claim and the accuracy claim
 * are different claims: a carried prior can leave log loss alone and still
 * change who is publishable, by opening a thin player's curve at a narrower
 * posterior SD than the global prior allows. Both have to be stated.
 *
 * `minGames` / `maxUncertaintyElo` are the snapshot's publishing bar. Fitted on
 * the whole window, not a split - this is a population count, not a prediction.
 */
export function setCarryRatedCounts(
  observations: ObservationSet,
  eras: readonly SetEra[],
  rotationSigmaElo: number | null,
  overrides: Partial<WhrOptions> = {},
  minGames = 8,
  maxUncertaintyElo = 120,
  mode: SetCarryMode = 'last-seen',
  minEraMatches = 50
): { eraId: string; matches: number; players: number; rated: number; carriedPlayers: number }[] {
  const playerCount = observations.players.length;
  const eraOf = (matchIndex: number) => observations.events[observations.event[matchIndex]].eraId;

  const counts = new Map<string, number>();
  for (let i = 0; i < observations.playerA.length; i++) {
    const eraId = eraOf(i);
    if (eraId) counts.set(eraId, (counts.get(eraId) ?? 0) + 1);
  }
  const fittable = eras.filter(era => (counts.get(era.id) ?? 0) >= minEraMatches);

  const carry = new SetCarry(playerCount, {
    enabled: rotationSigmaElo !== null,
    rotationSigmaElo: rotationSigmaElo ?? 0,
    mode,
  });
  const out: { eraId: string; matches: number; players: number; rated: number; carriedPlayers: number }[] = [];
  let globalSigma = Number.POSITIVE_INFINITY;

  fittable.forEach((era, ordinal) => {
    const slice = sliceMatches(observations, i => eraOf(i) === era.id);
    const built = carry.priorFor(ordinal, globalSigma);
    const fit = fitWhr(slice, overrides, built.prior);
    globalSigma = fit.priorSigma;
    carry.record(fit, ordinal);

    let players = 0;
    let rated = 0;
    for (let p = 0; p < playerCount; p++) {
      const points = fit.days[p]?.length ?? 0;
      if (points === 0) continue;
      players++;
      const sigmaElo = fit.sigmas[p][points - 1] * ELO_PER_NAT;
      if (fit.gamesPlayed[p] >= minGames && sigmaElo <= maxUncertaintyElo) rated++;
    }
    out.push({
      eraId: era.id,
      matches: slice.playerA.length,
      players,
      rated,
      carriedPlayers: built.counts.carried,
    });
  });

  return out;
}
