import * as cheerio from 'cheerio';
import { env } from './config.js';
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

function parseEventsFromHtml(html: string): ScrapedEvent[] {
  const $ = cheerio.load(html);
  const events: ScrapedEvent[] = [];
  const seenIds = new Set<string>();

  $('a[href^="/events/"]').each((_, element) => {
    try {
      const $card = $(element);
      const href = $card.attr('href') || '';

      const idMatch = href.match(/\/events\/(\d+)/);
      if (!idMatch) return;

      const externalId = idMatch[1];
      if (seenIds.has(externalId)) return;
      seenIds.add(externalId);

      // Get the full text content
      const text = $card.text().replace(/\s+/g, ' ').trim();

      // Parse the concatenated text
      // Pattern: [Upcoming|Ended]? Title Date Time [Players] Format Location Organizer Price
      const parsed = parseEventText(text);
      if (!parsed) return;

      // Extract image URL
      const $img = $card.find('img').first();
      const imageUrl = $img.attr('src') || null;

      const event: ScrapedEvent = {
        externalId,
        name: parsed.title,
        description: null,
        location: parsed.location,
        address: null,
        city: extractCity(parsed.location),
        state: extractState(parsed.location),
        country: extractCountry(parsed.location),
        latitude: null,
        longitude: null,
        startDate: parsed.date,
        endDate: null,
        eventType: parsed.format,
        organizer: parsed.organizer,
        url: `https://locator.riftbound.uvsgames.com${href}`,
        imageUrl,
      };

      events.push(event);
    } catch {
      // Skip malformed cards
    }
  });

  return events;
}

interface ParsedEvent {
  title: string;
  date: Date;
  format: string | null;
  location: string | null;
  organizer: string | null;
  price: string | null;
}

function parseEventText(text: string): ParsedEvent | null {
  // Remove status badge at start
  let remaining = text.replace(/^(Upcoming|Ended|In Progress)\s*/i, '');

  // Extract date pattern: "Dec 9, 2025" or "December 9, 2025"
  const dateMatch = remaining.match(/([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})/);
  if (!dateMatch) return null;

  const dateStr = dateMatch[1];
  const dateIndex = remaining.indexOf(dateStr);

  // Title is everything before the date
  const title = remaining.substring(0, dateIndex).trim();
  if (!title) return null;

  // Get everything after date
  remaining = remaining.substring(dateIndex + dateStr.length).trim();

  // Extract time: "5:00 AM (UTC)" or "5:00 AM UTC"
  const timeMatch = remaining.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM)?\s*\(?UTC\)?)/i);
  const timeStr = timeMatch ? timeMatch[1] : '';
  if (timeMatch) {
    remaining = remaining.substring(timeMatch[0].length).trim();
  }

  // Parse date + time
  const date = parseDateTime(dateStr, timeStr);

  // Skip optional player count: "1 Players" or "21 Players"
  remaining = remaining.replace(/^\d+\s*Players?\s*/i, '');

  // Extract format: Constructed, Sealed, Draft
  const formatMatch = remaining.match(/^(Constructed|Sealed|Draft|Multiplayer)/i);
  const format = formatMatch ? formatMatch[1] : null;
  if (formatMatch) {
    remaining = remaining.substring(formatMatch[0].length).trim();
  }

  // Price patterns: "Free Event", "NZ$16.00", "A$15.00", "$10.00"
  // Known currency prefixes: NZ$, A$, US$, C$, £, €, or just $
  const priceMatch = remaining.match(/(Free Event|(?:NZ|AU?|US|CA?|GB)?\$\d+(?:\.\d{2})?|[£€]\d+(?:\.\d{2})?)$/i);
  const price = priceMatch ? priceMatch[1] : null;
  if (priceMatch) {
    remaining = remaining.substring(0, remaining.length - priceMatch[0].length).trim();
  }

  // Remaining should be: "Location, CC Organizer" or "Location Organizer"
  // Try to split on known patterns
  const { location, organizer } = parseLocationOrganizer(remaining);

  return { title, date, format, location, organizer, price };
}

function parseLocationOrganizer(text: string): { location: string | null; organizer: string | null } {
  if (!text) return { location: null, organizer: null };

  // Pattern: "Canterbury, NZOrganizer Name" - country code immediately followed by org name
  // Country code is 2 letters, organizer starts with a capital letter
  // Handle both "NZGame Store" and "NZTCG Store" (acronym start)
  const locationMatch = text.match(/^(.+?,\s*[A-Z]{2})([A-Z].+)$/);
  if (locationMatch) {
    return {
      location: locationMatch[1].trim(),
      organizer: locationMatch[2].trim(),
    };
  }

  return { location: text, organizer: null };
}

function parseDateTime(dateStr: string, timeStr: string): Date {
  // Clean up time string
  const cleanTime = timeStr.replace(/[()]/g, '').replace(/UTC/i, '').trim() || '00:00';

  const fullStr = `${dateStr} ${cleanTime} UTC`;
  const parsed = new Date(fullStr);

  if (isNaN(parsed.getTime())) {
    // Fallback: just parse date
    return new Date(dateStr);
  }

  return parsed;
}

function extractCity(location: string | null): string | null {
  if (!location) return null;
  const parts = location.split(',').map(p => p.trim());
  return parts[0] || null;
}

function extractState(location: string | null): string | null {
  if (!location) return null;
  const parts = location.split(',').map(p => p.trim());
  if (parts.length >= 2) {
    // Could be "NSW" or "NSW AU" - take first word
    return parts[1].split(/\s+/)[0] || null;
  }
  return null;
}

function extractCountry(location: string | null): string | null {
  if (!location) return null;

  const lower = location.toLowerCase();
  if (lower.includes(', nz') || lower.includes('zealand')) return 'NZ';
  if (lower.includes(', au') || lower.includes('australia')) return 'AU';
  if (lower.includes(', us') || lower.includes(', usa')) return 'US';
  if (lower.includes(', uk') || lower.includes(', gb')) return 'UK';
  if (lower.includes(', ca')) return 'CA';

  // Check for country code at end
  const codeMatch = location.match(/,\s*([A-Z]{2})$/);
  if (codeMatch) return codeMatch[1];

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
