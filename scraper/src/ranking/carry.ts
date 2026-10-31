/**
 * Carrying a rating across a set rotation.
 *
 * Per-era ladders (`set:<id>`) are fitted independently, each on its own
 * matches, and every player's first rating in every era is drawn from the same
 * global prior N(0, sigma0^2). That is a defensible premise - a set rotation is
 * a real metagame reset - and it is expensive: a set in its first weeks has
 * almost no evidence, so most of its ladder fails the publishing bar.
 *
 * The alternative this module implements is to **anchor the opening prior of
 * era N+1 on the closing posterior of era N**: a player's first rating is drawn
 * from N(m, s^2 + k*rot^2), where `m` and `s` are their closing rating and
 * posterior SD in the last era they were seen in, `k` is the number of era
 * boundaries crossed since, and `rot` (`rotationSigmaElo`) is how much skill a
 * rotation is allowed to have scrambled.
 *
 * Four properties this shape is built to have, because each of them is a way
 * the obvious implementation would be wrong:
 *
 * 1. **A player with no previous era is untouched.** Their prior stays
 *    N(0, sigma0^2), so the whole existing model is the `k = infinity` corner
 *    of this one and a first era is fitted exactly as it is today.
 * 2. **The widening is a knob, not an assumption.** `rot = 0` carries the
 *    closing SD unchanged, which asserts a rotation costs nothing;
 *    `rot -> infinity` keeps the mean and throws the precision away. Both ends
 *    are wrong in opposite directions, so the value is swept against held-out
 *    log loss rather than argued (`sweepSetCarry` in validate.ts).
 * 3. **A carried prior is never wider than the global one.** The global prior
 *    is the maximum-entropy fallback: a player whose previous era told us
 *    nothing must land back on it, not somewhere worse. So the widened SD is
 *    capped at sigma0, and the cap is what makes a long absence degrade
 *    gracefully into "new player, but we remember roughly where you were"
 *    rather than into a confidently wrong number.
 * 4. **Natural units throughout.** `mean` and `sigma` are read straight off the
 *    previous fit in logistic units, where 0 is the prior mean. Nothing here
 *    touches `eloOrigin`, which is the whole point: the anchor stays a display
 *    offset, and a carried prior must not be the thing that makes it
 *    load-bearing. See scraper/CLAUDE.md, "Where the scale is anchored".
 *
 * What this module deliberately does *not* do is touch the `all` scope. `all`
 * already fits one curve over the whole history, and the Wiener process already
 * links a player's days across a set boundary - so a carried prior there would
 * be double-counting the same evidence. `carrySetPriors` is read only in the
 * per-era loop.
 */

import { ELO_PER_NAT, latestRating, type PlayerPrior, type WhrFit } from './whr.js';

/**
 * How a player who skipped an era is treated.
 *
 * - `last-seen` (default): carry from the last era they played in, widened once
 *   per boundary crossed. A long absence compounds the widening until the cap
 *   bites, so the prior decays towards the global one on its own.
 * - `previous-only`: carry only from the immediately preceding era; a returning
 *   player is a new player.
 *
 * **Not measurable on today's data,** and that is why both exist. Only two eras
 * have ever been fitted (`s4` Vendetta and `s5` Radiance) and they are adjacent,
 * so no player can have skipped one: the two modes are identical on every row
 * the sweep can score. `last-seen` is the default because it is the one that
 * degrades continuously - at the shipped widening a single skipped era already
 * puts the carried SD at the cap, i.e. at the global prior width - rather than
 * discarding a record at a cliff edge. Re-measure the day a third era exists.
 */
export type SetCarryMode = 'last-seen' | 'previous-only';

export interface SetCarryOptions {
  /** On by measurement; see DEFAULT_SET_CARRY_OPTIONS. */
  enabled: boolean;
  /**
   * Extra prior SD in Elo, added in quadrature once per era boundary crossed.
   *
   * 0 means "a rotation costs nothing"; a value at or above `priorSigmaElo`
   * means "keep the mean, keep none of the precision". Swept, not guessed.
   */
  rotationSigmaElo: number;
  mode: SetCarryMode;
}

/**
 * Shipped **on**, at a rotation of 100 Elo. Both halves are measurements, and
 * they are measurements of different strengths - which is the point of stating
 * them separately.
 *
 * **That carrying helps is measured.** Temporal split at 2026-10-17 on a replay
 * of production facts: predicting Radiance's held-out day from a Radiance fit
 * seeded with Vendetta closing ratings beats the same fit from the global prior
 * by 0.0044 nats of log loss (0.6741 -> 0.6697), on 3,886 held-out matches both
 * variants can call, with a paired bootstrap 95% CI of [-0.0099, -0.0031] - it
 * excludes zero at every widening in the sweep. A permutation control, carrying
 * the *same* closing ratings shuffled between players, makes log loss **worse**
 * by 0.0097, which is what rules out the gain being a mechanical effect of
 * moving the starting point or narrowing the posteriors.
 *
 * **The widening itself is not identifiable.** The whole sweep from 0 to 600
 * spans 0.0016 nats, which is inside the 0.0015-nat noise band this codebase
 * already established for the three observation levels. So 100 is picked on the
 * two principles the rest of the model is picked on, not on its score:
 *
 * 1. **It does not move the publishing bar.** The median posterior SD in the
 *    `set:s5` fit is 121.0 against 121.1 with no carry at all, where a rotation
 *    of 0 would take it to 117.3 and admit players on carried rather than
 *    earned evidence - the same failure the tier-weight section refuses.
 * 2. **Precision carries only where precision was earned.** The cap bites when
 *    sqrt(s^2 + 100^2) >= 150, i.e. at a closing SD of 112, which is almost
 *    exactly where the measured SD-against-games table crosses 120 - about five
 *    games. So a player with a real record last era carries their width, and a
 *    player with one or two games carries the mean alone at the global width.
 *
 * What this is *not* evidence for: that skill survives a real rotation. The one
 * window with any statistical power has Vendetta's last data one day before
 * Radiance's first, and the two eras differ by format (Nexus Night constructed
 * against the Pre-Rift sealed weekend) more than by time. A genuine three-month
 * gap - Radiance to Legacy, 2027-01-29 - is a harder test, and the widening is
 * the knob to re-sweep on it. See scraper/CLAUDE.md.
 */
export const DEFAULT_SET_CARRY_OPTIONS: SetCarryOptions = {
  enabled: true,
  rotationSigmaElo: 100,
  mode: 'last-seen',
};

/** Parse `RANKING_SET_CARRY` / `RANKING_SET_CARRY_ROTATION_ELO` / `..._MODE`. */
export function parseSetCarryOptions(env: {
  enabled?: string;
  rotationSigmaElo?: string;
  mode?: string;
}): { options: SetCarryOptions; warning?: string } {
  const warnings: string[] = [];
  let enabled = DEFAULT_SET_CARRY_OPTIONS.enabled;
  if (env.enabled !== undefined && env.enabled.trim() !== '') {
    const raw = env.enabled.trim().toLowerCase();
    if (raw === 'true' || raw === '1') enabled = true;
    else if (raw === 'false' || raw === '0') enabled = false;
    else warnings.push('RANKING_SET_CARRY is not a boolean');
  }

  let rotationSigmaElo = DEFAULT_SET_CARRY_OPTIONS.rotationSigmaElo;
  if (env.rotationSigmaElo !== undefined && env.rotationSigmaElo.trim() !== '') {
    const value = Number(env.rotationSigmaElo);
    if (Number.isFinite(value) && value >= 0) rotationSigmaElo = value;
    else warnings.push('RANKING_SET_CARRY_ROTATION_ELO must be a non-negative number');
  }

  let mode = DEFAULT_SET_CARRY_OPTIONS.mode;
  if (env.mode !== undefined && env.mode.trim() !== '') {
    const raw = env.mode.trim();
    if (raw === 'last-seen' || raw === 'previous-only') mode = raw;
    else warnings.push('RANKING_SET_CARRY_MODE must be last-seen or previous-only');
  }

  return {
    options: { enabled, rotationSigmaElo, mode },
    warning: warnings.length > 0 ? warnings.join('; ') : undefined,
  };
}

/** What one player brought out of their last fitted era. */
export interface CarryCounts {
  /** Players whose prior was moved off the global one. */
  carried: number;
  /** Of those, how many were capped at the global SD (no precision carried). */
  capped: number;
  /** Players who got the global prior because this is their first era. */
  fresh: number;
}

/**
 * The closing ratings of every era fitted so far, in era order.
 *
 * Counts only - no player id ever reaches a log line from here.
 */
export class SetCarry {
  private readonly mean: Float64Array;
  private readonly sigma: Float64Array;
  /** Ordinal of the last fitted era this player appeared in; -1 for never. */
  private readonly lastEra: Int32Array;

  constructor(
    playerCount: number,
    private readonly options: SetCarryOptions = DEFAULT_SET_CARRY_OPTIONS
  ) {
    this.mean = new Float64Array(playerCount);
    this.sigma = new Float64Array(playerCount);
    this.lastEra = new Int32Array(playerCount).fill(-1);
  }

  /**
   * Record one era's closing ratings.
   *
   * `eraOrdinal` counts *fitted* eras in chronological order, so an era with too
   * little evidence to be fitted at all does not consume a rotation's worth of
   * widening - it was never a ladder, and a player cannot have been reset by a
   * boundary whose ladder does not exist.
   *
   * Only a player with at least one match in the era is recorded: a carried
   * rating has to come from evidence inside the era, or it is just the previous
   * carry travelling forward for free.
   */
  record(fit: WhrFit, eraOrdinal: number): void {
    for (let p = 0; p < this.lastEra.length; p++) {
      if ((fit.days[p]?.length ?? 0) === 0) continue;
      const { rating, sigma } = latestRating(fit, p);
      if (!Number.isFinite(rating) || !Number.isFinite(sigma) || sigma <= 0) continue;
      this.mean[p] = rating;
      this.sigma[p] = sigma;
      this.lastEra[p] = eraOrdinal;
    }
  }

  /**
   * The prior to open era `eraOrdinal` with, or null when nothing is carried.
   *
   * `globalSigma` is the global prior SD in natural units - both the fallback
   * for a player with no previous era and the cap on a widened one.
   */
  priorFor(
    eraOrdinal: number,
    globalSigma: number
  ): { prior: PlayerPrior | null; counts: CarryCounts } {
    const counts: CarryCounts = { carried: 0, capped: 0, fresh: 0 };
    if (!this.options.enabled) {
      counts.fresh = this.lastEra.length;
      return { prior: null, counts };
    }

    const rotation = this.options.rotationSigmaElo / ELO_PER_NAT;
    const rotationVariance = rotation * rotation;
    const mean = new Float64Array(this.lastEra.length);
    const sigma = new Float64Array(this.lastEra.length);

    for (let p = 0; p < this.lastEra.length; p++) {
      const seen = this.lastEra[p];
      const boundaries = eraOrdinal - seen;
      if (seen < 0 || boundaries < 1 || (this.options.mode === 'previous-only' && boundaries > 1)) {
        counts.fresh++;
        continue;
      }
      const widened = Math.sqrt(this.sigma[p] * this.sigma[p] + boundaries * rotationVariance);
      // Capped at the global prior: see the header, property 3.
      mean[p] = this.mean[p];
      if (widened >= globalSigma) {
        sigma[p] = globalSigma;
        counts.capped++;
      } else {
        sigma[p] = widened;
      }
      counts.carried++;
    }

    return { prior: counts.carried > 0 ? { mean, sigma } : null, counts };
  }
}
