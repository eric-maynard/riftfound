import { getShopsToGeocode, updateShopGeocode, type Shop } from './database.js';
import { env } from './config.js';

// Photon has no rate limit when self-hosted, but we add a small delay for safety
const RATE_LIMIT_MS = 100;

interface PhotonFeature {
  geometry: {
    coordinates: [number, number]; // [lon, lat]
  };
  properties: {
    name?: string;
    city?: string;
    country?: string;
  };
}

interface PhotonResponse {
  features: PhotonFeature[];
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocodeLocation(locationText: string): Promise<{ latitude: number; longitude: number } | null> {
  const url = new URL(`${env.PHOTON_URL}/api`);
  url.searchParams.set('q', locationText);
  url.searchParams.set('limit', '1');

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Photon API error: ${response.status}`);
  }

  const data = await response.json() as PhotonResponse;

  if (data.features.length === 0) {
    return null;
  }

  const [lon, lat] = data.features[0].geometry.coordinates;
  return {
    latitude: lat,
    longitude: lon,
  };
}

export async function processGeocodingQueue(): Promise<{ processed: number; succeeded: number; failed: number }> {
  const shops = getShopsToGeocode();

  if (shops.length === 0) {
    console.log('No shops to geocode');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  console.log(`Processing ${shops.length} shops in geocoding queue...`);

  let succeeded = 0;
  let failed = 0;

  for (const shop of shops) {
    try {
      console.log(`  Geocoding: ${shop.name} - "${shop.locationText}"`);

      const result = await geocodeLocation(shop.locationText!);

      if (result) {
        updateShopGeocode(shop.id, result);
        console.log(`    -> ${result.latitude}, ${result.longitude}`);
        succeeded++;
      } else {
        updateShopGeocode(shop.id, { error: 'No results found' });
        console.log(`    -> No results found`);
        failed++;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      updateShopGeocode(shop.id, { error: errorMessage });
      console.log(`    -> Error: ${errorMessage}`);
      failed++;
    }

    // Rate limit
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`Geocoding complete: ${succeeded} succeeded, ${failed} failed`);

  return {
    processed: shops.length,
    succeeded,
    failed,
  };
}
