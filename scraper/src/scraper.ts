import { env } from './config.js';
import { parseEventsFromHtml } from './parser.js';
import type { ScrapedEvent } from './database.js';

const EVENTS_PER_PAGE = 25;

/**
 * Async generator that yields batches of events as pages are scraped.
 * Includes configurable delay between pages to be respectful to the source.
 */
export async function* scrapeEventsStream(
  maxPages = 10,
  pageDelaySeconds = 30
): AsyncGenerator<{ page: number; events: ScrapedEvent[] }, void, unknown> {
  let page = 1;
  let hasMore = true;

  console.log(`Starting scrape (max ${maxPages} pages, ${pageDelaySeconds}s delay between pages)...`);

  while (hasMore && page <= maxPages) {
    const url = `${env.RIFTBOUND_EVENTS_URL}?page=${page}`;
    console.log(`Fetching page ${page}: ${url}`);

    try {
      const events = await scrapePage(url);

      if (events.length === 0) {
        console.log(`  Page ${page} returned 0 events, stopping.`);
        hasMore = false;
      } else {
        console.log(`  Found ${events.length} events on page ${page}`);

        // Yield this batch immediately for processing
        yield { page, events };

        hasMore = events.length >= EVENTS_PER_PAGE;
        page++;

        // Wait between pages (except after the last one)
        if (hasMore && page <= maxPages) {
          console.log(`  Waiting ${pageDelaySeconds}s before next page...`);
          await sleep(pageDelaySeconds * 1000);
        }
      }
    } catch (err) {
      console.error(`Error fetching page ${page}:`, err);
      hasMore = false;
    }
  }

  console.log(`Scrape stream complete after ${page - 1} pages.`);
}

/**
 * Legacy function that collects all events at once (for backwards compatibility).
 */
export async function scrapeEvents(maxPages = 10): Promise<ScrapedEvent[]> {
  const allEvents: ScrapedEvent[] = [];

  // Use a minimal delay for the legacy function
  for await (const { events } of scrapeEventsStream(maxPages, 0.5)) {
    allEvents.push(...events);
  }

  console.log(`Scrape complete. Total events: ${allEvents.length}`);
  return allEvents;
}

async function scrapePage(url: string): Promise<ScrapedEvent[]> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Riftfound/1.0 (Event Aggregator)',
      'Accept': 'text/html',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();
  return parseEventsFromHtml(html);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
