import { getPool, getSqlite, useSqlite } from '../config/database.js';
import { env } from '../config/env.js';

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
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    osm_value?: string; // e.g., "city", "town", "village"
    type?: string;
  };
}

interface PhotonResponse {
  features: PhotonFeature[];
}

// Public Photon API as fallback for non-US queries
const PUBLIC_PHOTON_URL = 'https://photon.komoot.io';

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
    return await callPhotonApi(PUBLIC_PHOTON_URL, query, limit, osmTag);
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

  const data = await callPhotonWithFallback(query, 1);

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

  // Only use local Photon - no public fallback for suggestions
  let data: PhotonResponse;
  try {
    data = await callPhotonApi(env.PHOTON_URL, query, limit, 'place');
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
