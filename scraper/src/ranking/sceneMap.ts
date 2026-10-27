/**
 * Giving a scene a place on a map.
 *
 * ## What this answers, and what it refuses to
 *
 * A scene - a connected component of the co-play graph - has no coordinates of
 * its own. It is a set of players, and a player is not a location. What *does*
 * have coordinates is the venue each of its matches was played at, and
 * `findComponents` now carries those out of the replay as `Component.venues`
 * (see the note on `ComponentVenue` for why that is the only place the join is
 * affordable).
 *
 * So this module turns "the venues this scene plays at, weighted by how much
 * play each carries" into one published place. Three numbers, and the third is
 * the one that keeps the first two honest:
 *
 * - **a centroid**, weighted by matches played, so a scene sits where its play
 *   happens rather than at the midpoint of its outliers;
 * - **a count** of the venues that were locatable at all, beside the total, so
 *   a reader is never shown a pin derived from 2 of 40 stores as though it
 *   described the scene;
 * - **a spread** in kilometres - the match-weighted mean distance from the
 *   centroid - because a single pin asserts a precision a scene does not
 *   always have. Measured on the complete California sample, the largest
 *   community had a 133km mean venue spread: a corridor, not a city. A map
 *   that drew that as a dot would be lying; one that draws it as a 133km disc
 *   is telling the truth about it.
 *
 * ## It never guesses
 *
 * A scene whose venues carry no coordinates comes back with
 * `latitude: null` / `longitude: null` and `locatedVenues: 0`, and the API and
 * UI are required to show it as unlocated or leave it off. Three specific
 * refusals, all of them reachable with real data:
 *
 * 1. **No located venue, no centroid.** Not the region label's city, not the
 *    first venue that happens to have a geocode, not `0, 0`.
 * 2. **A `geo:` venue key is still evidence, but never an identity.** The key
 *    rounds coordinates to ~1km, which `scenes.ts` rightly refuses to use as a
 *    durable *id* - but the underlying event coordinates are real, and
 *    averaging them is exactly what this does. So an unresolved organizer
 *    contributes its position and no id, rather than being dropped.
 * 3. **An antipodal cancellation yields no centroid.** Averaging unit vectors
 *    is correct across the antimeridian, where averaging degrees is not, but
 *    it degenerates when the weighted directions sum to roughly nothing - two
 *    equal halves on opposite sides of the planet. That is not a place, so
 *    nothing is published for it. It cannot happen for a real travel region
 *    (0 of 56,257 recorded games cross a scene, so a scene is reachable on the
 *    ground), and it is cheaper to handle than to argue about.
 *
 * ## Why a spherical mean and not a mean of degrees
 *
 * A mean of latitudes and longitudes is wrong in two places and both are
 * populated: a scene straddling the antimeridian (Fiji, Kiribati, the eastern
 * Russian stores) averages +179 and -179 to 0 and lands in the Gulf of
 * Guinea, and a mean of degrees over-weights high latitudes. Converting each
 * venue to a unit vector, taking the weighted mean and converting back is the
 * standard fix, it is eight lines, and it has no failure mode other than the
 * cancellation above.
 */

import type { ComponentVenue } from './graph.js';
import type { ScenePlace } from './items.js';

export type { ScenePlace, SceneMapVenue } from './items.js';

/** Mean Earth radius, km. Only ever used for the spread figure. */
const EARTH_RADIUS_KM = 6371.0088;

/**
 * Below this, the weighted direction sum is treated as cancelled and no
 * centroid is published.
 *
 * The resultant of unit vectors has length 1 when every venue is in the same
 * place and 0 when they cancel exactly. 1e-9 is float noise rather than a
 * tolerance: a genuinely spread-out-but-real scene (two venues 180 degrees of
 * longitude apart on the equator) resolves to ~0, and that *should* be
 * refused, so the threshold only has to be above the arithmetic's own error.
 */
const MIN_RESULTANT = 1e-9;

/**
 * How many venues a scene publishes for a zoomed-in map.
 *
 * Capped for the same reason `VENUE#.topPlayers` is: this rides on a catalogue
 * item read in full on every map load, and the long tail of one-night venues
 * is not what a map renders. Five is the number of pins a reader can take in
 * over one city before they stop being individual stores.
 */
export const DEFAULT_SCENE_MAP_TOP_VENUES = 5;

export interface ScenePlaceOptions {
  /** Venues published on the item. Default `DEFAULT_SCENE_MAP_TOP_VENUES`. */
  topVenues?: number;
}

/** A scene with nothing locatable about it. The honest empty answer. */
export function unlocatedPlace(): ScenePlace {
  return {
    latitude: null,
    longitude: null,
    spreadKm: null,
    nearestVenueKm: null,
    locatedVenues: 0,
    locatedMatches: 0,
    topVenues: [],
  };
}

/**
 * Locate one scene from the venues it plays at.
 *
 * Pure, and the only arithmetic in the chain: the venue tallies come out of
 * the replay (`findComponents`), this turns them into a place, and
 * `snapshot.ts` writes the result. Tested on its own in
 * `rankingSceneMap.test.ts`, including the antimeridian and the refusals.
 */
export function scenePlace(venues: ComponentVenue[], options: ScenePlaceOptions = {}): ScenePlace {
  const topCount = options.topVenues ?? DEFAULT_SCENE_MAP_TOP_VENUES;

  const located = venues.filter(
    (venue): venue is ComponentVenue & { latitude: number; longitude: number } =>
      venue.latitude !== null &&
      venue.longitude !== null &&
      Number.isFinite(venue.latitude) &&
      Number.isFinite(venue.longitude)
  );
  if (located.length === 0) return unlocatedPlace();

  // A venue that somehow recorded no match still has a position worth
  // averaging, so a zero weight floors at 1 rather than removing the venue.
  // This cannot happen off `findComponents`, which only creates a tally when
  // it counts a match, but `scenePlace` is also the function a report or a
  // test hands hand-built rows to.
  const weight = (venue: ComponentVenue): number => Math.max(1, venue.matchCount);

  let x = 0;
  let y = 0;
  let z = 0;
  let totalWeight = 0;
  for (const venue of located) {
    const w = weight(venue);
    const lat = toRadians(venue.latitude);
    const lon = toRadians(venue.longitude);
    const cosLat = Math.cos(lat);
    x += w * cosLat * Math.cos(lon);
    y += w * cosLat * Math.sin(lon);
    z += w * Math.sin(lat);
    totalWeight += w;
  }

  x /= totalWeight;
  y /= totalWeight;
  z /= totalWeight;

  // Refusal 3: the directions cancelled, so there is no centroid to publish.
  if (Math.hypot(x, y, z) < MIN_RESULTANT) return unlocatedPlace();

  const latitude = toDegrees(Math.atan2(z, Math.hypot(x, y)));
  const longitude = toDegrees(Math.atan2(y, x));

  let spreadWeighted = 0;
  let nearest = Infinity;
  for (const venue of located) {
    const distance = haversineKm(latitude, longitude, venue.latitude, venue.longitude);
    spreadWeighted += weight(venue) * distance;
    if (distance < nearest) nearest = distance;
  }

  return {
    // Six decimals is ~0.1m, which is far finer than anything upstream knows
    // and is only here so the published number does not carry 15 digits of
    // float noise into every reader's JSON.
    latitude: round(latitude, 6),
    longitude: round(longitude, 6),
    spreadKm: round(spreadWeighted / totalWeight, 1),
    nearestVenueKm: round(nearest, 1),
    locatedVenues: located.length,
    locatedMatches: located.reduce((total, venue) => total + venue.matchCount, 0),
    topVenues: located.slice(0, Math.max(0, topCount)).map(venue => ({
      shopExternalId: venue.shopExternalId,
      latitude: round(venue.latitude, 6),
      longitude: round(venue.longitude, 6),
      matchCount: venue.matchCount,
    })),
  };
}

/**
 * Great-circle distance, km.
 *
 * Exported because the spread figure is the number a reader is most likely to
 * want to check, and a second implementation of the same formula elsewhere in
 * the repo is how two of them come to disagree. The backend's event search has
 * its own copy for its own reasons (it filters in SQL); nothing in the rating
 * pass needs a second one.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
