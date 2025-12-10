import type { ScrapedEvent } from './database.js';

const API_BASE = 'https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2';
const PAGE_SIZE = 1000;

// API response types
interface ApiStore {
  id: number;
  name: string;
  full_address: string;
  city: string;
  state: string;
  country: string;
  latitude: number;
  longitude: number;
  website: string | null;
  email: string | null;
}

interface ApiEvent {
  id: number;
  name: string;
  description: string | null;
  start_datetime: string;
  end_datetime: string | null;
  full_address: string;
  latitude: number;
  longitude: number;
  event_format: string;
  event_type: string;
  cost_in_cents: number;
  currency: string;
  capacity: number;
  registered_user_count: number;
  full_header_image_url: string | null;
  store: ApiStore;
}

interface ApiResponse {
  page_size: number;
  count: number;
  total: number;
  current_page_number: number;
  next_page_number: number | null;
  results: ApiEvent[];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatPrice(cents: number, currency: string): string {
  if (cents === 0) return 'Free';
  const dollars = cents / 100;
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '';
  return `${symbol}${dollars.toFixed(2)}`;
}

function parseEventType(format: string, type: string): string {
  // Map API format/type to our simplified categories
  const formatLower = format.toLowerCase();
  if (formatLower.includes('constructed')) return 'Constructed';
  if (formatLower.includes('sealed')) return 'Sealed';
  if (formatLower.includes('draft')) return 'Draft';
  if (formatLower.includes('multiplayer')) return 'Multiplayer';
  return format || type || 'Other';
}

function convertApiEvent(apiEvent: ApiEvent): ScrapedEvent & { storeInfo: ApiStore } {
  const startDate = new Date(apiEvent.start_datetime);
  const endDate = apiEvent.end_datetime ? new Date(apiEvent.end_datetime) : null;

  // Extract time string
  const timeStr = startDate.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  return {
    externalId: String(apiEvent.id),
    name: apiEvent.name,
    description: apiEvent.description,
    location: apiEvent.store?.name || null,
    address: apiEvent.full_address,
    city: apiEvent.store?.city || null,
    state: apiEvent.store?.state || null,
    country: apiEvent.store?.country || null,
    latitude: apiEvent.latitude,
    longitude: apiEvent.longitude,
    startDate,
    startTime: timeStr,
    endDate,
    eventType: parseEventType(apiEvent.event_format, apiEvent.event_type),
    organizer: apiEvent.store?.name || null,
    playerCount: apiEvent.registered_user_count,
    price: formatPrice(apiEvent.cost_in_cents, apiEvent.currency),
    url: null, // API doesn't provide event URL
    imageUrl: apiEvent.full_header_image_url,
    // Include store info for upsert
    storeInfo: apiEvent.store,
  };
}

/**
 * Fetch all upcoming events from the API.
 * Yields batches of events as pages are fetched.
 */
export async function* fetchEventsFromApi(
  pageDelayMs = 1000
): AsyncGenerator<{ page: number; events: (ScrapedEvent & { storeInfo: ApiStore })[] }, void, unknown> {
  let page = 1;
  let hasMore = true;
  const today = new Date().toISOString();

  console.log(`Fetching events from API (page size: ${PAGE_SIZE})...`);

  while (hasMore) {
    const url = `${API_BASE}/events/?start_date_after=${encodeURIComponent(today)}&display_status=upcoming&latitude=0&longitude=0&num_miles=20000&upcoming_only=true&game_slug=riftbound&page=${page}&page_size=${PAGE_SIZE}`;

    console.log(`Fetching page ${page}...`);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Riftfound/1.0 (Event Aggregator)',
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: ApiResponse = await response.json();
      const events = data.results.map(convertApiEvent);

      console.log(`  Page ${page}: ${events.length} events (${data.count} total remaining)`);

      yield { page, events };

      hasMore = data.next_page_number !== null;
      page++;

      // Small delay between pages to be nice to the API
      if (hasMore) {
        await sleep(pageDelayMs);
      }
    } catch (error) {
      console.error(`Error fetching page ${page}:`, error);
      throw error;
    }
  }

  console.log(`API fetch complete after ${page - 1} pages.`);
}

/**
 * Get total event count without fetching all data.
 */
export async function getEventCount(): Promise<number> {
  const today = new Date().toISOString();
  const url = `${API_BASE}/events/?start_date_after=${encodeURIComponent(today)}&display_status=upcoming&latitude=0&longitude=0&num_miles=20000&upcoming_only=true&game_slug=riftbound&page=1&page_size=1`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Riftfound/1.0 (Event Aggregator)',
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data: ApiResponse = await response.json();
  return data.total;
}
