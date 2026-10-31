/**
 * `GET /api/rankings?scope=scene:<id>` - the ladder a scene link lands on.
 *
 * What these pin, in order of how much a reader would notice it breaking:
 *
 * 1. **A scene link opens the scene.** It used to open
 *    `component:<the pool those players sit in>`, whose `regionLabel` is the
 *    modal city of a reachability closure - so clicking `Peninsula` landed on
 *    a board headed `North West Community Development Council`, a Singapore
 *    CDC label. Every row on a scene board carries the scene that was asked
 *    for, and nothing else.
 * 2. **The ranks are a dense re-rank inside the scene**, 1..N, not the pool's
 *    numbers with the other scenes' rows cut out. And the two are published
 *    together (`rank`, `poolRank`) so a reader can check one against the
 *    other - the restriction is order-preserving, so they can never disagree
 *    about who is ahead of whom.
 * 3. **`CONFIDENCE.minComponentSize` still measures the component.** A
 *    3-player scene inside a big pool holds positions; a big scene whose pool
 *    is below the gate holds none. Re-pointing that threshold at the scene's
 *    own size would be a different claim about identifiability, measured from
 *    nothing.
 * 4. **A multi-component scene is handled explicitly, not smoothed over.** The
 *    board holds one pool's rows, `singlePool` is false and `omittedPoolRows`
 *    says how many of the scene's rated players are not on it. What is
 *    incomplete is the board's coverage of the scene, never the comparability
 *    inside it, and those are different claims.
 * 5. **The pool stays reachable.** `component:<id>` is unchanged and is still
 *    the honest answer to "who else is on this scale"; it is simply no longer
 *    the thing a scene link lands on.
 * 6. **Every absence is a normal state, not a 404.** No scene item, no pool,
 *    no scene-board reader: 200 with the fact stated, because all three are
 *    also the state of a deploy whose engine has not refitted, and a shared
 *    `?scene=` link must not die for a deploy order.
 * 7. **It is cacheable.** A scene board is the dearest read in this API
 *    (~250 read units against ~2 for a stored board's page), so the header is
 *    the mechanism rather than a nicety.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import app from '../app.js';
import { setRankingStore } from '../services/rankingService.js';
import { fixtureRankingStore } from '../adapters/rankingFixtureAdapter.js';
import { CONFIDENCE, SCENE_BOARD_MAX_ROWS } from '../models/ranking.js';
import type {
  LeaderboardRecord,
  RankingStore,
  SceneBoardRead,
  SceneDirectoryEntry,
} from '../adapters/rankingStore.js';
import { startServer, getJson, type TestServer } from './helpers/server.js';

let server: TestServer;

beforeAll(async () => {
  setRankingStore(fixtureRankingStore);
  server = await startServer(app);
});

afterAll(async () => {
  setRankingStore(null);
  await server.close();
});

const get = (path: string) => getJson(server.url, path);

// ---------------------------------------------------------------------------
// A store built from one table of rows, so a structural case can be stated in
// four lines instead of generated.
// ---------------------------------------------------------------------------

interface Row {
  playerId: string;
  rating: number;
  sceneId: string | null;
  componentId: string;
  componentSize: number;
  /** Board rank as the engine wrote it; the rows are given in board order. */
  poolRank?: number;
}

/**
 * A store whose only real answer is one pool board plus one scene item.
 *
 * It reads the board the way both real adapters do - the whole partition, then
 * filtered on the scene **and** the pool - because that is where the two cases
 * worth testing live: a cap that truncates the tail, and a scene whose rows
 * arrive from two components at once.
 */
function boardStore(options: {
  rows: Row[];
  scene: Partial<SceneDirectoryEntry> & { sceneId: string };
  /** Scopes this engine wrote a board for. Default: the component scope only. */
  storedScopes?: string[];
  maxRows?: number;
}): RankingStore {
  const sceneItem: SceneDirectoryEntry = {
    label: 'Peninsula',
    venueCount: 3,
    playerCount: options.rows.length,
    ratedCount: options.rows.length,
    matchCount: 100,
    medianPurity: 1,
    assignedAt: '2026-10-28T00:00:00.000Z',
    latitude: null,
    longitude: null,
    spreadKm: null,
    nearestVenueKm: null,
    locatedVenues: 0,
    locatedMatches: 0,
    topVenues: [],
    componentId: 'c-pool',
    componentSize: 500,
    componentCount: 1,
    generatedAt: '2026-10-30T00:00:00.000Z',
    ...options.scene,
  };

  const toRecord = (row: Row, rank: number | null): LeaderboardRecord => ({
    playerId: row.playerId,
    rank,
    rating: row.rating,
    uncertainty: 70,
    gamesPlayed: 20,
    matchesPlayed: 15,
    displayName: row.playerId,
    tagLine: 'NA1',
    componentId: row.componentId,
    componentSize: row.componentSize,
    regionLabel: 'Modal City, Elsewhere',
    sceneId: row.sceneId,
    sceneLabel: row.sceneId === null ? null : 'Peninsula',
    provisional: false,
    provisionalReason: null,
    gamesUntilRated: 0,
  });

  const stored = options.storedScopes ?? ['component:c-pool'];

  return {
    ...fixtureRankingStore,
    kind: 'fixture',
    async getScene(sceneId: string) {
      return sceneId === sceneItem.sceneId ? sceneItem : null;
    },
    async listComponents() {
      return new Map([
        [
          'c-pool',
          {
            regionLabel: 'Modal City, Elsewhere',
            componentSize: sceneItem.componentSize,
            ratedPlayers: options.rows.length,
            totalPlayers: options.rows.length,
          },
        ],
      ]);
    },
    async getSceneBoard(pool, sceneId, componentId, maxRows): Promise<SceneBoardRead> {
      if (!stored.includes(pool.raw)) {
        return {
          items: [],
          poolScope: pool.raw,
          poolRowsRead: 0,
          complete: true,
          omittedPoolRows: 0,
          updatedAt: null,
        };
      }
      const cap = Math.min(maxRows, options.maxRows ?? maxRows);
      const examined = options.rows.slice(0, cap);
      const items: LeaderboardRecord[] = [];
      let omittedPoolRows = 0;
      for (const [index, row] of examined.entries()) {
        if (row.sceneId !== sceneId) continue;
        if (row.componentId !== componentId) {
          omittedPoolRows += 1;
          continue;
        }
        items.push(toRecord(row, row.poolRank ?? index + 1));
      }
      return {
        items,
        poolScope: pool.raw,
        poolRowsRead: examined.length,
        complete: examined.length === options.rows.length,
        omittedPoolRows,
        updatedAt: '2026-10-30T00:00:00.000Z',
      };
    },
  };
}

/** A pool of six, two scenes interleaved down it. */
const INTERLEAVED: Row[] = [
  { playerId: 'p1', rating: 1700, sceneId: 'other', componentId: 'c-pool', componentSize: 500 },
  { playerId: 'p2', rating: 1650, sceneId: 'peninsula', componentId: 'c-pool', componentSize: 500 },
  { playerId: 'p3', rating: 1600, sceneId: 'other', componentId: 'c-pool', componentSize: 500 },
  { playerId: 'p4', rating: 1550, sceneId: 'peninsula', componentId: 'c-pool', componentSize: 500 },
  { playerId: 'p5', rating: 1500, sceneId: 'other', componentId: 'c-pool', componentSize: 500 },
  { playerId: 'p6', rating: 1450, sceneId: 'peninsula', componentId: 'c-pool', componentSize: 500 },
];

describe('GET /api/rankings?scope=scene:<id>', () => {
  it('serves the scene that was asked for, with the pool beside it rather than as it', async () => {
    setRankingStore(boardStore({ rows: INTERLEAVED, scene: { sceneId: 'peninsula' } }));
    const { status, body, headers } = await get('/api/rankings?scope=scene:peninsula');

    expect(status).toBe(200);
    expect(body.data.scope).toEqual({
      raw: 'scene:peninsula',
      setId: null,
      componentId: null,
      sceneId: 'peninsula',
    });

    // Every row is the scene's, and nobody else's.
    expect(body.data.entries.map((entry: { playerId: string }) => entry.playerId)).toEqual([
      'p2',
      'p4',
      'p6',
    ]);
    for (const entry of body.data.entries) expect(entry.sceneId).toBe('peninsula');

    // The scene is named by the scene's own label; the pool keeps its own, and
    // the two are different strings. This is the reported bug, in one
    // assertion: the heading a reader lands on is theirs, and the modal city
    // of the closure is still published - just not as the name of the place.
    expect(body.data.scene.label).toBe('Peninsula');
    expect(body.data.component.regionLabel).toBe('Modal City, Elsewhere');
    expect(body.data.scene.componentId).toBe('c-pool');
    expect(body.data.scene.sceneId).not.toBe(body.data.scene.componentId);

    // The dearest read in this API, so the header is the mechanism.
    expect(headers.get('cache-control')).toContain('s-maxage=3600');
  });

  /**
   * The decision this endpoint exists to make. The pool's ranks for these
   * three are 2, 4 and 6; a board opening on `#2` and climbing in twos is the
   * component's board with holes in it, which is not what "this scene's
   * ladder" means.
   */
  it('ranks densely inside the scene, and publishes the pool position beside it', async () => {
    setRankingStore(boardStore({ rows: INTERLEAVED, scene: { sceneId: 'peninsula' } }));
    const { body } = await get('/api/rankings?scope=scene:peninsula');

    expect(body.data.entries.map((entry: { rank: number }) => entry.rank)).toEqual([1, 2, 3]);
    expect(body.data.entries.map((entry: { poolRank: number }) => entry.poolRank)).toEqual([2, 4, 6]);
  });

  /**
   * The restriction is order-preserving - a subset of one component sorted on
   * the same posterior mean - so the two columns cannot contradict each other.
   * Asserted as the property rather than as the numbers, because the numbers
   * are the previous test and this is the reason they are safe.
   */
  it('never lets the scene order disagree with the pool order', async () => {
    setRankingStore(boardStore({ rows: INTERLEAVED, scene: { sceneId: 'peninsula' } }));
    const { body } = await get('/api/rankings?scope=scene:peninsula');

    const rows: { rank: number; poolRank: number }[] = body.data.entries;
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].rank).toBeGreaterThan(rows[i - 1].rank);
      expect(rows[i].poolRank).toBeGreaterThan(rows[i - 1].poolRank);
    }
  });

  /**
   * `CONFIDENCE.minComponentSize` gates on the **pool** and this change does
   * not move it. Two cases, and they go opposite ways: three players in a
   * 500-player pool are ordered, and a scene twice the gate whose pool is
   * under it is not. The first is the one a scene-sized threshold would have
   * broken silently.
   */
  it('keeps the position gate on the pool, not on the scene', async () => {
    const tinyScene: Row[] = [
      { playerId: 'a', rating: 1600, sceneId: 'peninsula', componentId: 'c-pool', componentSize: 500 },
      { playerId: 'b', rating: 1500, sceneId: 'peninsula', componentId: 'c-pool', componentSize: 500 },
      { playerId: 'c', rating: 1400, sceneId: 'peninsula', componentId: 'c-pool', componentSize: 500 },
    ];
    setRankingStore(
      boardStore({ rows: tinyScene, scene: { sceneId: 'peninsula', playerCount: 3, componentSize: 500 } })
    );
    let response = await get('/api/rankings?scope=scene:peninsula');
    expect(response.body.data.scene.comparable).toBe(true);
    expect(response.body.data.entries.map((entry: { rank: number }) => entry.rank)).toEqual([1, 2, 3]);

    const smallPool = CONFIDENCE.minComponentSize - 1;
    const bigSceneSmallPool: Row[] = Array.from({ length: 16 }, (_, index) => ({
      playerId: `q${index}`,
      rating: 1600 - index,
      sceneId: 'peninsula',
      componentId: 'c-pool',
      componentSize: smallPool,
    }));
    setRankingStore(
      boardStore({
        rows: bigSceneSmallPool,
        scene: { sceneId: 'peninsula', playerCount: 16, componentSize: smallPool },
      })
    );
    response = await get('/api/rankings?scope=scene:peninsula&limit=20');
    expect(response.body.data.scene.comparable).toBe(false);
    expect(response.body.data.scene.playerCount).toBe(16);
    // 16 players, and not one position: the gate is a statement about the pool.
    for (const entry of response.body.data.entries) {
      expect(entry.rank).toBeNull();
      expect(entry.poolRank).toBeNull();
      // The rating is published either way - `component-too-small` is a
      // comparison problem, not an evidence one.
      expect(entry.rating).not.toBeNull();
    }
    expect(response.body.data.coverage.minComponentSize).toBe(CONFIDENCE.minComponentSize);
  });

  /**
   * A scene whose players straddle two pools. The board is one pool's rows -
   * mixing two would be the cross-scale board this whole design avoids - and
   * the two facts a reader needs are published in the order they need them:
   * there are two pools, and three players are not on this board.
   */
  it('publishes one pool for a multi-component scene, and says what it left out', async () => {
    const split: Row[] = [
      { playerId: 'm1', rating: 1700, sceneId: 'peninsula', componentId: 'c-pool', componentSize: 500 },
      { playerId: 'm2', rating: 1690, sceneId: 'peninsula', componentId: 'c-other', componentSize: 40 },
      { playerId: 'm3', rating: 1680, sceneId: 'peninsula', componentId: 'c-pool', componentSize: 500 },
      { playerId: 'm4', rating: 1670, sceneId: 'peninsula', componentId: 'c-other', componentSize: 40 },
      { playerId: 'm5', rating: 1660, sceneId: 'peninsula', componentId: 'c-other', componentSize: 40 },
    ];
    setRankingStore(
      boardStore({
        rows: split,
        scene: { sceneId: 'peninsula', componentCount: 2, playerCount: 5 },
        // The pool ladder exists here, and still holds every component's rows
        // in this store - which is the shape a set-wide fallback really has.
        storedScopes: ['component:c-pool'],
      })
    );
    const { body } = await get('/api/rankings?scope=scene:peninsula');

    expect(body.data.scene.componentCount).toBe(2);
    expect(body.data.scene.singlePool).toBe(false);
    expect(body.data.scene.omittedPoolRows).toBe(3);
    expect(body.data.entries.map((entry: { playerId: string }) => entry.playerId)).toEqual(['m1', 'm3']);
    for (const entry of body.data.entries) expect(entry.componentId).toBe('c-pool');

    // What is incomplete is the board's coverage of the scene, never the
    // comparability inside it: the two rows shown are in one pool, so they
    // hold real positions.
    expect(body.data.entries.map((entry: { rank: number }) => entry.rank)).toEqual([1, 2]);
    expect(body.data.scene.comparable).toBe(true);
  });

  it('reports a single-pool scene as one, and leaves nothing out of it', async () => {
    setRankingStore(boardStore({ rows: INTERLEAVED, scene: { sceneId: 'peninsula' } }));
    const { body } = await get('/api/rankings?scope=scene:peninsula');
    expect(body.data.scene.singlePool).toBe(true);
    expect(body.data.scene.omittedPoolRows).toBe(0);
  });

  /**
   * The engine writes at most `RANKING_MAX_COMPONENT_LADDERS` (50) component
   * boards and only for pools of at least `minComponentSize`, so for most of
   * the 1,235 pools `RANKING#component:<id>` does not exist at all. An empty
   * partition is told from an empty *scene* by whether anything was read.
   */
  it('falls back to the set-wide board when the pool has no ladder of its own', async () => {
    setRankingStore(
      boardStore({ rows: INTERLEAVED, scene: { sceneId: 'peninsula' }, storedScopes: ['all'] })
    );
    const { body } = await get('/api/rankings?scope=scene:peninsula');

    expect(body.data.scene.poolScope).toBe('all');
    expect(body.data.entries).toHaveLength(3);
  });

  it('keeps the set era when it falls back, so a set scope is not silently widened', async () => {
    setRankingStore(
      boardStore({
        rows: INTERLEAVED,
        scene: { sceneId: 'peninsula' },
        storedScopes: ['set:radiance'],
      })
    );
    const { body } = await get('/api/rankings?scope=set:radiance%23scene:peninsula');

    expect(body.data.scope.raw).toBe('set:radiance#scene:peninsula');
    expect(body.data.scene.poolScope).toBe('set:radiance');
  });

  /**
   * The partition is in rank order, so a cap drops the scene's low-rated tail.
   * Reported rather than served as if it were the whole board - the same rule
   * the ladder's own `coverageComplete` follows, and the opposite of what a
   * `Limit`ed, filtered Query would have done silently.
   */
  it('says so when the pool board was not read to its end', async () => {
    setRankingStore(
      boardStore({ rows: INTERLEAVED, scene: { sceneId: 'peninsula' }, maxRows: 3 })
    );
    const { body } = await get('/api/rankings?scope=scene:peninsula');

    expect(body.data.scene.poolComplete).toBe(false);
    expect(body.data.scene.poolRowsRead).toBe(3);
    expect(body.data.coverage.coverageComplete).toBe(false);
    // The first page of the scene is still right - what is missing is below it.
    expect(body.data.entries.map((entry: { playerId: string }) => entry.playerId)).toEqual(['p2']);
  });

  it('reports the read it paid for, so the cost is not invisible', async () => {
    setRankingStore(boardStore({ rows: INTERLEAVED, scene: { sceneId: 'peninsula' } }));
    const { body } = await get('/api/rankings?scope=scene:peninsula');
    expect(body.data.scene.poolRowsRead).toBe(INTERLEAVED.length);
    expect(body.data.scene.poolComplete).toBe(true);
    expect(SCENE_BOARD_MAX_ROWS).toBeGreaterThan(6_117);
  });

  it('counts the scene, not the board, in coverage', async () => {
    setRankingStore(
      boardStore({ rows: INTERLEAVED, scene: { sceneId: 'peninsula', playerCount: 49, ratedCount: 3 } })
    );
    const { body } = await get('/api/rankings?scope=scene:peninsula');

    // The board holds a row only for a rated player, so it structurally cannot
    // say how many people play in the scene. The `SCENE#` item can, and it is
    // the same number the event page's scene line prints.
    expect(body.data.coverage.totalPlayers).toBe(49);
    expect(body.data.coverage.ratedPlayers).toBe(3);
    expect(body.data.coverage.provisionalPlayers).toBe(46);
    expect(body.data.scene.playerCount).toBe(49);
  });

  it('paginates the scene board without losing the re-rank', async () => {
    setRankingStore(boardStore({ rows: INTERLEAVED, scene: { sceneId: 'peninsula' } }));
    const first = await get('/api/rankings?scope=scene:peninsula&limit=2');
    expect(first.body.data.entries.map((entry: { rank: number }) => entry.rank)).toEqual([1, 2]);
    expect(first.body.pagination.hasMore).toBe(true);

    const second = await get(
      `/api/rankings?scope=scene:peninsula&limit=2&cursor=${encodeURIComponent(first.body.pagination.cursor)}`
    );
    // Page two continues the scene's own numbering rather than restarting it.
    expect(second.body.data.entries.map((entry: { rank: number }) => entry.rank)).toEqual([3]);
    expect(second.body.pagination.hasMore).toBe(false);
  });
});

describe('a scene board with nothing behind it', () => {
  /**
   * Three absences, all of them 200. Each is also the state of a perfectly
   * healthy deploy: an engine that has not refitted since the assignment was
   * accepted has no `SCENE#` item for any id, and a shared `?scene=` link must
   * not die for a deploy order. Same rule as "Never seen is not absent".
   */
  it('answers an unknown scene id with known: false rather than a 404', async () => {
    setRankingStore(boardStore({ rows: INTERLEAVED, scene: { sceneId: 'peninsula' } }));
    const { status, body } = await get('/api/rankings?scope=scene:nowhere');

    expect(status).toBe(200);
    expect(body.data.scene.sceneId).toBe('nowhere');
    expect(body.data.scene.known).toBe(false);
    expect(body.data.scene.componentId).toBeNull();
    expect(body.data.entries).toEqual([]);
    // "We cannot count this" rather than "nobody plays here".
    expect(body.data.coverage.coverageComplete).toBe(false);
  });

  it('answers a scene with no rating pool as empty, with the scene still named', async () => {
    setRankingStore(
      boardStore({
        rows: [],
        scene: { sceneId: 'peninsula', componentId: null, componentSize: null, componentCount: 0, playerCount: 7 },
      })
    );
    const { status, body } = await get('/api/rankings?scope=scene:peninsula');

    expect(status).toBe(200);
    expect(body.data.scene.known).toBe(true);
    expect(body.data.scene.label).toBe('Peninsula');
    expect(body.data.scene.componentId).toBeNull();
    expect(body.data.scene.comparable).toBe(false);
    expect(body.data.component).toBeNull();
    expect(body.data.entries).toEqual([]);
    // The scene is still a fact about its stores, and its size still reads.
    expect(body.data.coverage.totalPlayers).toBe(7);
  });

  it('degrades rather than 500s on a store with no scene reader at all', async () => {
    const store: RankingStore = { ...fixtureRankingStore, kind: 'fixture' };
    delete (store as { getScene?: unknown }).getScene;
    delete (store as { getSceneBoard?: unknown }).getSceneBoard;
    setRankingStore(store);

    const { status, body } = await get('/api/rankings?scope=scene:sf-berkeley');
    expect(status).toBe(200);
    expect(body.data.scene.known).toBe(false);
    expect(body.data.entries).toEqual([]);
  });
});

describe('the pool board is untouched', () => {
  /**
   * The component board must stay exactly what it was - it is still the honest
   * answer to "who else is on this scale". What changed is only that a scene
   * link no longer lands on it.
   */
  it('serves a component scope with no scene header and no pool column', async () => {
    setRankingStore(fixtureRankingStore);
    const { body } = await get('/api/rankings?scope=component:c-bay&limit=100');

    expect(body.data.scene).toBeNull();
    expect(body.data.component.componentId).toBe('c-bay');
    // `rank` already *is* this board's own position, so a second column
    // repeating it would be furniture.
    for (const entry of body.data.entries) expect(entry.poolRank).toBeNull();
    // The pool board holds every scene in the pool, which is the point of it.
    const scenes = new Set(body.data.entries.map((entry: { sceneId: string | null }) => entry.sceneId));
    expect(scenes.size).toBeGreaterThan(1);
  });

  it('serves the fixture scene board off the same rows as the pool board', async () => {
    setRankingStore(fixtureRankingStore);
    const pool = await get('/api/rankings?scope=component:c-bay&limit=100');
    const scene = await get('/api/rankings?scope=scene:sf-berkeley&limit=100');

    const poolRows: { playerId: string; sceneId: string | null; rating: number | null }[] =
      pool.body.data.entries;
    const sceneRows: { playerId: string; rating: number | null }[] = scene.body.data.entries;

    expect(sceneRows.map((row) => row.playerId)).toEqual(
      poolRows.filter((row) => row.sceneId === 'sf-berkeley').map((row) => row.playerId)
    );
    // Nothing is re-fitted: the same player's rating is the same number on
    // both boards. A scene board that moved a rating would mean a new fit.
    const byId = new Map(poolRows.map((row) => [row.playerId, row.rating]));
    for (const row of sceneRows) expect(row.rating).toBe(byId.get(row.playerId));
  });

  it('rejects a pool and a place in one scope', async () => {
    setRankingStore(fixtureRankingStore);
    const { status, body } = await get('/api/rankings?scope=component:c-bay%23scene:sf-berkeley');
    expect(status).toBe(400);
    expect(body.error).toContain('scene');
  });

  /**
   * A rating curve comes from the fit, and nothing fits a scene. Refused
   * rather than served empty: an empty series reads as "no history" where the
   * truth is "that is not a thing this has a history for".
   */
  it('refuses a scene scope on a rating series', async () => {
    setRankingStore(fixtureRankingStore);
    const { body: board } = await get('/api/rankings?scope=scene:sf-berkeley&limit=1');
    const id = board.data.entries[0].playerId;
    const { status, body } = await get(`/api/players/${id}/ratings?scope=scene:sf-berkeley`);
    expect(status).toBe(400);
    expect(body.error).toContain('scene scope');
  });
});
