import {
  closePool,
  startScrapeRun,
  completeScrapeRun,
  failScrapeRun,
  upsertEventWithStore,
  updateShopDisplayCity,
  deleteOldEvents,
  UpsertShopResult,
} from './database.js';
import { fetchEventsPage, getEventCount } from './api.js';
import { env } from './config.js';
import { reverseGeocodeCity } from './geocoding.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Distributed scraping approach:
 * 1. Get total count and page count upfront
 * 2. Calculate delay between pages to spread requests across the cycle
 * 3. Fetch one page at a time with calculated delays
 *
 * This prevents burst traffic and spreads load evenly across the scrape interval.
 */
async function runDistributedScrape(): Promise<{ found: number; created: number }> {
  console.log('Starting distributed scrape run...');

  // Get total count and pages needed
  const { total: totalExpected, pageCount } = await getEventCount();
  console.log(`API reports ${totalExpected} upcoming events (~${pageCount} pages)`);

  if (pageCount === 0) {
    console.log('No events to scrape');
    return { found: 0, created: 0 };
  }

  // Calculate delay between pages to spread across the cycle
  // Reserve 10% of interval for processing overhead
  const cycleMs = env.SCRAPE_INTERVAL_MINUTES * 60 * 1000;
  const availableMs = cycleMs * 0.9;
  const delayBetweenPagesMs = Math.floor(availableMs / pageCount);

  // Minimum delay of 2 seconds, maximum of 5 minutes per page
  const effectiveDelayMs = Math.max(2000, Math.min(delayBetweenPagesMs, 5 * 60 * 1000));

  console.log(`Scrape strategy: ${pageCount} pages, ${Math.round(effectiveDelayMs / 1000)}s between pages`);
  console.log(`Estimated completion: ${Math.round((pageCount * effectiveDelayMs) / 60000)} minutes`);

  const runId = await startScrapeRun();

  let totalFound = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalStores = 0;
  let totalCitiesGeocoded = 0;
  const storesSeen = new Set<string>();
  let currentPage = 1;

  // Queue of shops that need city geocoding
  const shopsToGeocode: UpsertShopResult[] = [];

  try {
    while (true) {
      const startTime = Date.now();

      console.log(`\n[Page ${currentPage}/${pageCount}] Fetching...`);
      const { events, hasMore } = await fetchEventsPage(currentPage);

      totalFound += events.length;

      // Process events from this page
      let pageCreated = 0;
      let pageUpdated = 0;

      for (const event of events) {
        const result = await upsertEventWithStore(event, event.storeInfo);
        if (result.created) {
          pageCreated++;
        } else {
          pageUpdated++;
        }

        // Track unique stores and queue for geocoding if needed
        if (event.storeInfo && !storesSeen.has(event.storeInfo.name)) {
          storesSeen.add(event.storeInfo.name);
          totalStores++;

          // Queue shop for city geocoding if needed
          if (result.shopResult?.needsCityGeocode) {
            shopsToGeocode.push(result.shopResult);
          }
        }
      }

      totalCreated += pageCreated;
      totalUpdated += pageUpdated;

      const elapsed = Date.now() - startTime;
      console.log(`[Page ${currentPage}/${pageCount}] ${events.length} events (${pageCreated} new, ${pageUpdated} updated) in ${elapsed}ms`);

      if (!hasMore) {
        break;
      }

      currentPage++;

      // Wait before next page (subtract processing time to maintain consistent pace)
      const waitTime = Math.max(1000, effectiveDelayMs - elapsed);
      console.log(`Next page in ${Math.round(waitTime / 1000)}s...`);
      await sleep(waitTime);
    }

    // Process shops that need city geocoding
    if (shopsToGeocode.length > 0) {
      console.log(`\nGeocoding cities for ${shopsToGeocode.length} shops...`);
      for (const shop of shopsToGeocode) {
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
      console.log(`Geocoded ${totalCitiesGeocoded} shop cities`);
    }

    await completeScrapeRun(runId, {
      eventsFound: totalFound,
      eventsCreated: totalCreated,
      eventsUpdated: totalUpdated,
    });

    // Clean up old events (more than 60 days past)
    const deletedCount = await deleteOldEvents(60);

    console.log(`\n========================================`);
    console.log(`Distributed scrape completed`);
    console.log(`  Total events found: ${totalFound}`);
    console.log(`  Events created: ${totalCreated}`);
    console.log(`  Events updated: ${totalUpdated}`);
    console.log(`  Unique stores: ${totalStores}`);
    if (totalCitiesGeocoded > 0) {
      console.log(`  Cities geocoded: ${totalCitiesGeocoded}`);
    }
    console.log(`  Pages fetched: ${currentPage}`);
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
  console.log(`Scraper starting (distributed mode, cycle: ${env.SCRAPE_INTERVAL_MINUTES} minutes)`);
  console.log(`Requests will be spread evenly across each ${env.SCRAPE_INTERVAL_MINUTES}-minute cycle`);

  // Run forever
  while (true) {
    const cycleStart = Date.now();

    try {
      await runDistributedScrape();

      // Calculate how long until next cycle should start
      const cycleMs = env.SCRAPE_INTERVAL_MINUTES * 60 * 1000;
      const elapsed = Date.now() - cycleStart;
      const remainingMs = Math.max(0, cycleMs - elapsed);

      if (remainingMs > 0) {
        const remainingMinutes = Math.round(remainingMs / 60000);
        console.log(`Cycle complete. Next cycle in ${remainingMinutes} minutes...`);
        await sleep(remainingMs);
      } else {
        console.log(`Cycle took longer than interval, starting next immediately...`);
      }
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

// Export for Lambda handler (one-shot mode - still uses burst for Lambda)
export { runDistributedScrape as handler };
