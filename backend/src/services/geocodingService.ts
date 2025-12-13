import { getPool, getSqlite, useSqlite } from '../config/database.js';
import { env } from '../config/env.js';
import { appendFileSync } from 'fs';

// Log public Photon queries for analysis
function logPublicPhotonQuery(query: string): void {
  try {
    const timestamp = new Date().toISOString();
    const logLine = `${timestamp}\t${query}\n`;
    appendFileSync('public-queries.log', logLine);
  } catch {
    // Ignore logging errors
  }
}

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  displayName: string;
}

export interface GeocodeSuggestion {
  latitude: number;
  longitude: number;
  displayName: string;
  type: string; // city, state, country, etc.
}

interface PhotonFeature {
  geometry: {
    coordinates: [number, number]; // [lon, lat]
  };
  properties: {
    osm_id?: number;
    osm_type?: string;
    osm_key?: string;
    osm_value?: string; // e.g., "city", "town", "village"
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    type?: string;
  };
}

// Photon document format for Elasticsearch indexing
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

interface PhotonResponse {
  features: PhotonFeature[];
}

// Public Photon API as fallback for non-US queries
const PUBLIC_PHOTON_URL = 'https://photon.komoot.io';

// Detect US ZIP codes (5 digits, optionally with 4-digit extension)
const US_ZIP_REGEX = /^\d{5}(-\d{4})?$/;

// Elasticsearch URL for indexing (Photon uses ES internally on port 9200)
// Derived from PHOTON_URL by replacing port 2322 with 9200
function getElasticsearchUrl(): string {
  return env.PHOTON_URL.replace(':2322', ':9200');
}

// Convert a Photon feature to a document for indexing
function featureToPhotonDocument(feature: PhotonFeature, query: string): PhotonDocument {
  const props = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;
  const osmValue = props.osm_value || props.type || 'place';

  // Use query as English name if the default name uses non-Latin characters
  const defaultName = props.name || query;
  const hasNonLatin = /[^\u0000-\u007F]/.test(defaultName);

  const doc: PhotonDocument = {
    osm_id: props.osm_id || Math.floor(Math.random() * 100000000) + 700000000,
    osm_type: props.osm_type?.charAt(0).toUpperCase() || 'N',
    osm_key: props.osm_key || 'place',
    osm_value: osmValue,
    type: osmValue,
    importance: 0.5,
    name: hasNonLatin
      ? { default: query, en: query }  // Use query as default for non-Latin names
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

// Index a Photon feature into local Elasticsearch
async function indexFeatureToLocalPhoton(feature: PhotonFeature, query: string): Promise<void> {
  try {
    const esUrl = getElasticsearchUrl();
    const doc = featureToPhotonDocument(feature, query);

    // Index the document using ES 5.x API (requires _type)
    const response = await fetch(`${esUrl}/photon/place/${doc.osm_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });

    if (response.ok) {
      console.log(`Indexed location to local Photon: ${query} (osm_id: ${doc.osm_id})`);
    } else {
      console.error(`Failed to index to local Photon: ${response.status}`);
    }
  } catch (error) {
    // Don't fail the request if indexing fails - it's just a cache optimization
    console.error('Error indexing to local Photon:', error);
  }
}

// Helper to call a Photon API endpoint
async function callPhotonApi(baseUrl: string, query: string, limit: number, osmTag?: string): Promise<PhotonResponse> {
  const url = new URL(`${baseUrl}/api`);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  if (osmTag) {
    url.searchParams.set('osm_tag', osmTag);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Photon API error: ${response.status}`);
  }
  return response.json() as Promise<PhotonResponse>;
}

// Try self-hosted Photon first, fall back to public API
async function callPhotonWithFallback(query: string, limit: number, osmTag?: string): Promise<PhotonResponse> {
  // Try self-hosted first
  try {
    const result = await callPhotonApi(env.PHOTON_URL, query, limit, osmTag);
    // If we got results, return them
    if (result.features.length > 0) {
      return result;
    }
    // No results from self-hosted (might be non-US query), try public
  } catch {
    // Self-hosted failed, try public fallback
  }

  // Fallback to public Photon API
  try {
    logPublicPhotonQuery(query);
    const result = await callPhotonApi(PUBLIC_PHOTON_URL, query, limit, osmTag);

    // If we got results from public Photon, index them to local Photon
    // so future queries will find them locally
    if (result.features.length > 0) {
      // Index in background - don't block the response
      indexFeatureToLocalPhoton(result.features[0], query).catch(() => {});
    }

    return result;
  } catch {
    // Both failed, return empty
    return { features: [] };
  }
}

// Check cache for geocoded location
async function getCachedGeocode(query: string): Promise<GeocodeResult | null> {
  const normalizedQuery = query.toLowerCase().trim();

  if (useSqlite()) {
    const db = getSqlite();
    const row = db.prepare(
      'SELECT latitude, longitude, display_name FROM geocache WHERE query = ?'
    ).get(normalizedQuery) as { latitude: number; longitude: number; display_name: string } | undefined;

    if (row) {
      return {
        latitude: row.latitude,
        longitude: row.longitude,
        displayName: row.display_name,
      };
    }
    return null;
  } else {
    const pool = getPool();
    const result = await pool.query(
      'SELECT latitude, longitude, display_name FROM geocache WHERE query = $1',
      [normalizedQuery]
    );

    if (result.rows.length > 0) {
      return {
        latitude: result.rows[0].latitude,
        longitude: result.rows[0].longitude,
        displayName: result.rows[0].display_name,
      };
    }
    return null;
  }
}

// Save geocoded location to cache
async function cacheGeocode(query: string, result: GeocodeResult): Promise<void> {
  const normalizedQuery = query.toLowerCase().trim();

  if (useSqlite()) {
    const db = getSqlite();
    db.prepare(
      'INSERT OR REPLACE INTO geocache (query, latitude, longitude, display_name) VALUES (?, ?, ?, ?)'
    ).run(normalizedQuery, result.latitude, result.longitude, result.displayName);
  } else {
    const pool = getPool();
    await pool.query(
      `INSERT INTO geocache (query, latitude, longitude, display_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (query) DO UPDATE SET
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         display_name = EXCLUDED.display_name`,
      [normalizedQuery, result.latitude, result.longitude, result.displayName]
    );
  }
}

// Geocode a city/location using Photon API (with fallback)
export async function geocodeCity(query: string): Promise<GeocodeResult | null> {
  // Check cache first
  const cached = await getCachedGeocode(query);
  if (cached) {
    return cached;
  }

  const trimmedQuery = query.trim();

  // If query looks like a ZIP code, search specifically for postcodes
  const isZipCode = US_ZIP_REGEX.test(trimmedQuery);
  const osmTag = isZipCode ? 'place:postcode' : undefined;

  const data = await callPhotonWithFallback(trimmedQuery, 1, osmTag);

  if (data.features.length === 0) {
    return null;
  }

  const feature = data.features[0];
  const [lon, lat] = feature.geometry.coordinates;
  const props = feature.properties;

  // Build display name from properties
  const displayParts = [props.name, props.city, props.state, props.country].filter(Boolean);
  const displayName = displayParts.join(', ') || query;

  const result: GeocodeResult = {
    latitude: lat,
    longitude: lon,
    displayName,
  };

  // Cache the result
  await cacheGeocode(query, result);

  return result;
}

// Get autocomplete suggestions - local Photon only (no public fallback to avoid rate limits)
// Public Photon is only used when user clicks Search without selecting from autocomplete
export async function geocodeSuggestions(query: string, limit = 5): Promise<GeocodeSuggestion[]> {
  if (!query || query.length < 2) {
    return [];
  }

  const trimmedQuery = query.trim();

  // If query looks like a ZIP code, search specifically for postcodes
  const isZipCode = US_ZIP_REGEX.test(trimmedQuery);
  const osmTag = isZipCode ? 'place:postcode' : 'place';

  // Only use local Photon - no public fallback for suggestions
  let data: PhotonResponse;
  try {
    data = await callPhotonApi(env.PHOTON_URL, trimmedQuery, limit, osmTag);
  } catch {
    // Local Photon failed, return empty (no suggestions)
    return [];
  }

  return data.features.map((feature) => {
    const [lon, lat] = feature.geometry.coordinates;
    const props = feature.properties;

    // Build display name from properties
    const displayParts = [props.name, props.city, props.state, props.country].filter(Boolean);
    // Remove duplicates (e.g., when name === city)
    const uniqueParts = [...new Set(displayParts)];
    const displayName = uniqueParts.join(', ') || query;

    return {
      latitude: lat,
      longitude: lon,
      displayName,
      type: props.osm_value || props.type || 'place',
    };
  });
}
