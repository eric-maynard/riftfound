import {
  closePool,
  startScrapeRun,
  completeScrapeRun,
  failScrapeRun,
  upsertEventWithStore,
  updateShopDisplayCity,
  deleteOldEvents,
  UpsertShopResult,
  getPhotonQueue,
  clearPhotonQueue,
} from './database.js';
import { fetchEventsPage, getEventCount } from './api.js';
import { env } from './config.js';
import { reverseGeocodeCity } from './geocoding.js';
import { execSync } from 'child_process';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process the Photon queue - imports queued cities to Photon via docker exec.
 * Runs at the start of each scrape cycle.
 */
async function processPhotonQueue(): Promise<void> {
  const queue = getPhotonQueue();

  if (queue.length === 0) {
    return;
  }

  console.log(`\nProcessing Photon queue: ${queue.length} cities to import...`);

  let imported = 0;
  const importedIds: number[] = [];

  for (const item of queue) {
    try {
      const doc = JSON.parse(item.photonData);

      // Escape single quotes in JSON for shell
      const jsonEscaped = item.photonData.replace(/'/g, "'\\''");

      // Import to Photon via docker exec
      const cmd = `docker exec photon curl -s -X PUT "http://localhost:9200/photon/place/${doc.osm_id}" ` +
                  `-H "Content-Type: application/json" -d '${jsonEscaped}'`;

      execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });

      imported++;
      importedIds.push(item.id);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to import city (queue id ${item.id}):`, errorMsg);
      // Continue processing remaining items
    }
  }

  // Clear successfully imported items from queue
  if (importedIds.length > 0) {
    clearPhotonQueue(importedIds);
  }

  if (imported > 0) {
    console.log(`Imported ${imported}/${queue.length} cities to Photon\n`);
  }
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

  // Process any queued Photon imports from previous searches/scrapes
  await processPhotonQueue();

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
  let totalSkipped = 0;  // Events unchanged, write skipped (DynamoDB cost savings)
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
      let pageSkipped = 0;

      for (const event of events) {
        const result = await upsertEventWithStore(event, event.storeInfo);
        if (result.created) {
          pageCreated++;
        } else if (result.skipped) {
          pageSkipped++;
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
      totalSkipped += pageSkipped;

      const elapsed = Date.now() - startTime;
      const skipInfo = pageSkipped > 0 ? `, ${pageSkipped} unchanged` : '';
      console.log(`[Page ${currentPage}/${pageCount}] ${events.length} events (${pageCreated} new, ${pageUpdated} updated${skipInfo}) in ${elapsed}ms`);

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
    if (totalSkipped > 0) {
      const skipRate = Math.round((totalSkipped / totalFound) * 100);
      console.log(`  Events unchanged (writes skipped): ${totalSkipped} (${skipRate}%)`);
    }
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
      console.error('Scrape error:', error);
      console.error('Retrying in 5 minutes...');
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
