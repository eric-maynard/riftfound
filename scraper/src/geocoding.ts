/**
 * Geocoding utilities for the scraper.
 * Uses local Photon first, falls back to public Photon with rate limiting.
 */

import { env } from './config.js';

const PUBLIC_PHOTON_URL = 'https://photon.komoot.io';
const LOCAL_PHOTON_URL = env.PHOTON_URL || 'http://localhost:2322';
const RATE_LIMIT_MS = 1100; // ~1 request per second for public Photon

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    countrycode?: string;
  };
}

interface PhotonResponse {
  features: PhotonFeature[];
}

// Rate limiting for public Photon
let lastPublicRequest = 0;

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastPublicRequest;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastPublicRequest = Date.now();
}

/**
 * Reverse geocode coordinates to get city name.
 * Tries local Photon first, falls back to public Photon with rate limiting.
 * Returns the city name or null if not found.
 */
export async function reverseGeocodeCity(lat: number, lon: number): Promise<string | null> {
  // Try local Photon first
  try {
    const localResult = await callReverseGeocode(LOCAL_PHOTON_URL, lat, lon);
    if (localResult) {
      return localResult;
    }
  } catch {
    // Local Photon failed or unavailable
  }

  // Fall back to public Photon with rate limiting
  try {
    await waitForRateLimit();
    const publicResult = await callReverseGeocode(PUBLIC_PHOTON_URL, lat, lon);
    if (publicResult) {
      // Try to index this location to local Photon for future use
      await indexToLocalPhoton(lat, lon, publicResult).catch(() => {});
      return publicResult;
    }
  } catch (error) {
    console.error(`Reverse geocode failed for ${lat},${lon}:`, error);
  }

  return null;
}

async function callReverseGeocode(baseUrl: string, lat: number, lon: number): Promise<string | null> {
  const url = `${baseUrl}/reverse?lat=${lat}&lon=${lon}`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Riftfound/1.0 (Scraper)' },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data: PhotonResponse = await response.json();
  if (data.features.length === 0) {
    return null;
  }

  const props = data.features[0].properties;

  // Build city display name
  // Prefer city, fall back to name (for small towns), then state
  const cityName = props.city || props.name;
  const country = props.country;
  const countrycode = props.countrycode?.toUpperCase();

  if (!cityName) {
    return null;
  }

  // Format: "City, Country" or "City, State" for US
  if (countrycode === 'US' && props.state) {
    return `${cityName}, ${props.state}`;
  } else if (country) {
    return `${cityName}, ${country}`;
  }

  return cityName;
}

async function indexToLocalPhoton(lat: number, lon: number, cityName: string): Promise<void> {
  // Get Elasticsearch URL from Photon URL
  const esUrl = LOCAL_PHOTON_URL.replace(':2322', ':9200');

  // Create a simple document for this location
  const doc = {
    osm_id: Math.floor(Math.random() * 100000000) + 900000000,
    osm_type: 'N',
    osm_key: 'place',
    osm_value: 'city',
    type: 'city',
    importance: 0.5,
    name: { default: cityName },
    coordinate: { lat, lon },
    countrycode: '',
    context: {},
  };

  try {
    const response = await fetch(`${esUrl}/photon/place/${doc.osm_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });

    if (!response.ok) {
      console.error(`Failed to index to local Photon: ${response.status}`);
    }
  } catch (error) {
    // Silently fail - this is just a cache optimization
  }
}

/**
 * Queue for stores that need city geocoding.
 * Processes one store at a time with rate limiting.
 */
const geocodeQueue: Array<{ lat: number; lon: number; callback: (city: string | null) => void }> = [];
let isProcessingQueue = false;

export function queueCityGeocode(lat: number, lon: number): Promise<string | null> {
  return new Promise((resolve) => {
    geocodeQueue.push({ lat, lon, callback: resolve });
    processQueue();
  });
}

async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (geocodeQueue.length > 0) {
    const item = geocodeQueue.shift()!;
    const city = await reverseGeocodeCity(item.lat, item.lon);
    item.callback(city);
  }

  isProcessingQueue = false;
}
