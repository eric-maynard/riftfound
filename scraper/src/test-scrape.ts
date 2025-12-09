/**
 * Test script to verify scraping works without database
 * Run with: npx tsx scraper/src/test-scrape.ts
 */

import * as cheerio from 'cheerio';

const EVENTS_URL = 'https://locator.riftbound.uvsgames.com/events';

interface ParsedEvent {
  externalId: string;
  title: string;
  date: Date;
  format: string | null;
  location: string | null;
  organizer: string | null;
  price: string | null;
  url: string;
}

async function testScrape() {
  console.log(`Fetching ${EVENTS_URL}...\n`);

  const response = await fetch(EVENTS_URL, {
    headers: {
      'User-Agent': 'Riftfound/1.0 (Event Aggregator)',
      'Accept': 'text/html',
    },
  });

  const html = await response.text();
  const $ = cheerio.load(html);

  const events: ParsedEvent[] = [];
  const seenIds = new Set<string>();

  $('a[href^="/events/"]').each((_, element) => {
    const $card = $(element);
    const href = $card.attr('href') || '';

    const idMatch = href.match(/\/events\/(\d+)/);
    if (!idMatch) return;

    const externalId = idMatch[1];
    if (seenIds.has(externalId)) return;
    seenIds.add(externalId);

    const text = $card.text().replace(/\s+/g, ' ').trim();
    const parsed = parseEventText(text);
    if (!parsed) return;

    events.push({
      externalId,
      ...parsed,
      url: `https://locator.riftbound.uvsgames.com${href}`,
    });
  });

  console.log(`Parsed ${events.length} events:\n`);

  events.slice(0, 10).forEach((e, i) => {
    console.log(`${i + 1}. ${e.title}`);
    console.log(`   ID: ${e.externalId}`);
    console.log(`   Date: ${e.date.toISOString()}`);
    console.log(`   Format: ${e.format || 'N/A'}`);
    console.log(`   Location: ${e.location || 'N/A'}`);
    console.log(`   Organizer: ${e.organizer || 'N/A'}`);
    console.log(`   Price: ${e.price || 'N/A'}`);
    console.log('');
  });
}

function parseEventText(text: string): Omit<ParsedEvent, 'externalId' | 'url'> | null {
  let remaining = text.replace(/^(Upcoming|Ended|In Progress)\s*/i, '');

  const dateMatch = remaining.match(/([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})/);
  if (!dateMatch) return null;

  const dateStr = dateMatch[1];
  const dateIndex = remaining.indexOf(dateStr);
  const title = remaining.substring(0, dateIndex).trim();
  if (!title) return null;

  remaining = remaining.substring(dateIndex + dateStr.length).trim();

  const timeMatch = remaining.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM)?\s*\(?UTC\)?)/i);
  const timeStr = timeMatch ? timeMatch[1] : '';
  if (timeMatch) {
    remaining = remaining.substring(timeMatch[0].length).trim();
  }

  const cleanTime = timeStr.replace(/[()]/g, '').replace(/UTC/i, '').trim() || '00:00';
  const date = new Date(`${dateStr} ${cleanTime} UTC`);

  remaining = remaining.replace(/^\d+\s*Players?\s*/i, '');

  const formatMatch = remaining.match(/^(Constructed|Sealed|Draft|Multiplayer)/i);
  const format = formatMatch ? formatMatch[1] : null;
  if (formatMatch) {
    remaining = remaining.substring(formatMatch[0].length).trim();
  }

  // Price patterns: "Free Event", "NZ$16.00", "A$15.00", "$10.00", "€15.00"
  // Known currency prefixes: NZ$, A$, US$, C$, £, €, or just $
  const priceMatch = remaining.match(/(Free Event|(?:NZ|AU?|US|CA?|GB)?\$\d+(?:\.\d{2})?|[£€]\d+(?:\.\d{2})?)$/i);
  const price = priceMatch ? priceMatch[1] : null;
  if (priceMatch) {
    remaining = remaining.substring(0, remaining.length - priceMatch[0].length).trim();
  }

  const { location, organizer } = parseLocationOrganizer(remaining);

  return { title, date, format, location, organizer, price };
}

function parseLocationOrganizer(text: string): { location: string | null; organizer: string | null } {
  if (!text) return { location: null, organizer: null };

  // Pattern: "Canterbury, NZOrganizer Name" - country code immediately followed by org name
  // Country code is 2 letters, organizer starts with a capital letter
  // Handle both "NZGame Store" (caps start) and "NZTCG Store" (acronym start)
  const locationMatch = text.match(/^(.+?,\s*[A-Z]{2})([A-Z].+)$/);
  if (locationMatch) {
    return {
      location: locationMatch[1].trim(),
      organizer: locationMatch[2].trim()
    };
  }

  return { location: text, organizer: null };
}

testScrape().catch(console.error);
