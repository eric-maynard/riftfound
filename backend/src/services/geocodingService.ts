import { getPool, getSqlite, useSqlite, addToPhotonQueue } from '../config/database.js';
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
    county?: string;
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

// Non-US country indicators - if query contains these, skip local Photon (US-only) and go to public
const NON_US_INDICATORS = [
  'uk', 'united kingdom', 'england', 'scotland', 'wales', 'ireland',
  'canada', 'australia', 'germany', 'france', 'spain', 'italy', 'japan',
  'mexico', 'brazil', 'india', 'china', 'netherlands', 'belgium', 'sweden',
  'norway', 'denmark', 'finland', 'poland', 'austria', 'switzerland',
  'portugal', 'greece', 'new zealand', 'south africa', 'singapore',
];

// Check if query appears to be for a non-US location
function isNonUsQuery(query: string): boolean {
  const lowerQuery = query.toLowerCase();
  return NON_US_INDICATORS.some(indicator => {
    const regex = new RegExp(`\\b${indicator}\\b`);
    return regex.test(lowerQuery);
  });
}

// Detect US ZIP codes (5 digits only - we only store 5-digit ZIPs)
const US_ZIP_REGEX = /^\d{5}$/;

// Lookup ZIP code from us_zipcodes table
interface ZipCodeResult {
  zipcode: string;
  city: string;
  state: string;
  state_code: string;
  latitude: number;
  longitude: number;
}

function lookupZipCode(zipcode: string): ZipCodeResult | null {
  if (useSqlite()) {
    const db = getSqlite();
    const row = db.prepare(
      'SELECT zipcode, city, state, state_code, latitude, longitude FROM us_zipcodes WHERE zipcode = ?'
    ).get(zipcode) as ZipCodeResult | undefined;
    return row || null;
  } else {
    // PostgreSQL - would need async, but for now we only use SQLite in prod
    return null;
  }
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

// Place-level types that are worth indexing to local Photon
// We don't want to index addresses, businesses, landmarks, etc. - only actual places
const INDEXABLE_PLACE_TYPES = new Set([
  'city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'borough',
  'county', 'district', 'state', 'province', 'region', 'country',
  'municipality', 'locality',
]);

// Check if a feature is a place-level result worth indexing
function isIndexablePlace(feature: PhotonFeature): boolean {
  const props = feature.properties;
  const featureType = props.type || props.osm_value || '';
  return INDEXABLE_PLACE_TYPES.has(featureType.toLowerCase());
}

// Queue a Photon feature for batch import
async function indexFeatureToLocalPhoton(feature: PhotonFeature, query: string): Promise<void> {
  // Only index place-level results (cities, towns, counties, etc.)
  // Skip addresses, businesses, landmarks, POIs, etc.
  if (!isIndexablePlace(feature)) {
    const featureType = feature.properties.type || feature.properties.osm_value || 'unknown';
    console.log(`Skipping queue for non-place result: ${query} (type: ${featureType})`);
    return;
  }

  try {
    const doc = featureToPhotonDocument(feature, query);

    // Add to queue for batch import (scraper will process it)
    addToPhotonQueue(doc.osm_id, doc);
    console.log(`Queued location for Photon import: ${query} (osm_id: ${doc.osm_id})`);
  } catch (error) {
    // Don't fail the request if queueing fails - it's just a cache optimization
    console.error('Error queueing to Photon:', error);
  }
}

// Extract a place-level location from a non-place result's properties
// e.g., "SATO UK" (industrial) has county: "Essex", country: "United Kingdom"
// We can create a synthetic place document for "Essex, United Kingdom"
function extractPlaceFromProperties(feature: PhotonFeature, query: string): PhotonDocument | null {
  const props = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;

  // Try to find the most specific place-level property
  // Priority: city > county > state > country
  let placeName: string | undefined;
  let placeType: string;

  if (props.city) {
    placeName = props.city;
    placeType = 'city';
  } else if (props.county) {
    placeName = props.county;
    placeType = 'county';
  } else if (props.state) {
    placeName = props.state;
    placeType = 'state';
  } else if (props.country) {
    placeName = props.country;
    placeType = 'country';
  } else {
    return null;
  }

  // Build display name
  const displayParts = [placeName];
  if (placeType !== 'state' && props.state) displayParts.push(props.state);
  if (placeType !== 'country' && props.country) displayParts.push(props.country);

  const doc: PhotonDocument = {
    osm_id: Math.floor(Math.random() * 100000000) + 800000000,
    osm_type: 'N',
    osm_key: 'place',
    osm_value: placeType,
    type: placeType,
    importance: 0.5,
    name: { default: placeName },
    coordinate: { lat, lon },
    countrycode: (props.countrycode || '').toUpperCase(),
    context: {},
  };

  if (props.country) doc.country = { default: props.country };
  if (props.state && placeType !== 'state') doc.state = { default: props.state };

  return doc;
}

// Queue a synthetic place document extracted from a non-place result
async function indexExtractedPlace(feature: PhotonFeature, query: string): Promise<void> {
  const doc = extractPlaceFromProperties(feature, query);
  if (!doc) {
    console.log(`Could not extract place from result for: ${query}`);
    return;
  }

  try {
    // Add to queue for batch import (scraper will process it)
    addToPhotonQueue(doc.osm_id, doc);
    console.log(`Queued extracted place for Photon import: "${doc.name.default}" from query "${query}"`);
  } catch (error) {
    console.error('Error queueing extracted place:', error);
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
  // Skip local Photon for non-US queries (local Photon only has US data)
  const skipLocal = isNonUsQuery(query);

  // Try self-hosted first (unless query is clearly non-US)
  if (!skipLocal) {
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
  }

  // Fallback to public Photon API
  try {
    logPublicPhotonQuery(query);
    const result = await callPhotonApi(PUBLIC_PHOTON_URL, query, limit, osmTag);

    // If we got results, index for future autocomplete
    if (result.features.length > 0) {
      const feature = result.features[0];
      if (isIndexablePlace(feature)) {
        // Result is already a place (city/county/etc) - index it directly
        indexFeatureToLocalPhoton(feature, query).catch(() => {});
      } else {
        // Result is not a place (industrial/shop/etc) - extract place from its location properties
        // e.g., "SATO UK" has county: "Essex" we can index
        indexExtractedPlace(feature, query).catch(() => {});
      }
    }

    return result;
  } catch {
    // Both failed, return empty
    return { features: [] };
  }
}

// ============================================================================
// Google Maps API Functions
// ============================================================================

const GOOGLE_MAPS_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const GOOGLE_PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';

interface GoogleGeocodeResult {
  formatted_address: string;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
  address_components: Array<{
    long_name: string;
    short_name: string;
    types: string[];
  }>;
}

interface GoogleGeocodeResponse {
  status: string;
  results: GoogleGeocodeResult[];
}

// Places API (New) response types
interface PlacesAutocompleteSuggestion {
  placePrediction?: {
    placeId: string;
    text: {
      text: string;
    };
    structuredFormat?: {
      mainText: { text: string };
      secondaryText?: { text: string };
    };
    types: string[];
  };
}

interface PlacesAutocompleteResponse {
  suggestions: PlacesAutocompleteSuggestion[];
}

interface PlaceDetailsResponse {
  location: {
    latitude: number;
    longitude: number;
  };
  displayName: {
    text: string;
  };
}

// Check if Google Maps API is available
function hasGoogleMapsApiKey(): boolean {
  return Boolean(env.GOOGLE_MAPS_API_KEY);
}

// Check if local Photon is enabled
function isPhotonEnabled(): boolean {
  return env.PHOTON_ENABLED;
}

// Forward geocode using Google Maps API
async function callGoogleMapsGeocode(query: string): Promise<GeocodeResult | null> {
  if (!env.GOOGLE_MAPS_API_KEY) return null;

  try {
    const url = new URL(GOOGLE_MAPS_GEOCODE_URL);
    url.searchParams.set('address', query);
    url.searchParams.set('key', env.GOOGLE_MAPS_API_KEY);

    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error(`Google Maps geocode error: ${response.status}`);
      return null;
    }

    const data = await response.json() as GoogleGeocodeResponse;
    if (data.status !== 'OK' || data.results.length === 0) {
      return null;
    }

    const result = data.results[0];
    return {
      latitude: result.geometry.location.lat,
      longitude: result.geometry.location.lng,
      displayName: result.formatted_address,
    };
  } catch (error) {
    console.error('Google Maps geocode failed:', error);
    return null;
  }
}

// Reverse geocode using Google Maps API
async function callGoogleMapsReverse(lat: number, lon: number): Promise<GeocodeResult | null> {
  if (!env.GOOGLE_MAPS_API_KEY) return null;

  try {
    const url = new URL(GOOGLE_MAPS_GEOCODE_URL);
    url.searchParams.set('latlng', `${lat},${lon}`);
    url.searchParams.set('key', env.GOOGLE_MAPS_API_KEY);

    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error(`Google Maps reverse geocode error: ${response.status}`);
      return null;
    }

    const data = await response.json() as GoogleGeocodeResponse;
    if (data.status !== 'OK' || data.results.length === 0) {
      return null;
    }

    const result = data.results[0];
    // Extract city/state for cleaner display
    const components = result.address_components;
    const city = components.find(c => c.types.includes('locality'))?.long_name;
    const state = components.find(c => c.types.includes('administrative_area_level_1'))?.short_name;
    const country = components.find(c => c.types.includes('country'))?.long_name;

    let displayName: string;
    if (city && state) {
      displayName = `${city}, ${state}`;
    } else if (city && country) {
      displayName = `${city}, ${country}`;
    } else {
      displayName = result.formatted_address;
    }

    return {
      latitude: lat,
      longitude: lon,
      displayName,
    };
  } catch (error) {
    console.error('Google Maps reverse geocode failed:', error);
    return null;
  }
}

// Get autocomplete suggestions using Google Places API (New)
async function callGoogleMapsAutocomplete(query: string, limit: number): Promise<GeocodeSuggestion[]> {
  if (!env.GOOGLE_MAPS_API_KEY) return [];

  try {
    const response = await fetch(GOOGLE_PLACES_AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
      },
      body: JSON.stringify({
        input: query,
        includedPrimaryTypes: ['locality', 'administrative_area_level_1', 'administrative_area_level_2'],
      }),
    });

    if (!response.ok) {
      console.error(`Google Places autocomplete error: ${response.status}`);
      return [];
    }

    const data = await response.json() as PlacesAutocompleteResponse;
    if (!data.suggestions || data.suggestions.length === 0) {
      return [];
    }

    // Limit predictions and fetch details for each to get coordinates
    const predictions = data.suggestions.slice(0, limit);
    const suggestions: GeocodeSuggestion[] = [];

    for (const suggestion of predictions) {
      if (!suggestion.placePrediction) continue;

      const details = await fetchPlaceDetails(suggestion.placePrediction.placeId);
      if (details) {
        const displayName = suggestion.placePrediction.text.text;
        const types = suggestion.placePrediction.types || [];
        suggestions.push({
          latitude: details.lat,
          longitude: details.lng,
          displayName,
          type: types.includes('locality') ? 'city' : 'place',
        });
      }
    }

    return suggestions;
  } catch (error) {
    console.error('Google Places autocomplete failed:', error);
    return [];
  }
}

// Fetch place details to get coordinates using Places API (New)
async function fetchPlaceDetails(placeId: string): Promise<{ lat: number; lng: number } | null> {
  if (!env.GOOGLE_MAPS_API_KEY) return null;

  try {
    const url = `https://places.googleapis.com/v1/places/${placeId}`;
    const response = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'location',
      },
    });

    if (!response.ok) return null;

    const data = await response.json() as PlaceDetailsResponse;
    if (!data.location) return null;

    return {
      lat: data.location.latitude,
      lng: data.location.longitude,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Cache Functions
// ============================================================================

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

// Geocode a city/location
// Precedence: ZIP lookup → cache → Google Maps → local Photon → public Photon
export async function geocodeCity(query: string): Promise<GeocodeResult | null> {
  const trimmedQuery = query.trim();

  // For 5-digit ZIP codes, check our local table first (most reliable)
  if (US_ZIP_REGEX.test(trimmedQuery)) {
    const zipResult = lookupZipCode(trimmedQuery);
    if (zipResult) {
      return {
        latitude: zipResult.latitude,
        longitude: zipResult.longitude,
        displayName: `${zipResult.city}, ${zipResult.state_code} ${zipResult.zipcode}`,
      };
    }
    // ZIP not found in our table, fall through to geocoding
  }

  // Check cache for non-ZIP queries
  const cached = await getCachedGeocode(query);
  if (cached) {
    return cached;
  }

  // Try Google Maps API first (if available)
  if (hasGoogleMapsApiKey()) {
    const googleResult = await callGoogleMapsGeocode(trimmedQuery);
    if (googleResult) {
      await cacheGeocode(query, googleResult);
      return googleResult;
    }
  }

  // Fall back to Photon (if enabled) with public fallback
  if (isPhotonEnabled()) {
    const data = await callPhotonWithFallback(trimmedQuery, 1);

    if (data.features.length > 0) {
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
  } else {
    // Photon disabled, try public Photon as last resort
    try {
      logPublicPhotonQuery(query);
      const data = await callPhotonApi(PUBLIC_PHOTON_URL, trimmedQuery, 1);
      if (data.features.length > 0) {
        const feature = data.features[0];
        const [lon, lat] = feature.geometry.coordinates;
        const props = feature.properties;

        const displayParts = [props.name, props.city, props.state, props.country].filter(Boolean);
        const displayName = displayParts.join(', ') || query;

        const result: GeocodeResult = {
          latitude: lat,
          longitude: lon,
          displayName,
        };

        await cacheGeocode(query, result);
        return result;
      }
    } catch {
      // Public Photon failed
    }
  }

  return null;
}

// Get autocomplete suggestions
// Precedence: ZIP lookup → Google Places (if available) → local Photon (if enabled)
export async function geocodeSuggestions(query: string, limit = 5): Promise<GeocodeSuggestion[]> {
  if (!query || query.length < 2) {
    return [];
  }

  const trimmedQuery = query.trim();

  // For exact 5-digit ZIP codes, return from our local table
  if (US_ZIP_REGEX.test(trimmedQuery)) {
    const zipResult = lookupZipCode(trimmedQuery);
    if (zipResult) {
      return [{
        latitude: zipResult.latitude,
        longitude: zipResult.longitude,
        displayName: `${zipResult.city}, ${zipResult.state_code} ${zipResult.zipcode}`,
        type: 'postcode',
      }];
    }
    // ZIP not found, return empty (don't fall through for ZIPs)
    return [];
  }

  // Try Google Places API first (if available)
  if (hasGoogleMapsApiKey()) {
    const googleSuggestions = await callGoogleMapsAutocomplete(trimmedQuery, limit);
    if (googleSuggestions.length > 0) {
      return googleSuggestions;
    }
  }

  // Fall back to local Photon (if enabled)
  if (!isPhotonEnabled()) {
    return [];
  }

  let data: PhotonResponse;
  try {
    data = await callPhotonApi(env.PHOTON_URL, trimmedQuery, limit, 'place');
  } catch {
    // Local Photon failed, return empty (no suggestions)
    return [];
  }

  const suggestions = data.features.map((feature) => {
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

  // Deduplicate by displayName + type (e.g., "New York" city vs state, "Milano" city vs region)
  const seen = new Set<string>();
  return suggestions.filter(s => {
    const key = `${s.displayName}|${s.type}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// Reverse geocode coordinates to get location name
// Precedence: Google Maps → local Photon (if enabled) → public Photon
export async function reverseGeocode(lat: number, lon: number): Promise<GeocodeResult | null> {
  // Try Google Maps API first (if available)
  if (hasGoogleMapsApiKey()) {
    const googleResult = await callGoogleMapsReverse(lat, lon);
    if (googleResult) {
      return googleResult;
    }
  }

  // Try self-hosted Photon (if enabled)
  if (isPhotonEnabled()) {
    try {
      const url = new URL(`${env.PHOTON_URL}/reverse`);
      url.searchParams.set('lat', String(lat));
      url.searchParams.set('lon', String(lon));

      const response = await fetch(url.toString());
      if (response.ok) {
        const data = await response.json() as PhotonResponse;
        if (data.features.length > 0) {
          const feature = data.features[0];
          const props = feature.properties;

          // Build display name from properties
          const displayParts = [props.name, props.city, props.state, props.country].filter(Boolean);
          // Remove duplicates (e.g., when name === city)
          const uniqueParts = [...new Set(displayParts)];
          const displayName = uniqueParts.join(', ') || 'Unknown Location';

          return {
            latitude: lat,
            longitude: lon,
            displayName,
          };
        }
      }
    } catch {
      // Self-hosted failed, try public fallback
    }
  }

  // Fallback to public Photon API
  try {
    logPublicPhotonQuery(`reverse:${lat},${lon}`);
    const url = new URL(`${PUBLIC_PHOTON_URL}/reverse`);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Public Photon reverse API error: ${response.status}`);
    }

    const data = await response.json() as PhotonResponse;
    if (data.features.length === 0) {
      return null;
    }

    const feature = data.features[0];
    const props = feature.properties;

    // Build display name from properties
    const displayParts = [props.name, props.city, props.state, props.country].filter(Boolean);
    // Remove duplicates (e.g., when name === city)
    const uniqueParts = [...new Set(displayParts)];
    const displayName = uniqueParts.join(', ') || 'Unknown Location';

    // If we got a place-level result and Photon is enabled, index it for future autocomplete
    if (isPhotonEnabled() && isIndexablePlace(feature)) {
      indexFeatureToLocalPhoton(feature, displayName).catch(() => {});
    }

    return {
      latitude: lat,
      longitude: lon,
      displayName,
    };
  } catch {
    // All methods failed, return null
    return null;
  }
}
