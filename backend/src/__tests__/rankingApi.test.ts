import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import app from '../app.js';
import { setRankingStore } from '../services/rankingService.js';
import {
  createFixtureRankingStore,
  fixtureRankingStore,
  EMPTY_FIXTURE_DATA,
  LAUNCH_FIXTURE_DATA,
} from '../adapters/rankingFixtureAdapter.js';
import { CONFIDENCE } from '../models/ranking.js';
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

describe('GET /api/rankings', () => {
  it('serves the all-sets scope by default', async () => {
    const { status, body } = await get('/api/rankings');
    expect(status).toBe(200);
    expect(body.data.scope).toEqual({ raw: 'all', setId: null, componentId: null });
    expect(body.data.entries.length).toBeGreaterThan(0);
  });

  it('reports coverage honestly instead of implying a full ladder', async () => {
    const { body } = await get('/api/rankings?limit=100');
    const { coverage } = body.data;

    expect(coverage.minGamesForRating).toBe(CONFIDENCE.minGames);
    expect(coverage.maxUncertaintyForRating).toBe(CONFIDENCE.maxUncertainty);
    expect(coverage.totalPlayers).toBe(LAUNCH_FIXTURE_DATA.players.length);
    // The launch state: a handful rated, most of the base provisional.
    expect(coverage.ratedPlayers).toBeGreaterThan(0);
    expect(coverage.ratedPlayers).toBeLessThan(coverage.totalPlayers / 2);
    expect(coverage.ratedPlayers + coverage.provisionalPlayers).toBe(coverage.totalPlayers);
    expect(coverage.coverageComplete).toBe(true);
  });

  it('ranks only players whose rating is fit to publish', async () => {
    const { body } = await get('/api/rankings?limit=100');
    const entries = body.data.entries as Array<{
      rank: number | null;
      provisional: boolean;
      provisionalReason: string | null;
    }>;

    const rated = entries.filter((entry) => !entry.provisional);
    const provisional = entries.filter((entry) => entry.provisional);

    expect(rated.map((entry) => entry.rank)).toEqual(rated.map((_, index) => index + 1));
    expect(provisional.every((entry) => entry.rank === null)).toBe(true);
    expect(provisional.every((entry) => entry.provisionalReason !== null)).toBe(true);
  });

  it('explains a withheld rating with the reason it was withheld', async () => {
    const { body } = await get('/api/rankings?limit=100');
    const reasons = new Set(
      (body.data.entries as Array<{ provisionalReason: string | null }>)
        .map((entry) => entry.provisionalReason)
        .filter(Boolean)
    );
    expect(reasons).toContain('too-few-games');
    expect(reasons).toContain('uncertainty-too-wide');
    expect(reasons).toContain('no-rating');
  });

  it('carries component info so no cross-region comparison looks meaningful', async () => {
    const { body } = await get('/api/rankings?scope=component:c-bay');
    expect(body.data.component).toMatchObject({
      componentId: 'c-bay',
      regionLabel: 'San Francisco Bay Area',
      comparable: true,
    });
    expect(body.data.components.length).toBeGreaterThan(1);
  });

  it('counts a component\'s rated players by the same gate as its coverage', async () => {
    const { body } = await get('/api/rankings?scope=component:c-bay&limit=100');
    const bay = (body.data.components as Array<{ componentId: string; ratedPlayers: number }>).find(
      (component) => component.componentId === 'c-bay'
    );
    expect(bay?.ratedPlayers).toBe(body.data.coverage.ratedPlayers);
  });

  it('marks a component too small to order anyone as not comparable', async () => {
    const { body } = await get('/api/rankings?scope=component:c-sea');
    expect(body.data.component.componentSize).toBeLessThan(CONFIDENCE.minComponentSize);
    expect(body.data.component.comparable).toBe(false);
  });

  it('slices by set, using that set\'s own numbers', async () => {
    const { status, body } = await get('/api/rankings?scope=set:radiance&limit=100');
    expect(status).toBe(200);
    expect(body.data.scope.setId).toBe('radiance');
    expect(body.data.entries.length).toBeGreaterThan(0);

    const origins = await get('/api/rankings?scope=set:ogn&limit=100');
    // Only a couple of players played before Radiance shipped.
    expect(origins.body.data.entries.length).toBeLessThan(body.data.entries.length);
  });

  it('paginates with an opaque cursor', async () => {
    const first = await get('/api/rankings?limit=3');
    expect(first.body.data.entries).toHaveLength(3);
    expect(first.body.pagination.hasMore).toBe(true);

    const second = await get(`/api/rankings?limit=3&cursor=${encodeURIComponent(first.body.pagination.cursor)}`);
    expect(second.body.data.entries).toHaveLength(3);
    expect(second.body.data.entries[0].playerId).not.toBe(first.body.data.entries[0].playerId);
  });

  it('rejects a scope that is not one of the contract shapes', async () => {
    const { status, body } = await get('/api/rankings?scope=region:bay');
    expect(status).toBe(400);
    expect(body.error).toMatch(/Invalid scope/);
  });

  it('rejects an oversized limit', async () => {
    expect((await get('/api/rankings?limit=5000')).status).toBe(400);
  });

  it('answers a scope with no data as empty rather than as an error', async () => {
    const { status, body } = await get('/api/rankings?scope=set:does-not-exist');
    expect(status).toBe(200);
    expect(body.data.entries).toEqual([]);
    expect(body.data.coverage.ratedPlayers).toBe(0);
    expect(body.data.coverage.totalPlayers).toBe(0);
    expect(body.pagination.hasMore).toBe(false);
  });
});

describe('GET /api/rankings with no data at all', () => {
  it('serves an honest empty state before the engine has written anything', async () => {
    setRankingStore(createFixtureRankingStore(EMPTY_FIXTURE_DATA));
    try {
      const { status, body } = await get('/api/rankings');
      expect(status).toBe(200);
      expect(body.data.entries).toEqual([]);
      expect(body.data.components).toEqual([]);
      expect(body.data.coverage).toMatchObject({
        totalPlayers: 0,
        ratedPlayers: 0,
        provisionalPlayers: 0,
        totalGames: null,
        lastUpdated: null,
      });
    } finally {
      setRankingStore(fixtureRankingStore);
    }
  });
});

describe('GET /api/players/:playerId', () => {
  it('returns a profile with per-set ratings and component info', async () => {
    const { status, body } = await get('/api/players/p-kira');
    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      playerId: 'p-kira',
      displayName: 'Kirabosc',
      tagLine: 'NA1',
      componentId: 'c-bay',
      regionLabel: 'San Francisco Bay Area',
      comparable: true,
      provisional: false,
    });
    expect(body.data.setRatings.map((set: { setId: string }) => set.setId)).toEqual(['radiance', 'ogn']);
  });

  it('reports each set with its published name and release date', async () => {
    const { body } = await get('/api/players/p-kira');
    const sets = body.data.setRatings as Array<{ setId: string; releaseDate: string | null; setName: string | null }>;
    expect(sets.find((set) => set.setId === 'radiance')?.releaseDate).toBe('2026-10-23');
    expect(sets.find((set) => set.setId === 'ogn')).toMatchObject({
      setName: 'Origins',
      releaseDate: '2025-10-31',
    });
  });

  it('says why a rating is withheld, and how far off it is', async () => {
    const { body } = await get('/api/players/p-cyn');
    expect(body.data.provisional).toBe(true);
    expect(body.data.provisionalReason).toBe('too-few-games');
    expect(body.data.gamesUntilRated).toBe(CONFIDENCE.minGames - 2);
  });

  it('handles a player the engine has seen but never rated', async () => {
    const { body } = await get('/api/players/p-quill');
    expect(body.data).toMatchObject({ rating: null, provisional: true, provisionalReason: 'no-rating' });
    expect(body.data.setRatings).toEqual([]);
  });

  it('404s an unknown player and 400s an unusable id', async () => {
    expect((await get('/api/players/p-nobody')).status).toBe(404);
    expect((await get('/api/players/PLAYER%23x')).status).toBe(400);
  });

  it('marks player responses noindex', async () => {
    const { headers } = await get('/api/players/p-kira');
    expect(headers.get('x-robots-tag')).toMatch(/noindex/);
  });
});

describe('GET /api/players/:playerId/matches', () => {
  it('returns the match log with opponents and per-game outcomes', async () => {
    const { status, body } = await get('/api/players/p-kira/matches');
    expect(status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);

    const match = body.data[0];
    expect(match).toMatchObject({
      matchId: expect.any(String),
      opponentId: expect.any(String),
      opponentDisplayName: expect.any(String),
    });
    expect(['win', 'loss', 'draw', 'unknown']).toContain(match.outcome);
    expect(match.games.length).toBeGreaterThanOrEqual(2);
    expect(match.games.length).toBeLessThanOrEqual(3);
    expect(match.eventName).toBeTruthy();
    expect(match.shopId).toBeTruthy();
    expect(match.tournamentType).toBeTruthy();
  });

  it('is newest first and paginates', async () => {
    const first = await get('/api/players/p-kira/matches?limit=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.data[0].playedAt >= first.body.data[1].playedAt).toBe(true);
    expect(first.body.pagination.hasMore).toBe(true);

    const second = await get(`/api/players/p-kira/matches?limit=2&cursor=${encodeURIComponent(first.body.pagination.cursor)}`);
    expect(second.body.data[0].matchId).not.toBe(first.body.data[0].matchId);
  });

  it('filters to one set', async () => {
    const { body } = await get('/api/players/p-kira/matches?setId=ogn&limit=50');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((match: { setId: string }) => match.setId === 'ogn')).toBe(true);
  });

  it('agrees with the opponent\'s own match log', async () => {
    const mine = await get('/api/players/p-kira/matches?limit=50');
    const match = mine.body.data[0];
    const theirs = await get(`/api/players/${match.opponentId}/matches?limit=50`);
    const mirrored = theirs.body.data.find((entry: { matchId: string }) => entry.matchId === match.matchId);
    expect(mirrored).toBeTruthy();
    expect(mirrored.opponentId).toBe('p-kira');
    if (match.outcome === 'win') expect(mirrored.outcome).toBe('loss');
  });

  it('returns an empty log for a player with no matches', async () => {
    const { status, body } = await get('/api/players/p-quill/matches');
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.pagination.hasMore).toBe(false);
  });
});

describe('GET /api/players/:playerId/ratings', () => {
  it('returns an all-sets series by default', async () => {
    const { status, body } = await get('/api/players/p-kira/ratings');
    expect(status).toBe(200);
    expect(body.data.scope.raw).toBe('all');
    expect(body.data.points.length).toBeGreaterThan(1);
    expect(body.data.points[0]).toMatchObject({
      date: expect.any(String),
      rating: expect.any(Number),
    });
    // Dates ascend, so the chart can plot them as given.
    const dates = body.data.points.map((point: { date: string }) => point.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('carries uncertainty on every point, so the band can be drawn', async () => {
    const { body } = await get('/api/players/p-kira/ratings');
    expect(body.data.points.every((point: { uncertainty: number | null }) => point.uncertainty !== null)).toBe(true);
  });

  it('serves a per-set series', async () => {
    const { body } = await get('/api/players/p-kira/ratings?scope=set:radiance');
    expect(body.data.scope.setId).toBe('radiance');
    expect(body.data.points.length).toBeGreaterThan(0);
  });

  it('serves a one- or two-point series for a nearly unrated player, flagged provisional', async () => {
    const { status, body } = await get('/api/players/p-cyn/ratings');
    expect(status).toBe(200);
    expect(body.data.points.length).toBeLessThanOrEqual(2);
    expect(body.data.provisional).toBe(true);
    expect(body.data.provisionalReason).toBe('too-few-games');
  });

  it('returns no points rather than an error for an unrated player', async () => {
    const { status, body } = await get('/api/players/p-quill/ratings');
    expect(status).toBe(200);
    expect(body.data.points).toEqual([]);
    expect(body.data.provisional).toBe(true);
  });

  it('rejects a malformed scope', async () => {
    expect((await get('/api/players/p-kira/ratings?scope=nope')).status).toBe(400);
  });
});

describe('GET /api/players/search', () => {
  it('finds a player by display name', async () => {
    const { status, body } = await get('/api/players/search?q=kira');
    expect(status).toBe(200);
    expect(body.data[0]).toMatchObject({ playerId: 'p-kira', displayName: 'Kirabosc' });
  });

  it('is case-insensitive and matches a tagline too', async () => {
    expect((await get('/api/players/search?q=MARIGOLD')).body.data[0].playerId).toBe('p-mari');
    expect((await get('/api/players/search?q=EUW')).body.data[0].playerId).toBe('p-volto');
  });

  it('carries no personal data beyond what the contract holds', async () => {
    const { body } = await get('/api/players/search?q=kira');
    expect(Object.keys(body.data[0]).sort()).toEqual(
      ['displayName', 'gamesPlayed', 'playerId', 'provisional', 'rating', 'regionLabel', 'tagLine'].sort()
    );
  });

  it('refuses a one-character term and caps the result count', async () => {
    expect((await get('/api/players/search?q=a')).status).toBe(400);
    expect((await get('/api/players/search')).status).toBe(400);
    expect((await get('/api/players/search?q=a&limit=1000')).status).toBe(400);
  });

  it('returns nothing for a term that matches nobody', async () => {
    expect((await get('/api/players/search?q=zzzznobody')).body.data).toEqual([]);
  });

  it('is not shadowed by the :playerId route', async () => {
    expect((await get('/api/players/search?q=kira')).body.data).toBeInstanceOf(Array);
  });
});

describe('GET /api/sets', () => {
  it('lists the sets the engine has data for, newest dated set first', async () => {
    const { status, body } = await get('/api/sets');
    expect(status).toBe(200);
    expect(body.data.map((set: { setId: string }) => set.setId)).toEqual(['radiance', 'ogn']);
    expect(body.data[0]).toMatchObject({ setId: 'radiance', name: 'Radiance', releaseDate: '2026-10-23' });
    expect(body.data[1]).toMatchObject({ setId: 'ogn', releaseDate: '2025-10-31' });
  });

  it('is empty, not broken, when no set has rating data yet', async () => {
    setRankingStore(createFixtureRankingStore(EMPTY_FIXTURE_DATA));
    try {
      const { status, body } = await get('/api/sets');
      expect(status).toBe(200);
      expect(body.data).toEqual([]);
    } finally {
      setRankingStore(fixtureRankingStore);
    }
  });
});

describe('the calendar API is untouched', () => {
  it('still answers /api/health', async () => {
    expect((await get('/api/health')).status).toBe(200);
  });
});
