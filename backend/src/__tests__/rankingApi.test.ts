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
import type { PlayerRecord } from '../adapters/rankingStore.js';
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
    const { status, body, headers } = await get('/api/rankings');
    expect(status).toBe(200);
    expect(body.data.scope).toEqual({ raw: 'all', setId: null, componentId: null });
    expect(body.data.entries.length).toBeGreaterThan(0);

    // The cache header is the whole caching mechanism: CloudFront's /api/*
    // policies carry `default_ttl = 0` on purpose, so a route that stops
    // sending `s-maxage` quietly goes back to one Lambda invocation and four
    // DynamoDB round trips per visitor. An hour at the edge against a daily
    // refit; the reader's own copy is deliberately shorter than the shared one.
    // Asserted here rather than in a block of its own because the general rate
    // limiter is per-process and this suite already sits near its ceiling.
    expect(headers.get('cache-control')).toBe(
      'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
    );
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
    const { status, body, headers } = await get('/api/players/p-kira');
    expect(status).toBe(200);
    // Same freshness as the ladder - a profile comes out of the same refit, so
    // a page loading both must not be able to show two generations of it.
    expect(headers.get('cache-control')).toContain('s-maxage=3600');
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

  it('serves a no-rating profile for a player the engine has never seen, and 400s an unusable id', async () => {
    // Not a 404. The engine has no item for this id, but a player with no
    // recorded game still exists - that is most of a tournament field (every
    // one of 5 on one live upcoming event). The same id already answers 200 on
    // /matches and /ratings, so the profile answering 404 made the API
    // contradict itself.
    const { status, body } = await get('/api/players/p-nobody');
    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      playerId: 'p-nobody',
      known: false,
      rating: null,
      uncertainty: null,
      gamesPlayed: null,
      matchesPlayed: null,
      componentId: null,
      provisional: true,
      provisionalReason: 'no-rating',
      gamesUntilRated: CONFIDENCE.minGames,
    });
    expect(body.data.setRatings).toEqual([]);

    // A malformed id is still refused: never seen is not the same as unusable.
    expect((await get('/api/players/PLAYER%23x')).status).toBe(400);
  });

  it('separates "never seen" from "seen but unrated" by `known`, not by a status code', async () => {
    // Both read `no-rating` with a null rating, and only `known` tells them
    // apart: p-quill has a profile the engine wrote, p-nobody has none.
    const seen = await get('/api/players/p-quill');
    const never = await get('/api/players/p-nobody');

    expect([seen.status, never.status]).toEqual([200, 200]);
    expect(seen.body.data).toMatchObject({ known: true, provisionalReason: 'no-rating', rating: null });
    expect(never.body.data).toMatchObject({ known: false, provisionalReason: 'no-rating', rating: null });
    // The one that was seen still carries what the engine knows about them.
    expect(seen.body.data.displayName).toBeTruthy();
    expect(never.body.data.displayName).toBeNull();
  });

  it('answers all three player sub-resources consistently for an unseen id', async () => {
    // This is the incoherence the 404 created, pinned: a resource whose two
    // sub-resources exist cannot be absent.
    const profile = await get('/api/players/p-nobody');
    const matches = await get('/api/players/p-nobody/matches');
    const ratings = await get('/api/players/p-nobody/ratings');

    expect([profile.status, matches.status, ratings.status]).toEqual([200, 200, 200]);
    expect(matches.body.data).toEqual([]);
    expect(ratings.body.data.points).toEqual([]);
    // One verdict across all three.
    expect(ratings.body.data.provisionalReason).toBe('no-rating');
    expect(profile.body.data.provisionalReason).toBe('no-rating');
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

  it('serves no points for a nearly unrated player, with the verdict that says why', async () => {
    // The engine writes a history point per day of play whatever the verdict,
    // so a provisional player's series *is* the withheld rating. It is not
    // served at all; the verdict is, so the chart can explain itself.
    const { status, body } = await get('/api/players/p-cyn/ratings');
    expect(status).toBe(200);
    expect(body.data.points).toEqual([]);
    expect(body.data.provisional).toBe(true);
    expect(body.data.provisionalReason).toBe('too-few-games');
    expect(body.data.pointsWithheld).toBe(true);
    expect(body.data.gamesUntilRated).toBeGreaterThan(0);
  });

  it('returns no points rather than an error for an unrated player', async () => {
    const { status, body } = await get('/api/players/p-quill/ratings');
    expect(status).toBe(200);
    expect(body.data.points).toEqual([]);
    expect(body.data.provisional).toBe(true);
    // Nothing was withheld here - there is genuinely no history. The two
    // states look alike on the wire otherwise and want different copy.
    expect(body.data.pointsWithheld).toBe(false);
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
      [
        'displayName',
        'gamesPlayed',
        'gamesUntilRated',
        'playerId',
        'provisional',
        'provisionalReason',
        'rating',
        'regionLabel',
        'tagLine',
        // The margin travels with the number here too - a hit that showed a
        // rating without one would be the single unqualified rating in the API.
        'uncertainty',
      ].sort()
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
    const { status, body, headers } = await get('/api/sets');
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toContain('s-maxage=3600');
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

/**
 * The confidence gate, enforced on the way out.
 *
 * The product rule is that a rating below the bar is not *published*, so a
 * number in the JSON is published whatever a renderer then does with it. These
 * tests assert the absence of the number on every endpoint that could carry
 * one, and that nothing which explains the state - the margin, the game counts,
 * the games still needed - went with it.
 */
describe('the confidence gate is enforced server-side', () => {
  const SCOPES = ['all', 'set:radiance', 'set:ogn', 'component:c-bay', 'component:c-sea'];

  it('publishes every leaderboard rating with its margin, and ranks only the rated, in any scope', async () => {
    for (const scope of SCOPES) {
      const { body } = await get(`/api/rankings?scope=${encodeURIComponent(scope)}&limit=100`);
      const entries = body.data.entries as Array<{
        playerId: string;
        rating: number | null;
        uncertainty: number | null;
        provisional: boolean;
        provisionalReason: string | null;
        rank: number | null;
      }>;
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        // The invariant is no longer "provisional means no number". A
        // provisional player shows a rating and holds no *position*.
        if (entry.provisional) {
          expect(entry.provisionalReason).not.toBeNull();
          expect(entry.rank).toBeNull();
        } else {
          expect(typeof entry.rating).toBe('number');
          expect(entry.rank).not.toBeNull();
        }
        // The load-bearing one: a number never travels without its margin.
        if (entry.rating !== null) {
          expect(typeof entry.uncertainty).toBe('number');
        }
      }
    }
  });

  it('publishes a provisional rating with its margin, and no position', async () => {
    const { body } = await get('/api/rankings?limit=100');
    const juno = (body.data.entries as Array<Record<string, unknown>>).find(
      (entry) => entry.playerId === 'p-juno'
    );

    // The number is the answer; the margin is what qualifies it. "Unranked"
    // withheld the figure and told the reader nothing they could weigh.
    expect(juno).toMatchObject({ provisional: true, provisionalReason: 'too-few-games', rank: null });
    expect(typeof juno!.rating).toBe('number');
    expect(juno!.uncertainty).toBeGreaterThan(0);
    expect(juno!.gamesPlayed).toBeGreaterThan(0);
    expect(juno!.matchesPlayed).toBeGreaterThan(0);
    expect(juno!.gamesUntilRated).toBeGreaterThan(0);
  });

  it('publishes the same number on the profile as on the tournament endpoint', async () => {
    const { body } = await get('/api/players/p-juno');
    expect(body.data).toMatchObject({ provisional: true, provisionalReason: 'too-few-games' });
    expect(typeof body.data.rating).toBe('number');
    expect(body.data.uncertainty).toBeGreaterThan(0);
    expect(body.data.gamesPlayed).toBeGreaterThan(0);
    expect(body.data.gamesUntilRated).toBeGreaterThan(0);

    // The two endpoints must not contradict each other about one player: this
    // is the inconsistency the gate was unified to remove, and it holds the
    // same way now that the number is published rather than withheld.
    const tournament = await get('/api/events/48812/tournament');
    const fromEvent = (tournament.body.data.players as Array<{ playerId: string; rating: number | null; uncertainty: number | null; provisional: boolean }>)
      .find((player) => player.playerId === 'p-juno');
    expect(fromEvent).toMatchObject({
      rating: body.data.rating,
      uncertainty: body.data.uncertainty,
      provisional: true,
    });
  });

  it('gates every per-set entry on its own evidence, independently of the all-time one', async () => {
    const { body } = await get('/api/players/p-kira');
    const sets = body.data.setRatings as Array<{
      setId: string;
      rating: number | null;
      uncertainty: number | null;
      gamesPlayed: number | null;
      provisional: boolean;
      provisionalReason: string | null;
      gamesUntilRated: number;
    }>;

    for (const set of sets) {
      if (set.provisional) expect(set.provisionalReason).not.toBeNull();
      // One rule everywhere: a number never without its margin.
      if (set.rating !== null) expect(typeof set.uncertainty).toBe('number');
    }

    // The case that makes per-set gating necessary rather than cosmetic: this
    // player is rated all-time and provisional inside a set, because a set
    // slice holds fewer games and so carries a wider sigma. The verdict still
    // differs per era - what no longer differs is whether a number appears.
    expect(body.data.provisional).toBe(false);
    const provisionalSet = sets.find((set) => set.provisional);
    expect(provisionalSet).toBeTruthy();
    expect(typeof provisionalSet!.rating).toBe('number');
    // Still explainable: the slice's own margin and counts travel with it.
    expect(provisionalSet!.uncertainty).toBeGreaterThan(0);
    expect(provisionalSet!.gamesPlayed).toBeGreaterThan(0);
  });

  it('charts a provisional scope now that its rating is published', async () => {
    const profile = await get('/api/players/p-kira');
    const provisionalSet = (profile.body.data.setRatings as Array<{ setId: string; provisional: boolean }>)
      .find((set) => set.provisional)!;

    // The series used to be withheld because its last point reconstructed the
    // withheld headline. The headline is published, so there is nothing left
    // to reconstruct and the chart is just a chart.
    const series = await get(`/api/players/p-kira/ratings?scope=set:${provisionalSet.setId}`);
    expect(series.body.data.points.length).toBeGreaterThan(0);
    expect(series.body.data.provisional).toBe(true);
    expect(series.body.data.pointsWithheld).toBe(false);

    const allTime = await get('/api/players/p-kira/ratings');
    expect(allTime.body.data.points.length).toBeGreaterThan(1);
    expect(allTime.body.data.provisional).toBe(false);
    expect(allTime.body.data.pointsWithheld).toBe(false);
  });

  it('publishes the number in player search too, with its margin', async () => {
    const provisional = await get('/api/players/search?q=juno');
    expect(provisional.body.data[0]).toMatchObject({ playerId: 'p-juno', provisional: true });
    expect(typeof provisional.body.data[0].rating).toBe('number');
    expect(typeof provisional.body.data[0].uncertainty).toBe('number');
    expect(provisional.body.data[0].provisionalReason).toBe('too-few-games');

    const rated = await get('/api/players/search?q=kira');
    expect(rated.body.data[0].provisional).toBe(false);
    expect(typeof rated.body.data[0].rating).toBe('number');
    expect(typeof rated.body.data[0].uncertainty).toBe('number');
  });

  it('ranks and counts over the ratings, then withholds - never the other way round', async () => {
    const { body } = await get('/api/rankings?limit=100');
    const entries = body.data.entries as Array<{
      playerId: string;
      rank: number | null;
      rating: number | null;
      provisional: boolean;
    }>;

    const rated = entries.filter((entry) => !entry.provisional);
    // Dense 1..n in descending rating order: the order was computed before any
    // number was removed, so removing them cannot have reshuffled it.
    expect(rated.map((entry) => entry.rank)).toEqual(rated.map((_, index) => index + 1));
    expect(rated.map((entry) => entry.rating)).toEqual(
      [...rated.map((entry) => entry.rating as number)].sort((a, b) => b - a)
    );

    // p-sable has the highest raw rating in the fixture (1604) and is withheld
    // for a sigma of 168. Rank 1 is the best *rated* player, not the best
    // number, and p-sable occupies no position at all.
    const sable = entries.find((entry) => entry.playerId === 'p-sable')!;
    expect(sable).toMatchObject({ provisional: true, rank: null });
    // Its number is published now - which is exactly why the rank assertion
    // above matters more than it did: the highest rating on the page is not
    // rank 1, because the position is still earned on evidence.
    expect(sable.rating).toBe(1604);
    expect(entries.find((entry) => entry.rank === 1)!.playerId).toBe('p-kira');

    // Coverage counts the same population the ranks came from.
    expect(body.data.coverage.ratedPlayers).toBe(rated.length);
    expect(body.data.coverage.provisionalPlayers).toBe(entries.length - rated.length);
    expect(body.data.coverage.totalPlayers).toBe(entries.length);
    // Games are counted over everyone, rated or not - a game count is evidence,
    // not a position, so withholding must not change it.
    expect(body.data.coverage.totalGames).toBeGreaterThan(0);
  });
});

/**
 * The engine writes its own verdict onto the profile, and it is the authority:
 * its thresholds are measured from the posterior SD distribution it fitted, so
 * re-deriving one here from the numbers can only agree by coincidence.
 */
describe('the engine\'s verdict decides, not the API\'s own arithmetic', () => {
  const profile = (over: Partial<PlayerRecord>): PlayerRecord => ({
    playerId: 'p-x',
    displayName: 'X',
    tagLine: 'NA1',
    rating: null,
    uncertainty: null,
    gamesPlayed: null,
    matchesPlayed: null,
    firstSeen: '2026-10-01',
    lastSeen: '2026-10-20',
    componentId: 'c-bay',
    componentSize: 23,
    regionLabel: 'San Francisco Bay Area',
    // A scene is not the region: the Bay component spans two of them.
    sceneId: 'sf-berkeley',
    sceneLabel: 'San Francisco & Berkeley',
    setRatings: [],
    updatedAt: '2026-10-25T06:00:00.000Z',
    ...over,
  });

  // One player the API's own gate would publish and the engine withholds, and
  // one the API's gate would withhold and the engine publishes.
  const WITHHELD = profile({
    playerId: 'p-engine-withheld',
    displayName: 'Withheld',
    rating: 1777,
    uncertainty: 40,
    gamesPlayed: 40,
    matchesPlayed: 20,
    provisional: true,
    provisionalReason: 'too-uncertain',
    gamesUntilRated: null,
    setRatings: [
      {
        setId: 'radiance',
        rating: 1766,
        uncertainty: 44,
        gamesPlayed: 30,
        matchesPlayed: 15,
        provisional: true,
        provisionalReason: 'too-uncertain',
        gamesUntilRated: null,
      },
    ],
  });

  const PUBLISHED = profile({
    playerId: 'p-engine-rated',
    displayName: 'Published',
    rating: 1301,
    uncertainty: 200,
    gamesPlayed: 2,
    matchesPlayed: 1,
    provisional: false,
    provisionalReason: null,
    gamesUntilRated: null,
  });

  const DATA = {
    players: [WITHHELD, PUBLISHED],
    matches: {},
    ratings: {
      'p-engine-withheld': {
        all: [{ date: '2026-10-20', rating: 1777, uncertainty: 40, gamesPlayed: 40 }],
        'set:radiance': [{ date: '2026-10-20', rating: 1766, uncertainty: 44, gamesPlayed: 30 }],
      },
      'p-engine-rated': { all: [{ date: '2026-10-20', rating: 1301, uncertainty: 200, gamesPlayed: 2 }] },
    },
    boards: { all: ['p-engine-withheld', 'p-engine-rated'], 'set:radiance': ['p-engine-withheld'] },
  };

  beforeAll(() => setRankingStore(createFixtureRankingStore(DATA)));
  afterAll(() => setRankingStore(fixtureRankingStore));

  it('keeps the engine\'s verdict while publishing the number it withheld', async () => {
    const { body } = await get('/api/rankings?limit=100');
    const entry = (body.data.entries as Array<Record<string, unknown>>).find(
      (row) => row.playerId === 'p-engine-withheld'
    )!;

    // The verdict is still the engine's - this API's own arithmetic (40 sigma
    // over 40 games) would have called this player rated. What changed is that
    // a provisional verdict no longer removes the figure: it removes the rank.
    expect(entry).toMatchObject({ rating: 1777, provisional: true, rank: null });
    // The engine's vocabulary (`too-uncertain`) translated into this API's.
    expect(entry.provisionalReason).toBe('uncertainty-too-wide');
    expect(entry.uncertainty).toBe(40);
  });

  it('honours the engine\'s rated verdict but still applies the display floor', async () => {
    const { body } = await get('/api/rankings?limit=100');
    const entry = (body.data.entries as Array<Record<string, unknown>>).find(
      (row) => row.playerId === 'p-engine-rated'
    )!;
    // The engine published this one off two games. The verdict is honoured -
    // not provisional, and it holds rank 1 - but two games is below the display
    // floor, so the number itself is still the prior and is not shown. The two
    // thresholds are independent and this is where that shows.
    expect(entry).toMatchObject({ provisional: false, provisionalReason: null, rank: 1, rating: null });
  });

  it('publishes it on the profile, in the per-set map and in the history', async () => {
    const profileResponse = await get('/api/players/p-engine-withheld');
    expect(profileResponse.body.data.rating).toBe(1777);
    expect(profileResponse.body.data.uncertainty).toBe(40);
    expect(profileResponse.body.data.setRatings[0]).toMatchObject({
      setId: 'radiance',
      rating: 1766,
      uncertainty: 44,
      provisional: true,
    });

    const all = await get('/api/players/p-engine-withheld/ratings');
    expect(all.body.data.points.length).toBe(1);
    expect(all.body.data.points[0].rating).toBe(1777);
    expect(all.body.data.pointsWithheld).toBe(false);
    expect(all.body.data.provisional).toBe(true);

    const perSet = await get('/api/players/p-engine-withheld/ratings?scope=set:radiance');
    expect(perSet.body.data.points.length).toBe(1);
    expect(perSet.body.data.points[0].rating).toBe(1766);

    const search = await get('/api/players/search?q=Withheld');
    expect(search.body.data[0]).toMatchObject({
      playerId: 'p-engine-withheld',
      rating: 1777,
      uncertainty: 40,
      provisional: true,
    });
  });

  it('withholds the history of a player below the display floor', async () => {
    // Two games: the floor holds the figure back on the headline, so it has to
    // hold the series back too - its last point *is* the headline.
    const series = await get('/api/players/p-engine-rated/ratings');
    expect(series.body.data.points).toEqual([]);
    expect(series.body.data.pointsWithheld).toBe(true);
    expect(series.body.data.minGamesToPublishRating).toBe(3);
    expect(JSON.stringify(series.body)).not.toContain('1301');
  });

  it('never publishes a rating that does not exist, whatever the item claims', async () => {
    // `provisional: false` on a profile with no rating is a contradiction in
    // the data; "rated" is the one answer that cannot be right.
    setRankingStore(
      createFixtureRankingStore({
        players: [profile({ playerId: 'p-engine-empty', displayName: 'Empty', provisional: false, provisionalReason: null })],
        matches: {},
        ratings: {},
        boards: { all: ['p-engine-empty'] },
      })
    );
    try {
      const { body } = await get('/api/players/p-engine-empty');
      expect(body.data).toMatchObject({ rating: null, provisional: true, provisionalReason: 'no-rating' });
    } finally {
      setRankingStore(createFixtureRankingStore(DATA));
    }
  });
});

describe('the calendar API is untouched', () => {
  it('still answers /api/health, and never from a cache', async () => {
    const { status, headers } = await get('/api/health');
    expect(status).toBe(200);
    // A health check answered from an edge cache is not a health check.
    expect(headers.get('cache-control')).toBe('no-store');
  });
});

/**
 * The two thresholds, end to end, on a fixture built to sit either side of
 * each. They are independent and conflating them is the mistake this block
 * exists to catch.
 */
describe('the display floor and the rank gate are different thresholds', () => {
  const player = (over: Partial<PlayerRecord>): PlayerRecord => ({
    playerId: 'p-x',
    displayName: 'X',
    tagLine: 'NA1',
    rating: null,
    uncertainty: null,
    gamesPlayed: null,
    matchesPlayed: null,
    firstSeen: '2026-10-01',
    lastSeen: '2026-10-20',
    componentId: 'c-bay',
    componentSize: 23,
    regionLabel: 'San Francisco Bay Area',
    // A scene is not the region: the Bay component spans two of them.
    sceneId: 'sf-berkeley',
    sceneLabel: 'San Francisco & Berkeley',
    setRatings: [],
    updatedAt: '2026-10-25T06:00:00.000Z',
    ...over,
  });

  // One game either side of the floor, with everything else held equal, so the
  // only thing that can explain a difference is the floor itself.
  const BELOW = player({
    playerId: 'p-floor-below',
    displayName: 'Below',
    rating: 1207,
    uncertainty: 130,
    gamesPlayed: 2,
    matchesPlayed: 1,
  });
  const AT = player({
    playerId: 'p-floor-at',
    displayName: 'At',
    rating: 1232,
    uncertainty: 122,
    gamesPlayed: 3,
    matchesPlayed: 2,
  });
  // Past the floor and past the gate: a number and a position.
  const RATED = player({
    playerId: 'p-floor-rated',
    displayName: 'Rated',
    rating: 1340,
    uncertainty: 95,
    gamesPlayed: 12,
    matchesPlayed: 6,
  });

  const DATA = {
    players: [BELOW, AT, RATED],
    matches: {},
    ratings: {
      'p-floor-below': { all: [{ date: '2026-10-20', rating: 1207, uncertainty: 130, gamesPlayed: 2 }] },
      'p-floor-at': { all: [{ date: '2026-10-20', rating: 1232, uncertainty: 122, gamesPlayed: 3 }] },
    },
    boards: { all: ['p-floor-below', 'p-floor-at', 'p-floor-rated'] },
  };

  beforeAll(() => setRankingStore(createFixtureRankingStore(DATA)));
  afterAll(() => setRankingStore(fixtureRankingStore));

  const row = async (playerId: string) => {
    const { body } = await get('/api/rankings?limit=100');
    return (body.data.entries as Array<Record<string, unknown>>).find((entry) => entry.playerId === playerId)!;
  };

  it('withholds the number at two games and publishes it at three', async () => {
    // Two games is 1200-with-noise: the posterior has barely moved off the
    // prior (median SD 130 against a prior SD of 150), so there is nothing to
    // show. Three is where the figure starts responding to results.
    const below = await row('p-floor-below');
    expect(below.rating).toBeNull();
    expect(below.uncertainty).toBe(130);
    expect(below.gamesPlayed).toBe(2);

    const at = await row('p-floor-at');
    expect(at.rating).toBe(1232);
    expect(at.uncertainty).toBe(122);
    expect(at.gamesPlayed).toBe(3);
  });

  it('gives neither of them a rank, and publishes the floor it used', async () => {
    expect((await row('p-floor-below')).rank).toBeNull();
    expect((await row('p-floor-at')).rank).toBeNull();
    // Past the floor is not past the gate: 3 games, 8 needed.
    expect(await row('p-floor-at')).toMatchObject({
      provisional: true,
      provisionalReason: 'too-few-games',
      gamesUntilRated: CONFIDENCE.minGames - 3,
    });

    // Only the player past the gate holds a position.
    expect(await row('p-floor-rated')).toMatchObject({ rank: 1, provisional: false, rating: 1340 });

    const { body } = await get('/api/rankings?limit=100');
    expect(body.data.coverage.minGamesToPublishRating).toBe(3);
    expect(body.data.coverage.minGamesForRating).toBe(CONFIDENCE.minGames);
    // The ranks and the counts came off the ratings before the floor ran.
    expect(body.data.coverage.ratedPlayers).toBe(1);
    expect(body.data.coverage.provisionalPlayers).toBe(2);
    expect(body.data.coverage.totalPlayers).toBe(3);
  });

  it('applies the same floor to the profile, the search hit and the history', async () => {
    const below = await get('/api/players/p-floor-below');
    expect(below.body.data).toMatchObject({ known: true, rating: null, uncertainty: 130 });
    const at = await get('/api/players/p-floor-at');
    expect(at.body.data).toMatchObject({ known: true, rating: 1232, uncertainty: 122 });

    const searchBelow = await get('/api/players/search?q=Below');
    expect(searchBelow.body.data[0]).toMatchObject({ rating: null, uncertainty: 130 });
    const searchAt = await get('/api/players/search?q=At');
    expect(searchAt.body.data[0]).toMatchObject({ rating: 1232, uncertainty: 122 });

    const historyBelow = await get('/api/players/p-floor-below/ratings');
    expect(historyBelow.body.data.points).toEqual([]);
    expect(historyBelow.body.data.pointsWithheld).toBe(true);

    const historyAt = await get('/api/players/p-floor-at/ratings');
    expect(historyAt.body.data.points.length).toBe(1);
    expect(historyAt.body.data.pointsWithheld).toBe(false);
  });

  it('never publishes a rating without its uncertainty, anywhere', async () => {
    // `uncertainty` is now the only thing separating a settled rating from an
    // unsettled one, so a number without it is a bare figure wearing the word
    // "rating". The pairing is enforced at the publish boundary.
    const { body } = await get('/api/rankings?limit=100');
    for (const entry of body.data.entries as Array<Record<string, unknown>>) {
      if (entry.rating !== null) expect(typeof entry.uncertainty).toBe('number');
    }

    const noMargin = createFixtureRankingStore({
      ...DATA,
      players: [player({ playerId: 'p-no-margin', displayName: 'NoMargin', rating: 1400, uncertainty: null, gamesPlayed: 20, matchesPlayed: 10 })],
      boards: { all: ['p-no-margin'] },
      ratings: {},
    });
    setRankingStore(noMargin);
    try {
      const profile = await get('/api/players/p-no-margin');
      // The engine fitted a number but no margin: not publishable, because the
      // margin is what the decision to publish rests on.
      expect(profile.body.data.rating).toBeNull();
      expect(profile.body.data.uncertainty).toBeNull();
      expect(JSON.stringify(profile.body)).not.toContain('1400');
    } finally {
      setRankingStore(createFixtureRankingStore(DATA));
    }
  });
});

/**
 * The three provisional states as the profile endpoint reports them. The
 * frontend branches on `provisionalReason` - `too-few-games` draws the games
 * meter, the others do not - so a reason that names the wrong obstacle is a
 * missing progress indicator, not just wrong prose.
 */
describe('provisionalReason, end to end, for all three states', () => {
  const base: PlayerRecord = {
    playerId: 'p-x',
    displayName: 'X',
    tagLine: 'NA1',
    rating: null,
    uncertainty: null,
    gamesPlayed: null,
    matchesPlayed: null,
    firstSeen: '2026-10-01',
    lastSeen: '2026-10-20',
    componentId: 'c-bay',
    componentSize: 23,
    regionLabel: 'San Francisco Bay Area',
    // A scene is not the region: the Bay component spans two of them.
    sceneId: 'sf-berkeley',
    sceneLabel: 'San Francisco & Berkeley',
    setRatings: [],
    updatedAt: '2026-10-25T06:00:00.000Z',
  };

  // Known, six games, a fitted sigma, and no rating on the item - the exact
  // live shape that reported `no-rating` while sitting two games off the bar.
  const SHORT = { ...base, playerId: 'p-short', displayName: 'Short', rating: null, uncertainty: 100, gamesPlayed: 6, matchesPlayed: 3 };
  const WIDE = { ...base, playerId: 'p-wide', displayName: 'Wide', rating: 1480, uncertainty: 210, gamesPlayed: 20, matchesPlayed: 10 };

  beforeAll(() =>
    setRankingStore(
      createFixtureRankingStore({ players: [SHORT, WIDE], matches: {}, ratings: {}, boards: { all: ['p-short', 'p-wide'] } })
    )
  );
  afterAll(() => setRankingStore(fixtureRankingStore));

  it('never seen -> no-rating, and known: false', async () => {
    const { body } = await get('/api/players/p-ghost');
    expect(body.data).toMatchObject({
      known: false,
      rating: null,
      gamesPlayed: null,
      provisional: true,
      provisionalReason: 'no-rating',
      gamesUntilRated: CONFIDENCE.minGames,
    });
  });

  it('known but short of the games bar -> too-few-games, with the games left to go', async () => {
    const { body } = await get('/api/players/p-short');
    expect(body.data).toMatchObject({
      known: true,
      provisional: true,
      provisionalReason: 'too-few-games',
      gamesPlayed: 6,
      uncertainty: 100,
      gamesUntilRated: CONFIDENCE.minGames - 6,
    });
  });

  it('known with games but too wide a margin -> uncertainty-too-wide', async () => {
    const { body } = await get('/api/players/p-wide');
    expect(body.data).toMatchObject({
      known: true,
      provisional: true,
      provisionalReason: 'uncertainty-too-wide',
      rating: 1480,
      uncertainty: 210,
      // Not a games problem, so the meter has nothing to count down.
      gamesUntilRated: 0,
    });
  });
});

/**
 * The Global scope carries positions.
 *
 * It used not to, and the suppression was the wrong shape of honesty: Global is
 * the landing scope, so a reader's first sight of the ladder was a page with no
 * left-hand column and a banner explaining why. The order exists - the engine
 * publishes a global board with ranks on it - and an order that exists is
 * better reported with its caveat than withheld.
 *
 * The caveat is real and this block pins the part of it the API owes. Measured
 * on the live corpus: **0 of 56,257 recorded games cross a scene** - a scene is
 * a connected component of the co-play graph, so a game between two of them
 * would merge them - across 1,235 scenes, 369 of which appear on the global
 * board and 15 of which appear in its top 25. So every scene's level rests on
 * the 1,200 prior alone, and `sceneComparable` says only that a row's own
 * internal order is real. Nothing says a comparison *between* two rows of
 * different scenes is, because nothing in the data does.
 */
describe('the Global scope has positions, with the gate still on each row', () => {
  const player = (over: Partial<PlayerRecord>): PlayerRecord => ({
    playerId: 'p-x',
    displayName: 'X',
    tagLine: 'NA1',
    rating: null,
    uncertainty: null,
    gamesPlayed: null,
    matchesPlayed: null,
    firstSeen: '2026-10-01',
    lastSeen: '2026-10-20',
    componentId: 'c-bay',
    componentSize: 23,
    regionLabel: 'San Francisco Bay Area',
    // A scene is not the region: the Bay component spans two of them.
    sceneId: 'sf-berkeley',
    sceneLabel: 'San Francisco & Berkeley',
    setRatings: [],
    updatedAt: '2026-10-25T06:00:00.000Z',
    ...over,
  });

  // Two settled players in two scenes that have never met, plus one settled
  // player in a scene too small to order anyone, plus one provisional. The
  // only thing separating the third from the first two is its scene's size.
  const BAY = player({ playerId: 'p-g-bay', displayName: 'Bayward', rating: 1480, uncertainty: 95, gamesPlayed: 14, matchesPlayed: 7 });
  const SING = player({
    playerId: 'p-g-sing',
    displayName: 'Singa',
    rating: 1534,
    uncertainty: 94,
    gamesPlayed: 15,
    matchesPlayed: 15,
    componentId: 'c-sing',
    componentSize: 4654,
    regionLabel: 'Central Singapore Community Development Council, 01',
  });
  const TINY = player({
    playerId: 'p-g-tiny',
    displayName: 'Tinyscene',
    // The highest rating of the four, deliberately: if the scene gate were not
    // applied this row would take position 1 off a four-player scene.
    rating: 1620,
    uncertainty: 90,
    gamesPlayed: 20,
    matchesPlayed: 10,
    componentId: 'c-tiny',
    componentSize: 4,
    regionLabel: 'Ketchikan, AK',
  });
  const SOON = player({ playerId: 'p-g-soon', displayName: 'Soonish', rating: 1511, uncertainty: 140, gamesPlayed: 5, matchesPlayed: 3 });

  const DATA = {
    players: [TINY, SING, BAY, SOON],
    matches: {},
    ratings: {},
    boards: { all: ['p-g-tiny', 'p-g-sing', 'p-g-bay', 'p-g-soon'] },
  };

  // One request for the whole block, held here: the app's general rate limiter
  // is per-process, and a `get` inside every assertion exhausts it.
  let global: {
    entries: Array<Record<string, unknown>>;
    coverage: Record<string, unknown>;
  };
  let tinyScope: Record<string, unknown>;

  beforeAll(async () => {
    setRankingStore(createFixtureRankingStore(DATA));
    global = (await get('/api/rankings?limit=100')).body.data;
    tinyScope = (await get('/api/rankings?scope=component:c-tiny&limit=100')).body.data;
  });
  afterAll(() => setRankingStore(fixtureRankingStore));

  const row = (playerId: string) => global.entries.find((entry) => entry.playerId === playerId)!;

  it('places settled players across scenes, in rating order', () => {
    // The scope mixes scenes and still orders them. Singapore outranks the Bay
    // on the number, which is the whole point: a position is published.
    expect(row('p-g-sing')).toMatchObject({ rank: 1, rating: 1534, sceneComparable: true });
    expect(row('p-g-bay')).toMatchObject({ rank: 2, rating: 1480, sceneComparable: true });
  });

  it('withholds a global position from a scene too small to order anyone', () => {
    // The promise: no position here that the player would not get at home.
    // 1,620 is the best number on the page and takes no place at all.
    expect(row('p-g-tiny')).toMatchObject({
      rating: 1620,
      rank: null,
      sceneComparable: false,
      // Still rated: the scene is a *comparison* problem, not an evidence one,
      // so the number and the margin are published exactly as before.
      provisional: false,
      provisionalReason: null,
    });
  });

  it('withholds a global position from an unsettled rating, as a scene would', () => {
    expect(row('p-g-soon')).toMatchObject({
      rating: 1511,
      rank: null,
      sceneComparable: true,
      provisional: true,
      provisionalReason: 'too-few-games',
    });
  });

  it('counts the too-small player as rated, because "rated" is about evidence', () => {
    // Coverage must not move with a comparability rule: the scene gate decides
    // a position, and `ratedPlayers` is the count of published settled ratings.
    expect(global.coverage.ratedPlayers).toBe(3);
    expect(global.coverage.provisionalPlayers).toBe(1);
    expect(global.coverage.totalPlayers).toBe(4);
    // And the positions are dense over the placed rows only - 1 and 2, with no
    // gap where the suppressed row would have sat.
    expect(global.entries.map((entry) => entry.rank).filter((rank) => rank !== null)).toEqual([1, 2]);
  });

  it('reports every row\'s scene, so a mixed ladder can name what it is mixing', () => {
    // The only caveat the API can carry per row. The cross-scene weakness is
    // not expressible as a number: the engine's own `crossComponentUncertainty`
    // widens the margin by a median of 1.2 points on the live board (ratio
    // 1.011), because the model pins a 4,654-player scene's mean to +-2.2 off
    // the 1,200 prior - which would read as "1% less certain" for a comparison
    // nothing in the data identifies at all.
    for (const entry of global.entries) {
      expect(typeof entry.sceneComparable).toBe('boolean');
      expect(entry.componentId).toBeTruthy();
      expect(typeof entry.componentSize).toBe('number');
    }
    expect(row('p-g-sing').regionLabel).toContain('Singapore');
  });

  it('still suppresses the whole ladder for a scene scope too small to order', () => {
    // Unchanged, and the same rule read per row rather than per scope: asking
    // for the four-player scene by name gets its rating and no position.
    expect(tinyScope.component).toMatchObject({ componentId: 'c-tiny', comparable: false });
  });
});
