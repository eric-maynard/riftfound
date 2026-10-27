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
import { fitWhr, ratingOnDay, type WhrOptions } from './whr.js';

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
