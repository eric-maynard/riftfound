/**
 * Geocoding utilities for the scraper.
 * Uses local Photon first, falls back to public Photon with rate limiting.
 */

import { env } from './config.js';
import { addToPhotonQueue } from './database.js';

const PUBLIC_PHOTON_URL = 'https://photon.komoot.io';
const LOCAL_PHOTON_URL = env.PHOTON_URL || 'http://localhost:2322';
const RATE_LIMIT_MS = 1100; // ~1 request per second for public Photon

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    city?: string;
    county?: string;
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
    const localFeature = await callReverseGeocode(LOCAL_PHOTON_URL, lat, lon);
    if (localFeature) {
      return formatCityName(localFeature.properties);
    }
  } catch {
    // Local Photon failed or unavailable
  }

  // Fall back to public Photon with rate limiting
  try {
    await waitForRateLimit();
    const publicFeature = await callReverseGeocode(PUBLIC_PHOTON_URL, lat, lon);
    if (publicFeature) {
      // Index city AND county to local Photon for future forward searches
      await indexFeatureToLocalPhoton(publicFeature).catch(() => {});
      return formatCityName(publicFeature.properties);
    }
  } catch (error) {
    console.error(`Reverse geocode failed for ${lat},${lon}:`, error);
  }

  return null;
}

async function callReverseGeocode(baseUrl: string, lat: number, lon: number): Promise<PhotonFeature | null> {
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

  return data.features[0];
}

function formatCityName(props: PhotonFeature['properties']): string | null {
  // Build city display name
  // Prefer city, fall back to name (for small towns)
  const cityName = props.city || props.name;
  const country = props.country;
  const countrycode = props.countrycode?.toUpperCase();

  if (!cityName) {
    return null;
  }

  // Format: "City, State" for US, "City, Country" for others
  if (countrycode === 'US' && props.state) {
    return `${cityName}, ${props.state}`;
  } else if (country) {
    return `${cityName}, ${country}`;
  }

  return cityName;
}

// Queue a reverse geocode result for batch import to local Photon
// Queues both the city AND county (if present) so searches for either will work
async function indexFeatureToLocalPhoton(feature: PhotonFeature): Promise<void> {
  const props = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;

  const docsToIndex: Array<{
    name: string;
    type: string;
  }> = [];

  // Index the city if present
  if (props.city) {
    docsToIndex.push({ name: props.city, type: 'city' });
  } else if (props.name) {
    // Small town without city property
    docsToIndex.push({ name: props.name, type: 'town' });
  }

  // Also index the county if present (so "essex" searches work)
  if (props.county) {
    docsToIndex.push({ name: props.county, type: 'county' });
  }

  for (const { name, type } of docsToIndex) {
    const osmId = Math.floor(Math.random() * 100000000) + 900000000;
    const doc = {
      osm_id: osmId,
      osm_type: 'N',
      osm_key: 'place',
      osm_value: type,
      type: type,
      importance: 0.5,
      name: { default: name },
      coordinate: { lat, lon },
      countrycode: (props.countrycode || '').toUpperCase(),
      country: props.country ? { default: props.country } : undefined,
      state: props.state ? { default: props.state } : undefined,
      context: {},
    };

    try {
      // Add to queue for batch import (will be processed at start of scraper loop)
      addToPhotonQueue(osmId, doc);
    } catch {
      // Silently fail - this is just a cache optimization
    }
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
