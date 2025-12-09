import * as cheerio from 'cheerio';
import type { ScrapedEvent } from './database.js';

/**
 * Parse event cards from Riftbound HTML using data-testid selectors.
 * This module is designed to be unit testable with sample HTML fixtures.
 */
export function parseEventsFromHtml(html: string): ScrapedEvent[] {
  const $ = cheerio.load(html);
  const events: ScrapedEvent[] = [];
  const seenIds = new Set<string>();

  // Find all event cards by their data-testid pattern
  $('[data-testid^="eventCard-"]').each((_, element) => {
    const $card = $(element);
    const testId = $card.attr('data-testid') || '';

    // Skip text elements like eventCard-text-title
    if (testId.includes('-text-')) return;

    // Extract event ID from testid: "eventCard-269198"
    const idMatch = testId.match(/eventCard-(\d+)/);
    if (!idMatch) return;

    const externalId = idMatch[1];
    if (seenIds.has(externalId)) return;
    seenIds.add(externalId);

    try {
      const event = parseEventCard($, $card, externalId);
      if (event) {
        events.push(event);
      }
    } catch {
      // Skip malformed cards
    }
  });

  return events;
}

function parseEventCard(
  $: cheerio.CheerioAPI,
  $card: cheerio.Cheerio<cheerio.Element>,
  externalId: string
): ScrapedEvent | null {
  // Title: data-testid="eventCard-text-title"
  const name = $card.find('[data-testid="eventCard-text-title"]').text().trim();
  if (!name) return null;

  // Date: data-testid="eventCard-text-date"
  const dateStr = $card.find('[data-testid="eventCard-text-date"]').text().trim();

  // Time: data-testid="eventCard-text-time"
  const startTime = $card.find('[data-testid="eventCard-text-time"]').text().trim() || null;

  // Price: data-testid="eventCard-text-entryFee"
  const price = $card.find('[data-testid="eventCard-text-entryFee"]').text().trim() || null;

  // Location: data-testid="eventCard-text-storeName" (confusingly named - it's actually location)
  const location = $card.find('[data-testid="eventCard-text-storeName"]').text().trim() || null;

  // Player count: text near lucide-users icon (e.g., "7 Players")
  const playerCount = extractPlayerCount($, $card);

  // Format: text near lucide-trophy icon (e.g., "Constructed")
  const eventType = extractFormat($, $card);

  // Store name: text in span after lucide-store icon
  const organizer = extractStoreName($, $card);

  // Image URL
  const $img = $card.find('img').first();
  const imageUrl = $img.attr('src') || null;

  // Parse the date
  const startDate = parseDateTime(dateStr, startTime);

  // Find the event URL (look for parent link or nearby link)
  const $link = $card.is('a') ? $card : $card.find('a[href^="/events/"]').first();
  const href = $link.attr('href') || $card.closest('a').attr('href') || `/events/${externalId}`;
  const url = `https://locator.riftbound.uvsgames.com${href}`;

  return {
    externalId,
    name,
    description: null,
    location,
    address: null,
    city: extractCity(location),
    state: extractState(location),
    country: extractCountry(location),
    latitude: null,
    longitude: null,
    startDate,
    startTime,
    endDate: null,
    eventType,
    organizer,
    playerCount,
    price,
    url,
    imageUrl,
  };
}

function extractPlayerCount($: cheerio.CheerioAPI, $card: cheerio.Cheerio<cheerio.Element>): number | null {
  // Find the lucide-users icon and get the sibling span text
  const $usersIcon = $card.find('.lucide-users');
  if ($usersIcon.length) {
    const $parent = $usersIcon.parent();
    const text = $parent.text().replace(/\s+/g, ' ').trim();
    const match = text.match(/(\d+)\s*Players?/i);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}

function extractFormat($: cheerio.CheerioAPI, $card: cheerio.Cheerio<cheerio.Element>): string | null {
  // Find the lucide-trophy icon and get the sibling span text
  const $trophyIcon = $card.find('.lucide-trophy');
  if ($trophyIcon.length) {
    const $parent = $trophyIcon.parent();
    const $span = $parent.find('span').first();
    const text = $span.text().trim();
    if (text && ['Constructed', 'Sealed', 'Draft', 'Multiplayer'].some(f => text.includes(f))) {
      return text;
    }
  }
  return null;
}

function extractStoreName($: cheerio.CheerioAPI, $card: cheerio.Cheerio<cheerio.Element>): string | null {
  // Find the lucide-store icon and get the sibling span text
  const $storeIcon = $card.find('.lucide-store');
  if ($storeIcon.length) {
    const $parent = $storeIcon.parent();
    const $span = $parent.find('span').first();
    const text = $span.text().trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function parseDateTime(dateStr: string, timeStr: string | null): Date {
  // Clean up time string: "7:30 AM (UTC)" -> "7:30 AM"
  const cleanTime = timeStr?.replace(/[()]/g, '').replace(/UTC/i, '').trim() || '00:00';

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
  const codeMatch = location.match(/,?\s*([A-Z]{2})$/);
  if (codeMatch) return codeMatch[1];

  return null;
}
