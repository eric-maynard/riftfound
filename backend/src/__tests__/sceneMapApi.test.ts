/**
 * `GET /api/rankings/map` - the map of scenes.
 *
 * What these pin, in order of how much a reader would notice it breaking:
 *
 * 1. **An unlocated scene is never drawn.** The whole promise of this endpoint
 *    is that a pin means "this scene's own venues are here", so a scene with
 *    no coordinates has to arrive in a list the map cannot accidentally
 *    render, and it must never arrive carrying `0, 0`, its region label's city,
 *    or half a coordinate pair.
 * 2. **"Nothing is located" and "we cannot tell" are different answers.** An
 *    engine that has never refitted, or one that predates the place fields,
 *    reports `catalogueUnavailable` - which the page renders as a different
 *    sentence from an empty map.
 * 3. **It is cacheable.** The catalogue moves once a day; without the header
 *    this is a Lambda invocation and a 46-read-unit Query per visitor.
 * 4. The coverage counts describe the whole catalogue, not the drawn subset,
 *    because the ratio between them is the caveat the page prints.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import app from '../app.js';
import { setRankingStore } from '../services/rankingService.js';
import { fixtureRankingStore } from '../adapters/rankingFixtureAdapter.js';
import { CONFIDENCE } from '../models/ranking.js';
import type { RankingStore, SceneCatalogueEntry } from '../adapters/rankingStore.js';
import { startServer, getJson, type TestServer } from './helpers/server.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer(app);
});

afterAll(async () => {
  setRankingStore(null);
  await server.close();
});

const get = (path: string) => getJson(server.url, path);

/** A store that answers nothing but the scene catalogue. */
function catalogueStore(entries: SceneCatalogueEntry[] | null): RankingStore {
  const store: RankingStore = {
    ...fixtureRankingStore,
    kind: 'fixture',
  };
  if (entries === null) {
    // A store with no catalogue reader at all - every store older than the
    // GSI1 keys on those items.
    delete (store as { listSceneCatalogue?: unknown }).listSceneCatalogue;
    return store;
  }
  return { ...store, listSceneCatalogue: async () => entries };
}

function scene(overrides: Partial<SceneCatalogueEntry> & { componentId: string }): SceneCatalogueEntry {
  return {
    regionLabel: null,
    componentSize: 10,
    playerCount: 10,
    ratedCount: 0,
    matchCount: 20,
    venueCount: 1,
    isGiant: false,
    latitude: null,
    longitude: null,
    spreadKm: null,
    locatedVenues: 0,
    locatedMatches: 0,
    topVenues: [],
    generatedAt: '2026-10-27T01:23:07.949Z',
    ...overrides,
  };
}

describe('GET /api/rankings/map', () => {
  it('serves the fixture catalogue, derived from the fixture match log', async () => {
    setRankingStore(fixtureRankingStore);
    const { status, body, headers } = await get('/api/rankings/map');

    expect(status).toBe(200);
    expect(body.data.scenes.length).toBeGreaterThan(0);

    // Cacheable at the edge, or this becomes a Lambda invocation and a
    // 46-read-unit Query per visitor for an answer that changes daily.
    expect(headers.get('cache-control')).toContain('s-maxage=3600');

    const [biggest] = body.data.scenes;
    expect(typeof biggest.latitude).toBe('number');
    expect(typeof biggest.longitude).toBe('number');
    expect(biggest.componentId).toBeTruthy();

    // The fixture's Bay Area scene plays at three stores inside ~45km, so it
    // is located, has a real spread, and its centroid is in the Bay. The
    // numbers come from the fixture's own matches, which is the point: a map
    // that disagreed with the leaderboard beside it would be the bug.
    expect(biggest.latitude).toBeGreaterThan(36);
    expect(biggest.latitude).toBeLessThan(39);
    expect(biggest.longitude).toBeLessThan(-121);
    expect(biggest.spreadKm).toBeGreaterThan(0);
    expect(biggest.locatedVenues).toBeGreaterThan(1);

    // Every drawn scene carries a link target and a size, which is all the map
    // needs to be clickable.
    for (const entry of body.data.scenes) {
      expect(entry.playerCount).toBeGreaterThan(0);
      expect(entry.topVenues.length).toBeGreaterThan(0);
    }
  });

  it('marks which scenes can be ordered at all, on the ladder\'s own gate', async () => {
    setRankingStore(fixtureRankingStore);
    const { body } = await get('/api/rankings/map');

    expect(body.data.coverage.minComponentSize).toBe(CONFIDENCE.minComponentSize);
    // The fixture has a 23-player Bay Area scene and a 5-player Puget Sound
    // one, so exactly one of them is big enough for a position inside it to
    // mean anything - the same gate the ladder applies, read off the scene.
    const comparable = [...body.data.scenes, ...body.data.unlocated].filter(
      (entry: { comparable: boolean }) => entry.comparable
    );
    expect(comparable).toHaveLength(1);
    expect(body.data.coverage.comparableScenes).toBe(1);
  });

  it('sorts both lists biggest first', async () => {
    setRankingStore(
      catalogueStore([
        scene({ componentId: 'c-small', playerCount: 3, componentSize: 3, latitude: 1, longitude: 1 }),
        scene({ componentId: 'c-big', playerCount: 900, componentSize: 900, latitude: 2, longitude: 2 }),
        scene({ componentId: 'c-mid', playerCount: 50, componentSize: 50, latitude: 3, longitude: 3 }),
      ])
    );

    const { body } = await get('/api/rankings/map');
    expect(body.data.scenes.map((entry: { componentId: string }) => entry.componentId)).toEqual([
      'c-big',
      'c-mid',
      'c-small',
    ]);
  });

  describe('an unlocated scene is never drawn', () => {
    it('keeps it out of the drawn list and nulls its coordinates', async () => {
      setRankingStore(
        catalogueStore([
          scene({ componentId: 'c-here', playerCount: 40, latitude: 51.5074, longitude: -0.1278, locatedVenues: 2, spreadKm: 4.2 }),
          // A real production shape: a scene whose region is known by name
          // because one shop row carries a city, while no event at it has been
          // geocoded. Geocoding that label would be a city centre dressed as a
          // venue-weighted centroid, so nothing is published.
          scene({ componentId: 'c-nowhere', playerCount: 11, regionLabel: 'Rockhampton, Australia' }),
        ])
      );

      const { body } = await get('/api/rankings/map');
      expect(body.data.scenes.map((entry: { componentId: string }) => entry.componentId)).toEqual(['c-here']);
      expect(body.data.unlocated.map((entry: { componentId: string }) => entry.componentId)).toEqual(['c-nowhere']);

      const [missing] = body.data.unlocated;
      expect(missing.latitude).toBeNull();
      expect(missing.longitude).toBeNull();
      expect(missing.spreadKm).toBeNull();
      // The label still travels - it is what the page lists the scene under -
      // but it is never turned into a position.
      expect(missing.regionLabel).toBe('Rockhampton, Australia');
    });

    it('refuses half a coordinate pair rather than defaulting the other half', async () => {
      // Latitude with no longitude is the obvious route to a pin at 0,0 in the
      // Gulf of Guinea. It reports unlocated instead.
      setRankingStore(
        catalogueStore([
          scene({ componentId: 'c-half', playerCount: 9, latitude: 51.5074, longitude: null }),
          scene({ componentId: 'c-other-half', playerCount: 8, latitude: null, longitude: -0.1278 }),
        ])
      );

      const { body } = await get('/api/rankings/map');
      expect(body.data.scenes).toEqual([]);
      expect(body.data.unlocated).toHaveLength(2);
      for (const entry of body.data.unlocated) {
        expect(entry.latitude).toBeNull();
        expect(entry.longitude).toBeNull();
      }
    });

    it('drops venue pins from a scene it will not draw', async () => {
      // A stale item carrying venues but no centroid would otherwise hand the
      // map pins for a scene it has nothing else to say about.
      setRankingStore(
        catalogueStore([
          scene({
            componentId: 'c-nowhere',
            playerCount: 12,
            topVenues: [{ shopExternalId: 7, latitude: 1, longitude: 1, matchCount: 5 }],
          }),
        ])
      );

      const { body } = await get('/api/rankings/map');
      expect(body.data.unlocated[0].topVenues).toEqual([]);
    });
  });

  describe('coverage', () => {
    it('counts the whole catalogue, not the drawn subset', async () => {
      setRankingStore(
        catalogueStore([
          scene({ componentId: 'c-1', playerCount: 100, componentSize: 100, latitude: 1, longitude: 1 }),
          scene({ componentId: 'c-2', playerCount: 60, componentSize: 60, latitude: 2, longitude: 2 }),
          scene({ componentId: 'c-3', playerCount: 40, componentSize: 40 }),
          scene({ componentId: 'c-4', playerCount: 2, componentSize: 2 }),
        ])
      );

      const { body } = await get('/api/rankings/map');
      const { coverage } = body.data;
      expect(coverage.totalScenes).toBe(4);
      expect(coverage.locatedScenes).toBe(2);
      // 160 of 202 players are in a scene the map can draw. That ratio is the
      // caveat the page prints, so it cannot be derived from the drawn list.
      expect(coverage.locatedPlayers).toBe(160);
      expect(coverage.totalPlayers).toBe(202);
      expect(coverage.catalogueUnavailable).toBe(false);
      expect(coverage.lastUpdated).toBe('2026-10-27T01:23:07.949Z');
    });

    it('reports the latest generatedAt across the catalogue', async () => {
      setRankingStore(
        catalogueStore([
          scene({ componentId: 'c-1', latitude: 1, longitude: 1, generatedAt: '2026-10-20T00:00:00.000Z' }),
          scene({ componentId: 'c-2', latitude: 2, longitude: 2, generatedAt: '2026-10-27T00:00:00.000Z' }),
          scene({ componentId: 'c-3', latitude: 3, longitude: 3, generatedAt: null }),
        ])
      );

      const { body } = await get('/api/rankings/map');
      expect(body.data.coverage.lastUpdated).toBe('2026-10-27T00:00:00.000Z');
    });
  });

  describe('"we cannot tell" is not "nothing is located"', () => {
    it('says so when the catalogue is empty', async () => {
      // The live state until the engine has refitted with the place fields on
      // its items: the scenes exist, nothing says where they are. A map that
      // reported "0 of 0 scenes" here would be claiming there are no scenes.
      setRankingStore(catalogueStore([]));

      const { status, body } = await get('/api/rankings/map');
      expect(status).toBe(200);
      expect(body.data.scenes).toEqual([]);
      expect(body.data.unlocated).toEqual([]);
      expect(body.data.coverage.catalogueUnavailable).toBe(true);
      expect(body.data.coverage.minComponentSize).toBe(CONFIDENCE.minComponentSize);
    });

    it('says so when the store has no catalogue reader', async () => {
      setRankingStore(catalogueStore(null));

      const { status, body } = await get('/api/rankings/map');
      expect(status).toBe(200);
      expect(body.data.coverage.catalogueUnavailable).toBe(true);
    });
  });

  it('does not shadow the leaderboard route', async () => {
    // `/map` is mounted ahead of `/`, and the board still answers. The
    // tournaments router needed the same ordering guarantee for
    // `/tournament-availability`, and it is the kind of thing that only breaks
    // once a `/:scope` route is added.
    setRankingStore(fixtureRankingStore);
    const { status, body } = await get('/api/rankings');
    expect(status).toBe(200);
    expect(body.data.entries.length).toBeGreaterThan(0);
  });
});
