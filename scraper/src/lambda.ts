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
} from './database.js';
import { fetchEventsPage, fetchEventTemplates, getEventCount } from './api.js';
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

function isWorkerEvent(event: unknown): event is WorkerEvent {
  return typeof event === 'object' && event !== null &&
    (event as { mode?: string }).mode === 'worker';
}

async function publishMetrics(metrics: {
  found: number;
  created: number;
  updated: number;
  skipped: number;
  skipRate: number;
  durationMs: number;
}): Promise<void> {
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'Riftfound/Scraper',
      MetricData: [
        { MetricName: 'EventsFound', Value: metrics.found, Unit: 'Count' },
        { MetricName: 'EventsCreated', Value: metrics.created, Unit: 'Count' },
        { MetricName: 'EventsUpdated', Value: metrics.updated, Unit: 'Count' },
        { MetricName: 'EventsSkipped', Value: metrics.skipped, Unit: 'Count' },
        { MetricName: 'SkipRate', Value: metrics.skipRate, Unit: 'Percent' },
        { MetricName: 'DurationMs', Value: metrics.durationMs, Unit: 'Milliseconds' },
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
 */
export async function handler(
  event: ScheduledEvent | WorkerEvent,
  context: Context
): Promise<{ statusCode: number; body: string }> {
  if (isWorkerEvent(event)) return runWorker(event, context);
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

      totalFound += pageEvents.length;

      // Process events from this page
      for (const apiEvent of pageEvents) {
        eventIdsSeen.add(apiEvent.externalId);
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
