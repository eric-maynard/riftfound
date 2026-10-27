/**
 * Locating a scene.
 *
 * These pin the properties the map rests on, not the surface:
 *
 * - the centroid is **weighted by play**, so a scene sits where its matches
 *   happen rather than at the midpoint of its outliers;
 * - it is a **spherical** mean, so a scene straddling the antimeridian lands
 *   next to its stores instead of in the Gulf of Guinea;
 * - the **spread** is published beside the pin, because a single point asserts
 *   a precision a 133km corridor does not have;
 * - and every one of the three refusals in `sceneMap.ts` yields nulls rather
 *   than a plausible-looking guess. That last group is the whole point of the
 *   module: a map that invents a coordinate is worse than one with a gap in
 *   it, and "unlocated" has to be a value the pipeline carries end to end.
 *
 * The component walk is exercised too (`findComponents`), because the venue
 * tallies the centroid is computed from are a by-product of that loop and an
 * off-by-one there would be invisible in the arithmetic above.
 */

import { describe, it, expect } from 'vitest';
import {
  scenePlace,
  unlocatedPlace,
  haversineKm,
  DEFAULT_SCENE_MAP_TOP_VENUES,
} from '../ranking/sceneMap.js';
import { findComponents, type ComponentVenue } from '../ranking/graph.js';
import type { ObservationSet } from '../ranking/observations.js';

function venue(overrides: Partial<ComponentVenue> & { venue: string }): ComponentVenue {
  return {
    shopExternalId: null,
    matchCount: 1,
    latitude: null,
    longitude: null,
    ...overrides,
  };
}

/**
 * A minimal observation set: `n` players and a list of
 * `[playerA, playerB, eventIndex]` matches over the given events.
 *
 * Only the fields `findComponents` reads are filled - it does not look at
 * ratings, outcomes or names - so this stays readable at the size the cases
 * below need.
 */
function observations(
  playerCount: number,
  events: { shopExternalId: number | null; latitude: number | null; longitude: number | null }[],
  matches: [number, number, number][]
): ObservationSet {
  return {
    players: Array.from({ length: playerCount }, (_, i) => `p${i}`),
    displayNames: Array.from({ length: playerCount }, () => null),
    tagLines: Array.from({ length: playerCount }, () => null),
    firstSeen: Array.from({ length: playerCount }, () => 0),
    lastSeen: Array.from({ length: playerCount }, () => 0),
    events: events.map((event, index) => ({
      externalId: `e${index}`,
      name: null,
      startDate: new Date('2026-10-01T00:00:00.000Z'),
      tournamentType: 'Nexus Night',
      eraId: null,
      day: 0,
      ...event,
    })),
    matchIds: matches.map((_, i) => `m${i}`),
    playerA: matches.map(([a]) => a),
    playerB: matches.map(([, b]) => b),
    event: matches.map(([, , e]) => e),
    result: matches.map(() => 1),
    gameWinners: matches.map(() => [1]),
    standings: [],
    stats: {
      eventsSeen: events.length,
      eventsWithMatches: events.length,
      matchesSeen: matches.length,
      matchesUsed: matches.length,
      byeMatchesSkipped: 0,
      byeLeaks: 0,
      unmappedTeamSkipped: 0,
      selfMatchSkipped: 0,
      undecidedSkipped: 0,
      duplicateMatchSkipped: 0,
      gamesUsed: matches.length,
      drawsSeen: 0,
      rostersSeen: 0,
      rosterOnlyPlayers: 0,
    },
  };
}

describe('scenePlace', () => {
  it('puts a single-venue scene on that venue, with no spread', () => {
    const place = scenePlace([
      venue({ venue: 'shop:1', shopExternalId: 1, matchCount: 40, latitude: 37.7749, longitude: -122.4194 }),
    ]);

    expect(place.latitude).toBeCloseTo(37.7749, 4);
    expect(place.longitude).toBeCloseTo(-122.4194, 4);
    // A single pin is exactly where its one venue is, so the honest spread is
    // zero rather than a fudge factor.
    expect(place.spreadKm).toBe(0);
    expect(place.locatedVenues).toBe(1);
    expect(place.locatedMatches).toBe(40);
  });

  it('weights the centroid by matches played, not by venue count', () => {
    // Nine venues of one match each at the equator's prime meridian, against
    // one venue of 900 matches ten degrees east. An unweighted mean sits at
    // 1 degree; the weighted one sits essentially on the busy store, which is
    // where the scene actually is.
    const venues: ComponentVenue[] = [
      venue({ venue: 'shop:big', shopExternalId: 1, matchCount: 900, latitude: 0, longitude: 10 }),
      ...Array.from({ length: 9 }, (_, i) =>
        venue({ venue: `shop:${i + 2}`, shopExternalId: i + 2, matchCount: 1, latitude: 0, longitude: 0 })
      ),
    ];

    const place = scenePlace(venues);
    expect(place.longitude).toBeGreaterThan(9.8);
    expect(place.latitude).toBeCloseTo(0, 6);

    // And the spread says the nine quiet stores are out there: the weighted
    // mean distance is small, but it is not zero.
    expect(place.spreadKm).toBeGreaterThan(0);
    expect(place.spreadKm).toBeLessThan(50);
  });

  it('averages across the antimeridian instead of landing in the Atlantic', () => {
    // Two stores either side of the 180th meridian. A mean of degrees gives
    // longitude 0 - an ocean 20,000km away from both - which is the specific
    // bug the spherical mean exists to avoid.
    const place = scenePlace([
      venue({ venue: 'shop:1', shopExternalId: 1, matchCount: 10, latitude: -17.7, longitude: 179.0 }),
      venue({ venue: 'shop:2', shopExternalId: 2, matchCount: 10, latitude: -17.7, longitude: -179.0 }),
    ]);

    expect(Math.abs(place.longitude!)).toBeGreaterThan(179.9);
    expect(place.latitude).toBeCloseTo(-17.7, 2);
    // Both venues are ~106km from the centroid at that latitude.
    expect(place.spreadKm).toBeGreaterThan(80);
    expect(place.spreadKm).toBeLessThan(130);
  });

  it('reports how far the pin is from the nearest venue, which is not the spread', () => {
    // This is the figure the API gates the pin on, and the two genuinely
    // differ. Both scenes below are wide; only one has its centre near a
    // store, and `spreadKm` cannot tell them apart.
    const corridor = scenePlace([
      // Two stores 120km apart, equal play: the midpoint is 60km from each.
      venue({ venue: 'shop:1', shopExternalId: 1, matchCount: 100, latitude: 37.7749, longitude: -122.4194 }),
      venue({ venue: 'shop:2', shopExternalId: 2, matchCount: 100, latitude: 38.5816, longitude: -121.4944 }),
    ]);
    expect(corridor.nearestVenueKm).toBeGreaterThan(50);
    expect(corridor.nearestVenueKm).toBeLessThan(70);

    // A busy hub with a distant outlier: the centroid is pulled a little way
    // off the hub but is still right beside it, while the spread is large.
    const hubAndSpoke = scenePlace([
      venue({ venue: 'shop:1', shopExternalId: 1, matchCount: 1000, latitude: 51.5074, longitude: -0.1278 }),
      venue({ venue: 'shop:2', shopExternalId: 2, matchCount: 10, latitude: 55.9533, longitude: -3.1883 }),
    ]);
    expect(hubAndSpoke.spreadKm!).toBeGreaterThan(10);
    // ...and yet the pin is a few kilometres from the busy store, so it *is*
    // a place.
    expect(hubAndSpoke.nearestVenueKm!).toBeLessThan(10);
  });

  it('is zero for a single-venue scene', () => {
    const place = scenePlace([
      venue({ venue: 'shop:1', shopExternalId: 1, matchCount: 5, latitude: 1.3475, longitude: 103.71 }),
    ]);
    expect(place.nearestVenueKm).toBe(0);
  });

  it('publishes the spread a corridor really has', () => {
    // San Francisco and Sacramento, equal play: ~120km apart, so each is
    // ~60km from the midpoint. A map drawing this as a dot over either city
    // would be wrong about the scene.
    const place = scenePlace([
      venue({ venue: 'shop:1', shopExternalId: 1, matchCount: 100, latitude: 37.7749, longitude: -122.4194 }),
      venue({ venue: 'shop:2', shopExternalId: 2, matchCount: 100, latitude: 38.5816, longitude: -121.4944 }),
    ]);

    expect(place.spreadKm).toBeGreaterThan(50);
    expect(place.spreadKm).toBeLessThan(70);
  });

  describe('refuses to guess', () => {
    it('leaves a scene with no geocoded venue unlocated', () => {
      const place = scenePlace([
        venue({ venue: 'shop:1', shopExternalId: 1, matchCount: 12 }),
        venue({ venue: 'shop:2', shopExternalId: 2, matchCount: 3 }),
      ]);

      expect(place).toEqual(unlocatedPlace());
      expect(place.latitude).toBeNull();
      expect(place.longitude).toBeNull();
      expect(place.spreadKm).toBeNull();
      expect(place.locatedVenues).toBe(0);
      expect(place.topVenues).toEqual([]);
    });

    it('leaves a scene with no venues at all unlocated', () => {
      expect(scenePlace([])).toEqual(unlocatedPlace());
    });

    it('never publishes 0,0 for a missing coordinate pair', () => {
      // Half a coordinate is not a coordinate. A venue with a latitude and no
      // longitude used to be the obvious way to end up with a pin in the Gulf
      // of Guinea, which is why the filter demands both.
      const place = scenePlace([
        venue({ venue: 'shop:1', shopExternalId: 1, matchCount: 5, latitude: 51.5 }),
        venue({ venue: 'shop:2', shopExternalId: 2, matchCount: 5, longitude: -0.12 }),
      ]);

      expect(place.latitude).toBeNull();
      expect(place.longitude).toBeNull();
    });

    it('refuses a centroid when the directions cancel', () => {
      // Antipodal venues with equal play: the weighted unit vectors sum to
      // nothing, so there is no centroid. Picking either pole, either venue or
      // 0,0 would all be inventions.
      const place = scenePlace([
        venue({ venue: 'shop:1', shopExternalId: 1, matchCount: 10, latitude: 0, longitude: 0 }),
        venue({ venue: 'shop:2', shopExternalId: 2, matchCount: 10, latitude: 0, longitude: 180 }),
      ]);

      expect(place.latitude).toBeNull();
      expect(place.longitude).toBeNull();
      expect(place.spreadKm).toBeNull();
    });

    it('counts only the located venues and matches, so the ratio is readable', () => {
      // One geocoded store of 3 matches among three stores of 33 matches. The
      // pin is real and describes a tenth of the scene, and the counts are the
      // only thing that says so.
      const place = scenePlace([
        venue({ venue: 'shop:1', shopExternalId: 1, matchCount: 15 }),
        venue({ venue: 'shop:2', shopExternalId: 2, matchCount: 15, latitude: 40.7, longitude: -74.0 }),
        venue({ venue: 'shop:3', shopExternalId: 3, matchCount: 3 }),
      ]);

      expect(place.latitude).toBeCloseTo(40.7, 4);
      expect(place.locatedVenues).toBe(1);
      expect(place.locatedMatches).toBe(15);
    });
  });

  it('keeps an unresolved organizer as evidence but never as an id', () => {
    // `venueKey`'s `geo:` fallback must not become a durable id (it moves if
    // the geocode moves), but the coordinates behind it are real event
    // coordinates and are worth averaging. So the position counts and the id
    // is null.
    const place = scenePlace([
      venue({ venue: 'geo:48.86,2.35', matchCount: 20, latitude: 48.8566, longitude: 2.3522 }),
    ]);

    expect(place.latitude).toBeCloseTo(48.8566, 3);
    expect(place.topVenues).toHaveLength(1);
    expect(place.topVenues[0].shopExternalId).toBeNull();
  });

  it('caps the published venues and keeps the busiest', () => {
    const venues = Array.from({ length: 12 }, (_, i) =>
      venue({
        venue: `shop:${i}`,
        shopExternalId: i,
        matchCount: 100 - i,
        latitude: 10 + i * 0.01,
        longitude: 10,
      })
    );

    const place = scenePlace(venues);
    expect(place.topVenues).toHaveLength(DEFAULT_SCENE_MAP_TOP_VENUES);
    expect(place.topVenues.map(entry => entry.matchCount)).toEqual([100, 99, 98, 97, 96]);
    // The counts still describe the whole scene, not the published five.
    expect(place.locatedVenues).toBe(12);

    expect(scenePlace(venues, { topVenues: 2 }).topVenues).toHaveLength(2);
    expect(scenePlace(venues, { topVenues: 0 }).topVenues).toEqual([]);
  });
});

describe('findComponents venue tallies', () => {
  it('tallies each venue once per component, with the mean of its coordinates', () => {
    // One venue, two events, geocoded 0.002 degrees apart - which is the real
    // case: the two event sources geocode the same store ~20m apart. The mean
    // is what lands on the item, so the pin does not wobble between refits.
    const set = observations(
      2,
      [
        { shopExternalId: 7, latitude: 37.0, longitude: -122.0 },
        { shopExternalId: 7, latitude: 37.002, longitude: -122.002 },
      ],
      [
        [0, 1, 0],
        [0, 1, 1],
      ]
    );

    const components = findComponents(set);
    expect(components.components).toHaveLength(1);
    const [component] = components.components;
    expect(component.venueCount).toBe(1);
    expect(component.venues).toHaveLength(1);
    expect(component.venues[0].venue).toBe('shop:7');
    expect(component.venues[0].matchCount).toBe(2);
    expect(component.venues[0].latitude).toBeCloseTo(37.001, 6);
    expect(component.venues[0].longitude).toBeCloseTo(-122.001, 6);

    // And the place derived from it is that store.
    const place = scenePlace(component.venues);
    expect(place.latitude).toBeCloseTo(37.001, 4);
    expect(place.spreadKm).toBe(0);
  });

  it('attributes each venue to the component that played there', () => {
    // Two disjoint pairs at two different stores: two components, one venue
    // each. This is the property the whole map rests on - a scene's venues are
    // its own - and it is only true because no recorded game crosses a scene
    // (0 of 56,257 on production, by construction).
    const set = observations(
      4,
      [
        { shopExternalId: 1, latitude: 51.5, longitude: -0.12 },
        { shopExternalId: 2, latitude: 35.68, longitude: 139.69 },
      ],
      [
        [0, 1, 0],
        [2, 3, 1],
      ]
    );

    const components = findComponents(set);
    expect(components.components).toHaveLength(2);
    for (const component of components.components) {
      expect(component.venues).toHaveLength(1);
      expect(component.venues[0].matchCount).toBe(1);
    }

    const places = components.components.map(component => scenePlace(component.venues));
    expect(places.every(place => place.latitude !== null)).toBe(true);
    // Two scenes 9,500km apart, each with its own pin - never one centroid
    // between them.
    expect(haversineKm(places[0].latitude!, places[0].longitude!, places[1].latitude!, places[1].longitude!)).toBeGreaterThan(
      9000
    );
  });

  it('leaves a venue with no coordinates unlocated rather than at the origin', () => {
    const set = observations(
      2,
      [{ shopExternalId: 9, latitude: null, longitude: null }],
      [[0, 1, 0]]
    );

    const [component] = findComponents(set).components;
    expect(component.venues[0].latitude).toBeNull();
    expect(scenePlace(component.venues)).toEqual(unlocatedPlace());
  });

  it('orders a component\'s venues by play, deterministically', () => {
    const set = observations(
      2,
      [
        { shopExternalId: 1, latitude: 1, longitude: 1 },
        { shopExternalId: 2, latitude: 2, longitude: 2 },
      ],
      [
        [0, 1, 1],
        [0, 1, 0],
        [0, 1, 0],
      ]
    );

    const [component] = findComponents(set).components;
    expect(component.venues.map(entry => entry.venue)).toEqual(['shop:1', 'shop:2']);
    expect(component.venues.map(entry => entry.matchCount)).toEqual([2, 1]);
  });
});

describe('haversineKm', () => {
  it('agrees with a known distance', () => {
    // San Francisco to New York, 4,129km by great circle.
    expect(haversineKm(37.7749, -122.4194, 40.7128, -74.006)).toBeCloseTo(4129, -1);
  });

  it('is zero for a point against itself', () => {
    expect(haversineKm(12.34, -56.78, 12.34, -56.78)).toBe(0);
  });
});
