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

// Parse city from full_address when API city field is unreliable
// Address format: "Street, City, State, Zip, Country" or "Street, City, State Zip, Country"
function parseCityFromAddress(fullAddress: string, storeCity: string | null, storeState: string | null): string | null {
  // If store city looks valid (not same as state, not a 2-letter code), use it
  if (storeCity && storeCity !== storeState && storeCity.length > 2) {
    return storeCity;
  }

  // Parse from full_address: "1569 Olivina Ave, Ste 121, Livermore, CA, 94551, US"
  // Split by comma and find the city (usually 2nd or 3rd from end before state/zip/country)
  const parts = fullAddress.split(',').map(p => p.trim());
  if (parts.length >= 4) {
    // Try to find city - it's typically before state abbreviation
    // Pattern: [..., City, State, Zip, Country] or [..., City, State Zip, Country]
    for (let i = parts.length - 3; i >= 1; i--) {
      const part = parts[i];
      // Skip if it looks like a zip code, state abbreviation, or country
      if (/^\d{5}/.test(part)) continue; // Zip code
      if (/^[A-Z]{2}$/.test(part)) continue; // State abbr
      if (/^[A-Z]{2,3}$/.test(part) && ['US', 'USA', 'UK', 'CA'].includes(part)) continue; // Country
      if (part.length <= 3) continue; // Too short
      return part;
    }
  }

  return storeCity;
}

function inferEventCategory(name: string, description: string | null): string {
  // Infer category from event name and description
  const text = `${name} ${description || ''}`.toLowerCase();

  if (text.includes('summoner skirmish')) return 'Summoner Skirmish';
  if (text.includes('nexus night')) return 'Nexus Night';

  return 'Other';
}

function convertApiEvent(apiEvent: ApiEvent): ScrapedEvent & { storeInfo: ApiStore } {
  const startDate = new Date(apiEvent.start_datetime);
  const endDate = apiEvent.end_datetime ? new Date(apiEvent.end_datetime) : null;

  // Store time as null - frontend will extract from startDate ISO string
  // This avoids timezone conversion issues with server locale

  return {
    externalId: String(apiEvent.id),
    name: apiEvent.name,
    description: apiEvent.description,
    location: apiEvent.store?.name || null,
    address: apiEvent.full_address,
    city: parseCityFromAddress(apiEvent.full_address, apiEvent.store?.city || null, apiEvent.store?.state || null),
    state: apiEvent.store?.state || null,
    country: apiEvent.store?.country || null,
    latitude: apiEvent.latitude,
    longitude: apiEvent.longitude,
    startDate,
    startTime: null, // Frontend will convert from UTC startDate to local time
    endDate,
    eventType: inferEventCategory(apiEvent.name, apiEvent.description),
    organizer: apiEvent.store?.name || null,
    playerCount: apiEvent.registered_user_count,
    capacity: apiEvent.capacity,
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
 * Get total event count and page info without fetching all data.
 */
export async function getEventCount(): Promise<{ total: number; pageCount: number }> {
  const today = new Date().toISOString();
  const url = `${API_BASE}/events/?start_date_after=${encodeURIComponent(today)}&display_status=upcoming&latitude=0&longitude=0&num_miles=20000&upcoming_only=true&game_slug=riftbound&page=1&page_size=${PAGE_SIZE}`;

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
  const pageCount = Math.ceil(data.total / PAGE_SIZE);
  return { total: data.total, pageCount };
}

/**
 * Fetch a single page of events from the API.
 * Used for distributed scraping approach.
 */
export async function fetchEventsPage(
  page: number
): Promise<{ events: (ScrapedEvent & { storeInfo: ApiStore })[]; hasMore: boolean }> {
  const today = new Date().toISOString();
  const url = `${API_BASE}/events/?start_date_after=${encodeURIComponent(today)}&display_status=upcoming&latitude=0&longitude=0&num_miles=20000&upcoming_only=true&game_slug=riftbound&page=${page}&page_size=${PAGE_SIZE}`;

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

  return {
    events,
    hasMore: data.next_page_number !== null,
  };
}
