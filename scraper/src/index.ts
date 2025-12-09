import {
  closePool,
  startScrapeRun,
  completeScrapeRun,
  failScrapeRun,
  upsertEvent,
} from './database.js';
import { scrapeEvents } from './scraper.js';
import { processGeocodingQueue } from './geocoding.js';
import { env } from './config.js';

async function main() {
  console.log('Starting scrape run...');
  const runId = await startScrapeRun();

  try {
    const events = await scrapeEvents(env.SCRAPE_MAX_PAGES);

    let created = 0;
    let updated = 0;

    for (const event of events) {
      const result = await upsertEvent(event);
      if (result.created) {
        created++;
      } else {
        updated++;
      }
    }

    await completeScrapeRun(runId, {
      eventsFound: events.length,
      eventsCreated: created,
      eventsUpdated: updated,
    });

    console.log(`Scrape completed successfully`);
    console.log(`  Events found: ${events.length}`);
    console.log(`  Events created: ${created}`);
    console.log(`  Events updated: ${updated}`);

    // Process geocoding queue for any new shops
    console.log('\nProcessing geocoding queue...');
    const geocodeResult = await processGeocodingQueue();
    console.log(`  Shops geocoded: ${geocodeResult.processed}`);
    console.log(`  Succeeded: ${geocodeResult.succeeded}`);
    console.log(`  Failed: ${geocodeResult.failed}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Scrape failed:', message);
    await failScrapeRun(runId, message);
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Run if executed directly
main().catch(console.error);

// Export for Lambda handler
export async function handler() {
  await main();
  return { statusCode: 200, body: 'Scrape completed' };
}
