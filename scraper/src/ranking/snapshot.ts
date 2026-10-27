/**
 * Fit -> derived items.
 *
 * Three decisions are concentrated here, and they are the ones that decide what
 * the public ladder actually claims:
 *
 * **The publishing bar.** Most players in this data have played a handful of
 * games ever, and a Bradley-Terry fit will happily report 1712 +/- 190 for
 * someone with two wins. So a rating is only published when the evidence clears
 * the bar, and the *verdict* - `provisional`, `provisionalReason`,
 * `gamesUntilRated` - is written onto the item rather than left for the UI to
 * invent. Below the bar the profile still exists and still carries
 * `provisionalRating` and the real uncertainty, so a reader can show "three more
 * games" instead of a number nobody should act on.
 *
 * **The default scope is a component, not the world.** Ratings are identified
 * per connected component (see graph.ts), so `component:<id>` ladders are the
 * ones that mean something and the global `all` ladder carries
 * `positionsSuppressed` plus the measured giant-component share so a reader
 * never has to take its global ordering on trust.
 *
 * **Per-set is a filter, not a separate world.** Each set era is fitted
 * independently on its own matches, which is right (a set rotation is a real
 * metagame reset) and expensive in evidence: a two-day-old set has almost no
 * games, so per-set ladders will be nearly empty for weeks and the bar will
 * exclude almost everyone. That is the honest behaviour, and it is why the
 * product default is all-time.
 *
 * One invariant the whole output rests on: **the counts agree.** A profile's
 * `gamesPlayed` is exactly the number of game outcomes in that player's match
 * log, `matchesPlayed` exactly the number of entries, and the same for each
 * per-set slice. Everything is derived from one pass over the same observation
 * set so this holds by construction, and `rankingStore.test.ts` checks it.
 */

import { MatchResult, sliceMatches, type ObservationSet } from './observations.js';
import { findComponents, venueKey, type ComponentAssignment } from './graph.js';
import { fitWhr, latestRating, natToElo, ELO_PER_NAT, type WhrFit, type WhrOptions } from './whr.js';
import { sceneLookup, type SceneAssignment } from './scenes.js';
import { scenePlace, DEFAULT_SCENE_MAP_TOP_VENUES } from './sceneMap.js';
import { ALL_SCOPE, componentScope, setComponentScope, setScope, utcDate, type SetDefinition, type SetEra } from './sets.js';
import {
  MATCH_LOG_VERSION,
  MODEL_VERSION,
  type ComponentProfile,
  type GameOutcome,
  type MatchOutcome,
  type PlayerMatchLogEntry,
  type PlayerProfile,
  type PlayerRatingPoint,
  type ProvisionalReason,
  type RankingMeta,
  type RankingRow,
  type RankingSnapshot,
  type RatingThresholds,
  type SceneProfile,
  type ScopedRating,
  type SetProfile,
  type VenueProfile,
  type VenueRosterEntry,
} from './items.js';
import {
  sanitizeComponentProfile,
  sanitizeMatchLogEntry,
  sanitizePlayerProfile,
  sanitizeSceneProfile,
  sanitizeVenueProfile,
  sanitizeRankingMeta,
  sanitizeRankingRow,
  sanitizeSetProfile,
} from '../sanitize.js';

export interface SnapshotOptions {
  eras: readonly SetEra[];
  /** The set table the eras came from, for the `SET#` items' citations. */
  setTable?: readonly SetDefinition[];
  /** Minimum game observations before a rating is published. */
  minGames: number;
  /** Maximum posterior SD, in rating points, before a rating is published. */
  maxUncertaintyElo: number;
  /** Component size below which a rank is not presented as a position. */
  minComponentSize: number;
  /** Component ladders are published for the largest N components only. */
  maxComponentLadders: number;
  /** Venue key -> human-readable label, resolved from the shops table. */
  venueLabels: Map<string, string>;
  /**
   * The persisted venue -> scene assignment, read not computed.
   *
   * Null means "no re-clustering has been run", and every scene field comes out
   * null rather than being invented. The refit never clusters: see
   * ranking/scenes.ts for why a per-refit partition is unshippable (12-18%
   * label churn) and why this is the one piece of cross-refit state the pass
   * carries.
   */
  sceneAssignment?: SceneAssignment | null;
  /** How many players a venue item denormalises, ordered by matches there. */
  venueTopPlayers: number;
  /**
   * How many venues a component item denormalises for the scene map, ordered
   * by matches of that component played there. See `ranking/sceneMap.ts`.
   */
  sceneMapTopVenues: number;
  whr: Partial<WhrOptions>;
  /** Events whose per-player match log still has to be emitted. */
  matchLogEvents: Set<string>;
  generatedAt?: Date;
  /** Per-set fits are skipped below this many matches in the era. */
  minSetMatches: number;
}

/**
 * The measured publishing bar.
 *
 * Picked from the posterior SD distribution on a complete regional sample
 * (all 1,282 California events of 2026-10-01..24; 26,102 matches, 7,732 players
 * with at least one match):
 *
 * | games played | n | median SD | p90 SD | share at or below 120 |
 * |---|---|---|---|---|
 * | 1-2 | 855 | 130 | 139 | 0.7% |
 * | 3-4 | 2,747 | 122 | 124 | 15.4% |
 * | 5-7 | 1,494 | 107 | 121 | 87.3% |
 * | 8-9 | 672 | 97 | 109 | 95.1% |
 * | 10-12 | 655 | 91 | 105 | 100% |
 * | 20+ | 536 | 73 | 84 | 100% |
 *
 * - `minGames: 8` is the binding test. At 8 games the median SD is 97 rating
 *   points, 35% below the 150-point prior, which is enough to separate players
 *   a couple of hundred points apart. It admits 33.7% of players with any match
 *   at all (2,603 of 7,732) - a ladder of regulars rather than a list dominated
 *   by people who turned up once. (5 games would admit 50.5%, 10 would admit
 *   25.4%.)
 * - `maxUncertaintyElo: 120` is where the game-count buckets separate cleanly:
 *   it admits 87% of players with 5-7 games and 0.7% of those with 1-2. It is
 *   not redundant with the game count - 4.9% of players with 8-9 games still
 *   fail it, which is the case a game count cannot see: eight games against the
 *   same single opponent carry far less information than eight against eight.
 * - `minComponentSize: 8` decides when a rank stops being a position. 22 of the
 *   29 measured components are smaller than 8 and hold 62 players between them,
 *   0.80% of the pool, so suppressing their positions costs almost nothing and
 *   avoids publishing "2nd place" out of three.
 */
export const DEFAULT_SNAPSHOT_OPTIONS: Omit<
  SnapshotOptions,
  'eras' | 'venueLabels' | 'matchLogEvents' | 'whr'
> = {
  minGames: 8,
  maxUncertaintyElo: 120,
  minComponentSize: 8,
  maxComponentLadders: 50,
  minSetMatches: 50,
  // 25 covers the median venue's 22 players outright; the maximum is 209 and
  // the rest is the long tail of one-night attendees a map drill-down
  // truncates anyway.
  venueTopPlayers: 25,
  // Five pins is what a reader can take in over one city before they stop
  // reading as individual stores; see DEFAULT_SCENE_MAP_TOP_VENUES.
  sceneMapTopVenues: DEFAULT_SCENE_MAP_TOP_VENUES,
  sceneAssignment: null,
};

export interface SnapshotDiagnostics {
  players: number;
  playersWithMatches: number;
  ratedPlayers: number;
  matches: number;
  games: number;
  componentCount: number;
  giantComponentShare: number;
  iterations: number;
  converged: boolean;
  maxDelta: number;
  scopes: { scope: string; rated: number; total: number }[];
  /** Eras skipped for want of data, with their match counts. */
  skippedEras: { eraId: string; matches: number }[];
  matchLogEntries: number;
  matchLogEventsWritten: number;
  /** Venue items emitted, which is the count of venues with a real shop id. */
  venueCount: number;
  /** Scenes from the persisted assignment that this snapshot's venues populate. */
  sceneCount: number;
  /** True when no re-clustering has been run, so every scene field is null. */
  scenesUnassigned: boolean;
  thresholds: RatingThresholds;
}

/** A per-scope fit plus the counters the items need. */
interface ScopeFit {
  scope: string;
  label: string;
  eraId: string | null;
  fit: WhrFit;
  observations: ObservationSet;
  wins: Int32Array;
  losses: Int32Array;
  draws: Int32Array;
}

function outcomeFor(result: number, isA: boolean): MatchOutcome {
  if (result === MatchResult.Draw) return 'draw';
  const aWon = result === MatchResult.AWin;
  return aWon === isA ? 'win' : 'loss';
}

/**
 * The verdict: is this rating publishable, and if not, why?
 *
 * Reasons are reported most-actionable first. A player short of games can do
 * something about it and is told how many; one whose record is uninformative
 * cannot; one in a tiny isolated scene has a comparison problem rather than an
 * evidence problem, and is the only case where a rating is still published
 * (their internal order is real) while the *position* is suppressed.
 */
function verdict(
  games: number,
  uncertaintyElo: number,
  componentSize: number,
  options: SnapshotOptions
): { rated: boolean; reason: ProvisionalReason | null; gamesUntilRated: number | null } {
  if (games < options.minGames) {
    return { rated: false, reason: 'too-few-games', gamesUntilRated: options.minGames - games };
  }
  if (uncertaintyElo > options.maxUncertaintyElo) {
    return { rated: false, reason: 'too-uncertain', gamesUntilRated: null };
  }
  if (componentSize < options.minComponentSize) {
    // Rated, but not positioned: see RankingRow.suppressPosition.
    return { rated: true, reason: 'component-too-small', gamesUntilRated: null };
  }
  return { rated: true, reason: null, gamesUntilRated: null };
}

/**
 * Cross-component uncertainty.
 *
 * A component's overall level is pinned only by the prior, to about
 * priorSigma/sqrt(size). Inside the component that offset cancels; across
 * components it does not, so it is added in quadrature. For a singleton this
 * collapses to the prior SD, which is the correct statement that we know
 * nothing about where that player sits relative to anyone else.
 */
function crossComponentSigma(withinElo: number, componentSize: number, priorSigmaElo: number): number {
  const offset = componentSize > 0 ? priorSigmaElo / Math.sqrt(componentSize) : priorSigmaElo;
  return Math.sqrt(withinElo * withinElo + offset * offset);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function scopedRating(
  scopeFit: ScopeFit,
  player: number,
  componentSize: number,
  priorSigmaElo: number,
  options: SnapshotOptions
): ScopedRating {
  const { rating, sigma } = latestRating(scopeFit.fit, player);
  const games = scopeFit.fit.gamesPlayed[player];
  const matches = scopeFit.fit.matchesPlayed[player];
  const uncertainty = sigma * ELO_PER_NAT;
  const provisionalRating = natToElo(rating, scopeFit.fit.options.eloOrigin);
  const decision = matches > 0
    ? verdict(games, uncertainty, componentSize, options)
    : { rated: false, reason: 'too-few-games' as ProvisionalReason, gamesUntilRated: options.minGames };
  return {
    scope: scopeFit.scope,
    setEraId: scopeFit.eraId,
    label: scopeFit.label,
    rating: decision.rated ? round(provisionalRating) : null,
    uncertainty: round(uncertainty),
    crossComponentUncertainty: round(crossComponentSigma(uncertainty, componentSize, priorSigmaElo)),
    gamesPlayed: games,
    matchesPlayed: matches,
    wins: scopeFit.wins[player],
    losses: scopeFit.losses[player],
    draws: scopeFit.draws[player],
    rated: decision.rated,
    provisional: !decision.rated,
    provisionalReason: decision.reason,
    gamesUntilRated: decision.gamesUntilRated,
    provisionalRating: round(provisionalRating),
  };
}

/** Win/loss/draw tallies per player within one slice of the history. */
function tally(observations: ObservationSet, playerCount: number) {
  const wins = new Int32Array(playerCount);
  const losses = new Int32Array(playerCount);
  const draws = new Int32Array(playerCount);
  for (let i = 0; i < observations.playerA.length; i++) {
    const a = observations.playerA[i];
    const b = observations.playerB[i];
    if (observations.result[i] === MatchResult.Draw) {
      draws[a]++;
      draws[b]++;
    } else if (observations.result[i] === MatchResult.AWin) {
      wins[a]++;
      losses[b]++;
    } else {
      wins[b]++;
      losses[a]++;
    }
  }
  return { wins, losses, draws };
}

/**
 * Build everything one refit produces.
 *
 * Deterministic for a given ObservationSet and options: re-running from scratch
 * writes byte-identical items, which is what makes a from-scratch rerun
 * idempotent and the match log's write-once marker safe.
 */
export function buildSnapshot(
  observations: ObservationSet,
  options: SnapshotOptions
): { snapshot: RankingSnapshot; diagnostics: SnapshotDiagnostics; components: ComponentAssignment; allFit: WhrFit } {
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const playerCount = observations.players.length;
  const components = findComponents(observations);

  const allFit = fitWhr(observations, options.whr);
  const priorSigmaElo = allFit.priorSigma * ELO_PER_NAT;
  const thresholds: RatingThresholds = {
    minGames: options.minGames,
    maxUncertainty: options.maxUncertaintyElo,
    minComponentSize: options.minComponentSize,
  };

  // Per-era fits. An era with too little evidence is skipped outright rather
  // than published as a ladder of provisional numbers.
  const eraMatches = new Map<string, number[]>();
  for (let i = 0; i < observations.playerA.length; i++) {
    const eraId = observations.events[observations.event[i]].eraId;
    if (!eraId) continue;
    const bucket = eraMatches.get(eraId);
    if (bucket) bucket.push(i);
    else eraMatches.set(eraId, [i]);
  }

  const allTally = tally(observations, playerCount);
  const scopeFits: ScopeFit[] = [
    { scope: ALL_SCOPE, label: 'All time', eraId: null, fit: allFit, observations, ...allTally },
  ];
  const skippedEras: { eraId: string; matches: number }[] = [];
  for (const era of options.eras) {
    const indices = eraMatches.get(era.id);
    if (!indices || indices.length < options.minSetMatches) {
      if (indices) skippedEras.push({ eraId: era.id, matches: indices.length });
      continue;
    }
    const keep = new Set(indices);
    const slice = sliceMatches(observations, i => keep.has(i));
    scopeFits.push({
      scope: setScope(era.id),
      label: era.label,
      eraId: era.id,
      fit: fitWhr(slice, options.whr),
      observations: slice,
      ...tally(slice, playerCount),
    });
  }

  // Venue counts and home venue per player.
  const venuesPerPlayer = new Map<number, Map<string, number>>();
  const addVenue = (player: number, venue: string) => {
    let counts = venuesPerPlayer.get(player);
    if (!counts) venuesPerPlayer.set(player, (counts = new Map()));
    counts.set(venue, (counts.get(venue) ?? 0) + 1);
  };
  for (let i = 0; i < observations.playerA.length; i++) {
    const meta = observations.events[observations.event[i]];
    const venue = venueKey(meta.shopExternalId, meta.latitude, meta.longitude);
    addVenue(observations.playerA[i], venue);
    addVenue(observations.playerB[i], venue);
  }

  const homeVenue = new Map<number, string>();
  for (const [player, counts] of venuesPerPlayer) {
    let best = '';
    let bestCount = -1;
    for (const [venue, count] of counts) {
      // Ties broken by venue key so the choice is deterministic across runs.
      if (count > bestCount || (count === bestCount && venue < best)) {
        best = venue;
        bestCount = count;
      }
    }
    homeVenue.set(player, best);
  }

  const regionFor = (player: number): string | null => {
    const venue = homeVenue.get(player);
    return venue ? options.venueLabels.get(venue) ?? null : null;
  };

  // Scenes are *read*, never fitted here. A null assignment leaves every scene
  // field null rather than inventing one - see ranking/scenes.ts.
  const scenes = sceneLookup(options.sceneAssignment ?? null);
  const sceneOf = (player: number): { sceneId: string | null; sceneLabel: string | null } => {
    const venue = homeVenue.get(player);
    const sceneId = venue ? scenes.sceneOfVenue.get(venue) ?? null : null;
    return { sceneId, sceneLabel: sceneId ? scenes.labelOfScene.get(sceneId) ?? null : null };
  };

  // Profiles.
  const profiles: PlayerProfile[] = [];
  const ratedPlayer = new Uint8Array(playerCount);
  const publishedRating = new Array<number | null>(playerCount).fill(null);
  const giantId = components.components[0]?.id ?? null;
  for (let p = 0; p < playerCount; p++) {
    if (allFit.matchesPlayed[p] === 0) continue; // roster-only attendee: no rating to state
    const componentId = components.componentIds[p];
    if (componentId === null) continue; // unreachable: a match implies a component
    const componentSize = components.componentSizes[p];

    const setRatings: Record<string, ScopedRating> = {};
    for (const scopeFit of scopeFits) {
      if (scopeFit.eraId === null || scopeFit.fit.matchesPlayed[p] === 0) continue;
      setRatings[scopeFit.eraId] = scopedRating(scopeFit, p, componentSize, priorSigmaElo, options);
    }

    const all = scopedRating(scopeFits[0], p, componentSize, priorSigmaElo, options);
    const venue = homeVenue.get(p);
    ratedPlayer[p] = all.rated ? 1 : 0;
    publishedRating[p] = all.rating;
    const scene = sceneOf(p);
    profiles.push(
      sanitizePlayerProfile({
        playerId: observations.players[p],
        displayName: observations.displayNames[p],
        tagLine: observations.tagLines[p],
        rating: all.rating,
        provisionalRating: all.provisionalRating,
        uncertainty: all.uncertainty,
        uncertaintyLogOdds: latestRating(allFit, p).sigma,
        crossComponentUncertainty: all.crossComponentUncertainty,
        rated: all.rated,
        provisional: all.provisional,
        provisionalReason: all.provisionalReason,
        gamesUntilRated: all.gamesUntilRated,
        gamesPlayed: all.gamesPlayed,
        matchesPlayed: all.matchesPlayed,
        wins: all.wins,
        losses: all.losses,
        draws: all.draws,
        firstSeen: new Date(observations.firstSeen[p]).toISOString(),
        lastSeen: new Date(observations.lastSeen[p]).toISOString(),
        componentId,
        componentSize,
        componentShare:
          components.playersWithMatches > 0 ? componentSize / components.playersWithMatches : 0,
        inGiantComponent: componentId === giantId,
        regionLabel: regionFor(p),
        venueCount: venuesPerPlayer.get(p)?.size ?? 0,
        homeVenueId: venue?.startsWith('shop:') ? Number(venue.slice(5)) : null,
        sceneId: scene.sceneId,
        sceneLabel: scene.sceneLabel,
        setRatings,
        generatedAt,
        modelVersion: MODEL_VERSION,
        thresholds,
      })
    );
  }

  // Rating history, for rated players only: an unrated player has no chart to
  // draw, and emitting a point per play-day for every one-event attendee would
  // dominate the write volume for nothing.
  const history: PlayerRatingPoint[] = [];
  for (const scopeFit of scopeFits) {
    const perDay = new Map<number, Map<number, { matches: number; games: number }>>();
    for (let i = 0; i < scopeFit.observations.playerA.length; i++) {
      const day = scopeFit.observations.events[scopeFit.observations.event[i]].day;
      const games = scopeFit.observations.gameWinners[i].length;
      for (const player of [scopeFit.observations.playerA[i], scopeFit.observations.playerB[i]]) {
        let byDay = perDay.get(player);
        if (!byDay) perDay.set(player, (byDay = new Map()));
        const bucket = byDay.get(day) ?? { matches: 0, games: 0 };
        bucket.matches++;
        bucket.games += games;
        byDay.set(day, bucket);
      }
    }

    for (let p = 0; p < playerCount; p++) {
      const points = scopeFit.fit.days[p];
      if (!points || points.length === 0) continue;
      const { sigma } = latestRating(scopeFit.fit, p);
      const decision = verdict(
        scopeFit.fit.gamesPlayed[p],
        sigma * ELO_PER_NAT,
        components.componentSizes[p],
        options
      );
      if (!decision.rated) continue;
      let cumulativeMatches = 0;
      let cumulativeGames = 0;
      const byDay = perDay.get(p);
      for (let t = 0; t < points.length; t++) {
        const day = points[t];
        const bucket = byDay?.get(day) ?? { matches: 0, games: 0 };
        cumulativeMatches += bucket.matches;
        cumulativeGames += bucket.games;
        history.push({
          playerId: observations.players[p],
          scope: scopeFit.scope,
          date: utcDate(new Date(day * 86_400_000)),
          rating: round(natToElo(scopeFit.fit.ratings[p][t], scopeFit.fit.options.eloOrigin)),
          uncertainty: round(scopeFit.fit.sigmas[p][t] * ELO_PER_NAT),
          matchesPlayed: cumulativeMatches,
          gamesPlayed: cumulativeGames,
        });
      }
    }
  }

  // Per-player match log, for events not already emitted.
  const matchLog: PlayerMatchLogEntry[] = [];
  const matchLogEvents = new Set<string>();
  for (let i = 0; i < observations.playerA.length; i++) {
    const meta = observations.events[observations.event[i]];
    if (!options.matchLogEvents.has(meta.externalId)) continue;
    matchLogEvents.add(meta.externalId);

    const a = observations.playerA[i];
    const b = observations.playerB[i];
    const winners = observations.gameWinners[i];
    const playedAt = meta.startDate.toISOString();
    const eventDate = utcDate(meta.startDate);

    for (const [self, other, isA] of [
      [a, b, true],
      [b, a, false],
    ] as [number, number, boolean][]) {
      const gameOutcomes: GameOutcome[] = winners.map(winner =>
        (winner === MatchResult.AWin) === isA ? 'win' : 'loss'
      );
      matchLog.push(
        sanitizeMatchLogEntry({
          playerId: observations.players[self],
          matchId: observations.matchIds[i],
          playedAt,
          opponentId: observations.players[other],
          opponentDisplayName: observations.displayNames[other],
          opponentTagLine: observations.tagLines[other],
          result: outcomeFor(observations.result[i], isA),
          gameOutcomes,
          gameWins: gameOutcomes.filter(outcome => outcome === 'win').length,
          gameLosses: gameOutcomes.filter(outcome => outcome === 'loss').length,
          eventExternalId: meta.externalId,
          eventName: meta.name,
          tournamentType: meta.tournamentType,
          shopExternalId: meta.shopExternalId,
          latitude: meta.latitude,
          longitude: meta.longitude,
          eventDate,
          setId: meta.eraId,
        })
      );
    }
  }

  // Ladders: one row per player per scope, rank-ordered.
  const rankings: RankingRow[] = [];
  const metas: RankingMeta[] = [];
  const scopeCounts: { scope: string; rated: number; total: number }[] = [];
  const ratedPerComponent = new Map<string, number>();

  const ladderComponents = components.components
    .slice(0, options.maxComponentLadders)
    .filter(component => component.size >= options.minComponentSize);

  for (const scopeFit of scopeFits) {
    const era = scopeFit.eraId ? options.eras.find(candidate => candidate.id === scopeFit.eraId) ?? null : null;

    const ranked: { player: number; row: Omit<RankingRow, 'rank' | 'scope'> }[] = [];
    let total = 0;
    for (let p = 0; p < playerCount; p++) {
      if (scopeFit.fit.matchesPlayed[p] === 0) continue;
      total++;
      const componentId = components.componentIds[p];
      if (componentId === null) continue;
      const componentSize = components.componentSizes[p];
      const { rating, sigma } = latestRating(scopeFit.fit, p);
      const uncertainty = sigma * ELO_PER_NAT;
      const decision = verdict(scopeFit.fit.gamesPlayed[p], uncertainty, componentSize, options);
      if (!decision.rated) continue;
      ranked.push({
        player: p,
        row: {
          playerId: observations.players[p],
          displayName: observations.displayNames[p],
          tagLine: observations.tagLines[p],
          rating: round(natToElo(rating, scopeFit.fit.options.eloOrigin)),
          uncertainty: round(uncertainty),
          crossComponentUncertainty: round(crossComponentSigma(uncertainty, componentSize, priorSigmaElo)),
          gamesPlayed: scopeFit.fit.gamesPlayed[p],
          matchesPlayed: scopeFit.fit.matchesPlayed[p],
          wins: scopeFit.wins[p],
          losses: scopeFit.losses[p],
          draws: scopeFit.draws[p],
          componentId,
          componentSize,
          regionLabel: regionFor(p),
          ...sceneOf(p),
          suppressPosition: componentSize < options.minComponentSize,
        },
      });
    }
    // Ties broken on the player UUID so the ladder is stable between refits.
    ranked.sort((x, y) => y.row.rating - x.row.rating || (x.row.playerId < y.row.playerId ? -1 : 1));

    scopeCounts.push({ scope: scopeFit.scope, rated: ranked.length, total });
    if (scopeFit.scope === ALL_SCOPE) {
      for (const row of ranked) {
        ratedPerComponent.set(row.row.componentId, (ratedPerComponent.get(row.row.componentId) ?? 0) + 1);
      }
    }

    emitLadder({
      scope: scopeFit.scope,
      label: scopeFit.label,
      kind: scopeFit.eraId ? 'set' : 'all',
      eraId: scopeFit.eraId,
      setAmbiguous: era?.ambiguous ?? false,
      componentId: null,
      componentSize: null,
      componentShare: null,
      regionLabel: null,
      // A cross-component ordering is not a position: see graph.ts.
      positionsSuppressed: true,
      ranked,
    });

    for (const component of ladderComponents) {
      const members = new Set(component.members);
      const inComponent = ranked.filter(row => members.has(row.player));
      if (inComponent.length === 0) continue;
      const label = modalRegion(inComponent.map(row => regionFor(row.player)));
      emitLadder({
        scope: scopeFit.eraId
          ? setComponentScope(scopeFit.eraId, component.id)
          : componentScope(component.id),
        label: label ?? `Cluster ${component.id}`,
        kind: scopeFit.eraId ? 'set-component' : 'component',
        eraId: scopeFit.eraId,
        setAmbiguous: era?.ambiguous ?? false,
        componentId: component.id,
        componentSize: component.size,
        componentShare:
          components.playersWithMatches > 0 ? component.size / components.playersWithMatches : 0,
        regionLabel: label,
        positionsSuppressed: component.size < options.minComponentSize,
        ranked: inComponent,
      });
    }
  }

  function emitLadder(input: {
    scope: string;
    label: string;
    kind: RankingMeta['kind'];
    eraId: string | null;
    setAmbiguous: boolean;
    componentId: string | null;
    componentSize: number | null;
    componentShare: number | null;
    regionLabel: string | null;
    positionsSuppressed: boolean;
    ranked: { player: number; row: Omit<RankingRow, 'rank' | 'scope'> }[];
  }) {
    input.ranked.forEach((entry, index) => {
      rankings.push(
        sanitizeRankingRow({
          scope: input.scope,
          rank: index + 1,
          ...entry.row,
          // On a cross-component board every rank is a comparison between
          // floating scales, so none of them is a position.
          suppressPosition: entry.row.suppressPosition || input.positionsSuppressed,
        })
      );
    });
    metas.push(
      sanitizeRankingMeta({
        scope: input.scope,
        label: input.label,
        kind: input.kind,
        setEraId: input.eraId,
        setAmbiguous: input.setAmbiguous,
        componentId: input.componentId,
        ratedPlayers: input.ranked.length,
        totalPlayers: input.componentSize ?? components.playersWithMatches,
        giantComponentShare: components.giantShare,
        componentSize: input.componentSize,
        componentShare: input.componentShare,
        regionLabel: input.regionLabel,
        positionsSuppressed: input.positionsSuppressed,
        thresholds,
        generatedAt,
        modelVersion: MODEL_VERSION,
      })
    );
  }

  // Component directory, so the region selector and the scene map are one
  // Query each rather than a scan. The place comes off the venue tallies the
  // component walk already collected - see ranking/sceneMap.ts for why that
  // is the only affordable place to locate a scene at all, and for the cases
  // where it publishes nulls instead of a guess.
  const componentProfiles: ComponentProfile[] = components.components.map(component => {
    const label = modalRegion(component.members.map(member => regionFor(member)));
    return sanitizeComponentProfile({
      ...scenePlace(component.venues, { topVenues: options.sceneMapTopVenues }),
      componentId: component.id,
      componentSize: component.size,
      playerCount: component.size,
      ratedCount: ratedPerComponent.get(component.id) ?? 0,
      regionLabel: label,
      componentShare:
        components.playersWithMatches > 0 ? component.size / components.playersWithMatches : 0,
      matchCount: component.matchCount,
      venueCount: component.venueCount,
      isGiant: component.id === giantId,
      positionsSuppressed: component.size < options.minComponentSize,
      generatedAt,
    });
  });

  // Set directory. Every era in the table gets an item, including ones with no
  // data yet, so /api/sets is complete from the first refit - and including the
  // ones whose release date Riot never published, as null rather than a guess.
  const setsById = new Map((options.setTable ?? []).map(set => [set.id, set]));
  const setProfiles: SetProfile[] = options.eras.map(era => {
    const scopeFit = scopeFits.find(candidate => candidate.eraId === era.id);
    const sources = era.setIds
      .map(id => setsById.get(id)?.source)
      .filter((source): source is string => Boolean(source));
    return sanitizeSetProfile({
      setId: era.id,
      name: era.label,
      // The era's own start date: for an ambiguous era this is the first of its
      // sets' releases, and `ambiguous` says the rest are unknown.
      releaseDate: era.setIds.length > 0 ? era.from : null,
      endDate: era.to,
      ambiguous: era.ambiguous,
      setIds: [...era.setIds],
      source: sources.length > 0 ? [...new Set(sources)].join('; ') : 'no published English street date',
      matchCount: eraMatches.get(era.id)?.length ?? 0,
      ratedCount: scopeFit ? (scopeCounts.find(count => count.scope === scopeFit.scope)?.rated ?? 0) : 0,
      fitted: Boolean(scopeFit),
      generatedAt,
    });
  });

  // Venue directory, so a map's first render is one Query and a store page is
  // one GetItem. Nothing here needs data the facts do not already carry: every
  // match fact has a shop id plus coordinates.
  //
  // Keyed on `shopExternalId` only. `venueKey`'s `geo:` fallback is a 1km
  // coordinate rounding, which is a fine graph node and a bad durable key - the
  // id would move if the geocode moved - so an unresolved organizer is left off
  // the map rather than given an id that will change under it.
  interface VenueAccumulator {
    shopExternalId: number;
    latSum: number;
    lonSum: number;
    coordCount: number;
    matches: number;
    events: Set<string>;
    first: number;
    last: number;
    matchesByPlayer: Map<number, number>;
  }
  const venueRows = new Map<string, VenueAccumulator>();
  for (let i = 0; i < observations.playerA.length; i++) {
    const meta = observations.events[observations.event[i]];
    if (meta.shopExternalId === null || meta.shopExternalId === undefined) continue;
    const key = venueKey(meta.shopExternalId, meta.latitude, meta.longitude);
    let row = venueRows.get(key);
    if (!row) {
      venueRows.set(key, (row = {
        shopExternalId: meta.shopExternalId,
        latSum: 0,
        lonSum: 0,
        coordCount: 0,
        matches: 0,
        events: new Set(),
        first: Number.POSITIVE_INFINITY,
        last: Number.NEGATIVE_INFINITY,
        matchesByPlayer: new Map(),
      }));
    }
    if (meta.latitude !== null && meta.longitude !== null) {
      row.latSum += meta.latitude;
      row.lonSum += meta.longitude;
      row.coordCount++;
    }
    row.matches++;
    row.events.add(meta.externalId);
    const at = meta.startDate.getTime();
    if (at < row.first) row.first = at;
    if (at > row.last) row.last = at;
    for (const player of [observations.playerA[i], observations.playerB[i]]) {
      row.matchesByPlayer.set(player, (row.matchesByPlayer.get(player) ?? 0) + 1);
    }
  }

  const venueProfiles: VenueProfile[] = [];
  const sceneTotals = new Map<string, { venues: number; players: Set<number>; rated: number; matches: number; purities: number[] }>();
  for (const [key, row] of [...venueRows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sceneId = scenes.sceneOfVenue.get(key) ?? null;
    const scenePurity = sceneId ? scenes.purityOfVenue.get(key) ?? null : null;
    // Ordered by matches played here, ties on the player UUID so the roster is
    // stable between refits rather than reshuffling on a Map iteration order.
    const roster = [...row.matchesByPlayer.entries()]
      .sort((a, b) => b[1] - a[1] || (observations.players[a[0]] < observations.players[b[0]] ? -1 : 1));
    const topPlayers: VenueRosterEntry[] = roster.slice(0, options.venueTopPlayers).map(([player, matches]) => ({
      playerId: observations.players[player],
      displayName: observations.displayNames[player],
      tagLine: observations.tagLines[player],
      matches,
      rating: publishedRating[player],
      rated: ratedPlayer[player] === 1,
    }));
    let ratedPlayers = 0;
    for (const player of row.matchesByPlayer.keys()) if (ratedPlayer[player] === 1) ratedPlayers++;

    venueProfiles.push(
      sanitizeVenueProfile({
        venue: key,
        shopExternalId: row.shopExternalId,
        name: options.venueLabels.get(key) ?? null,
        latitude: row.coordCount > 0 ? row.latSum / row.coordCount : null,
        longitude: row.coordCount > 0 ? row.lonSum / row.coordCount : null,
        players: row.matchesByPlayer.size,
        ratedPlayers,
        matches: row.matches,
        events: row.events.size,
        firstSeen: new Date(row.first).toISOString(),
        lastSeen: new Date(row.last).toISOString(),
        sceneId,
        sceneLabel: sceneId ? scenes.labelOfScene.get(sceneId) ?? null : null,
        scenePurity,
        topPlayers,
        topPlayersTruncated: roster.length > topPlayers.length,
        generatedAt,
      })
    );

    if (sceneId) {
      let totals = sceneTotals.get(sceneId);
      if (!totals) {
        sceneTotals.set(sceneId, (totals = { venues: 0, players: new Set(), rated: 0, matches: 0, purities: [] }));
      }
      totals.venues++;
      totals.matches += row.matches;
      if (scenePurity !== null) totals.purities.push(scenePurity);
    }
  }

  // A scene's player counts come from *home* venue, not from every venue a
  // player visited, so a scene's membership is a partition of players rather
  // than an overlapping set of visitors.
  for (let p = 0; p < playerCount; p++) {
    if (allFit.matchesPlayed[p] === 0) continue;
    const venue = homeVenue.get(p);
    const sceneId = venue ? scenes.sceneOfVenue.get(venue) ?? null : null;
    if (!sceneId) continue;
    const totals = sceneTotals.get(sceneId);
    if (!totals) continue;
    totals.players.add(p);
    if (ratedPlayer[p] === 1) totals.rated++;
  }

  // Scene directory. Built from the *stored* assignment, so every scene it
  // names exists in the assignment an operator accepted - a scene cannot
  // appear or vanish because a refit saw one more match.
  const assignedAt = options.sceneAssignment?.generatedAt ?? generatedAt;
  const sceneProfiles: SceneProfile[] = (options.sceneAssignment?.scenes ?? [])
    .filter(scene => sceneTotals.has(scene.sceneId))
    .map(scene => {
      const totals = sceneTotals.get(scene.sceneId)!;
      const purities = [...totals.purities].sort((a, b) => a - b);
      const mid = purities.length >> 1;
      return sanitizeSceneProfile({
        sceneId: scene.sceneId,
        label: scene.label,
        venueCount: totals.venues,
        playerCount: totals.players.size,
        ratedCount: totals.rated,
        matchCount: totals.matches,
        medianPurity:
          purities.length === 0
            ? 0
            : purities.length % 2 === 1
              ? purities[mid]
              : (purities[mid - 1] + purities[mid]) / 2,
        assignedAt,
        generatedAt,
      });
    });

  const diagnostics: SnapshotDiagnostics = {
    players: playerCount,
    playersWithMatches: components.playersWithMatches,
    ratedPlayers: profiles.filter(profile => profile.rated).length,
    matches: observations.playerA.length,
    games: observations.stats.gamesUsed,
    componentCount: components.components.length,
    giantComponentShare: components.giantShare,
    iterations: allFit.iterations,
    converged: allFit.converged,
    maxDelta: allFit.maxDelta,
    scopes: scopeCounts,
    skippedEras,
    matchLogEntries: matchLog.length,
    matchLogEventsWritten: matchLogEvents.size,
    venueCount: venueProfiles.length,
    sceneCount: sceneProfiles.length,
    scenesUnassigned: (options.sceneAssignment?.venues.length ?? 0) === 0,
    thresholds,
  };

  return {
    snapshot: {
      profiles,
      history,
      matchLog,
      matchLogEvents: [...matchLogEvents],
      rankings,
      metas,
      components: componentProfiles,
      sets: setProfiles,
      venues: venueProfiles,
      scenes: sceneProfiles,
    },
    diagnostics,
    components,
    allFit,
  };
}

/** Most common non-null label, for a component's region. */
function modalRegion(labels: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const label of labels) {
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && label < best)) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

export { MATCH_LOG_VERSION };
