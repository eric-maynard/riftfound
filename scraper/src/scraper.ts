import { env } from './config.js';
import { parseEventsFromHtml } from './parser.js';
import type { ScrapedEvent } from './database.js';

const EVENTS_PER_PAGE = 25;
const REQUEST_DELAY_MS = 500;

export async function scrapeEvents(maxPages = 10): Promise<ScrapedEvent[]> {
  const allEvents: ScrapedEvent[] = [];
  let page = 1;
  let hasMore = true;

  console.log(`Starting scrape (max ${maxPages} pages)...`);

  while (hasMore && page <= maxPages) {
    const url = `${env.RIFTBOUND_EVENTS_URL}?page=${page}`;
    console.log(`Fetching page ${page}: ${url}`);

    try {
      const events = await scrapePage(url);

      if (events.length === 0) {
        hasMore = false;
      } else {
        allEvents.push(...events);
        console.log(`  Found ${events.length} events (total: ${allEvents.length})`);
        hasMore = events.length >= EVENTS_PER_PAGE;
        page++;

        if (hasMore) {
          await sleep(REQUEST_DELAY_MS);
        }
      }
    } catch (err) {
      console.error(`Error fetching page ${page}:`, err);
      hasMore = false;
    }
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
