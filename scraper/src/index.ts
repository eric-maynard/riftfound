import {
  closePool,
  startScrapeRun,
  completeScrapeRun,
  failScrapeRun,
  upsertEventWithStore,
  deleteOldEvents,
} from './database.js';
import { fetchEventsFromApi, getEventCount } from './api.js';
import { env } from './config.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runScrape(): Promise<{ found: number; created: number }> {
  console.log('Starting scrape run...');

  // Get total count first
  const totalExpected = await getEventCount();
  console.log(`API reports ${totalExpected} upcoming events worldwide`);

  const runId = await startScrapeRun();

  let totalFound = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalStores = 0;
  const storesSeen = new Set<string>();

  try {
    // Fetch events from API with pagination
    for await (const { page, events } of fetchEventsFromApi(1000)) {
      console.log(`\nProcessing page ${page} (${events.length} events)...`);
      totalFound += events.length;

      // Upsert events from this page
      let pageCreated = 0;
      let pageUpdated = 0;

      for (const event of events) {
        const result = await upsertEventWithStore(event, event.storeInfo);
        if (result.created) {
          pageCreated++;
        } else {
          pageUpdated++;
        }

        // Track unique stores
        if (event.storeInfo && !storesSeen.has(event.storeInfo.name)) {
          storesSeen.add(event.storeInfo.name);
          totalStores++;
        }
      }

      totalCreated += pageCreated;
      totalUpdated += pageUpdated;
      console.log(`  Upserted: ${pageCreated} created, ${pageUpdated} updated`);
    }

    await completeScrapeRun(runId, {
      eventsFound: totalFound,
      eventsCreated: totalCreated,
      eventsUpdated: totalUpdated,
    });

    // Clean up old events (more than 60 days past)
    const deletedCount = await deleteOldEvents(60);

    console.log(`\n========================================`);
    console.log(`Scrape completed successfully`);
    console.log(`  Total events found: ${totalFound}`);
    console.log(`  Events created: ${totalCreated}`);
    console.log(`  Events updated: ${totalUpdated}`);
    console.log(`  Unique stores: ${totalStores}`);
    if (deletedCount > 0) {
      console.log(`  Old events deleted: ${deletedCount}`);
    }
    console.log(`========================================\n`);

    return { found: totalFound, created: totalCreated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Scrape failed:', message);
    await failScrapeRun(runId, message);
    throw error;
  }
}

async function main() {
  const intervalMs = env.SCRAPE_INTERVAL_MINUTES * 60 * 1000;

  console.log(`Scraper starting (interval: ${env.SCRAPE_INTERVAL_MINUTES} minutes)`);
  console.log(`Using API endpoint for worldwide event data`);

  // Run forever
  while (true) {
    try {
      const result = await runScrape();

      // If no new events, use shorter interval (5 min)
      const nextInterval = result.created === 0 ? Math.min(intervalMs, 5 * 60 * 1000) : intervalMs;
      const nextMinutes = Math.round(nextInterval / 60000);

      console.log(`Next scrape in ${nextMinutes} minutes...`);
      await sleep(nextInterval);
    } catch (error) {
      console.error('Scrape error, retrying in 5 minutes...');
      await sleep(5 * 60 * 1000);
    }
  }
}

// Run if executed directly
main().catch(async (error) => {
  console.error('Fatal error:', error);
  await closePool();
  process.exit(1);
});

// Export for Lambda handler (one-shot mode)
export async function handler() {
  const result = await runScrape();
  await closePool();
  return { statusCode: 200, body: `Scrape completed: ${result.found} found, ${result.created} created` };
}
