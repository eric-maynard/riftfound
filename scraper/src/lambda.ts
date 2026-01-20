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
import {
  startScrapeRun,
  completeScrapeRun,
  failScrapeRun,
  upsertEventWithStore,
  updateShopDisplayCity,
  deleteOldEvents,
  UpsertShopResult,
} from './database.js';
import { fetchEventsPage, getEventCount } from './api.js';
import { reverseGeocodeCity } from './geocoding.js';

/**
 * Lambda handler for scheduled scraping
 */
export async function handler(
  event: ScheduledEvent,
  context: Context
): Promise<{ statusCode: number; body: string }> {
  console.log('Lambda scraper invoked');
  console.log('Event:', JSON.stringify(event, null, 2));
  console.log('Remaining time:', context.getRemainingTimeInMillis(), 'ms');

  const runId = await startScrapeRun();

  let totalFound = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;  // Events unchanged, write skipped (DynamoDB cost savings)
  let totalStores = 0;
  let totalCitiesGeocoded = 0;
  const storesSeen = new Set<string>();
  const shopsToGeocode: UpsertShopResult[] = [];

  try {
    // Get total count to know how many pages we need
    const { total: totalExpected, pageCount } = await getEventCount();
    console.log(`API reports ${totalExpected} upcoming events (~${pageCount} pages)`);

    if (pageCount === 0) {
      console.log('No events to scrape');
      await completeScrapeRun(runId, {
        eventsFound: 0,
        eventsCreated: 0,
        eventsUpdated: 0,
      });
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No events to scrape', found: 0, created: 0 }),
      };
    }

    // Fetch all pages (burst mode - faster for Lambda)
    let currentPage = 1;
    while (true) {
      // Check remaining time - leave 60 seconds buffer for cleanup
      if (context.getRemainingTimeInMillis() < 60000) {
        console.warn('Running low on time, stopping early');
        break;
      }

      console.log(`Fetching page ${currentPage}/${pageCount}...`);
      const { events, hasMore } = await fetchEventsPage(currentPage);

      totalFound += events.length;

      // Process events from this page
      for (const event of events) {
        const result = await upsertEventWithStore(event, event.storeInfo);
        if (result.created) {
          totalCreated++;
        } else if (result.skipped) {
          totalSkipped++;
        } else {
          totalUpdated++;
        }

        // Track unique stores
        if (event.storeInfo && !storesSeen.has(event.storeInfo.name)) {
          storesSeen.add(event.storeInfo.name);
          totalStores++;

          if (result.shopResult?.needsCityGeocode) {
            shopsToGeocode.push(result.shopResult);
          }
        }
      }

      const skipInfo = totalSkipped > 0 ? `, ${totalSkipped} unchanged` : '';
      console.log(`Page ${currentPage}: ${events.length} events (${totalCreated} new, ${totalUpdated} updated${skipInfo})`);

      if (!hasMore) {
        break;
      }

      currentPage++;

      // Small delay to be respectful to upstream API (2 seconds)
      await new Promise(resolve => setTimeout(resolve, 2000));
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

    // Complete the scrape run
    await completeScrapeRun(runId, {
      eventsFound: totalFound,
      eventsCreated: totalCreated,
      eventsUpdated: totalUpdated,
    });

    // Clean up old events if we have time
    let deletedCount = 0;
    if (context.getRemainingTimeInMillis() > 15000) {
      deletedCount = await deleteOldEvents(60);
    }

    const skipRate = totalFound > 0 ? Math.round((totalSkipped / totalFound) * 100) : 0;
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
    };

    console.log('Scrape summary:', summary);

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
