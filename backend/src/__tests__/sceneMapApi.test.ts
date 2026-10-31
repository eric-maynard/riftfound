/**
 * `GET /api/rankings/map` - the map of scenes.
 *
 * What these pin, in order of how much a reader would notice it breaking:
 *
 * 1. **The rows are scenes.** The endpoint used to serve the engine's
 *    `COMPONENT#` catalogue under scene-shaped field names, and a component is
 *    a reachability closure of the co-play graph - so the map's list read
 *    `Karlsruhe, Deutschland` and `Paris, France` while `Peninsula` and
 *    `South Bay` were not selectable anywhere on it, and a `?scene=<sceneId>`
 *    link resolved to nothing because the ids came from another partition.
 *    Every id this endpoint publishes is now a `sceneId`.
 * 2. **A scene is not a rating scale, and the payload keeps them apart.**
 *    `componentId` is the *pool* the scene's players are rated in, carried
 *    beside the scene rather than as its identity. A scene does have a board
 *    now (`scope=scene:<id>`), but it is that pool's board **filtered** to the
 *    scene's rows - a filter, not a fit - so this field keeps its meaning
 *    exactly. Two scenes sharing a pool is the normal case.
 * 3. **An unlocated scene is never drawn.** The whole promise of this endpoint
 *    is that a pin means "this scene's own venues are here", so a scene with
 *    no coordinates has to arrive in a list the map cannot accidentally
 *    render, and it must never arrive carrying `0, 0`, its label's city, or
 *    half a coordinate pair.
 * 4. **"Nothing is located" and "we cannot tell" are different answers.** An
 *    engine with no accepted re-clustering, or one that predates the place
 *    fields, reports `catalogueUnavailable` - which the page renders as a
 *    different sentence from an empty map.
 * 5. **What is in no scene at all is published.** A list of scenes cannot
 *    express an absence, so the venues and players that failed the
 *    rankability gate ride on `coverage` instead of vanishing.
 * 6. **It is cacheable.** The directory moves once a day; without the header
 *    this is a Lambda invocation and a ~46-read-unit Query per visitor.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import app from '../app.js';
import { setRankingStore } from '../services/rankingService.js';
import { fixtureRankingStore } from '../adapters/rankingFixtureAdapter.js';
import { CONFIDENCE } from '../models/ranking.js';
import type { RankingStore, SceneDirectoryEntry } from '../adapters/rankingStore.js';
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

/** A store that answers nothing but the scene directory. */
function directoryStore(
  entries: SceneDirectoryEntry[] | null,
  coverage?: { unassignedVenues: number | null; unassignedPlayers: number | null } | null
): RankingStore {
  const store: RankingStore = { ...fixtureRankingStore, kind: 'fixture' };
  if (coverage === null) {
    // An engine that does not publish the figure at all.
    delete (store as { getSceneCoverage?: unknown }).getSceneCoverage;
  } else if (coverage !== undefined) {
    (store as { getSceneCoverage?: unknown }).getSceneCoverage = async () => ({
      ...coverage,
      generatedAt: null,
    });
  }
  if (entries === null) {
    // A store with no directory reader at all - every store older than the
    // GSI1 keys on the `SCENE#` items.
    delete (store as { listSceneDirectory?: unknown }).listSceneDirectory;
    return store;
  }
  return { ...store, listSceneDirectory: async () => entries };
}

function scene(overrides: Partial<SceneDirectoryEntry> & { sceneId: string }): SceneDirectoryEntry {
  return {
    label: null,
    venueCount: 1,
    playerCount: 10,
    ratedCount: 0,
    matchCount: 20,
    medianPurity: 1,
    assignedAt: '2026-10-28T05:46:25.569Z',
    latitude: null,
    longitude: null,
    spreadKm: null,
    nearestVenueKm: null,
    locatedVenues: 0,
    locatedMatches: 0,
    topVenues: [],
    componentId: 'c-pool',
    componentSize: 100,
    componentCount: 1,
    generatedAt: '2026-10-27T01:23:07.949Z',
    ...overrides,
  };
}

describe('GET /api/rankings/map', () => {
  it('serves the fixture scene directory, derived from the fixture match log', async () => {
    setRankingStore(fixtureRankingStore);
    const { status, body, headers } = await get('/api/rankings/map');

    expect(status).toBe(200);
    expect(body.data.scenes.length).toBeGreaterThan(0);

    // Cacheable at the edge, or this becomes a Lambda invocation and a
    // ~46-read-unit Query per visitor for an answer that changes daily.
    expect(headers.get('cache-control')).toContain('s-maxage=3600');

    const [biggest] = body.data.scenes;
    // The id is a scene's, and the row is named the way the engine's
    // assignment names it - not after whichever city holds the busiest store.
    expect(biggest.sceneId).toBe('sf-berkeley');
    expect(biggest.label).toBe('San Francisco & Berkeley');
    // The pool rides beside the scene, under its own name, and is a different
    // string from the scene's id.
    expect(biggest.componentId).toBe('c-bay');
    expect(biggest.componentId).not.toBe(biggest.sceneId);

    // The fixture's two Bay stores are ~15km apart, so the scene is located,
    // has a real spread, and its centroid is in the Bay. The numbers come from
    // the fixture's own matches, which is the point: a map that disagreed with
    // the leaderboard beside it would be the bug.
    expect(biggest.latitude).toBeGreaterThan(36);
    expect(biggest.latitude).toBeLessThan(39);
    expect(biggest.longitude).toBeLessThan(-121);
    expect(biggest.spreadKm).toBeGreaterThan(0);
    expect(biggest.locatedVenues).toBe(2);

    // Every drawn scene carries a size and the venues it was located from,
    // which is all the map needs to be clickable.
    for (const entry of body.data.scenes) {
      expect(entry.playerCount).toBeGreaterThan(0);
      expect(entry.topVenues.length).toBeGreaterThan(0);
    }

    // No entry carries a `componentId` *as* its id. This is the regression the
    // whole change is about: a reader's `?scene=` link must resolve against
    // these ids.
    const ids = body.data.scenes.map((entry: { sceneId: string }) => entry.sceneId);
    expect(ids).toEqual(['sf-berkeley', 'south-bay']);
  });

  it('carries the pool a scene is ranked on, beside the scene and not as it', async () => {
    setRankingStore(fixtureRankingStore);
    const { body } = await get('/api/rankings/map');

    // Both fixture scenes sit in one connected component, which is the normal
    // case and the reason a scene cannot own a ladder: the two scenes are
    // different places and one rating scale. A UI that read `sceneId` as a
    // ladder scope would ask for `component:sf-berkeley` and get nothing.
    const pools = body.data.scenes.map((entry: { componentId: string | null }) => entry.componentId);
    expect(pools).toEqual(['c-bay', 'c-bay']);
    for (const entry of body.data.scenes) {
      expect(entry.componentCount).toBe(1);
      expect(entry.componentSize).toBe(23);
    }
  });

  it("marks which pools can be ordered, on the ladder's own gate", async () => {
    // `comparable` is a statement about the **pool's** board, never about the
    // scene's player count - a 1-player scene inside a 23-player pool has an
    // orderable ladder, and a 40-player scene whose pool is 6 does not.
    setRankingStore(
      directoryStore([
        scene({ sceneId: 's-big-scene-small-pool', playerCount: 40, componentId: 'c-tiny', componentSize: 4, latitude: 1, longitude: 1 }),
        scene({ sceneId: 's-small-scene-big-pool', playerCount: 2, componentId: 'c-wide', componentSize: 400, latitude: 2, longitude: 2 }),
        scene({ sceneId: 's-no-pool', playerCount: 9, componentId: null, componentSize: null, componentCount: 0, latitude: 3, longitude: 3 }),
      ])
    );

    const { body } = await get('/api/rankings/map');
    expect(body.data.coverage.minComponentSize).toBe(CONFIDENCE.minComponentSize);
    const comparable = body.data.scenes
      .filter((entry: { comparable: boolean }) => entry.comparable)
      .map((entry: { sceneId: string }) => entry.sceneId);
    expect(comparable).toEqual(['s-small-scene-big-pool']);
    expect(body.data.coverage.comparableScenes).toBe(1);
  });

  it('flags the largest scene in the corpus, not the largest drawn one', async () => {
    setRankingStore(
      directoryStore([
        scene({ sceneId: 's-drawn', playerCount: 50, latitude: 1, longitude: 1 }),
        // Bigger, and unlocated - so a flag computed over the drawn list alone
        // would put "largest scene" on the wrong row.
        scene({ sceneId: 's-hidden', playerCount: 900 }),
      ])
    );

    const { body } = await get('/api/rankings/map');
    expect(body.data.scenes[0].isGiant).toBe(false);
    expect(body.data.unlocated[0].isGiant).toBe(true);
  });

  it('sorts both lists biggest first', async () => {
    setRankingStore(
      directoryStore([
        scene({ sceneId: 's-small', playerCount: 3, latitude: 1, longitude: 1 }),
        scene({ sceneId: 's-big', playerCount: 900, latitude: 2, longitude: 2 }),
        scene({ sceneId: 's-mid', playerCount: 50, latitude: 3, longitude: 3 }),
      ])
    );

    const { body } = await get('/api/rankings/map');
    expect(body.data.scenes.map((entry: { sceneId: string }) => entry.sceneId)).toEqual([
      's-big',
      's-mid',
      's-small',
    ]);
  });

  describe('an unlocated scene is never drawn', () => {
    it('keeps it out of the drawn list and nulls its coordinates', async () => {
      setRankingStore(
        directoryStore([
          scene({ sceneId: 's-here', playerCount: 40, latitude: 51.5074, longitude: -0.1278, locatedVenues: 2, spreadKm: 4.2 }),
          // A real production shape: a scene whose region is known by name
          // because one shop row carries a city, while no event at it has been
          // geocoded. Geocoding that label would be a city centre dressed as a
          // venue-weighted centroid, so nothing is published.
          scene({ sceneId: 's-nowhere', playerCount: 11, label: 'Rockhampton, Australia' }),
        ])
      );

      const { body } = await get('/api/rankings/map');
      expect(body.data.scenes.map((entry: { sceneId: string }) => entry.sceneId)).toEqual(['s-here']);
      expect(body.data.unlocated.map((entry: { sceneId: string }) => entry.sceneId)).toEqual(['s-nowhere']);

      const [missing] = body.data.unlocated;
      expect(missing.latitude).toBeNull();
      expect(missing.longitude).toBeNull();
      expect(missing.spreadKm).toBeNull();
      // The label still travels - it is what the page lists the scene under -
      // but it is never turned into a position.
      expect(missing.label).toBe('Rockhampton, Australia');
    });

    it('refuses half a coordinate pair rather than defaulting the other half', async () => {
      // Latitude with no longitude is the obvious route to a pin at 0,0 in the
      // Gulf of Guinea. It reports unlocated instead.
      setRankingStore(
        directoryStore([
          scene({ sceneId: 's-half', playerCount: 9, latitude: 51.5074, longitude: null }),
          scene({ sceneId: 's-other-half', playerCount: 8, latitude: null, longitude: -0.1278 }),
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

    it('withholds a pin that is nowhere near the scene it claims to locate', async () => {
      // The gate cannot fire on a scene produced at the 30km diameter cap - a
      // weighted mean of mutually-within-30km points is within 30km of each of
      // them, and the largest scene extent in the 2026-10-31 production
      // proposal is 29.9km. It is kept because the cap is a knob and because
      // the Louvain method has no geometric bound, so the shape below is still
      // reachable; this pins that it is handled rather than drawn.
      setRankingStore(
        directoryStore([
          scene({
            sceneId: 's-asia',
            playerCount: 5254,
            venueCount: 325,
            latitude: 8.9689,
            longitude: 104.0092,
            spreadKm: 1858.2,
            nearestVenueKm: 360.3,
            topVenues: [{ shopExternalId: 56036, latitude: 1.3475, longitude: 103.71, matchCount: 281 }],
          }),
          // A wide one whose centre is still a place: 131km of spread but only
          // 26km to the nearest store. `spreadKm` alone would have thrown this
          // one away too, which is why the gate reads the distance to the
          // nearest venue instead.
          scene({
            sceneId: 's-roermond',
            playerCount: 259,
            venueCount: 11,
            latitude: 51.2254,
            longitude: 5.9204,
            spreadKm: 131.2,
            nearestVenueKm: 26.1,
          }),
        ])
      );

      const { body } = await get('/api/rankings/map');
      expect(body.data.scenes.map((entry: { sceneId: string }) => entry.sceneId)).toEqual([
        's-roermond',
      ]);

      const [away] = body.data.unlocated;
      expect(away.sceneId).toBe('s-asia');
      expect(away.latitude).toBeNull();
      expect(away.longitude).toBeNull();
      expect(away.dispersed).toBe(true);
      // The figures that explain it survive, and so do the venues - a scene
      // that is not in one place can still be shown *as its places*.
      expect(away.spreadKm).toBe(1858.2);
      expect(away.nearestVenueKm).toBe(360.3);
      expect(away.topVenues).toHaveLength(1);

      expect(body.data.coverage.dispersedScenes).toBe(1);
    });

    it('does not withdraw a pin from an item written before the field existed', async () => {
      // A deploy must not blank the map. An item with no `nearestVenueKm` is
      // read as near rather than far, so the worst case is a pin that stays
      // until the next refit corrects it - not a map that empties out.
      setRankingStore(
        directoryStore([
          scene({ sceneId: 's-old', latitude: 51.5, longitude: -0.12, nearestVenueKm: null }),
        ])
      );

      const { body } = await get('/api/rankings/map');
      expect(body.data.scenes).toHaveLength(1);
      expect(body.data.scenes[0].dispersed).toBe(false);
    });

    it('drops venue pins from a scene it will not draw', async () => {
      // A stale item carrying venues but no centroid would otherwise hand the
      // map pins for a scene it has nothing else to say about.
      setRankingStore(
        directoryStore([
          scene({
            sceneId: 's-nowhere',
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
    it('counts the whole directory, not the drawn subset', async () => {
      setRankingStore(
        directoryStore([
          scene({ sceneId: 's-1', playerCount: 100, latitude: 1, longitude: 1 }),
          scene({ sceneId: 's-2', playerCount: 60, latitude: 2, longitude: 2 }),
          scene({ sceneId: 's-3', playerCount: 40 }),
          scene({ sceneId: 's-4', playerCount: 2 }),
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

    it('publishes what is in no scene at all', async () => {
      // The one figure a list of scenes structurally cannot carry: a store that
      // failed the intra-scene play-share gate is simply absent from the
      // directory, and an absence cannot be rendered. 38 venues and 172 players
      // on the live production assignment.
      setRankingStore(
        directoryStore(
          [scene({ sceneId: 's-1', playerCount: 100, latitude: 1, longitude: 1 })],
          { unassignedVenues: 38, unassignedPlayers: 172 }
        )
      );

      const { body } = await get('/api/rankings/map');
      expect(body.data.coverage.unassignedVenues).toBe(38);
      expect(body.data.coverage.unassignedPlayers).toBe(172);
    });

    it('reports an engine that does not publish that figure as null, not zero', async () => {
      // Null is "we do not know how much is unassigned"; zero would claim
      // every store is in a scene, which is the one thing it must not say.
      setRankingStore(
        directoryStore([scene({ sceneId: 's-1', latitude: 1, longitude: 1 })], null)
      );

      const { body } = await get('/api/rankings/map');
      expect(body.data.coverage.unassignedVenues).toBeNull();
      expect(body.data.coverage.unassignedPlayers).toBeNull();
    });

    it('derives the fixture figures from the fixture, including a store in no scene', async () => {
      setRankingStore(fixtureRankingStore);
      const { body } = await get('/api/rankings/map');
      // The fixture carries a Bellevue store with no scene, and three players
      // whose home store it is. The page has to say so rather than lose them.
      expect(body.data.coverage.unassignedVenues).toBe(1);
      expect(body.data.coverage.unassignedPlayers).toBe(3);
    });

    it('reports the latest generatedAt across the directory', async () => {
      setRankingStore(
        directoryStore([
          scene({ sceneId: 's-1', latitude: 1, longitude: 1, generatedAt: '2026-10-20T00:00:00.000Z' }),
          scene({ sceneId: 's-2', latitude: 2, longitude: 2, generatedAt: '2026-10-27T00:00:00.000Z' }),
          scene({ sceneId: 's-3', latitude: 3, longitude: 3, generatedAt: null }),
        ])
      );

      const { body } = await get('/api/rankings/map');
      expect(body.data.coverage.lastUpdated).toBe('2026-10-27T00:00:00.000Z');
    });
  });

  describe('"we cannot tell" is not "nothing is located"', () => {
    it('says so when the directory is empty', async () => {
      // The state until an operator has accepted a re-clustering *and* a refit
      // has run after it: no `SCENE#` item exists. A map that reported "0 of 0
      // scenes" here would be claiming there are no scenes.
      setRankingStore(directoryStore([], { unassignedVenues: 2574, unassignedPlayers: 39390 }));

      const { status, body } = await get('/api/rankings/map');
      expect(status).toBe(200);
      expect(body.data.scenes).toEqual([]);
      expect(body.data.unlocated).toEqual([]);
      expect(body.data.coverage.catalogueUnavailable).toBe(true);
      expect(body.data.coverage.minComponentSize).toBe(CONFIDENCE.minComponentSize);
      // And the unassigned figures still travel, because in this state they
      // are the only numbers there are: every store is in no scene.
      expect(body.data.coverage.unassignedVenues).toBe(2574);
    });

    it('says so when the store has no directory reader', async () => {
      setRankingStore(directoryStore(null));

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
