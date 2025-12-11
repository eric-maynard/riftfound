#!/usr/bin/env npx tsx
/**
 * Generate Photon-compatible JSON for cities that have game stores.
 *
 * Usage: npx tsx scripts/generate-cities-json.ts > cities.json
 *
 * This script:
 * 1. Fetches unique cities from the Riftfound API
 * 2. Geocodes each city using public Photon (rate-limited)
 * 3. Outputs newline-delimited JSON in Photon's format
 */

const API_URL = process.env.API_URL || 'https://www.riftfound.com/api';
const PHOTON_URL = 'https://photon.komoot.io/api';
const RATE_LIMIT_MS = 1100; // ~1 request per second to be respectful

interface Event {
  city: string | null;
  state: string | null;
  country: string | null;
}

interface PhotonFeature {
  geometry: {
    coordinates: [number, number]; // [lon, lat]
  };
  properties: {
    osm_id?: number;
    osm_type?: string;
    osm_key?: string;
    osm_value?: string;
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    type?: string;
  };
}

interface PhotonResponse {
  features: PhotonFeature[];
}

// OpenSearch document format matching Photon's actual index structure
interface PhotonDocument {
  osm_id: number;
  osm_type: string;
  osm_key: string;
  osm_value: string;
  type: string;
  importance: number;
  name: { default: string };
  coordinate: { lat: number; lon: number };
  countrycode: string;
  country?: { default: string };
  state?: { default: string };
  city?: { default: string };
  context: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCitiesFromApi(): Promise<Array<{ city: string; state: string | null; country: string }>> {
  const response = await fetch(`${API_URL}/events?calendarMode=true`);
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  const events: Event[] = data.data;

  // Extract unique city/state/country combinations
  const seen = new Set<string>();
  const cities: Array<{ city: string; state: string | null; country: string }> = [];

  for (const event of events) {
    if (!event.city || !event.country) continue;

    const key = `${event.city}|${event.state || ''}|${event.country}`;
    if (seen.has(key)) continue;
    seen.add(key);

    cities.push({
      city: event.city,
      state: event.state,
      country: event.country,
    });
  }

  return cities;
}

async function geocodeCity(city: string, state: string | null, country: string): Promise<PhotonFeature | null> {
  // Build query string
  const query = [city, state, country].filter(Boolean).join(', ');

  const url = new URL(PHOTON_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '1');
  url.searchParams.set('osm_tag', 'place');

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Riftfound/1.0 (City Geocoder)',
      },
    });

    if (!response.ok) {
      console.error(`Geocode failed for "${query}": HTTP ${response.status}`);
      return null;
    }

    const data: PhotonResponse = await response.json();

    if (data.features.length === 0) {
      console.error(`No results for "${query}"`);
      return null;
    }

    return data.features[0];
  } catch (error) {
    console.error(`Geocode error for "${query}":`, error);
    return null;
  }
}

function featureToPhotonDocument(feature: PhotonFeature, docId: number): PhotonDocument {
  const props = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;

  const osmValue = props.osm_value || props.type || 'city';

  const doc: PhotonDocument = {
    osm_id: props.osm_id || docId,
    osm_type: props.osm_type?.charAt(0).toUpperCase() || 'N',
    osm_key: props.osm_key || 'place',
    osm_value: osmValue,
    type: osmValue,
    importance: 0.5,
    name: { default: props.name || '' },
    coordinate: { lat, lon },
    countrycode: (props.countrycode || '').toUpperCase(),
    context: {},
  };

  // Add address parts
  if (props.country) {
    doc.country = { default: props.country };
  }
  if (props.state) {
    doc.state = { default: props.state };
  }
  if (props.city && props.city !== props.name) {
    doc.city = { default: props.city };
  }

  return doc;
}

async function main() {
  console.error('Fetching cities from API...');
  const cities = await fetchCitiesFromApi();
  console.error(`Found ${cities.length} unique cities`);

  // Filter out US cities (already in local Photon)
  const nonUsCities = cities.filter(c => c.country !== 'US');
  console.error(`${nonUsCities.length} non-US cities to geocode`);

  let placeId = 900000000; // Start with high ID to avoid conflicts
  let successCount = 0;
  let failCount = 0;

  for (const city of nonUsCities) {
    console.error(`Geocoding: ${city.city}, ${city.state || ''}, ${city.country}...`);

    const feature = await geocodeCity(city.city, city.state, city.country);

    if (feature) {
      const doc = featureToPhotonDocument(feature, placeId++);
      // Output as newline-delimited JSON
      console.log(JSON.stringify(doc));
      successCount++;
    } else {
      failCount++;
    }

    // Rate limit
    await sleep(RATE_LIMIT_MS);
  }

  console.error(`\nDone! Success: ${successCount}, Failed: ${failCount}`);
}

main().catch(console.error);
