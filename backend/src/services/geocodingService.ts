import { getPool, getSqlite, useSqlite } from '../config/database.js';
import { env } from '../config/env.js';

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  displayName: string;
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
  };
}

interface PhotonResponse {
  features: PhotonFeature[];
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

// Geocode a city/location using Photon API
export async function geocodeCity(query: string): Promise<GeocodeResult | null> {
  // Check cache first
  const cached = await getCachedGeocode(query);
  if (cached) {
    return cached;
  }

  // Call Photon API
  const url = new URL(`${env.PHOTON_URL}/api`);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '1');

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Photon API error: ${response.status}`);
  }

  const data = await response.json() as PhotonResponse;

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
