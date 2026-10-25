/**
 * AWS Lambda handler for the Riftfound Scraper
 *
 * This handler is triggered by EventBridge (CloudWatch Events) on a schedule
 * to scrape events from the Riftbound API and store them in DynamoDB.
 *
 * Unlike the continuous scraper that runs on EC2, this Lambda version runs
 * as a single burst operation - it fetches all pages as quickly as possible
 * since Lambda has a 15-minute timeout limit.
 */

import type { ScheduledEvent, Context } from 'aws-lambda';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  startScrapeRun,
  completeScrapeRun,
  failScrapeRun,
  upsertEventWithStore,
  updateShopDisplayCity,
  deleteOldEvents,
  UpsertShopResult,
  supportsStoredEventReads,
  loadUpcomingEvents,
  applyMergedEventFields,
  deleteEventsByExternalId,
  recordScrapeCycle,
  recordShardSeenIds,
  loadScrapeCycles,
  loadShopsByGeohash4,
  repointEventsToShop,
  deleteShopsByExternalId,
  supportsEventFacts,
  supportsRankingWrites,
  getLastRankingRefit,
  type StoredEventSummary,
} from './database.js';
import { fetchEventLiveness, fetchEventsPage, fetchEventTemplates, getEventCount } from './api.js';
import {
  fetchPlayriftboundEvents,
  isSynthesizedShopId,
  ANCHOR_RADIUS_METERS,
  PLAYRIFTBOUND_ID_PREFIX,
} from './sources/playriftbound.js';
import { runPlayriftboundResultsPass } from './sources/playriftboundResults.js';
import { refitDue, runRankingPass } from './ranking/pass.js';
import { parsePrereleaseTypes } from './ranking/sets.js';
import {
  findCancelledPlayriftboundEvents,
  findCancelledUvsEvents,
  isCycleComplete,
  UVS_CYCLES_REQUIRED,
} from './cancellations.js';
import { resolveOrganizerShops, type OrganizerLocation, type ShopCandidate } from './shopMatch.js';
import geohash from 'ngeohash';
import type { ScrapedEvent, StoreInfo } from './database.js';
import { buildDedupeIndex, markEventSeen, splitDuplicates } from './dedupe.js';
import { mergeEventRecords, mergedFieldChanges } from './merge.js';
import { env } from './config.js';
import { reverseGeocodeCity } from './geocoding.js';

const cloudwatch = new CloudWatchClient({});
const lambda = new LambdaClient({});

// Sharded execution: a coordinator invocation fetches page count, splits pages
// into shards, and async-invokes N worker invocations of this same Lambda.
// Each worker processes only its assigned page range. This scales the scraper
// beyond the 15-min single-Lambda cap and cuts wall time from ~14min to ~3min.
const PAGES_PER_SHARD = Number(process.env.SCRAPER_PAGES_PER_SHARD ?? '45');
const MAX_SHARDS = Number(process.env.SCRAPER_MAX_SHARDS ?? '6');

interface WorkerEvent {
  mode: 'worker';
  startPage: number;
  endPage: number;
  totalPages: number;
  shardIndex: number;
  shardCount: number;
  /** Cycle this shard belongs to; the shard records the event ids it saw under it. */
  cycleId?: string;
}

// Second source (Riot's playriftbound API) runs as its own invocation, dispatched
// by the coordinator alongside the UVS workers. No UVS worker sees the whole feed,
// so this invocation reads the UVS rows back from the table instead: once before
// the sweep (anchor coordinates) and once after it (de-dupe index), by which time
// the UVS workers for this cycle have normally finished writing.
interface PlayriftboundEvent {
  mode: 'playriftbound';
}

// Third pass (rosters + results) also gets its own invocation: it is a long run
// of small, independent page fetches with no dependency on the other two passes
// beyond the event rows they already wrote.
interface PlayriftboundResultsEvent {
  mode: 'playriftboundResults';
}

// Fourth pass (player ratings) is a batch refit of the whole stored history, so
// it gets its own invocation *and* its own cadence: the coordinator only
// dispatches it once `RANKING_REFIT_INTERVAL_HOURS` have passed since the last
// one completed. Gating in the coordinator rather than with a second EventBridge
// rule keeps this change inside the Lambda - no infrastructure to apply - and
// means the cadence is an environment variable rather than a Terraform edit.
interface RankingEvent {
  mode: 'ranking';
}

// Time kept back from the sweep for the post-sweep table reload, upserts, city
// geocoding and metrics.
const PRB_RESERVED_MS = Number(process.env.PLAYRIFTBOUND_RESERVED_MS ?? '300000');
const PRB_DAYS_FORWARD = 90;

// The results pass writes as it goes, so it only needs enough slack to finish
// the event it is on and log its summary.
const PRB_RESULTS_RESERVED_MS = Number(process.env.PLAYRIFTBOUND_RESULTS_RESERVED_MS ?? '60000');

// The rating pass writes everything at the end, so it needs enough slack left
// to get the whole snapshot out rather than being killed mid-write.
const RANKING_RESERVED_MS = Number(process.env.RANKING_RESERVED_MS ?? '120000');

function isWorkerEvent(event: unknown): event is WorkerEvent {
  return typeof event === 'object' && event !== null &&
    (event as { mode?: string }).mode === 'worker';
}

function isPlayriftboundEvent(event: unknown): event is PlayriftboundEvent {
  return typeof event === 'object' && event !== null &&
    (event as { mode?: string }).mode === 'playriftbound';
}

function isPlayriftboundResultsEvent(event: unknown): event is PlayriftboundResultsEvent {
  return typeof event === 'object' && event !== null &&
    (event as { mode?: string }).mode === 'playriftboundResults';
}

function isRankingEvent(event: unknown): event is RankingEvent {
  return typeof event === 'object' && event !== null &&
    (event as { mode?: string }).mode === 'ranking';
}

function isPlayriftboundId(externalId: string): boolean {
  return externalId.startsWith(PLAYRIFTBOUND_ID_PREFIX);
}

async function publishMetrics(metrics: {
  found: number;
  created: number;
  updated: number;
  skipped: number;
  skipRate: number;
  durationMs: number;
}, source?: string): Promise<void> {
  // UVS worker metrics keep their existing dimensionless series; the second
  // source publishes under a Source dimension so it doesn't skew those graphs.
  const Dimensions = source ? [{ Name: 'Source', Value: source }] : undefined;
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'Riftfound/Scraper',
      MetricData: [
        { MetricName: 'EventsFound', Value: metrics.found, Unit: 'Count', Dimensions },
        { MetricName: 'EventsCreated', Value: metrics.created, Unit: 'Count', Dimensions },
        { MetricName: 'EventsUpdated', Value: metrics.updated, Unit: 'Count', Dimensions },
        { MetricName: 'EventsSkipped', Value: metrics.skipped, Unit: 'Count', Dimensions },
        { MetricName: 'SkipRate', Value: metrics.skipRate, Unit: 'Percent', Dimensions },
        { MetricName: 'DurationMs', Value: metrics.durationMs, Unit: 'Milliseconds', Dimensions },
      ],
    }));
  } catch (error) {
    console.error('Failed to publish CloudWatch metrics:', error);
  }
}

/**
 * Lambda handler. Dispatches to coordinator or worker based on the event.
 *
 * - EventBridge scheduled invocations (no `mode` field) → coordinator.
 * - Coordinator's own async invocations (`mode: 'worker'`) → worker.
 * - Coordinator's own async invocation (`mode: 'playriftbound'`) → second source.
 * - Coordinator's own async invocation (`mode: 'playriftboundResults'`) → rosters
 *   and results for events already in the table.
 * - Coordinator's own async invocation (`mode: 'ranking'`) → the player rating
 *   refit, dispatched only when its interval has elapsed.
 */
export async function handler(
  event: ScheduledEvent | WorkerEvent | PlayriftboundEvent | PlayriftboundResultsEvent | RankingEvent,
  context: Context
): Promise<{ statusCode: number; body: string }> {
  if (isWorkerEvent(event)) return runWorker(event, context);
  if (isPlayriftboundEvent(event)) return runPlayriftbound(context);
  if (isPlayriftboundResultsEvent(event)) return runPlayriftboundResults(context);
  if (isRankingEvent(event)) return runRanking(context);
  return runCoordinator(event as ScheduledEvent, context);
}

async function runCoordinator(
  event: ScheduledEvent,
  context: Context
): Promise<{ statusCode: number; body: string }> {
  console.log('Coordinator invoked');
  console.log('Event:', JSON.stringify(event, null, 2));

  const startTime = Date.now();
  const cycleId = new Date(startTime).toISOString();
  const runId = await startScrapeRun();

  try {
    // Determine page count from the upstream API (single lightweight call).
    await fetchEventTemplates();
    const { total: totalExpected, pageCount } = await getEventCount();
    console.log(`API reports ${totalExpected} upcoming events across ${pageCount} pages`);

    if (pageCount === 0) {
      await completeScrapeRun(runId, { eventsFound: 0, eventsCreated: 0, eventsUpdated: 0 });
      return { statusCode: 200, body: JSON.stringify({ message: 'No events to scrape' }) };
    }

    // Split into shards. Keep shard count bounded so we don't hammer upstream
    // — MAX_SHARDS concurrent workers × 1 req per ~1s each is still gentle.
    const shardCount = Math.min(MAX_SHARDS, Math.max(1, Math.ceil(pageCount / PAGES_PER_SHARD)));
    const pagesPerShard = Math.ceil(pageCount / shardCount);
    const shards: Array<{ startPage: number; endPage: number }> = [];
    for (let i = 0; i < shardCount; i++) {
      const startPage = i * pagesPerShard + 1;
      const endPage = Math.min(pageCount, (i + 1) * pagesPerShard);
      if (startPage > endPage) break;
      shards.push({ startPage, endPage });
    }
    console.log(`Dispatching ${shards.length} shards of ~${pagesPerShard} pages each`);

    try {
      await recordScrapeCycle({ cycleId, shardCount: shards.length, totalExpected });
    } catch (error) {
      console.error('Failed to record scrape cycle:', error instanceof Error ? error.message : error);
    }

    // Fire-and-forget invoke each worker. InvocationType: 'Event' returns
    // immediately; workers run independently.
    const functionName = context.functionName;
    await Promise.all(shards.map((shard, idx) =>
      lambda.send(new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          mode: 'worker',
          startPage: shard.startPage,
          endPage: shard.endPage,
          totalPages: pageCount,
          shardIndex: idx,
          shardCount: shards.length,
          cycleId,
        } satisfies WorkerEvent)),
      }))
    ));

    // Second source gets its own invocation (and its own 15-minute budget).
    const playriftboundDispatched = env.PLAYRIFTBOUND_ENABLED && supportsStoredEventReads();
    if (playriftboundDispatched) {
      await lambda.send(new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ mode: 'playriftbound' } satisfies PlayriftboundEvent)),
      }));
    }

    // Third pass likewise. It reads the event rows the previous cycle wrote, so
    // it does not have to wait for this cycle's workers.
    const playriftboundResultsDispatched =
      env.PLAYRIFTBOUND_ENABLED && env.PLAYRIFTBOUND_RESULTS_ENABLED && supportsEventFacts();
    if (playriftboundResultsDispatched) {
      await lambda.send(new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(
          JSON.stringify({ mode: 'playriftboundResults' } satisfies PlayriftboundResultsEvent)
        ),
      }));
    }

    // Rating refit. Unlike the three scrape passes this one does not need to
    // run every cycle - it is a refit of the whole stored history, not an
    // increment - so the coordinator checks the elapsed time first and most
    // cycles dispatch nothing.
    let rankingDispatched = false;
    let rankingSkippedReason: string | undefined;
    if (!env.RANKING_ENABLED) rankingSkippedReason = 'disabled';
    else if (!supportsRankingWrites()) rankingSkippedReason = 'requires DynamoDB';
    else {
      try {
        const lastRefit = await getLastRankingRefit();
        if (refitDue(lastRefit, env.RANKING_REFIT_INTERVAL_HOURS)) {
          await lambda.send(new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'Event',
            Payload: Buffer.from(JSON.stringify({ mode: 'ranking' } satisfies RankingEvent)),
          }));
          rankingDispatched = true;
        } else {
          rankingSkippedReason = `last refit ${lastRefit}, interval ${env.RANKING_REFIT_INTERVAL_HOURS}h`;
        }
      } catch (error) {
        rankingSkippedReason = error instanceof Error ? error.message : String(error);
        console.error('Rating refit dispatch check failed:', rankingSkippedReason);
      }
    }

    // Coordinator does the fast housekeeping itself; workers only page-scrape.
    let deletedCount = 0;
    if (context.getRemainingTimeInMillis() > 15000) {
      deletedCount = await deleteOldEvents(60);
    }

    // Remove UVS events that recent complete cycles no longer saw upstream and
    // UVS confirms are gone. Only reads cycles that finished well before this one.
    let cancelled: CancellationSummary = { removed: 0, considered: 0 };
    try {
      cancelled = await removeCancelledUvsEvents(context);
    } catch (error) {
      console.error('UVS cancellation check failed:', error instanceof Error ? error.message : error);
    }

    const durationMs = Date.now() - startTime;
    const summary = {
      message: 'Coordinator dispatched',
      shards: shards.length,
      totalPages: pageCount,
      totalExpected,
      playriftboundDispatched,
      playriftboundResultsDispatched,
      rankingDispatched,
      rankingSkippedReason,
      deletedOldEvents: deletedCount,
      cancelledEventsRemoved: cancelled.removed,
      cancelledEventsUnconfirmed: cancelled.unconfirmed ?? 0,
      cancellationCheck: cancelled.skippedReason ?? `checked ${cancelled.considered} upcoming UVS events`,
      durationMs,
    };
    console.log('Coordinator summary:', summary);

    // The scrape run's roll-up event totals will be filled in by the workers
    // — we complete the coordinator's own run record with just the dispatch info.
    await completeScrapeRun(runId, {
      eventsFound: 0,
      eventsCreated: 0,
      eventsUpdated: 0,
    });

    return { statusCode: 202, body: JSON.stringify(summary) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Coordinator failed:', message);
    await failScrapeRun(runId, message);
    return { statusCode: 500, body: JSON.stringify({ error: message }) };
  }
}

async function runWorker(
  event: WorkerEvent,
  context: Context
): Promise<{ statusCode: number; body: string }> {
  console.log(`Worker shard ${event.shardIndex + 1}/${event.shardCount}: pages ${event.startPage}-${event.endPage}`);

  const startTime = Date.now();
  const runId = await startScrapeRun();

  let totalFound = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalDuplicateIds = 0;  // Same event id returned twice by the API's unstable paging
  let totalStores = 0;
  let totalCitiesGeocoded = 0;
  const storesSeen = new Set<string>();
  const eventIdsSeen = new Set<string>();
  const shopsToGeocode: UpsertShopResult[] = [];

  try {
    await fetchEventTemplates();

    let currentPage = event.startPage;
    while (currentPage <= event.endPage) {
      if (context.getRemainingTimeInMillis() < 60000) {
        console.warn(`Worker running low on time at page ${currentPage} — bailing`);
        break;
      }

      console.log(`Fetching page ${currentPage}/${event.endPage} (shard ${event.shardIndex + 1}/${event.shardCount})...`);
      const { events: pageEvents } = await fetchEventsPage(currentPage);

      // Process events from this page
      for (const apiEvent of pageEvents) {
        // Offset pagination is unstable upstream, so the same event id shows up
        // on more than one page within a run (~1.5% of rows). Skip the repeats
        // within this shard; repeats across shards are caught by the upsert's
        // unchanged-row check instead.
        if (!markEventSeen(eventIdsSeen, apiEvent.externalId)) {
          totalDuplicateIds++;
          continue;
        }

        totalFound++;
        const result = await upsertEventWithStore(apiEvent, apiEvent.storeInfo);
        if (result.created) {
          totalCreated++;
        } else if (result.skipped) {
          totalSkipped++;
        } else {
          totalUpdated++;
        }

        // Track unique stores
        if (apiEvent.storeInfo && !storesSeen.has(apiEvent.storeInfo.name)) {
          storesSeen.add(apiEvent.storeInfo.name);
          totalStores++;

          if (result.shopResult?.needsCityGeocode) {
            shopsToGeocode.push(result.shopResult);
          }
        }
      }

      const skipInfo = totalSkipped > 0 ? `, ${totalSkipped} unchanged` : '';
      console.log(`Page ${currentPage}: ${pageEvents.length} events (${totalCreated} new, ${totalUpdated} updated${skipInfo})`);

      currentPage++;

      // Be respectful to upstream — small inter-page delay. With ~6 shards
      // running concurrently this is per-worker, not global, so upstream sees
      // ~6 req/s at peak. Still very gentle for a public search API.
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Record what this shard saw, for the coordinator's cancellation check.
    if (event.cycleId) {
      try {
        await recordShardSeenIds(event.cycleId, event.shardIndex, eventIdsSeen, currentPage > event.endPage);
      } catch (error) {
        console.error('Failed to record seen event ids:', error instanceof Error ? error.message : error);
      }
    }

    // Process shops that need city geocoding (if we have time)
    if (shopsToGeocode.length > 0 && context.getRemainingTimeInMillis() > 30000) {
      console.log(`Geocoding cities for ${shopsToGeocode.length} shops...`);
      for (const shop of shopsToGeocode) {
        if (context.getRemainingTimeInMillis() < 15000) {
          console.warn('Skipping remaining geocoding - low time');
          break;
        }
        try {
          const city = await reverseGeocodeCity(shop.latitude, shop.longitude);
          if (city) {
            updateShopDisplayCity(shop.shopId, city);
            totalCitiesGeocoded++;
          }
        } catch (error) {
          console.error(`Failed to geocode shop ${shop.shopId}:`, error);
        }
      }
    }

    // Complete this worker's scrape run
    await completeScrapeRun(runId, {
      eventsFound: totalFound,
      eventsCreated: totalCreated,
      eventsUpdated: totalUpdated,
    });

    // Cancellation cleanup + deleteOldEvents are coordinator-owned: a worker only
    // sees its shard's page range. The shard's ids are recorded above instead.
    const deletedCount = 0;
    const staleCount = 0;

    const skipRate = totalFound > 0 ? Math.round((totalSkipped / totalFound) * 100) : 0;
    const durationMs = Date.now() - startTime;
    const summary = {
      message: 'Scrape completed',
      found: totalFound,
      created: totalCreated,
      updated: totalUpdated,
      skipped: totalSkipped,
      skipRate: `${skipRate}%`,
      stores: totalStores,
      duplicateIdsSkipped: totalDuplicateIds,
      citiesGeocoded: totalCitiesGeocoded,
      pagesProcessed: currentPage,
      deleted: deletedCount,
      staleRemoved: staleCount,
      durationMs,
    };

    console.log('Scrape summary:', summary);

    // Publish metrics to CloudWatch
    await publishMetrics({
      found: totalFound,
      created: totalCreated,
      updated: totalUpdated,
      skipped: totalSkipped,
      skipRate,
      durationMs,
    });

    return {
      statusCode: 200,
      body: JSON.stringify(summary),
    };

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Scrape failed:', message);

    await failScrapeRun(runId, message);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: message }),
    };
  }
}

async function runPlayriftbound(
  context: Context
): Promise<{ statusCode: number; body: string }> {
  console.log('playriftbound invocation');

  const startTime = Date.now();
  if (!env.PLAYRIFTBOUND_ENABLED) {
    return { statusCode: 200, body: JSON.stringify({ message: 'playriftbound source disabled' }) };
  }
  if (!supportsStoredEventReads()) {
    return { statusCode: 200, body: JSON.stringify({ message: 'playriftbound pass requires DynamoDB' }) };
  }

  const runId = await startScrapeRun();
  const isUvsRow = (e: StoredEventSummary) => !isPlayriftboundId(e.externalId);
  const sweepStartedAt = new Date();

  try {
    // 1. Anchor coordinates from the UVS rows already in the table. Anchors are
    //    ~156km geohash cells, so rows from the previous cycle are just as good.
    const before = await loadUpcomingEvents(PRB_DAYS_FORWARD);
    const coordinates = before.filter(isUvsRow).map(e => ({ latitude: e.latitude, longitude: e.longitude }));
    console.log(`Loaded ${before.length} stored events (${coordinates.length} UVS) in ${Date.now() - startTime}ms`);

    // 2. Rate-limited sweep, bounded by the invocation's time budget.
    const prbResult = await fetchPlayriftboundEvents({
      requestDelayMs: env.PLAYRIFTBOUND_REQUEST_DELAY_MS,
      maxAnchorsPerRun: env.PLAYRIFTBOUND_MAX_ANCHORS_PER_RUN,
      queryHash: env.PLAYRIFTBOUND_QUERY_HASH,
      coordinates,
      deadline: Date.now() + context.getRemainingTimeInMillis() - PRB_RESERVED_MS,
    });

    // 3. De-dupe index from a fresh read, so UVS rows this cycle's workers wrote
    //    during the sweep are matched rather than duplicated.
    const after = await loadUpcomingEvents(PRB_DAYS_FORWARD);
    const storedById = new Map(after.map(e => [e.externalId, e]));
    const uvsIndex = buildDedupeIndex(after.filter(isUvsRow));
    const { unique, matched } = splitDuplicates(prbResult.events, uvsIndex);

    let mergeWritten = 0;
    let mergeSkipped = 0;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let citiesGeocoded = 0;
    let notWritten = 0;
    const orphanPrbRows: string[] = [];
    const storesSeen = new Set<string>();
    const shopsToGeocode: UpsertShopResult[] = [];

    // 4. Matched pairs: write Riot's merge-owned fields onto the UVS row. Only
    //    the changed attributes are written; nothing else on the row is touched.
    for (const { secondary, primary } of matched) {
      const merged = mergeEventRecords(primary, secondary);
      const changes = mergedFieldChanges(primary, merged);
      if (changes && await applyMergedEventFields(primary.externalId, changes)) {
        mergeWritten++;
      } else {
        mergeSkipped++;
      }
      // A Riot event inserted on its own before its UVS twin was known is now a
      // duplicate row - remove it.
      if (storedById.has(secondary.externalId)) {
        orphanPrbRows.push(secondary.externalId);
      }
    }
    const orphansDeleted = orphanPrbRows.length > 0 ? await deleteEventsByExternalId(orphanPrbRows) : 0;

    // 5. Organizers that are stores UVS already knows: use the UVS shop row
    //    rather than a synthesised duplicate.
    const shopResolution = await resolvePlayriftboundShops(prbResult.events, matched);
    const orphanSet = new Set(orphanPrbRows);

    // 6. Riot-only events become their own rows.
    for (const rawEvent of unique) {
      if (context.getRemainingTimeInMillis() < 45000) {
        notWritten = unique.length - (created + updated + skipped);
        console.warn(`Low on time - ${notWritten} playriftbound events left for the next sweep of their anchors`);
        break;
      }
      const uvsShop = shopResolution.resolved.get(rawEvent.storeInfo.id);
      const event = uvsShop ? attachToShop(rawEvent, uvsShop) : rawEvent;
      const result = await upsertEventWithStore(event, event.storeInfo, { existingShop: Boolean(uvsShop) });
      if (result.created) created++;
      else if (result.skipped) skipped++;
      else updated++;

      if (event.storeInfo && !storesSeen.has(event.storeInfo.name)) {
        storesSeen.add(event.storeInfo.name);
        if (result.shopResult?.needsCityGeocode) shopsToGeocode.push(result.shopResult);
      }
    }

    // 7. Stored Riot rows of resolved organizers that this run didn't rewrite,
    //    then the duplicate shop rows themselves (only once every event is moved).
    const upsertedIds = new Set(unique.map(e => e.externalId));
    const toRepoint = new Map<number, { externalId: string; startDate: Date }[]>();
    for (const row of after) {
      if (!isPlayriftboundId(row.externalId) || upsertedIds.has(row.externalId) || orphanSet.has(row.externalId)) continue;
      if (row.shopExternalId == null || !shopResolution.resolved.has(row.shopExternalId)) continue;
      const list = toRepoint.get(row.shopExternalId) ?? [];
      list.push({ externalId: row.externalId, startDate: row.startDate });
      toRepoint.set(row.shopExternalId, list);
    }
    let eventsRepointed = 0;
    for (const [organizerShopId, rows] of toRepoint) {
      eventsRepointed += await repointEventsToShop(rows, shopResolution.resolved.get(organizerShopId) as ShopCandidate);
    }
    const duplicateShops = notWritten === 0
      ? [...shopResolution.resolved.keys()].filter(id => shopResolution.existingSynthesized.has(id))
      : [];
    const duplicateShopsDeleted = duplicateShops.length > 0 ? await deleteShopsByExternalId(duplicateShops) : 0;

    // 8. Riot rows inside fully swept anchors that Riot no longer lists.
    const cancellation = findCancelledPlayriftboundEvents(
      after.filter(row => !orphanSet.has(row.externalId)),
      {
        completedAnchors: prbResult.completedAnchors,
        returnedIds: new Set(prbResult.events.map(e => e.externalId)),
        radiusMeters: ANCHOR_RADIUS_METERS,
        startedAt: sweepStartedAt,
        horizon: prbResult.horizon,
      },
      isPlayriftboundId
    );
    if (cancellation.skippedReason) {
      console.warn(`playriftbound cancellation check skipped: ${cancellation.skippedReason}`);
    } else if (cancellation.stale.length > 0) {
      console.log(`Removing ${cancellation.stale.length} cancelled playriftbound events: ${cancellation.stale.slice(0, 20).join(', ')}`);
    }
    const cancelledRemoved = cancellation.stale.length > 0 ? await deleteEventsByExternalId(cancellation.stale) : 0;

    // 9. City names for newly synthesised organizer shops.
    for (const shop of shopsToGeocode) {
      if (context.getRemainingTimeInMillis() < 20000) {
        console.warn('Skipping remaining geocoding - low time');
        break;
      }
      try {
        const city = await reverseGeocodeCity(shop.latitude, shop.longitude);
        if (city) {
          updateShopDisplayCity(shop.shopId, city);
          citiesGeocoded++;
        }
      } catch (error) {
        console.error(`Failed to geocode shop ${shop.shopId}:`, error);
      }
    }

    const found = prbResult.events.length;
    await completeScrapeRun(runId, { eventsFound: found, eventsCreated: created, eventsUpdated: updated + mergeWritten });

    const durationMs = Date.now() - startTime;
    const summary = {
      message: 'playriftbound pass completed',
      found,
      created,
      updated,
      skipped,
      notWritten,
      mergedIntoUvs: matched.length,
      mergeWritten,
      mergeSkipped,
      orphansDeleted,
      organizersResolvedToUvsShops: shopResolution.resolved.size,
      eventsRepointed,
      duplicateShopsDeleted,
      cancelledRemoved,
      cancellationCheck: cancellation.skippedReason ?? `checked ${cancellation.considered} covered events`,
      anchorsCompleted: prbResult.completedAnchors.length,
      anchors: `${prbResult.anchorsQueried}/${prbResult.anchorsAvailable}`,
      anchorsFailed: prbResult.anchorsFailed,
      requests: prbResult.requests,
      sourceFailed: prbResult.failed,
      citiesGeocoded,
      durationMs,
    };
    console.log('playriftbound summary:', summary);

    await publishMetrics({
      found,
      created,
      updated: updated + mergeWritten,
      skipped: skipped + mergeSkipped,
      skipRate: found > 0 ? Math.round(((skipped + mergeSkipped) / found) * 100) : 0,
      durationMs,
    }, 'playriftbound');

    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('playriftbound pass failed:', message);
    await failScrapeRun(runId, message);
    return { statusCode: 500, body: JSON.stringify({ error: message }) };
  }
}

/**
 * Third pass: one page fetch per event for rosters (pre-event) and results
 * (post-event).
 *
 * Deadline-aware in exactly the same way as the playriftbound sweep: it stops
 * before the invocation's budget runs out and whatever is left rolls over to the
 * next run, rather than the pass being killed mid-write.
 */
async function runPlayriftboundResults(
  context: Context
): Promise<{ statusCode: number; body: string }> {
  console.log('playriftbound results invocation');

  if (!env.PLAYRIFTBOUND_RESULTS_ENABLED) {
    return { statusCode: 200, body: JSON.stringify({ message: 'playriftbound results pass disabled' }) };
  }
  if (!supportsEventFacts()) {
    return { statusCode: 200, body: JSON.stringify({ message: 'results storage requires DynamoDB' }) };
  }

  const runId = await startScrapeRun();
  try {
    const summary = await runPlayriftboundResultsPass({
      requestDelayMs: env.PLAYRIFTBOUND_REQUEST_DELAY_MS,
      maxEvents: env.PLAYRIFTBOUND_RESULTS_MAX_EVENTS_PER_RUN,
      lookbackDays: env.PLAYRIFTBOUND_RESULTS_LOOKBACK_DAYS,
      deadline: Date.now() + context.getRemainingTimeInMillis() - PRB_RESULTS_RESERVED_MS,
    });

    console.log('playriftbound results summary:', summary);
    await completeScrapeRun(runId, {
      eventsFound: summary.fetched,
      eventsCreated: summary.resultsWritten + summary.rostersWritten,
      eventsUpdated: 0,
    });

    await publishMetrics({
      found: summary.fetched,
      created: summary.resultsWritten + summary.rostersWritten,
      updated: 0,
      skipped: summary.unchanged,
      skipRate: summary.fetched > 0 ? Math.round((summary.unchanged / summary.fetched) * 100) : 0,
      durationMs: summary.durationMs,
    }, 'playriftbound-results');

    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('playriftbound results pass failed:', message);
    await failScrapeRun(runId, message);
    return { statusCode: 500, body: JSON.stringify({ error: message }) };
  }
}

/**
 * Fourth pass: refit player ratings from the stored tournament facts.
 *
 * Reads only (fact rows + shop labels + event names), fits in memory, then
 * writes the derived items in one go. Deadline-aware like the other passes, but
 * with the opposite failure mode: it writes nothing if it cannot finish, because
 * a ladder fitted on part of the history is worse than the previous ladder. The
 * next cycle simply tries again.
 */
async function runRanking(context: Context): Promise<{ statusCode: number; body: string }> {
  console.log('ranking invocation');

  if (!env.RANKING_ENABLED) {
    return { statusCode: 200, body: JSON.stringify({ message: 'rating pass disabled' }) };
  }
  if (!supportsRankingWrites()) {
    return { statusCode: 200, body: JSON.stringify({ message: 'ratings require DynamoDB' }) };
  }

  const runId = await startScrapeRun();
  try {
    const summary = await runRankingPass({
      historyDays: env.RANKING_HISTORY_DAYS,
      maxMatches: env.RANKING_MAX_MATCHES,
      setTable: env.RANKING_SET_TABLE,
      prerelease: {
        prereleaseTypes: parsePrereleaseTypes(env.RANKING_PRERELEASE_TYPES),
        leadDays: env.RANKING_PRERELEASE_LEAD_DAYS,
      },
      deadline: Date.now() + context.getRemainingTimeInMillis() - RANKING_RESERVED_MS,
      whr: {
        priorSigmaElo: env.RANKING_PRIOR_SIGMA_ELO,
        driftEloPerSqrtDay: env.RANKING_DRIFT_ELO_PER_SQRT_DAY,
        observationLevel: env.RANKING_OBSERVATION_LEVEL,
        weightScale: env.RANKING_WEIGHT_SCALE,
        maxIterations: env.RANKING_MAX_ITERATIONS,
      },
      snapshot: {
        minGames: env.RANKING_MIN_GAMES,
        maxUncertaintyElo: env.RANKING_MAX_UNCERTAINTY_ELO,
        minComponentSize: env.RANKING_MIN_COMPONENT_SIZE,
        maxComponentLadders: env.RANKING_MAX_COMPONENT_LADDERS,
        minSetMatches: env.RANKING_MIN_SET_MATCHES,
      },
    });

    console.log('ranking summary:', summary);
    await completeScrapeRun(runId, {
      eventsFound: summary.eventsWithResults,
      eventsCreated: summary.writes?.profiles ?? 0,
      eventsUpdated: summary.writes?.rankingRows ?? 0,
    });

    await publishMetrics({
      found: summary.matches,
      created: summary.ratedPlayers,
      updated: summary.playersWithMatches,
      skipped: summary.playersWithMatches - summary.ratedPlayers,
      skipRate: summary.playersWithMatches > 0
        ? Math.round(((summary.playersWithMatches - summary.ratedPlayers) / summary.playersWithMatches) * 100)
        : 0,
      durationMs: summary.durationMs,
    }, 'ranking');

    return { statusCode: summary.partial ? 202 : 200, body: JSON.stringify(summary) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('ranking pass failed:', message);
    await failScrapeRun(runId, message);
    return { statusCode: 500, body: JSON.stringify({ error: message }) };
  }
}

interface CancellationSummary {
  removed: number;
  considered: number;
  /** Candidates UVS still lists as live (or couldn't be checked this run). */
  unconfirmed?: number;
  skippedReason?: string;
}

/** Spacing between UVS detail lookups while confirming cancellations. */
const VERIFY_DELAY_MS = 250;
/** Upper bound per run; a backlog is worked through over several runs. */
const MAX_VERIFICATIONS_PER_RUN = 1500;

/** How far back to look for finished scrape cycles, and how long one may still be running. */
const CYCLE_LOOKBACK_MS = 12 * 60 * 60 * 1000;
const CYCLE_SETTLE_MS = 20 * 60 * 1000;

/**
 * Delete upcoming UVS events that the last few complete scrape cycles didn't see
 * and that UVS's own detail endpoint confirms are cancelled, unlisted or gone.
 */
async function removeCancelledUvsEvents(context: Context): Promise<CancellationSummary> {
  if (!supportsStoredEventReads()) return { removed: 0, considered: 0, skippedReason: 'requires DynamoDB' };

  const now = new Date();
  const cycles = await loadScrapeCycles(
    new Date(now.getTime() - CYCLE_LOOKBACK_MS),
    new Date(now.getTime() - CYCLE_SETTLE_MS)
  );
  const completeCycles = cycles.filter(isCycleComplete).length;
  if (completeCycles < UVS_CYCLES_REQUIRED) {
    const skippedReason = `only ${completeCycles}/${UVS_CYCLES_REQUIRED} complete scrape cycles recorded`;
    console.log(`UVS cancellation check skipped: ${skippedReason}`);
    return { removed: 0, considered: 0, skippedReason };
  }

  const rows = await loadUpcomingEvents(PRB_DAYS_FORWARD);
  const result = findCancelledUvsEvents(rows, cycles, id => !isPlayriftboundId(id), now);
  if (result.skippedReason) {
    console.warn(`UVS cancellation check skipped: ${result.skippedReason}`);
    return { removed: 0, considered: result.considered, skippedReason: result.skippedReason };
  }

  const confirmed: string[] = [];
  let checked = 0;
  for (const externalId of result.stale.slice(0, MAX_VERIFICATIONS_PER_RUN)) {
    if (context.getRemainingTimeInMillis() < 60000) {
      console.warn(`Low on time - confirmed ${checked}/${result.stale.length} missing UVS events, rest next run`);
      break;
    }
    try {
      if (await fetchEventLiveness(externalId) === 'gone') confirmed.push(externalId);
      checked++;
    } catch (error) {
      console.warn(`Stopping UVS cancellation checks: ${error instanceof Error ? error.message : error}`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, VERIFY_DELAY_MS));
  }

  if (confirmed.length > 0) {
    console.log(
      `Removing ${confirmed.length} cancelled UVS events (${checked}/${result.stale.length} checked): ` +
        confirmed.slice(0, 20).join(', ')
    );
  }
  const removed = confirmed.length > 0 ? await deleteEventsByExternalId(confirmed) : 0;
  return { removed, considered: result.considered, unconfirmed: result.stale.length - confirmed.length };
}

/** ~300m, the most two sources' coordinates for one store plausibly disagree by. */
const SHOP_CELL_PROBE_DEGREES = 0.003;

/**
 * Map Riot organizers (by synthesised shop id) onto existing UVS shop rows, and
 * note which synthesised shop rows already exist so the duplicates can be removed.
 */
async function resolvePlayriftboundShops(
  events: { storeInfo: StoreInfo }[],
  matched: { secondary: { storeInfo: StoreInfo }; primary: StoredEventSummary }[]
): Promise<{ resolved: Map<number, ShopCandidate>; existingSynthesized: Set<number> }> {
  const organizers = new Map<number, OrganizerLocation>();
  for (const { storeInfo } of events) {
    if (!isSynthesizedShopId(storeInfo.id)) continue;
    organizers.set(storeInfo.id, { name: storeInfo.name, latitude: storeInfo.latitude, longitude: storeInfo.longitude });
  }
  if (organizers.size === 0) return { resolved: new Map(), existingSynthesized: new Set() };

  const evidence: { organizerShopId: number; uvsShop: ShopCandidate }[] = [];
  for (const { secondary, primary } of matched) {
    if (
      primary.shopExternalId == null || isSynthesizedShopId(primary.shopExternalId) ||
      primary.shopLatitude == null || primary.shopLongitude == null
    ) {
      continue;
    }
    evidence.push({
      organizerShopId: secondary.storeInfo.id,
      uvsShop: {
        externalId: primary.shopExternalId,
        name: primary.shopName ?? '',
        latitude: primary.shopLatitude,
        longitude: primary.shopLongitude,
      },
    });
  }

  // The organizer's geohash-4 cell, plus any neighbour within probing distance.
  const cells = new Set<string>();
  for (const { latitude, longitude } of organizers.values()) {
    const lonDelta = SHOP_CELL_PROBE_DEGREES / Math.max(0.1, Math.cos((latitude * Math.PI) / 180));
    for (const dLat of [-SHOP_CELL_PROBE_DEGREES, 0, SHOP_CELL_PROBE_DEGREES]) {
      for (const dLon of [-lonDelta, 0, lonDelta]) {
        cells.add(geohash.encode(latitude + dLat, longitude + dLon, 4));
      }
    }
  }
  const shops = await loadShopsByGeohash4([...cells]);
  const candidates = shops.filter(shop => !isSynthesizedShopId(shop.externalId));
  const existingSynthesized = new Set(shops.filter(shop => isSynthesizedShopId(shop.externalId)).map(s => s.externalId));

  const resolved = resolveOrganizerShops(organizers, evidence, candidates);
  console.log(
    `Resolved ${resolved.size}/${organizers.size} playriftbound organizers to UVS shops ` +
      `(${evidence.length} event matches, ${candidates.length} nearby UVS shops in ${cells.size} cells)`
  );
  return { resolved, existingSynthesized };
}

/** A Riot event re-homed onto a UVS shop: same event, the UVS shop's identity. */
function attachToShop<T extends ScrapedEventWithStore>(event: T, shop: ShopCandidate): T {
  return {
    ...event,
    location: shop.name,
    organizer: shop.name,
    storeInfo: {
      ...event.storeInfo,
      id: shop.externalId,
      name: shop.name,
      latitude: shop.latitude,
      longitude: shop.longitude,
    },
  };
}

type ScrapedEventWithStore = ScrapedEvent & { storeInfo: StoreInfo };
