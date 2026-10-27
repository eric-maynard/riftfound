import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import app from '../app.js';
import { setRankingStore } from '../services/rankingService.js';
import { getTournament, setTournamentStore } from '../services/tournamentService.js';
import {
  createFixtureRankingStore,
  fixtureRankingStore,
} from '../adapters/rankingFixtureAdapter.js';
import type { RankingStore } from '../adapters/rankingStore.js';
import {
  createFixtureTournamentStore,
  fixtureTournamentStore,
  EMPTY_TOURNAMENT_FIXTURE_DATA,
} from '../adapters/tournamentFixtureAdapter.js';
import { CONFIDENCE } from '../models/ranking.js';
import { MAX_AVAILABILITY_IDS } from '../models/tournament.js';
import { startServer, getJson, type TestServer } from './helpers/server.js';

/**
 * The tournament endpoints, against the fixture stores.
 *
 * The two fixtures share player ids on purpose, so these tests exercise the
 * real join - facts keyed on Riot's UUID against the rating engine's profiles -
 * rather than a mock of it.
 */

let server: TestServer;

beforeAll(async () => {
  setRankingStore(fixtureRankingStore);
  setTournamentStore(fixtureTournamentStore);
  server = await startServer(app);
});

afterAll(async () => {
  setRankingStore(null);
  setTournamentStore(null);
  await server.close();
});

const get = (path: string) => getJson(server.url, path);

const PLAYED = '48812';
const UPCOMING = 'prb-upcoming-sanjose-1';
const LISTING_ONLY = '48666';
const TRIMMED = '48540';
const NO_FACTS = '48999';

describe('GET /api/events/:externalId/tournament - a played event', () => {
  it('serves the capture in the order a page renders it', async () => {
    const { status, body } = await get(`/api/events/${PLAYED}/tournament`);
    expect(status).toBe(200);

    const { event, results, roster, players, field, scene } = body.data;

    // The scene is part of the one response a page renders top to bottom, so
    // nothing re-derives "which scene is this" client side.
    expect(scene).toMatchObject({ status: 'scene', componentId: 'c-bay' });

    // Event info comes off the fact, not off the event row - the facts outlive
    // the rows, so a page still renders for an event that has aged out.
    expect(event).toMatchObject({
      externalId: PLAYED,
      eventType: 'Nexus Night',
      playFormat: 'CONSTRUCTED',
      shopExternalId: 1041,
    });
    expect(event.startDate).toBe('2026-10-22T02:00:00.000Z');

    expect(results.status).toBe('final');
    expect(results.roundCount).toBe(3);
    expect(results.trimmed).toBe(false);
    expect(roster.source).toBe('participants');
    expect(players.length).toBe(7);
    expect(field.totalPlayers).toBe(7);
  });

  it('resolves every standing to the player behind its team id', async () => {
    const { body } = await get(`/api/events/${PLAYED}/tournament`);
    const standings = body.data.results.standings as Array<{
      rank: number;
      teamId: string;
      matchWins: number | null;
      player: { playerId: string; displayName: string } | null;
    }>;

    expect(standings.map((standing) => standing.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(standings.every((standing) => standing.player !== null)).toBe(true);
    // Kirabosc won all three rounds in the fixture, so the join has to put them
    // first. A mis-wired teamId join would show up exactly here.
    expect(standings[0].player?.playerId).toBe('p-kira');
    expect(standings[0].matchWins).toBe(3);
  });

  it('carries the Swiss tiebreakers so a standings table needs no arithmetic', async () => {
    const { body } = await get(`/api/events/${PLAYED}/tournament`);
    const top = body.data.results.standings[0];
    expect(top.matchPoints).toBe(9);
    expect(typeof top.opponentMatchWinPct).toBe('number');
    expect(typeof top.gameWinPct).toBe('number');
    expect(typeof top.opponentGameWinPct).toBe('number');
  });

  it('attaches a rating to both sides of every pairing, and resolves byes', async () => {
    const { body } = await get(`/api/events/${PLAYED}/tournament`);
    const rounds = body.data.results.rounds as Array<{
      roundNumber: number;
      byeTeamIds: string[];
      byes: Array<{ playerId: string | null; displayName: string | null }>;
      matches: Array<{
        tableNumber: number | null;
        bye: boolean;
        sides: Array<{ teamId: string; outcome: string | null; gameWins: number; player: { playerId: string } | null }>;
        games: Array<{ number: number; winnerTeamId: string | null }>;
      }>;
    }>;

    expect(rounds.map((round) => round.roundNumber)).toEqual([1, 2, 3]);

    for (const round of rounds) {
      // Seven players, so every round has exactly one bye, and it is named.
      expect(round.byeTeamIds.length).toBe(1);
      expect(round.byes.length).toBe(1);
      expect(round.byes[0].displayName).toBeTruthy();

      for (const match of round.matches) {
        expect(match.sides.length).toBe(2);
        expect(match.sides.every((side) => side.player !== null)).toBe(true);
        expect(match.tableNumber).toBeGreaterThan(0);
        // Per-game detail survives the round trip.
        expect(match.games.length).toBeGreaterThan(0);
      }
    }

    const first = rounds[0].matches[0];
    expect(first.sides.map((side) => side.outcome)).toEqual(['win', 'loss']);
    expect(first.sides[0].gameWins).toBe(2);
  });

  it('normalises Riot\'s TIE to this API\'s one word for a draw', async () => {
    // Riot emits TIE and never DRAW - measured over 30 live captures: WIN 686,
    // LOSS 686, TIE 72, DRAW zero. A consumer matching on DRAW therefore
    // printed "no result" over a recorded draw whose own standings row read
    // 1D. The fixture carries TIE for exactly that reason.
    const { body } = await get(`/api/events/${PLAYED}/tournament`);
    const matches = (body.data.results.rounds as Array<{ matches: Array<{ sides: Array<{ teamId: string; outcome: string | null; rawOutcome: string | null }> }> }>)
      .flatMap((round) => round.matches);

    const drawn = matches.filter((match) => match.sides.every((side) => side.outcome === 'draw'));
    expect(drawn.length).toBe(1);
    // Normalised to one vocabulary, with Riot's own word still beside it.
    expect(drawn[0].sides.map((side) => side.rawOutcome)).toEqual(['TIE', 'TIE']);

    // Nothing leaks the upstream spelling, and nothing is left unreadable.
    const outcomes = new Set(matches.flatMap((match) => match.sides.map((side) => side.outcome)));
    expect([...outcomes].sort()).toEqual(['draw', 'loss', 'win']);
  });

  it('agrees with the standings about who drew', async () => {
    // The bug was one capture telling two stories: the pairing said "no
    // result" while the standings counted the same 1-1 as a draw. Same source,
    // so they have to agree.
    const { body } = await get(`/api/events/${PLAYED}/tournament`);
    const standings = body.data.results.standings as Array<{ teamId: string; matchDraws: number | null }>;
    const drawnTeams = (body.data.results.rounds as Array<{ matches: Array<{ sides: Array<{ teamId: string; outcome: string | null }> }> }>)
      .flatMap((round) => round.matches)
      .flatMap((match) => match.sides)
      .filter((side) => side.outcome === 'draw')
      .map((side) => side.teamId);

    expect(drawnTeams.length).toBe(2);
    for (const teamId of drawnTeams) {
      expect(standings.find((standing) => standing.teamId === teamId)?.matchDraws).toBe(1);
    }
    // And nobody else is carrying a draw the pairings do not show.
    const teamsWithDraws = standings.filter((standing) => (standing.matchDraws ?? 0) > 0).map((s) => s.teamId);
    expect(teamsWithDraws.sort()).toEqual([...drawnTeams].sort());
  });

  it('publishes a bye once, as a bye and not as a match', async () => {
    // The capture carries every bye twice: in `byeTeamIds` and again as a
    // synthesised `bye: true` match (`bye-<teamId>-r<n>`, the empty half a
    // `bye-opponent-...` team with no player). Serving both printed every bye
    // player twice. `byes` is the representation that survives - a bye is the
    // absence of a match, not one.
    const { body } = await get(`/api/events/${PLAYED}/tournament`);
    const rounds = body.data.results.rounds as Array<{
      byeTeamIds: string[];
      byes: Array<{ playerId: string | null; displayName: string | null }>;
      matches: Array<{ matchId: string; bye: boolean; sides: Array<{ teamId: string; player: unknown }> }>;
    }>;

    for (const round of rounds) {
      // Seven players, so one bye a round - named once, and nowhere else.
      expect(round.byeTeamIds.length).toBe(1);
      expect(round.byes.length).toBe(1);
      expect(round.matches.length).toBe(3);

      expect(round.matches.some((match) => match.bye)).toBe(false);
      // No synthetic id of any kind leaves the API.
      const ids = round.matches.flatMap((match) => [match.matchId, ...match.sides.map((side) => side.teamId)]);
      expect(ids.some((id) => id.startsWith('bye-'))).toBe(false);
      // And the bye player appears exactly once across the whole round.
      const byePlayer = round.byes[0].playerId;
      const inMatches = round.matches
        .flatMap((match) => match.sides)
        .filter((side) => (side.player as { playerId?: string } | null)?.playerId === byePlayer);
      expect(inMatches).toEqual([]);
    }
  });

  it('serves the pairings in table order, not capture order', async () => {
    // The store returns whatever Riot's software did - round 1 of the live
    // event arrives 7, 6, 4, 3, 2, 1, 5, and 21 of 87 live rounds are out of
    // order. Sorting here means every consumer gets the same order.
    const { body } = await get(`/api/events/${PLAYED}/tournament`);
    const rounds = body.data.results.rounds as Array<{ matches: Array<{ tableNumber: number | null }> }>;

    for (const round of rounds) {
      const tables = round.matches.map((match) => match.tableNumber);
      expect(tables).toEqual([...tables].sort((a, b) => (a as number) - (b as number)));
      expect(tables).toEqual([1, 2, 3]);
    }
  });

  it('publishes a provisional player\'s rating with its margin', async () => {
    const { body } = await get(`/api/events/${PLAYED}/tournament`);
    const players = body.data.players as Array<{
      playerId: string;
      rating: number | null;
      uncertainty: number | null;
      provisional: boolean;
      provisionalReason: string | null;
      known: boolean;
      gamesUntilRated: number;
    }>;

    for (const player of players) {
      if (player.provisional) {
        expect(player.provisionalReason).not.toBeNull();
      } else {
        expect(typeof player.rating).toBe('number');
        expect(player.provisionalReason).toBeNull();
      }
      // The one hard rule: a number never without its margin.
      if (player.rating !== null) expect(typeof player.uncertainty).toBe('number');
    }

    // The four states the fixture is built to cover.
    const byId = new Map(players.map((player) => [player.playerId, player]));
    expect(byId.get('p-kira')).toMatchObject({ known: true, provisional: false });
    // Provisional but above the floor: a number *and* a reason.
    expect(byId.get('p-juno')).toMatchObject({ known: true, provisional: true, provisionalReason: 'too-few-games' });
    expect(typeof byId.get('p-juno')!.rating).toBe('number');
    // Known, but the engine fitted nothing at all for them.
    expect(byId.get('p-quill')).toMatchObject({
      known: true,
      provisional: true,
      provisionalReason: 'no-rating',
      rating: null,
    });
    // Never seen.
    expect(byId.get('u-fieldguest-1')).toMatchObject({
      known: false,
      provisional: true,
      provisionalReason: 'no-rating',
      rating: null,
    });
  });

  it('carries the margin on a pairing side too, never a bare number', async () => {
    const { body } = await get(`/api/events/${PLAYED}/tournament`);
    const sides = (body.data.results.rounds as Array<{ matches: Array<{ sides: Array<{ player: { rating: number | null; uncertainty: number | null; provisional: boolean } | null }> }> }>)
      .flatMap((round) => round.matches)
      .flatMap((match) => match.sides)
      .map((side) => side.player)
      .filter((player): player is { rating: number | null; uncertainty: number | null; provisional: boolean } => player !== null);

    expect(sides.length).toBeGreaterThan(0);
    // A pairing row is the compact form, and it is exactly where a bare rating
    // would have appeared, so the margin rides along with it.
    expect(sides.every((player) => player.rating === null || typeof player.uncertainty === 'number')).toBe(true);
    // And a provisional side does show its number.
    expect(sides.some((player) => player.provisional && typeof player.rating === 'number')).toBe(true);
  });

  it('summarises strength of field over the rated players, with the sample size', async () => {
    const { body } = await get(`/api/events/${PLAYED}/tournament`);
    const field = body.data.field;
    const rated = (body.data.players as Array<{ rating: number | null; provisional: boolean }>)
      .filter((player) => !player.provisional)
      .map((player) => player.rating as number);

    expect(field.ratedPlayers).toBe(rated.length);
    expect(field.ratedSample).toBe(rated.length);
    expect(field.knownPlayers + field.unknownPlayers).toBe(field.totalPlayers);
    expect(field.ratedPlayers + field.provisionalPlayers).toBe(field.knownPlayers);
    expect(field.ratedShare).toBeCloseTo(rated.length / field.totalPlayers, 3);

    const mean = rated.reduce((sum, value) => sum + value, 0) / rated.length;
    expect(field.meanRating).toBeCloseTo(mean, 1);
    expect(field.topRating).toBe(Math.max(...rated));

    // The gates travel with the figures so a page can explain them.
    expect(field.minGamesForRating).toBe(CONFIDENCE.minGames);
    expect(field.maxUncertaintyForRating).toBe(CONFIDENCE.maxUncertainty);
    expect(field.minComponentSize).toBe(CONFIDENCE.minComponentSize);
  });
});

describe('GET /api/events/:externalId/tournament - an upcoming event', () => {
  it('serves the roster alone, which is the normal state before an event', async () => {
    const { status, body } = await get(`/api/events/${UPCOMING}/tournament`);
    expect(status).toBe(200);
    expect(body.data.results).toBeNull();
    expect(body.data.roster.source).toBe('registrants');
    expect(body.data.roster.entries.length).toBe(12);
    expect(body.data.event.tournamentId).toBe('upcoming-sanjose-1');
    // `scene` is on the payload even here, carrying its own reason: nothing
    // was paired, so there is no scene, and that is not a null to guess at.
    expect(body.data.scene.status).toBe('no-matches');
  });

  it('dates every signup, so a page can show the registration order', async () => {
    const { body } = await get(`/api/events/${UPCOMING}/tournament`);
    const entries = body.data.roster.entries as Array<{
      playerId: string;
      registeredAt: string | null;
      waitlistPosition: number | null;
      status: string | null;
      player: { playerId: string };
    }>;

    expect(entries.every((entry) => entry.registeredAt !== null)).toBe(true);
    const times = entries.map((entry) => Date.parse(entry.registeredAt as string));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // The enriched player is inline on the entry, keyed on the same uuid.
    expect(entries.every((entry) => entry.player.playerId === entry.playerId)).toBe(true);
    expect(entries.at(-1)).toMatchObject({ status: 'WAITLISTED', waitlistPosition: 1 });
  });

  it('previews the field honestly when almost nobody is rated', async () => {
    const { body } = await get(`/api/events/${UPCOMING}/tournament`);
    const field = body.data.field;

    expect(field.totalPlayers).toBe(12);
    // Two rated of twelve: the aggregate must not read as the field average.
    expect(field.ratedPlayers).toBe(2);
    expect(field.ratedSample).toBe(2);
    expect(field.ratedShare).toBeCloseTo(0.167, 3);
    expect(field.unknownPlayers).toBe(5);
    expect(field.provisionalPlayers).toBe(5);
    expect(field.meanRating).not.toBeNull();
    expect(field.medianRating).not.toBeNull();
  });

  it('reports no average at all when nothing in the field cleared the bar', async () => {
    const unrated = createFixtureTournamentStore({
      results: {},
      rosters: {
        'ev-unrated': {
          externalId: 'ev-unrated',
          tournamentId: null,
          eventStartDate: '2026-11-14T02:00:00.000Z',
          eventType: 'Nexus Night',
          playFormat: null,
          shopExternalId: 1041,
          latitude: 37.8716,
          longitude: -122.2727,
          source: 'registrants',
          playerCount: 2,
          capturedAt: '2026-11-13T03:00:00.000Z',
          entries: [
            {
              playerId: 'u-nobody-1',
              displayName: 'Nobody',
              tagLine: 'NA1',
              teamId: null,
              status: 'REGISTERED',
              checkedIn: false,
              waitlistPosition: null,
              registeredAt: '2026-11-10T18:00:00.000Z',
            },
            {
              playerId: 'p-quill',
              displayName: 'Quillon',
              tagLine: 'NA1',
              teamId: null,
              status: 'REGISTERED',
              checkedIn: false,
              waitlistPosition: null,
              registeredAt: '2026-11-10T19:00:00.000Z',
            },
          ],
        },
      },
    });

    setTournamentStore(unrated);
    try {
      const { status, body } = await get('/api/events/ev-unrated/tournament');
      expect(status).toBe(200);
      expect(body.data.field).toMatchObject({
        totalPlayers: 2,
        ratedPlayers: 0,
        ratedSample: 0,
        ratedShare: 0,
        meanRating: null,
        medianRating: null,
        topRating: null,
      });
    } finally {
      setTournamentStore(fixtureTournamentStore);
    }
  });
});

describe('GET /api/events/:externalId/tournament - edge states', () => {
  it('404s an event with neither results nor a roster', async () => {
    const { status, body } = await get(`/api/events/${NO_FACTS}/tournament`);
    expect(status).toBe(404);
    expect(body.error).toBeTruthy();
  });

  it('404s everything when no facts have been captured at all', async () => {
    setTournamentStore(createFixtureTournamentStore(EMPTY_TOURNAMENT_FIXTURE_DATA));
    try {
      const { status } = await get(`/api/events/${PLAYED}/tournament`);
      expect(status).toBe(404);
    } finally {
      setTournamentStore(fixtureTournamentStore);
    }
  });

  it('serves a listing-only capture as the fact it is, with nothing in it', async () => {
    const { status, body } = await get(`/api/events/${LISTING_ONLY}/tournament`);
    expect(status).toBe(200);
    expect(body.data.results).toMatchObject({ status: 'none', roundCount: 0 });
    expect(body.data.results.standings).toEqual([]);
    expect(body.data.roster).toBeNull();
    expect(body.data.field.totalPlayers).toBe(0);
  });

  it('keeps the standings when the pairings were trimmed out of the item', async () => {
    const { status, body } = await get(`/api/events/${TRIMMED}/tournament`);
    expect(status).toBe(200);
    expect(body.data.results.trimmed).toBe(true);
    expect(body.data.results.rounds).toEqual([]);
    expect(body.data.results.standings.length).toBe(4);
    expect(body.data.results.roundCount).toBe(9);
  });

  it('keeps a bye that arrived only as a match, rather than dropping it', async () => {
    // Across 87 live rounds the two shapes agreed every time, so this path is
    // insurance: dropping the synthesised match must not be able to lose a bye
    // whose `byeTeamIds` entry is missing. Silently losing one would be worse
    // than the duplicate was.
    const byeOnlyAsMatch = createFixtureTournamentStore({
      rosters: {},
      results: {
        'ev-bye-only': {
          externalId: 'ev-bye-only',
          tournamentId: null,
          eventStartDate: '2026-10-22T02:00:00.000Z',
          eventType: 'Nexus Night',
          playFormat: null,
          shopExternalId: 1041,
          latitude: 37.8716,
          longitude: -122.2727,
          status: 'final',
          roundCount: 1,
          playerCount: 1,
          openMatches: 0,
          trimmed: false,
          sourceUpdatedAt: null,
          capturedAt: '2026-10-22T08:12:00.000Z',
          players: [{ teamId: 'z-1', playerId: 'p-kira', displayName: 'Kirabosc', tagLine: 'NA1' }],
          standings: [],
          rounds: [
            {
              section: 0,
              roundNumber: 1,
              status: 'FINALIZED',
              // The capture forgot to list it.
              byeTeamIds: [],
              matches: [
                {
                  matchId: 'bye-z-1-r1',
                  tableNumber: null,
                  status: 'COMPLETED',
                  bye: true,
                  sides: [
                    { teamId: 'z-1', outcome: 'WIN', gameWins: 0 },
                    { teamId: 'bye-opponent-z-1', outcome: 'LOSS', gameWins: 0 },
                  ],
                  games: [],
                },
              ],
            },
          ],
        },
      },
    });

    setTournamentStore(byeOnlyAsMatch);
    try {
      const { status, body } = await get('/api/events/ev-bye-only/tournament');
      expect(status).toBe(200);
      const round = body.data.results.rounds[0];
      // Folded into the one representation, placeholder half discarded.
      expect(round.byeTeamIds).toEqual(['z-1']);
      expect(round.byes.length).toBe(1);
      expect(round.byes[0].playerId).toBe('p-kira');
      expect(round.matches).toEqual([]);
    } finally {
      setTournamentStore(fixtureTournamentStore);
    }
  });

  it('rejects a malformed event id', async () => {
    const { status } = await get('/api/events/not%20an%20id%2F../tournament');
    expect([400, 404]).toContain(status);
  });

  it('marks itself noindex - it lists named individuals', async () => {
    const { headers } = await get(`/api/events/${PLAYED}/tournament`);
    expect(headers.get('x-robots-tag')).toContain('noindex');

    // The facts arrive with the hourly scraper, so a quarter of an hour at the
    // edge is a rounding error on their cadence and the difference between one
    // origin hit and one per reader. CloudFront's /api/* cache policy has
    // `default_ttl = 0`, so this header is the only thing making the edge hold
    // anything at all.
    expect(headers.get('cache-control')).toBe(
      'public, max-age=300, s-maxage=900, stale-while-revalidate=3600'
    );
  });

  it('leaves the plain event routes alone', async () => {
    // The tournament router shares the /api/events prefix, so this is the
    // mount-order regression that matters: the events router must still see
    // everything the tournament routes do not match.
    const info = await get('/api/events/info');
    expect(info.status).toBe(200);
    expect(info.body.data).toHaveProperty('totalEvents');
    // And they keep the calendar's own, shorter freshness rather than the
    // facts': five minutes at the edge against an hourly scrape.
    expect(info.headers.get('cache-control')).toContain('s-maxage=300');
  });
});

describe('GET /api/events/tournament-availability', () => {
  it('answers for a mix of events in one call', async () => {
    const ids = [PLAYED, UPCOMING, LISTING_ONLY, TRIMMED, NO_FACTS];
    const { status, body } = await get(`/api/events/tournament-availability?ids=${ids.join(',')}`);
    expect(status).toBe(200);
    expect(body.meta).toEqual({ requested: ids.length, limit: MAX_AVAILABILITY_IDS });

    expect(Object.keys(body.data).sort()).toEqual([...ids].sort());

    expect(body.data[PLAYED]).toEqual({
      hasResults: true,
      resultsStatus: 'final',
      hasRoster: true,
      hasTournament: true,
      playerCount: 7,
    });
    // An upcoming event: a roster and no results. Still worth a trophy.
    expect(body.data[UPCOMING]).toEqual({
      hasResults: false,
      resultsStatus: null,
      hasRoster: true,
      hasTournament: true,
      playerCount: 12,
    });
    // A capture that holds nothing is not a page worth opening.
    expect(body.data[LISTING_ONLY]).toEqual({
      hasResults: false,
      resultsStatus: 'none',
      hasRoster: false,
      hasTournament: false,
      playerCount: null,
    });
    expect(body.data[TRIMMED]).toMatchObject({ hasResults: true, hasTournament: true });
    // Every requested id comes back, so a caller needs no null handling.
    expect(body.data[NO_FACTS]).toEqual({
      hasResults: false,
      resultsStatus: null,
      hasRoster: false,
      hasTournament: false,
      playerCount: null,
    });
  });

  it('caps the id count', async () => {
    const tooMany = Array.from({ length: MAX_AVAILABILITY_IDS + 1 }, (_, index) => `ev-${index}`);
    const { status, body } = await get(`/api/events/tournament-availability?ids=${tooMany.join(',')}`);
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain(String(MAX_AVAILABILITY_IDS));

    const atTheCap = tooMany.slice(0, MAX_AVAILABILITY_IDS);
    const ok = await get(`/api/events/tournament-availability?ids=${atTheCap.join(',')}`);
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body.data).length).toBe(MAX_AVAILABILITY_IDS);
  });

  it('rejects a missing, empty or malformed id list', async () => {
    expect((await get('/api/events/tournament-availability')).status).toBe(400);
    expect((await get('/api/events/tournament-availability?ids=')).status).toBe(400);
    expect((await get('/api/events/tournament-availability?ids=,,')).status).toBe(400);
    expect((await get('/api/events/tournament-availability?ids=48812,bad%2Fid')).status).toBe(400);
  });

  it('tolerates duplicate ids without duplicating the answer', async () => {
    const { status, body } = await get(
      `/api/events/tournament-availability?ids=${PLAYED},${PLAYED},${UPCOMING}`
    );
    expect(status).toBe(200);
    expect(Object.keys(body.data).length).toBe(2);
  });
});

/**
 * Which scene an event belongs to.
 *
 * Called through the service rather than over HTTP, deliberately: this suite
 * already sits near the general rate limiter's per-process ceiling, and these
 * are assertions about a derivation, not about a route. The route's own
 * contract - that `scene` is on the payload at all - is pinned in the played
 * and upcoming blocks above.
 */
describe('the scene an event belongs to', () => {
  it('reads the scene off the players who played, not off the field', async () => {
    const detail = await getTournament(PLAYED);
    // Seven in the field; six of them the engine has placed, and the seventh
    // (`u-fieldguest-1`) it has never seen - which is most of a real field.
    expect(detail?.scene).toEqual({
      status: 'scene',
      matchPlayers: 7,
      placedPlayers: 6,
      componentCount: 1,
      componentId: 'c-bay',
      regionLabel: 'San Francisco Bay Area',
      componentSize: 23,
      ratedPlayers: 6,
      comparable: true,
      playersInScene: 6,
    });
  });

  it('names the scene from the component, never from a player', async () => {
    const detail = await getTournament(PLAYED);
    // `PlayerRecord.regionLabel` is the *player's* home region and differs
    // between members of one scene - measured on the live board, one
    // 5,405-player component holds players labelled across four regions. The
    // label has to come off the component's own catalogue item, or the same
    // scene gets a different name on every event page and a different name
    // again on the ladder this links to.
    const catalogue = await fixtureRankingStore.getComponent!('c-bay');
    expect(detail?.scene.regionLabel).toBe(catalogue?.regionLabel);
  });

  it('claims no scene for an event with no recorded matches', async () => {
    // An upcoming event: a roster and nothing else. Every entry may be in a
    // different scene or in none, and this event is no evidence either way.
    const upcoming = await getTournament(UPCOMING);
    expect(upcoming?.roster?.entries.length).toBeGreaterThan(0);
    expect(upcoming?.scene).toMatchObject({
      status: 'no-matches',
      matchPlayers: 0,
      componentId: null,
      regionLabel: null,
      comparable: false,
    });

    // A finished event whose organiser never ran pairings - the ~29%. The
    // answer is the same one, and it is a fact rather than an error.
    const listingOnly = await getTournament(LISTING_ONLY);
    expect(listingOnly?.results?.status).toBe('none');
    expect(listingOnly?.scene.status).toBe('no-matches');
  });

  it('still finds the scene when the pairings were trimmed away', async () => {
    // `trimmed: true` drops the rounds to stay under DynamoDB's item limit and
    // keeps the standings whole, so a Swiss record is the only witness left
    // that anyone played at all.
    const detail = await getTournament(TRIMMED);
    expect(detail?.results?.trimmed).toBe(true);
    expect(detail?.results?.rounds).toEqual([]);
    expect(detail?.scene).toMatchObject({ status: 'scene', componentId: 'c-bay' });
    expect(detail?.scene.matchPlayers).toBeGreaterThan(0);
  });

  it('reports players it cannot place rather than inventing a scene', async () => {
    // The engine refits daily and places a player from the history it last
    // replayed, so a capture newer than the last refit has pairings full of
    // players with no component. That is "the ladder has not caught up", not
    // "this event has no scene", and the two have to be tellable apart.
    setRankingStore(createFixtureRankingStore({ players: [], matches: {}, boards: {}, ratings: {} }));
    try {
      const detail = await getTournament(PLAYED);
      expect(detail?.scene).toMatchObject({
        status: 'unplaced',
        matchPlayers: 7,
        placedPlayers: 0,
        componentCount: 0,
        componentId: null,
      });
    } finally {
      setRankingStore(fixtureRankingStore);
    }
  });

  it('survives a store with no component catalogue at all', async () => {
    // `getComponent` is optional on the store, like `listSceneCatalogue`, so a
    // deploy whose items predate the GSI1 keys has to come back with the scene
    // and no name rather than a 500. The size still arrives, because the
    // engine denormalises `componentSize` onto every profile.
    const noCatalogue: RankingStore = { ...fixtureRankingStore, getComponent: undefined };
    setRankingStore(noCatalogue);
    try {
      const detail = await getTournament(PLAYED);
      expect(detail?.scene).toMatchObject({
        status: 'scene',
        componentId: 'c-bay',
        regionLabel: null,
        componentSize: 23,
        ratedPlayers: null,
        comparable: true,
      });
    } finally {
      setRankingStore(fixtureRankingStore);
    }
  });

  it('names the dominant scene and says how many there were', async () => {
    // Reachable two ways: an event's pairings connect the players they pair
    // rather than all of them (one round of eight is four disjoint edges), and
    // a stale refit can leave two players here carrying the components they
    // had before this event. Four production events of 8-53 players and three
    // more of 5-15 all came back unanimous, so this is rare - but a payload
    // that could not say so would assert something it does not know.
    setTournamentStore(createFixtureTournamentStore(splitSceneFixture()));
    try {
      const detail = await getTournament(SPLIT);
      expect(detail?.scene).toMatchObject({
        status: 'scene',
        matchPlayers: 4,
        placedPlayers: 4,
        componentCount: 2,
        // c-bay has three of the four, so it wins; the count is what lets the
        // page qualify the claim.
        componentId: 'c-bay',
        playersInScene: 3,
      });
    } finally {
      setTournamentStore(fixtureTournamentStore);
    }
  });
});

/** One event pairing three Bay players against one Puget Sound player. */
const SPLIT = 'split-scene-1';

function splitSceneFixture() {
  const field = [
    { teamId: 's-1', playerId: 'p-kira', displayName: 'Kirabosc', tagLine: 'NA1' },
    { teamId: 's-2', playerId: 'p-volto', displayName: 'Voltomancer', tagLine: 'EUW' },
    { teamId: 's-3', playerId: 'p-mari', displayName: 'Marigold', tagLine: 'NA1' },
    { teamId: 's-4', playerId: 'p-adria', displayName: 'Adrian', tagLine: 'NA1' },
  ];
  const side = (teamId: string, outcome: string, gameWins: number) => ({ teamId, outcome, gameWins });

  return {
    results: {
      [SPLIT]: {
        externalId: SPLIT,
        tournamentId: null,
        eventStartDate: '2026-10-20T02:00:00.000Z',
        eventType: 'Nexus Night',
        playFormat: 'CONSTRUCTED',
        shopExternalId: 1041,
        latitude: 37.8716,
        longitude: -122.2727,
        status: 'final' as const,
        roundCount: 1,
        playerCount: 4,
        openMatches: 0,
        trimmed: false,
        sourceUpdatedAt: null,
        capturedAt: '2026-10-20T06:00:00.000Z',
        players: field,
        standings: field.map((player, index) => ({
          rank: index + 1,
          teamId: player.teamId,
          matchPoints: 3 - index,
          matchWins: index < 2 ? 1 : 0,
          matchLosses: index < 2 ? 0 : 1,
          matchDraws: 0,
          opponentMatchWinPct: null,
          gameWinPct: null,
          opponentGameWinPct: null,
        })),
        rounds: [
          {
            section: 0,
            roundNumber: 1,
            status: 'FINALIZED',
            byeTeamIds: [],
            matches: [
              {
                matchId: 'm-1',
                tableNumber: 1,
                status: 'COMPLETED',
                bye: false,
                sides: [side('s-1', 'WIN', 2), side('s-2', 'LOSS', 0)],
                games: [],
              },
              {
                matchId: 'm-2',
                tableNumber: 2,
                status: 'COMPLETED',
                bye: false,
                sides: [side('s-3', 'WIN', 2), side('s-4', 'LOSS', 1)],
                games: [],
              },
            ],
          },
        ],
      },
    },
    rosters: {},
  };
}
