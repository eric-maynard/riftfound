import { haversineMeters } from './shopMatch.js';

/**
 * Detecting cancelled events: rows still in the table whose source no longer
 * lists them.
 *
 * Neither source has a "cancelled" status we can read, and in the sharded Lambda
 * no single invocation sees a whole source, so each source gets its own rule:
 *
 * - UVS: every worker records the event ids its shard saw. An upcoming UVS row
 *   that none of the last few *complete* cycles saw is a candidate. Several
 *   cycles are required because UVS offset pagination drifts while we page
 *   (~1.5% of rows are repeated, so a similar share is skipped in any one cycle).
 *   Candidates are then confirmed one by one against the UVS event detail
 *   endpoint before deletion (lambda.ts).
 * - playriftbound: Riot's search is cursor paginated and date ordered, so an
 *   anchor whose pages were read to the end returns every event within its
 *   radius. A Riot row inside a fully swept anchor's radius that wasn't returned
 *   is gone.
 *
 * Both rules refuse to act when the deletion count looks like an outage rather
 * than cancellations.
 */

export interface CancellationCandidateRow {
  externalId: string;
  latitude: number | null;
  longitude: number | null;
  startDate: Date;
  createdAt?: Date | null;
}

export interface ScrapeCycle {
  cycleId: string;
  startedAt: Date;
  shardCount: number;
  totalExpected: number;
  shards: { shardIndex: number; complete: boolean; ids: string[] }[];
}

export interface CancellationResult {
  stale: string[];
  considered: number;
  /** Set when the check was skipped; `stale` is then empty. */
  skippedReason?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Complete cycles needed before a UVS event counts as gone (2-hourly schedule = 6 hours). */
export const UVS_CYCLES_REQUIRED = 3;
/** A cycle must have seen at least this share of the events UVS said it had. */
const UVS_MIN_COVERAGE = 0.9;
/** Only events starting this far in the future: UVS drops events from "upcoming" around their start. */
export const CANCELLATION_START_MARGIN_MS = 3 * HOUR_MS;
/** The UVS fetch window is 90 days; keep clear of its far edge. */
const UVS_WINDOW_MS = 89 * DAY_MS;
const UVS_MAX_DELETE_SHARE = 0.1;
const UVS_MAX_DELETE_FLOOR = 500;

const PRB_MAX_DELETE_SHARE = 0.2;
const PRB_MAX_DELETE_FLOOR = 25;
/** Stay inside the anchor radius so geocoding jitter at the edge doesn't count as "missing". */
const PRB_COVERAGE_MARGIN_METERS = 5_000;

export function isCycleComplete(cycle: ScrapeCycle): boolean {
  if (cycle.shardCount <= 0) return false;
  const complete = new Set(cycle.shards.filter(s => s.complete).map(s => s.shardIndex));
  for (let i = 0; i < cycle.shardCount; i++) {
    if (!complete.has(i)) return false;
  }
  const seen = new Set(cycle.shards.flatMap(s => s.ids));
  return seen.size >= cycle.totalExpected * UVS_MIN_COVERAGE;
}

export function findCancelledUvsEvents(
  rows: CancellationCandidateRow[],
  cycles: ScrapeCycle[],
  isUvsRow: (externalId: string) => boolean,
  now = new Date()
): CancellationResult {
  const complete = cycles
    .filter(isCycleComplete)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, UVS_CYCLES_REQUIRED);

  if (complete.length < UVS_CYCLES_REQUIRED) {
    return {
      stale: [],
      considered: 0,
      skippedReason: `only ${complete.length}/${UVS_CYCLES_REQUIRED} complete scrape cycles recorded`,
    };
  }

  const seen = new Set<string>();
  for (const cycle of complete) for (const shard of cycle.shards) for (const id of shard.ids) seen.add(id);

  const oldestStart = complete[complete.length - 1].startedAt.getTime();
  const earliestStart = now.getTime() + CANCELLATION_START_MARGIN_MS;
  const latestStart = oldestStart + UVS_WINDOW_MS;

  let considered = 0;
  const stale: string[] = [];
  for (const row of rows) {
    if (!isUvsRow(row.externalId)) continue;
    const start = row.startDate.getTime();
    if (start < earliestStart || start > latestStart) continue;
    // Rows created after the oldest cycle began weren't necessarily listed by it.
    if (!row.createdAt || row.createdAt.getTime() >= oldestStart) continue;
    considered++;
    if (!seen.has(row.externalId)) stale.push(row.externalId);
  }

  const limit = Math.max(UVS_MAX_DELETE_FLOOR, Math.floor(considered * UVS_MAX_DELETE_SHARE));
  if (stale.length > limit) {
    return {
      stale: [],
      considered,
      skippedReason: `${stale.length} of ${considered} upcoming UVS events missing - exceeds the ${limit} safety limit`,
    };
  }
  return { stale, considered };
}

export function findCancelledPlayriftboundEvents(
  rows: CancellationCandidateRow[],
  sweep: {
    completedAnchors: { latitude: number; longitude: number }[];
    returnedIds: Set<string>;
    radiusMeters: number;
    startedAt: Date;
    horizon: Date;
  },
  isPlayriftboundRow: (externalId: string) => boolean,
  now = new Date()
): CancellationResult {
  if (sweep.completedAnchors.length === 0) {
    return { stale: [], considered: 0, skippedReason: 'no anchors were swept to completion' };
  }

  const coverage = sweep.radiusMeters - PRB_COVERAGE_MARGIN_METERS;
  const earliestStart = now.getTime() + CANCELLATION_START_MARGIN_MS;
  const latestStart = sweep.horizon.getTime() - DAY_MS;

  let considered = 0;
  const stale: string[] = [];
  for (const row of rows) {
    if (!isPlayriftboundRow(row.externalId)) continue;
    if (row.latitude === null || row.longitude === null) continue;
    const start = row.startDate.getTime();
    if (start < earliestStart || start > latestStart) continue;
    if (!row.createdAt || row.createdAt.getTime() >= sweep.startedAt.getTime()) continue;
    const covered = sweep.completedAnchors.some(
      a => haversineMeters(a.latitude, a.longitude, row.latitude as number, row.longitude as number) <= coverage
    );
    if (!covered) continue;
    considered++;
    if (!sweep.returnedIds.has(row.externalId)) stale.push(row.externalId);
  }

  const limit = Math.max(PRB_MAX_DELETE_FLOOR, Math.floor(considered * PRB_MAX_DELETE_SHARE));
  if (stale.length > limit) {
    return {
      stale: [],
      considered,
      skippedReason: `${stale.length} of ${considered} covered playriftbound events missing - exceeds the ${limit} safety limit`,
    };
  }
  return { stale, considered };
}
