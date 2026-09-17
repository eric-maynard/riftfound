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
  shouldRunStaleCleanup,
  cleanupStaleEvents,
  UpsertShopResult,
  supportsStoredEventReads,
  loadUpcomingEvents,
  applyMergedEventFields,
  deleteEventsByExternalId,
  type StoredEventSummary,
} from './database.js';
import { fetchEventsPage, fetchEventTemplates, getEventCount } from './api.js';
import { fetchPlayriftboundEvents, PLAYRIFTBOUND_ID_PREFIX } from './sources/playriftbound.js';
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
}

// Second source (Riot's playriftbound API) runs as its own invocation, dispatched
// by the coordinator alongside the UVS workers. No UVS worker sees the whole feed,
// so this invocation reads the UVS rows back from the table instead: once before
// the sweep (anchor coordinates) and once after it (de-dupe index), by which time
// the UVS workers for this cycle have normally finished writing.
interface PlayriftboundEvent {
  mode: 'playriftbound';
}

// Time kept back from the sweep for the post-sweep table reload, upserts, city
// geocoding and metrics.
const PRB_RESERVED_MS = Number(process.env.PLAYRIFTBOUND_RESERVED_MS ?? '300000');
const PRB_DAYS_FORWARD = 90;

function isWorkerEvent(event: unknown): event is WorkerEvent {
  return typeof event === 'object' && event !== null &&
    (event as { mode?: string }).mode === 'worker';
}

function isPlayriftboundEvent(event: unknown): event is PlayriftboundEvent {
  return typeof event === 'object' && event !== null &&
    (event as { mode?: string }).mode === 'playriftbound';
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
 */
export async function handler(
  event: ScheduledEvent | WorkerEvent | PlayriftboundEvent,
  context: Context
): Promise<{ statusCode: number; body: string }> {
  if (isWorkerEvent(event)) return runWorker(event, context);
  if (isPlayriftboundEvent(event)) return runPlayriftbound(context);
  return runCoordinator(event as ScheduledEvent, context);
}

async function runCoordinator(
  event: ScheduledEvent,
  context: Context
): Promise<{ statusCode: number; body: string }> {
  console.log('Coordinator invoked');
  console.log('Event:', JSON.stringify(event, null, 2));

  const startTime = Date.now();
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

    // Coordinator does the fast housekeeping itself; workers only page-scrape.
    let deletedCount = 0;
    if (context.getRemainingTimeInMillis() > 15000) {
      deletedCount = await deleteOldEvents(60);
    }

    const durationMs = Date.now() - startTime;
    const summary = {
      message: 'Coordinator dispatched',
      shards: shards.length,
      totalPages: pageCount,
      totalExpected,
      playriftboundDispatched,
      deletedOldEvents: deletedCount,
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

    // Stale cleanup + deleteOldEvents are coordinator-owned now: workers only
    // see their shard's page range, so `eventIdsSeen` here is a partial view
    // and would incorrectly reap events from other shards. Keep imports live
    // (referenced below) so they aren't tree-shaken out for future coordinator use.
    void shouldRunStaleCleanup; void cleanupStaleEvents;
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

    // 5. Riot-only events become their own rows.
    for (const event of unique) {
      if (context.getRemainingTimeInMillis() < 45000) {
        notWritten = unique.length - (created + updated + skipped);
        console.warn(`Low on time - ${notWritten} playriftbound events left for the next sweep of their anchors`);
        break;
      }
      const result = await upsertEventWithStore(event, event.storeInfo);
      if (result.created) created++;
      else if (result.skipped) skipped++;
      else updated++;

      if (event.storeInfo && !storesSeen.has(event.storeInfo.name)) {
        storesSeen.add(event.storeInfo.name);
        if (result.shopResult?.needsCityGeocode) shopsToGeocode.push(result.shopResult);
      }
    }

    // 6. City names for newly synthesised organizer shops.
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
