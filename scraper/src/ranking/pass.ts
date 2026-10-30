/**
 * The rating pass: replay every stored fact, fit the whole history at once,
 * write the derived items.
 *
 * It is a **batch refit from scratch**, deliberately. The alternative - keeping
 * incremental state and updating it - would be cheaper per run and wrong in two
 * ways: Whole-History Rating revises the *whole past curve* when new evidence
 * arrives (so yesterday's rating is not final), and the results backfill fills
 * in *older* events as it progresses, so new facts do not arrive in time order.
 * An incremental rating would therefore depend on the order the scraper happened
 * to capture things in, which is the opposite of what a replayable history is
 * for.
 *
 * The cost of that choice is the write volume, which is why the pass is on a
 * multi-hour cadence (`RANKING_REFIT_INTERVAL_HOURS`), why rating history is
 * emitted only for players who clear the publishing bar, and why the per-player
 * match log is marked per event and never re-emitted.
 *
 * Reading is scan-free: one Query per UTC day against GSI1's `RESULTS#<date>`
 * and `ROSTER#<date>` partitions, which is exactly the access pattern the facts
 * were shaped for.
 *
 * Logging here is counts-only. These items are named individuals' match
 * histories, and the rule from the results pass carries over: no player id, no
 * display name, no event name in a log line.
 */

import {
  loadEventFactsByDate,
  loadEventNames,
  loadMatchLogMarkers,
  loadSceneAssignment,
  loadShopLabels,
  saveRankingSnapshot,
  setLastRankingRefit,
  supportsEventFacts,
  supportsRankingWrites,
  type RankingWriteSummary,
} from '../database.js';
import { ObservationBuilder, type ObservationSet } from './observations.js';
import { connectivityReport, venueKey, type ConnectivityReport } from './graph.js';
import { buildSnapshot, DEFAULT_SNAPSHOT_OPTIONS, type SnapshotDiagnostics, type SnapshotOptions } from './snapshot.js';
import { MATCH_LOG_VERSION } from './items.js';
import type { SceneAssignment } from './scenes.js';
import {
  buildEras,
  DEFAULT_PRERELEASE_OPTIONS,
  parsePrereleaseTypes,
  parseSetTable,
  utcDate,
  type PrereleaseOptions,
  type SetEra,
} from './sets.js';
import type { WhrOptions } from './whr.js';

/** Days read in parallel. Each is two small Queries; 8 keeps Lambda IO busy. */
const DAY_CONCURRENCY = 8;

export interface RankingPassOptions {
  /** How far back the replay reads. */
  historyDays?: number;
  /** Days forward; facts exist for events that have already started, so 2 is plenty. */
  lookaheadDays?: number;
  now?: Date;
  /** Epoch ms after which the pass gives up rather than writing a half-built snapshot. */
  deadline?: number;
  maxMatches?: number;
  whr?: Partial<WhrOptions>;
  snapshot?: Partial<Omit<SnapshotOptions, 'eras' | 'venueLabels' | 'matchLogEvents'>>;
  /** Raw `RANKING_SET_TABLE` value. */
  setTable?: string;
  /** How prerelease events are attributed to a set. See sets.ts. */
  prerelease?: PrereleaseOptions;
  /** Fit and report, write nothing. Used by the metrics CLI. */
  dryRun?: boolean;
  /** Re-emit every event's match log, ignoring the markers. */
  rewriteMatchLog?: boolean;
  eras?: readonly SetEra[];
  /**
   * Override the stored venue -> scene assignment (tests and the re-clustering
   * CLI's preview). `undefined` means "read whatever is stored", which is what
   * production does; `null` means "there is no assignment".
   */
  sceneAssignment?: SceneAssignment | null;
}

export interface RankingPassSummary {
  daysRead: number;
  eventsWithResults: number;
  rostersRead: number;
  players: number;
  playersWithMatches: number;
  matches: number;
  games: number;
  ratedPlayers: number;
  componentCount: number;
  giantComponentShare: number;
  /** Venue items this refit would write, and the scenes they populate. */
  venueCount: number;
  sceneCount: number;
  /** True when no re-clustering has been run yet, so every scene field is null. */
  scenesUnassigned: boolean;
  scopes: { scope: string; rated: number; total: number }[];
  skippedEras: { eraId: string; matches: number }[];
  converged: boolean;
  iterations: number;
  byeLeaks: number;
  unmappedTeamSkipped: number;
  undecidedSkipped: number;
  writes: RankingWriteSummary | null;
  durationMs: number;
  replayMs: number;
  fitMs: number;
  writeMs: number;
  partial: boolean;
  skippedReason?: string;
}

function emptySummary(): RankingPassSummary {
  return {
    daysRead: 0,
    eventsWithResults: 0,
    rostersRead: 0,
    players: 0,
    playersWithMatches: 0,
    matches: 0,
    games: 0,
    ratedPlayers: 0,
    componentCount: 0,
    giantComponentShare: 0,
    venueCount: 0,
    sceneCount: 0,
    scenesUnassigned: true,
    scopes: [],
    skippedEras: [],
    converged: false,
    iterations: 0,
    byeLeaks: 0,
    unmappedTeamSkipped: 0,
    undecidedSkipped: 0,
    writes: null,
    durationMs: 0,
    replayMs: 0,
    fitMs: 0,
    writeMs: 0,
    partial: false,
  };
}

/** UTC day keys from `historyDays` back to `lookaheadDays` forward, ascending. */
export function replayDates(now: Date, historyDays: number, lookaheadDays: number): string[] {
  const dates: string[] = [];
  const day = new Date(now.getTime());
  day.setUTCDate(day.getUTCDate() - historyDays);
  for (let i = -historyDays; i <= lookaheadDays; i++) {
    dates.push(utcDate(day));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Read every stored fact in the window and fold it into one ObservationSet.
 *
 * Days are fetched a batch at a time and fed to the builder **in date order**
 * even though they arrive out of order, so the result does not depend on which
 * Query finished first. The payloads are dropped as soon as they are folded in:
 * the whole history as observations is a fraction of the size of the rows it
 * came from.
 */
export async function replayFacts(options: {
  dates: string[];
  eras: readonly SetEra[];
  eventNames: Map<string, string>;
  maxMatches: number;
  collectStandings?: boolean;
  prerelease?: PrereleaseOptions;
  deadline?: number;
  onProgress?: (daysDone: number, matches: number) => void;
}): Promise<{ observations: ObservationSet; daysRead: number; timedOut: boolean }> {
  const builder = new ObservationBuilder(
    options.eras,
    options.eventNames,
    options.maxMatches,
    options.collectStandings ?? false,
    options.prerelease ?? DEFAULT_PRERELEASE_OPTIONS
  );
  let daysRead = 0;
  let timedOut = false;

  for (let i = 0; i < options.dates.length; i += DAY_CONCURRENCY) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      timedOut = true;
      break;
    }
    const batch = options.dates.slice(i, i + DAY_CONCURRENCY);
    const loaded = await Promise.all(batch.map(date => loadEventFactsByDate(date)));
    for (const facts of loaded) {
      for (const results of facts.results) {
        if (results.status === 'none') continue; // listing-only event: no games
        builder.addResults(results);
      }
      for (const roster of facts.rosters) builder.addRoster(roster);
      daysRead++;
    }
    options.onProgress?.(daysRead, builder.matchIds.length);
  }

  return { observations: builder.finish(), daysRead, timedOut };
}

/** Venue key -> label, resolved from the shops table. */
export async function resolveVenueLabels(observations: ObservationSet): Promise<Map<string, string>> {
  const shopIds = new Set<number>();
  for (const event of observations.events) {
    if (event.shopExternalId !== null) shopIds.add(event.shopExternalId);
  }
  const labels = await loadShopLabels([...shopIds]);
  const byVenue = new Map<string, string>();
  for (const [shopExternalId, label] of labels) {
    byVenue.set(venueKey(shopExternalId, null, null), label);
  }
  return byVenue;
}

/**
 * Run the pass.
 *
 * Never throws for a single bad day; a deadline reached during the replay aborts
 * *without writing*, because a ladder fitted on half the history is worse than
 * yesterday's ladder.
 */
export async function runRankingPass(options: RankingPassOptions = {}): Promise<RankingPassSummary> {
  const startedAt = Date.now();
  const summary = emptySummary();

  if (!supportsEventFacts() || !supportsRankingWrites()) {
    summary.skippedReason = 'ratings need the SQLite or DynamoDB backend';
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const now = options.now ?? new Date();
  const historyDays = options.historyDays ?? 400;
  const lookaheadDays = options.lookaheadDays ?? 2;
  const { table, warning } = parseSetTable(options.setTable);
  if (warning) console.warn(`[ranking] ${warning}; using the curated set table`);
  const eras = options.eras ?? buildEras(table);

  const prerelease = options.prerelease ?? DEFAULT_PRERELEASE_OPTIONS;
  const dates = replayDates(now, historyDays, lookaheadDays);
  const eventNames = await loadEventNames(historyDays, lookaheadDays).catch(error => {
    console.warn(`[ranking] event names unavailable: ${error instanceof Error ? error.message : error}`);
    return new Map<string, string>();
  });

  const replayStart = Date.now();
  const { observations, daysRead, timedOut } = await replayFacts({
    dates,
    eras,
    eventNames,
    maxMatches: options.maxMatches ?? Number.POSITIVE_INFINITY,
    prerelease,
    deadline: options.deadline,
  });
  summary.replayMs = Date.now() - replayStart;
  summary.daysRead = daysRead;
  summary.eventsWithResults = observations.stats.eventsWithMatches;
  summary.rostersRead = observations.stats.rostersSeen;
  summary.players = observations.players.length;
  summary.matches = observations.stats.matchesUsed;
  summary.games = observations.stats.gamesUsed;
  summary.byeLeaks = observations.stats.byeLeaks;
  summary.unmappedTeamSkipped = observations.stats.unmappedTeamSkipped;
  summary.undecidedSkipped = observations.stats.undecidedSkipped;

  console.log(
    `[ranking] replayed ${daysRead}/${dates.length} days: ${observations.stats.eventsWithMatches} events ` +
      `with results, ${observations.stats.matchesUsed} matches, ${observations.stats.gamesUsed} games, ` +
      `${observations.players.length} players (${observations.stats.rosterOnlyPlayers} roster-only)`
  );
  if (observations.stats.byeLeaks > 0) {
    // The upstream filter is supposed to make this impossible; if it ever fires,
    // a synthetic player was one step from appearing on a public ladder.
    console.error(
      `[ranking] ${observations.stats.byeLeaks} bye-prefixed ids reached the fact rows and were dropped here`
    );
  }

  if (timedOut) {
    summary.partial = true;
    summary.skippedReason = 'time budget reached during replay; nothing written';
    summary.durationMs = Date.now() - startedAt;
    console.warn(`[ranking] ${summary.skippedReason}`);
    return summary;
  }
  if (summary.matches === 0) {
    summary.skippedReason = 'no match facts stored yet';
    summary.durationMs = Date.now() - startedAt;
    console.log(`[ranking] ${summary.skippedReason}`);
    return summary;
  }

  const venueLabels = await resolveVenueLabels(observations);

  // Scenes are read, never fitted here. A missing or unreadable assignment is
  // not a failure: every scene field comes out null and the ladder is
  // unaffected, until an operator runs ./scene-recluster.sh.
  const sceneAssignment =
    options.sceneAssignment !== undefined
      ? options.sceneAssignment
      : await loadSceneAssignment().catch(error => {
          console.warn(
            `[ranking] scene assignment unavailable: ${error instanceof Error ? error.message : error}`
          );
          return null;
        });

  const eventIds = [...new Set(observations.events.map(event => event.externalId))];
  const alreadyLogged = options.rewriteMatchLog
    ? new Set<string>()
    : await loadMatchLogMarkers(eventIds, MATCH_LOG_VERSION);
  const matchLogEvents = new Set(eventIds.filter(id => !alreadyLogged.has(id)));

  const snapshotOptions: SnapshotOptions = {
    ...DEFAULT_SNAPSHOT_OPTIONS,
    ...options.snapshot,
    eras,
    setTable: table,
    venueLabels,
    sceneAssignment,
    matchLogEvents,
    whr: options.whr ?? {},
    generatedAt: now,
  };

  const fitStart = Date.now();
  const { snapshot, diagnostics } = buildSnapshot(observations, snapshotOptions);
  summary.fitMs = Date.now() - fitStart;

  applyDiagnostics(summary, diagnostics);

  console.log(
    `[ranking] fit ${diagnostics.matches} matches in ${diagnostics.iterations} iterations ` +
      `(converged=${diagnostics.converged}): ${diagnostics.ratedPlayers} of ` +
      `${diagnostics.playersWithMatches} players clear the bar, ${diagnostics.componentCount} components, ` +
      `giant share ${(diagnostics.giantComponentShare * 100).toFixed(1)}%`
  );
  console.log(
    diagnostics.scenesUnassigned
      ? `[ranking] ${diagnostics.venueCount} venues, scenes unassigned ` +
          '(run scripts/metrics/scene-recluster.sh to create an assignment)'
      : `[ranking] ${diagnostics.venueCount} venues across ${diagnostics.sceneCount} scenes ` +
          `(assignment of ${sceneAssignment?.generatedAt ?? 'unknown date'})`
  );

  if (options.dryRun) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const writeStart = Date.now();
  summary.writes = await saveRankingSnapshot(snapshot, MATCH_LOG_VERSION);
  await setLastRankingRefit(new Date().toISOString());
  summary.writeMs = Date.now() - writeStart;
  summary.durationMs = Date.now() - startedAt;

  console.log(
    `[ranking] wrote ${summary.writes.profiles} profiles, ${summary.writes.historyPoints} rating points, ` +
      `${summary.writes.matchLogEntries} match log entries for ${summary.writes.markers} new events, ` +
      `${summary.writes.rankingRows} ladder rows across ${summary.writes.metas} scopes, ` +
      `${summary.writes.components} components, ${summary.writes.sets} sets, ` +
      `${summary.writes.venues} venues, ${summary.writes.scenes} scenes, ` +
      // Counts only, as everywhere in this pass: the shard count and the
      // number of names in the index, never a name.
      `${summary.writes.searchEntries} searchable names in ${summary.writes.searchShards} shards ` +
      `(pruned ${summary.writes.deletedRows} rows, ${summary.writes.deletedScopes} scopes)`
  );

  return summary;
}

function applyDiagnostics(summary: RankingPassSummary, diagnostics: SnapshotDiagnostics): void {
  summary.playersWithMatches = diagnostics.playersWithMatches;
  summary.ratedPlayers = diagnostics.ratedPlayers;
  summary.componentCount = diagnostics.componentCount;
  summary.giantComponentShare = diagnostics.giantComponentShare;
  summary.venueCount = diagnostics.venueCount;
  summary.sceneCount = diagnostics.sceneCount;
  summary.scenesUnassigned = diagnostics.scenesUnassigned;
  summary.scopes = diagnostics.scopes;
  summary.skippedEras = diagnostics.skippedEras;
  summary.converged = diagnostics.converged;
  summary.iterations = diagnostics.iterations;
}

/** Whether enough time has passed since the last refit. */
export function refitDue(lastRefit: string | null, intervalHours: number, now = new Date()): boolean {
  if (!lastRefit) return true;
  const last = Date.parse(lastRefit);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= intervalHours * 3_600_000;
}

export type { ConnectivityReport };
export { connectivityReport };
