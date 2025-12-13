#!/usr/bin/env npx tsx
/**
 * Generate Photon-compatible JSON for cities from two sources:
 * 1. Store locations (reverse geocoded from coordinates)
 * 2. Top ~1000 world cities by population
 *
 * Deduplicates by city+country before geocoding to minimize API calls.
 *
 * Usage:
 *   npx tsx scripts/generate-combined-cities-json.ts > combined-cities.json
 *
 * Or with existing JSON to skip already-geocoded cities:
 *   npx tsx scripts/generate-combined-cities-json.ts existing-cities.json > combined-cities.json
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';

const PUBLIC_PHOTON_URL = 'https://photon.komoot.io';
const RATE_LIMIT_MS = 1100; // ~1 request per second

// Top ~1000 world cities by population/importance
const TOP_CITIES: Array<{ city: string; country: string }> = [
  // ASIA - Major Cities
  { city: 'Tokyo', country: 'Japan' },
  { city: 'Delhi', country: 'India' },
  { city: 'Shanghai', country: 'China' },
  { city: 'Beijing', country: 'China' },
  { city: 'Mumbai', country: 'India' },
  { city: 'Osaka', country: 'Japan' },
  { city: 'Dhaka', country: 'Bangladesh' },
  { city: 'Karachi', country: 'Pakistan' },
  { city: 'Kolkata', country: 'India' },
  { city: 'Chongqing', country: 'China' },
  { city: 'Guangzhou', country: 'China' },
  { city: 'Manila', country: 'Philippines' },
  { city: 'Tianjin', country: 'China' },
  { city: 'Shenzhen', country: 'China' },
  { city: 'Bangalore', country: 'India' },
  { city: 'Jakarta', country: 'Indonesia' },
  { city: 'Chennai', country: 'India' },
  { city: 'Seoul', country: 'South Korea' },
  { city: 'Hyderabad', country: 'India' },
  { city: 'Bangkok', country: 'Thailand' },
  { city: 'Lahore', country: 'Pakistan' },
  { city: 'Ho Chi Minh City', country: 'Vietnam' },
  { city: 'Hong Kong', country: 'China' },
  { city: 'Kuala Lumpur', country: 'Malaysia' },
  { city: 'Singapore', country: 'Singapore' },
  { city: 'Taipei', country: 'Taiwan' },
  { city: 'Nagoya', country: 'Japan' },

  // EUROPE - Major Cities
  { city: 'London', country: 'United Kingdom' },
  { city: 'Paris', country: 'France' },
  { city: 'Berlin', country: 'Germany' },
  { city: 'Madrid', country: 'Spain' },
  { city: 'Rome', country: 'Italy' },
  { city: 'Moscow', country: 'Russia' },
  { city: 'Saint Petersburg', country: 'Russia' },
  { city: 'Istanbul', country: 'Turkey' },
  { city: 'Barcelona', country: 'Spain' },
  { city: 'Milan', country: 'Italy' },
  { city: 'Munich', country: 'Germany' },
  { city: 'Amsterdam', country: 'Netherlands' },
  { city: 'Vienna', country: 'Austria' },
  { city: 'Warsaw', country: 'Poland' },
  { city: 'Budapest', country: 'Hungary' },
  { city: 'Prague', country: 'Czech Republic' },
  { city: 'Brussels', country: 'Belgium' },
  { city: 'Stockholm', country: 'Sweden' },
  { city: 'Copenhagen', country: 'Denmark' },
  { city: 'Oslo', country: 'Norway' },
  { city: 'Helsinki', country: 'Finland' },
  { city: 'Dublin', country: 'Ireland' },
  { city: 'Lisbon', country: 'Portugal' },
  { city: 'Athens', country: 'Greece' },
  { city: 'Zurich', country: 'Switzerland' },
  { city: 'Edinburgh', country: 'United Kingdom' },
  { city: 'Manchester', country: 'United Kingdom' },
  { city: 'Birmingham', country: 'United Kingdom' },
  { city: 'Glasgow', country: 'United Kingdom' },
  { city: 'Liverpool', country: 'United Kingdom' },
  { city: 'Leeds', country: 'United Kingdom' },
  { city: 'Bristol', country: 'United Kingdom' },
  { city: 'Lyon', country: 'France' },
  { city: 'Marseille', country: 'France' },
  { city: 'Hamburg', country: 'Germany' },
  { city: 'Frankfurt', country: 'Germany' },
  { city: 'Cologne', country: 'Germany' },
  { city: 'Naples', country: 'Italy' },
  { city: 'Turin', country: 'Italy' },
  { city: 'Valencia', country: 'Spain' },
  { city: 'Seville', country: 'Spain' },
  { city: 'Krakow', country: 'Poland' },
  { city: 'Bucharest', country: 'Romania' },
  { city: 'Sofia', country: 'Bulgaria' },
  { city: 'Zagreb', country: 'Croatia' },
  { city: 'Belgrade', country: 'Serbia' },
  { city: 'Rotterdam', country: 'Netherlands' },
  { city: 'Antwerp', country: 'Belgium' },
  { city: 'Gothenburg', country: 'Sweden' },
  { city: 'Porto', country: 'Portugal' },

  // NORTH AMERICA (non-US)
  { city: 'Toronto', country: 'Canada' },
  { city: 'Montreal', country: 'Canada' },
  { city: 'Vancouver', country: 'Canada' },
  { city: 'Calgary', country: 'Canada' },
  { city: 'Edmonton', country: 'Canada' },
  { city: 'Ottawa', country: 'Canada' },
  { city: 'Winnipeg', country: 'Canada' },
  { city: 'Quebec City', country: 'Canada' },
  { city: 'Hamilton', country: 'Canada' },
  { city: 'Victoria', country: 'Canada' },
  { city: 'Halifax', country: 'Canada' },
  { city: 'Mexico City', country: 'Mexico' },
  { city: 'Guadalajara', country: 'Mexico' },
  { city: 'Monterrey', country: 'Mexico' },
  { city: 'Puebla', country: 'Mexico' },
  { city: 'Tijuana', country: 'Mexico' },
  { city: 'Cancun', country: 'Mexico' },

  // SOUTH AMERICA
  { city: 'Sao Paulo', country: 'Brazil' },
  { city: 'Rio de Janeiro', country: 'Brazil' },
  { city: 'Buenos Aires', country: 'Argentina' },
  { city: 'Lima', country: 'Peru' },
  { city: 'Bogota', country: 'Colombia' },
  { city: 'Santiago', country: 'Chile' },
  { city: 'Caracas', country: 'Venezuela' },
  { city: 'Medellin', country: 'Colombia' },
  { city: 'Brasilia', country: 'Brazil' },

  // OCEANIA
  { city: 'Sydney', country: 'Australia' },
  { city: 'Melbourne', country: 'Australia' },
  { city: 'Brisbane', country: 'Australia' },
  { city: 'Perth', country: 'Australia' },
  { city: 'Adelaide', country: 'Australia' },
  { city: 'Gold Coast', country: 'Australia' },
  { city: 'Canberra', country: 'Australia' },
  { city: 'Auckland', country: 'New Zealand' },
  { city: 'Wellington', country: 'New Zealand' },
  { city: 'Christchurch', country: 'New Zealand' },

  // AFRICA
  { city: 'Cairo', country: 'Egypt' },
  { city: 'Lagos', country: 'Nigeria' },
  { city: 'Johannesburg', country: 'South Africa' },
  { city: 'Cape Town', country: 'South Africa' },
  { city: 'Nairobi', country: 'Kenya' },
  { city: 'Casablanca', country: 'Morocco' },
  { city: 'Durban', country: 'South Africa' },

  // MIDDLE EAST
  { city: 'Dubai', country: 'United Arab Emirates' },
  { city: 'Abu Dhabi', country: 'United Arab Emirates' },
  { city: 'Doha', country: 'Qatar' },
  { city: 'Tel Aviv', country: 'Israel' },
  { city: 'Jerusalem', country: 'Israel' },
  { city: 'Riyadh', country: 'Saudi Arabia' },
  { city: 'Jeddah', country: 'Saudi Arabia' },
];

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
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

interface PhotonDocument {
  osm_id: number;
  osm_type: string;
  osm_key: string;
  osm_value: string;
  type: string;
  importance: number;
  name: { default: string; en?: string };
  coordinate: { lat: number; lon: number };
  countrycode: string;
  country?: { default: string };
  state?: { default: string };
  city?: { default: string };
  context: Record<string, unknown>;
}

interface StoreRow {
  latitude: number;
  longitude: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Reverse geocode coordinates to get city info
async function reverseGeocode(lat: number, lon: number): Promise<{ city: string; country: string } | null> {
  const url = `${PUBLIC_PHOTON_URL}/reverse?lat=${lat}&lon=${lon}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Riftfound/1.0 (Store Cities Geocoder)' },
    });

    if (!response.ok) {
      console.error(`Reverse geocode failed for ${lat},${lon}: HTTP ${response.status}`);
      return null;
    }

    const data: PhotonResponse = await response.json();
    if (data.features.length === 0) {
      return null;
    }

    const props = data.features[0].properties;
    // Get the city - prefer city, then name for places, then state
    const city = props.city || props.name || props.state;
    const country = props.country;

    if (!city || !country) {
      return null;
    }

    return { city, country };
  } catch (error) {
    console.error(`Reverse geocode error for ${lat},${lon}:`, error);
    return null;
  }
}

// Forward geocode city to get full Photon feature
async function geocodeCity(city: string, country: string): Promise<PhotonFeature | null> {
  const query = `${city}, ${country}`;
  const url = new URL(`${PUBLIC_PHOTON_URL}/api`);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '1');
  url.searchParams.set('osm_tag', 'place');

  try {
    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Riftfound/1.0 (Cities Geocoder)' },
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

function featureToPhotonDocument(feature: PhotonFeature, docId: number, englishName: string): PhotonDocument {
  const props = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;
  const osmValue = props.osm_value || props.type || 'city';

  const defaultName = props.name || englishName;
  const hasNonLatin = /[^\u0000-\u007F]/.test(defaultName);

  const doc: PhotonDocument = {
    osm_id: props.osm_id || docId,
    osm_type: props.osm_type?.charAt(0).toUpperCase() || 'N',
    osm_key: props.osm_key || 'place',
    osm_value: osmValue,
    type: osmValue,
    importance: 0.7,
    name: hasNonLatin
      ? { default: englishName, en: englishName }
      : { default: defaultName },
    coordinate: { lat, lon },
    countrycode: (props.countrycode || '').toUpperCase(),
    context: {},
  };

  if (props.country) doc.country = { default: props.country };
  if (props.state) doc.state = { default: props.state };
  if (props.city && props.city !== props.name) doc.city = { default: props.city };

  return doc;
}

function loadExistingOsmIds(filePath: string): Set<number> {
  const ids = new Set<number>();
  try {
    if (!existsSync(filePath)) return ids;
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.trim()) {
        const doc = JSON.parse(line);
        if (doc.osm_id) ids.add(doc.osm_id);
      }
    }
    console.error(`Loaded ${ids.size} existing osm_ids from ${filePath}`);
  } catch {
    console.error(`Could not load existing file: ${filePath}`);
  }
  return ids;
}

function normalizeCity(city: string, country: string): string {
  // Normalize for deduplication: lowercase, trim, remove extra spaces
  return `${city.toLowerCase().trim()}|${country.toLowerCase().trim()}`;
}

async function getStoreCities(dbPath: string): Promise<Array<{ city: string; country: string }>> {
  const db = new Database(dbPath);

  // Get unique store coordinates (rounded to reduce duplicates)
  const stores = db.prepare(`
    SELECT DISTINCT
      ROUND(latitude, 2) as latitude,
      ROUND(longitude, 2) as longitude
    FROM shops
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  `).all() as StoreRow[];

  db.close();

  console.error(`Found ${stores.length} unique store locations to reverse geocode...`);

  const cities: Array<{ city: string; country: string }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < stores.length; i++) {
    const store = stores[i];
    console.error(`Reverse geocoding ${i + 1}/${stores.length}: ${store.latitude},${store.longitude}`);

    const result = await reverseGeocode(store.latitude, store.longitude);
    if (result) {
      const key = normalizeCity(result.city, result.country);
      if (!seen.has(key)) {
        seen.add(key);
        cities.push(result);
        console.error(`  -> ${result.city}, ${result.country}`);
      } else {
        console.error(`  -> (duplicate) ${result.city}, ${result.country}`);
      }
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.error(`Found ${cities.length} unique cities from store locations`);
  return cities;
}

async function main() {
  const dbPath = process.env.DB_PATH || '/opt/riftfound/riftfound.db';
  const existingFile = process.argv[2];
  const existingIds = existingFile ? loadExistingOsmIds(existingFile) : new Set<number>();

  // Step 1: Get cities from store locations
  console.error('\n=== Phase 1: Getting cities from store locations ===\n');
  const storeCities = await getStoreCities(dbPath);

  // Step 2: Combine with top cities and deduplicate
  console.error('\n=== Phase 2: Combining and deduplicating ===\n');
  const allCities = new Map<string, { city: string; country: string }>();

  // Add store cities first (they take priority)
  for (const c of storeCities) {
    const key = normalizeCity(c.city, c.country);
    allCities.set(key, c);
  }

  // Add top cities (only if not already present)
  let topCitiesAdded = 0;
  for (const c of TOP_CITIES) {
    const key = normalizeCity(c.city, c.country);
    if (!allCities.has(key)) {
      allCities.set(key, c);
      topCitiesAdded++;
    }
  }

  console.error(`Store cities: ${storeCities.length}`);
  console.error(`Top cities added: ${topCitiesAdded}`);
  console.error(`Total unique cities: ${allCities.size}`);

  // Step 3: Forward geocode all unique cities
  console.error('\n=== Phase 3: Forward geocoding cities ===\n');

  const cities = Array.from(allCities.values());
  let placeId = 900000000;
  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (let i = 0; i < cities.length; i++) {
    const { city, country } = cities[i];
    console.error(`Geocoding ${i + 1}/${cities.length}: ${city}, ${country}`);

    const feature = await geocodeCity(city, country);

    if (feature) {
      const osmId = feature.properties.osm_id;
      if (osmId && existingIds.has(osmId)) {
        console.error(`  Skipping (already exists): osm_id=${osmId}`);
        skipCount++;
      } else {
        const doc = featureToPhotonDocument(feature, placeId++, city);
        console.log(JSON.stringify(doc));
        successCount++;
        if (osmId) existingIds.add(osmId);
      }
    } else {
      failCount++;
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.error(`\n=== Done! ===`);
  console.error(`Added: ${successCount}, Skipped: ${skipCount}, Failed: ${failCount}`);
}

main().catch(console.error);
