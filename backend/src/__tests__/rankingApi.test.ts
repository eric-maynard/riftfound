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

  it('never puts a provisional rating on a leaderboard row, in any scope', async () => {
    for (const scope of SCOPES) {
      const { body } = await get(`/api/rankings?scope=${encodeURIComponent(scope)}&limit=100`);
      const entries = body.data.entries as Array<{
        playerId: string;
        rating: number | null;
        provisional: boolean;
        provisionalReason: string | null;
        rank: number | null;
      }>;
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        // The one invariant: withheld and null are the same thing.
        expect(entry.rating === null).toBe(entry.provisional);
        if (entry.provisional) {
          expect(entry.provisionalReason).not.toBeNull();
          expect(entry.rank).toBeNull();
        }
      }
    }
  });

  it('keeps the margin and the counts on a withheld row - a width is not a position', async () => {
    const { body } = await get('/api/rankings?limit=100');
    const juno = (body.data.entries as Array<Record<string, unknown>>).find(
      (entry) => entry.playerId === 'p-juno'
    );

    expect(juno).toMatchObject({ rating: null, provisional: true, provisionalReason: 'too-few-games' });
    expect(juno!.uncertainty).toBeGreaterThan(0);
    expect(juno!.gamesPlayed).toBeGreaterThan(0);
    expect(juno!.matchesPlayed).toBeGreaterThan(0);
    expect(juno!.gamesUntilRated).toBeGreaterThan(0);
  });

  it('withholds the number on the profile too, and reads the same as the tournament endpoint', async () => {
    const { body } = await get('/api/players/p-juno');
    expect(body.data).toMatchObject({
      rating: null,
      provisional: true,
      provisionalReason: 'too-few-games',
    });
    expect(body.data.uncertainty).toBeGreaterThan(0);
    expect(body.data.gamesPlayed).toBeGreaterThan(0);
    expect(body.data.gamesUntilRated).toBeGreaterThan(0);

    // The two endpoints must not contradict each other about one player: this
    // is the inconsistency the gate was unified to remove.
    const tournament = await get('/api/events/48812/tournament');
    const fromEvent = (tournament.body.data.players as Array<{ playerId: string; rating: number | null; provisional: boolean }>)
      .find((player) => player.playerId === 'p-juno');
    expect(fromEvent).toMatchObject({ rating: null, provisional: true });
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
      expect(set.rating === null).toBe(set.provisional);
      if (set.provisional) expect(set.provisionalReason).not.toBeNull();
    }

    // The case that makes per-set gating necessary rather than cosmetic: this
    // player is rated all-time and provisional inside a set, because a set
    // slice holds fewer games and so carries a wider sigma.
    expect(body.data.provisional).toBe(false);
    const withheld = sets.find((set) => set.provisional);
    expect(withheld).toBeTruthy();
    expect(withheld!.rating).toBeNull();
    // Still explainable: the slice's own margin and counts survive.
    expect(withheld!.uncertainty).toBeGreaterThan(0);
    expect(withheld!.gamesPlayed).toBeGreaterThan(0);
  });

  it('withholds the series for a scope the player is provisional in', async () => {
    const profile = await get('/api/players/p-kira');
    const withheldSet = (profile.body.data.setRatings as Array<{ setId: string; provisional: boolean }>)
      .find((set) => set.provisional)!;

    const series = await get(`/api/players/p-kira/ratings?scope=set:${withheldSet.setId}`);
    expect(series.body.data.points).toEqual([]);
    expect(series.body.data.provisional).toBe(true);
    expect(series.body.data.pointsWithheld).toBe(true);

    // ...while the scope they *are* rated in still charts.
    const allTime = await get('/api/players/p-kira/ratings');
    expect(allTime.body.data.points.length).toBeGreaterThan(1);
    expect(allTime.body.data.provisional).toBe(false);
    expect(allTime.body.data.pointsWithheld).toBe(false);
  });

  it('withholds the number in player search too', async () => {
    const provisional = await get('/api/players/search?q=juno');
    expect(provisional.body.data[0]).toMatchObject({ playerId: 'p-juno', provisional: true, rating: null });

    const rated = await get('/api/players/search?q=kira');
    expect(rated.body.data[0].provisional).toBe(false);
    expect(typeof rated.body.data[0].rating).toBe('number');
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
    expect(sable).toMatchObject({ provisional: true, rating: null, rank: null });
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

  it('withholds a number its own arithmetic would have published', async () => {
    const { body } = await get('/api/rankings?limit=100');
    const entry = (body.data.entries as Array<Record<string, unknown>>).find(
      (row) => row.playerId === 'p-engine-withheld'
    )!;

    expect(entry).toMatchObject({ rating: null, provisional: true, rank: null });
    // The engine's vocabulary (`too-uncertain`) translated into this API's.
    expect(entry.provisionalReason).toBe('uncertainty-too-wide');
    expect(entry.uncertainty).toBe(40);
    expect(JSON.stringify(body)).not.toContain('1777');
  });

  it('publishes a number its own arithmetic would have withheld', async () => {
    const { body } = await get('/api/rankings?limit=100');
    const entry = (body.data.entries as Array<Record<string, unknown>>).find(
      (row) => row.playerId === 'p-engine-rated'
    )!;
    expect(entry).toMatchObject({ rating: 1301, provisional: false, provisionalReason: null, rank: 1 });
  });

  it('withholds it on the profile, in the per-set map and in the history', async () => {
    const profileResponse = await get('/api/players/p-engine-withheld');
    expect(profileResponse.body.data.rating).toBeNull();
    expect(profileResponse.body.data.setRatings[0]).toMatchObject({ setId: 'radiance', rating: null, provisional: true });
    expect(JSON.stringify(profileResponse.body)).not.toContain('1777');
    expect(JSON.stringify(profileResponse.body)).not.toContain('1766');

    const all = await get('/api/players/p-engine-withheld/ratings');
    expect(all.body.data.points).toEqual([]);
    expect(all.body.data.pointsWithheld).toBe(true);
    expect(JSON.stringify(all.body)).not.toContain('1777');

    const perSet = await get('/api/players/p-engine-withheld/ratings?scope=set:radiance');
    expect(perSet.body.data.points).toEqual([]);
    expect(JSON.stringify(perSet.body)).not.toContain('1766');

    const search = await get('/api/players/search?q=Withheld');
    expect(search.body.data[0]).toMatchObject({ playerId: 'p-engine-withheld', rating: null, provisional: true });
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
  it('still answers /api/health', async () => {
    expect((await get('/api/health')).status).toBe(200);
  });
});
