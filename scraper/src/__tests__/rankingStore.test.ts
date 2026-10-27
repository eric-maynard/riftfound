import { describe, it, expect } from 'vitest';
// Must come before the ../database.js import: it chooses the backend. See the
// comment in that file.
import './helpers/sqliteEnv.js';
import {
  closePool,
  getLastRankingRefit,
  getPlayerMatchLog,
  getPlayerProfile,
  getPlayerRatingHistory,
  loadMatchLogMarkers,
  loadSceneAssignment,
  getRankingRows,
  saveRankingSnapshot,
  saveSceneAssignment,
  setLastRankingRefit,
  supportsRankingWrites,
} from '../database.js';
import { MATCH_LOG_VERSION, MODEL_VERSION } from '../ranking/items.js';
import type {
  PlayerMatchLogEntry,
  PlayerProfile,
  PlayerRatingPoint,
  RankingMeta,
  RankingRow,
  RankingSnapshot,
} from '../ranking/items.js';
import { ObservationBuilder } from '../ranking/observations.js';
import { buildEras, SET_TABLE } from '../ranking/sets.js';
import { buildSnapshot, DEFAULT_SNAPSHOT_OPTIONS } from '../ranking/snapshot.js';
import { refitDue } from '../ranking/pass.js';
import { SCENE_ASSIGNMENT_VERSION, type SceneAssignment } from '../ranking/scenes.js';
import type { EventResults } from '../database.js';

/**
 * Storage discipline for the derived rating items, against a real throwaway
 * SQLite file.
 *
 * The rules being pinned down are the ones a reader and a re-run depend on:
 * a refit is idempotent, a leaderboard row whose rank moved does not leave its
 * old row behind, a component that disappears does not leave a dangling scope,
 * the per-player match log is written once per event, the counts on a profile
 * agree with that player's match log, and nothing reaches a table without being
 * sanitised.
 */

function profile(overrides: Partial<PlayerProfile> = {}): PlayerProfile {
  return {
    playerId: 'uuid-1',
    displayName: 'Player One',
    tagLine: 'NA1',
    rating: 1620.5,
    provisionalRating: 1620.5,
    uncertainty: 95.2,
    uncertaintyLogOdds: 0.548,
    crossComponentUncertainty: 110.4,
    rated: true,
    provisional: false,
    provisionalReason: null,
    gamesUntilRated: null,
    gamesPlayed: 24,
    matchesPlayed: 18,
    wins: 12,
    losses: 5,
    draws: 1,
    firstSeen: '2026-10-01T12:00:00.000Z',
    lastSeen: '2026-10-24T18:00:00.000Z',
    componentId: 'cabc1234567',
    componentSize: 500,
    componentShare: 0.83,
    inGiantComponent: true,
    regionLabel: 'Oakland, CA',
    venueCount: 2,
    homeVenueId: 1234,
    sceneId: 'sdeadbeef01',
    sceneLabel: 'Oakland, CA',
    setRatings: {
      s4: {
        scope: 'set:s4',
        setEraId: 's4',
        label: 'Vendetta',
        rating: 1610,
        uncertainty: 99,
        crossComponentUncertainty: 112,
        gamesPlayed: 20,
        matchesPlayed: 15,
        wins: 10,
        losses: 4,
        draws: 1,
        rated: true,
        provisional: false,
        provisionalReason: null,
        gamesUntilRated: null,
        provisionalRating: 1610,
      },
    },
    generatedAt: '2026-10-25T00:00:00.000Z',
    modelVersion: MODEL_VERSION,
    thresholds: { minGames: 8, maxUncertainty: 120, minComponentSize: 8 },
    ...overrides,
  };
}

function point(overrides: Partial<PlayerRatingPoint> = {}): PlayerRatingPoint {
  return {
    playerId: 'uuid-1',
    scope: 'all',
    date: '2026-10-20',
    rating: 1580,
    uncertainty: 110,
    matchesPlayed: 9,
    gamesPlayed: 12,
    ...overrides,
  };
}

function logEntry(overrides: Partial<PlayerMatchLogEntry> = {}): PlayerMatchLogEntry {
  return {
    playerId: 'uuid-1',
    matchId: 'm-1',
    playedAt: '2026-10-20T18:00:00.000Z',
    opponentId: 'uuid-2',
    opponentDisplayName: 'Player Two',
    opponentTagLine: 'NA1',
    result: 'win',
    gameOutcomes: ['win', 'win'],
    gameWins: 2,
    gameLosses: 0,
    eventExternalId: 'prb-100',
    eventName: 'Thursday Nexus Night',
    tournamentType: 'Nexus Night',
    shopExternalId: 1234,
    latitude: 37.8,
    longitude: -122.27,
    eventDate: '2026-10-20',
    setId: 's4',
    ...overrides,
  };
}

function meta(scope: string, ratedPlayers: number, overrides: Partial<RankingMeta> = {}): RankingMeta {
  return {
    scope,
    label: scope,
    kind: 'all',
    setEraId: null,
    setAmbiguous: false,
    componentId: null,
    ratedPlayers,
    totalPlayers: 600,
    giantComponentShare: 0.955,
    componentSize: null,
    componentShare: null,
    regionLabel: null,
    positionsSuppressed: true,
    thresholds: { minGames: 8, maxUncertainty: 120, minComponentSize: 8 },
    generatedAt: '2026-10-25T00:00:00.000Z',
    modelVersion: MODEL_VERSION,
    ...overrides,
  };
}

function row(scope: string, rank: number, playerId = `uuid-${rank}`): RankingRow {
  return {
    scope,
    rank,
    playerId,
    displayName: `Player ${rank}`,
    tagLine: 'NA1',
    rating: 1700 - rank * 10,
    uncertainty: 90,
    crossComponentUncertainty: 100,
    gamesPlayed: 30,
    matchesPlayed: 20,
    wins: 14,
    losses: 5,
    draws: 1,
    componentId: 'cabc1234567',
    componentSize: 500,
    regionLabel: 'Oakland, CA',
    sceneId: 'sdeadbeef01',
    sceneLabel: 'Oakland, CA',
    suppressPosition: false,
  };
}

function snapshot(overrides: Partial<RankingSnapshot> = {}): RankingSnapshot {
  return {
    profiles: [profile()],
    history: [point()],
    matchLog: [logEntry()],
    matchLogEvents: ['prb-100'],
    rankings: [row('all', 1)],
    metas: [meta('all', 1)],
    components: [],
    sets: [],
    venues: [],
    scenes: [],
    ...overrides,
  };
}

describe('derived rating storage', () => {
  it('supports the SQLite backend, like the fact rows do', () => {
    expect(supportsRankingWrites()).toBe(true);
  });

  it('stores a refit under the keys the output contract names', async () => {
    const summary = await saveRankingSnapshot(snapshot(), MATCH_LOG_VERSION);
    expect(summary).toMatchObject({ profiles: 1, historyPoints: 1, matchLogEntries: 1, rankingRows: 1, metas: 1 });

    const stored = await getPlayerProfile('uuid-1');
    expect(stored).toMatchObject({
      playerId: 'uuid-1',
      rating: 1620.5,
      uncertainty: 95.2,
      componentId: 'cabc1234567',
      componentSize: 500,
      regionLabel: 'Oakland, CA',
      rated: true,
    });
    expect(stored?.setRatings.s4.scope).toBe('set:s4');
    expect(stored?.thresholds).toEqual({ minGames: 8, maxUncertainty: 120, minComponentSize: 8 });

    expect(await getPlayerRatingHistory('uuid-1', 'all')).toEqual([point()]);

    const log = await getPlayerMatchLog('uuid-1');
    expect(log).toHaveLength(1);
    // The denormalised fields are the reason this item exists: the per-player
    // page must not have to fan out to every opponent's profile.
    expect(log[0]).toMatchObject({
      opponentId: 'uuid-2',
      opponentDisplayName: 'Player Two',
      result: 'win',
      gameOutcomes: ['win', 'win'],
      eventExternalId: 'prb-100',
      eventName: 'Thursday Nexus Night',
      tournamentType: 'Nexus Night',
      shopExternalId: 1234,
      eventDate: '2026-10-20',
      setId: 's4',
    });

    // One item per player, rank in the key: the board reads back in rank order.
    const board = await getRankingRows('all');
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ rank: 1, playerId: 'uuid-1', suppressPosition: false });
  });

  it('is idempotent: the same snapshot written twice is one of everything', async () => {
    await saveRankingSnapshot(snapshot(), MATCH_LOG_VERSION);
    await saveRankingSnapshot(snapshot(), MATCH_LOG_VERSION);
    expect(await getPlayerMatchLog('uuid-1')).toHaveLength(1);
    expect(await getPlayerRatingHistory('uuid-1', 'all')).toHaveLength(1);
  });

  it('marks an event once the match log is written, so a refit does not re-emit it', async () => {
    await saveRankingSnapshot(snapshot({ matchLogEvents: ['prb-200'] }), MATCH_LOG_VERSION);
    expect(await loadMatchLogMarkers(['prb-200', 'prb-201'], MATCH_LOG_VERSION)).toEqual(new Set(['prb-200']));
    // A schema bump forces a rewrite: the version is what makes the marker safe.
    expect(await loadMatchLogMarkers(['prb-200'], MATCH_LOG_VERSION + 1)).toEqual(new Set());
  });

  it('reads a board back in rank order, with ranks past 9 sorting correctly', async () => {
    const scope = 'component:ordering';
    const ranks = [1, 2, 9, 10, 11, 100];
    await saveRankingSnapshot(
      snapshot({
        rankings: ranks.map(rank => row(scope, rank)),
        metas: [meta(scope, ranks.length, { kind: 'component', scope })],
      }),
      MATCH_LOG_VERSION
    );
    // Zero-padding is the whole point: unpadded, "10" sorts before "2".
    expect((await getRankingRows(scope)).map(entry => entry.rank)).toEqual(ranks);
  });

  it('removes a row whose rank moved, so a board has no duplicate players', async () => {
    const scope = 'component:moving';
    await saveRankingSnapshot(
      snapshot({
        rankings: [row(scope, 1, 'uuid-a'), row(scope, 2, 'uuid-b'), row(scope, 3, 'uuid-c')],
        metas: [meta(scope, 3, { kind: 'component', scope })],
      }),
      MATCH_LOG_VERSION
    );

    // uuid-c overtakes uuid-b, and uuid-a drops off the ladder entirely.
    const moved = await saveRankingSnapshot(
      snapshot({
        rankings: [row(scope, 1, 'uuid-c'), row(scope, 2, 'uuid-b')],
        metas: [meta(scope, 2, { kind: 'component', scope })],
      }),
      MATCH_LOG_VERSION
    );
    expect(moved.deletedRows).toBe(1);
    const board = await getRankingRows(scope);
    expect(board.map(entry => entry.playerId)).toEqual(['uuid-c', 'uuid-b']);
    expect(board.map(entry => entry.rank)).toEqual([1, 2]);
  });

  it('removes a whole scope when its component merges away', async () => {
    const gone = 'component:merged-away';
    await saveRankingSnapshot(
      snapshot({ rankings: [row(gone, 1)], metas: [meta(gone, 1, { kind: 'component', scope: gone })] }),
      MATCH_LOG_VERSION
    );
    expect(await getRankingRows(gone)).toHaveLength(1);

    const next = await saveRankingSnapshot(snapshot(), MATCH_LOG_VERSION);
    expect(next.deletedScopes).toBeGreaterThanOrEqual(1);
    expect(await getRankingRows(gone)).toHaveLength(0);
  });

  it('records when the refit last completed, for the cadence gate', async () => {
    await setLastRankingRefit('2026-10-25T00:00:00.000Z');
    expect(await getLastRankingRefit()).toBe('2026-10-25T00:00:00.000Z');
    expect(refitDue('2026-10-25T00:00:00.000Z', 24, new Date('2026-10-25T12:00:00.000Z'))).toBe(false);
    expect(refitDue('2026-10-25T00:00:00.000Z', 24, new Date('2026-10-26T00:00:00.000Z'))).toBe(true);
    expect(refitDue(null, 24)).toBe(true);
    expect(refitDue('not a date', 24)).toBe(true);
  });
});

describe('the snapshot builder', () => {
  const eras = buildEras();

  /** Two closed venues plus one bridging event, with enough games to rate. */
  function history(): EventResults[] {
    const events: EventResults[] = [];
    const teamId = (id: string, i: number) => `t-${id}-${i}`;
    const makeEvent = (id: string, day: number, players: string[], shop: number, type: string): EventResults => ({
      externalId: `prb-${id}`,
      tournamentId: id,
      eventStartDate: new Date(Date.UTC(2026, 9, day, 18)),
      eventType: type,
      playFormat: null,
      shopExternalId: shop,
      latitude: 37.8,
      longitude: -122.27,
      status: 'final',
      roundCount: 1,
      playerCount: players.length,
      openMatches: 0,
      players: players.map((playerId, i) => ({
        teamId: teamId(id, i),
        playerId,
        // A poisoned display name, to prove sanitisation reaches the items.
        name: playerId === 'uuid-a' ? 'Ace<script src="https://evil/x.js"></script>' : `Name ${playerId}`,
        tagLine: 'NA1',
      })),
      standings: [],
      rounds: [
        {
          section: 0,
          roundNumber: 1,
          status: 'FINALIZED',
          byeTeamIds: [],
          matches: players.flatMap((_, i) =>
            players.slice(i + 1).map((_unused, offset) => {
              const j = i + offset + 1;
              return {
                matchId: `${id}-${i}-${j}`,
                tableNumber: i + 1,
                status: 'COMPLETED',
                bye: false,
                sides: [
                  { teamId: teamId(id, i), outcome: 'WIN', gameWins: 2 },
                  { teamId: teamId(id, j), outcome: 'LOSS', gameWins: 0 },
                ],
                games: [
                  { number: 1, winnerTeamId: teamId(id, i) },
                  { number: 2, winnerTeamId: teamId(id, i) },
                ],
              };
            })
          ),
        },
      ],
      sourceUpdatedAt: null,
      capturedAt: '2026-10-25T00:00:00.000Z',
    });

    for (let day = 1; day <= 6; day++) {
      events.push(makeEvent(`north${day}`, day, ['uuid-a', 'uuid-b', 'uuid-c', 'uuid-d'], 10, 'Nexus Night'));
      events.push(makeEvent(`south${day}`, day, ['uuid-x', 'uuid-y', 'uuid-z', 'uuid-w'], 20, 'Nexus Night'));
    }
    return events;
  }

  function buildIt(options: Partial<Parameters<typeof buildSnapshot>[1]> = {}) {
    const builder = new ObservationBuilder(eras);
    for (const event of history()) builder.addResults(event);
    const observations = builder.finish();
    return {
      observations,
      ...buildSnapshot(observations, {
        ...DEFAULT_SNAPSHOT_OPTIONS,
        eras,
        venueLabels: new Map([
          ['shop:10', 'Oakland, CA'],
          ['shop:20', 'San Diego, CA'],
        ]),
        matchLogEvents: new Set(history().map(event => event.externalId)),
        setTable: SET_TABLE,
        whr: {},
        minComponentSize: 2,
        generatedAt: new Date('2026-10-25T00:00:00.000Z'),
        ...options,
      }),
    };
  }

  it('publishes a ladder per component as well as the global one', () => {
    const { snapshot: built } = buildIt();
    const scopes = built.metas.map(entry => entry.scope);
    expect(scopes).toContain('all');
    expect(scopes.filter(scope => scope.startsWith('component:'))).toHaveLength(2);
    const global = built.metas.find(entry => entry.scope === 'all')!;
    // The connectivity signal travels with the ladder, so a reader never has to
    // assume the giant component dominates.
    expect(global.giantComponentShare).toBeCloseTo(0.5, 10);
    for (const componentMeta of built.metas.filter(entry => entry.kind === 'component')) {
      expect(componentMeta.componentShare).toBeCloseTo(0.5, 10);
      expect(componentMeta.regionLabel).toMatch(/Oakland, CA|San Diego, CA/);
    }
  });

  it('emits a profile for everyone with a match and rates only those past the bar', () => {
    const { snapshot: built } = buildIt();
    expect(built.profiles).toHaveLength(8);
    for (const stored of built.profiles) {
      expect(stored.gamesPlayed).toBeGreaterThan(0);
      expect(stored.rated).toBe(stored.rating !== null);
      // The honest number is always there even when the public one is not.
      expect(stored.provisionalRating).toBeGreaterThan(0);
      expect(stored.uncertainty).toBeGreaterThan(0);
      // A cross-component comparison is wider than a within-component one.
      expect(stored.crossComponentUncertainty).toBeGreaterThan(stored.uncertainty);
    }
  });

  it('withholds a rating below the bar but keeps the profile', () => {
    const { snapshot: built } = buildIt({ minGames: 1000 });
    expect(built.profiles).toHaveLength(8);
    expect(built.profiles.every(stored => stored.rating === null)).toBe(true);
    expect(built.profiles.every(stored => stored.rated === false)).toBe(true);
    // No chart points and no ladder rows for an unrated player.
    expect(built.history).toHaveLength(0);
    expect(built.rankings).toHaveLength(0);
  });

  it('writes two match log entries per match, one from each side', () => {
    const { snapshot: built, observations } = buildIt();
    expect(built.matchLog).toHaveLength(observations.playerA.length * 2);
    const forA = built.matchLog.filter(entry => entry.playerId === 'uuid-a');
    const anyWin = forA.find(entry => entry.result === 'win')!;
    const mirror = built.matchLog.find(
      entry => entry.matchId === anyWin.matchId && entry.playerId === anyWin.opponentId
    )!;
    expect(mirror.result).toBe('loss');
    expect(mirror.opponentId).toBe('uuid-a');
    expect(anyWin.gameOutcomes).toEqual(['win', 'win']);
    expect(mirror.gameOutcomes).toEqual(['loss', 'loss']);
  });

  it('emits nothing for an event already in the match log', () => {
    const { snapshot: built } = buildIt({ matchLogEvents: new Set() });
    expect(built.matchLog).toHaveLength(0);
    expect(built.matchLogEvents).toHaveLength(0);
  });

  it('sanitises free text on the way into the items, and again on the way into the table', async () => {
    const { snapshot: built } = buildIt();
    const poisoned = built.profiles.find(stored => stored.playerId === 'uuid-a')!;
    expect(poisoned.displayName).toBe('Ace');
    expect(JSON.stringify(built)).not.toContain('<script');

    // And the storage boundary is the second line of defence: an item built by
    // some future code path that forgot still cannot put markup in a table.
    await saveRankingSnapshot(
      snapshot({
        profiles: [profile({ playerId: 'uuid-raw', displayName: 'Raw<script>alert(1)</script>', regionLabel: 'X<b>Y</b>' })],
        history: [],
        matchLog: [logEntry({ playerId: 'uuid-raw', eventName: 'Night<iframe src="x"></iframe>' })],
        matchLogEvents: [],
        rankings: [],
        metas: [meta('all', 0)],
      }),
      MATCH_LOG_VERSION
    );
    const stored = await getPlayerProfile('uuid-raw');
    expect(stored?.displayName).toBe('Raw');
    // Tags are replaced by a space, per the house policy in sanitize.ts.
    expect(stored?.regionLabel).toBe('X Y');
    expect((await getPlayerMatchLog('uuid-raw'))[0].eventName).toBe('Night');
  });

  it('produces a rating history point per play day, oldest first', () => {
    const { snapshot: built } = buildIt();
    const forA = built.history.filter(entry => entry.playerId === 'uuid-a' && entry.scope === 'all');
    expect(forA).toHaveLength(6);
    expect(forA.map(entry => entry.date)).toEqual([
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06',
    ]);
    // Cumulative within the scope, so the chart can show "after N matches".
    expect(forA[0].matchesPlayed).toBeLessThan(forA[5].matchesPlayed);
    expect(forA[5].matchesPlayed).toBe(18);
  });

  it('keeps profile counts, per-set counts and the match log in agreement', () => {
    // The fixture data the API agent builds against is generated from the match
    // log outwards so these three agree; a replay that produced a profile whose
    // counts disagreed with its MATCH# items would be a bug, so it is pinned.
    const { snapshot: built } = buildIt();
    for (const stored of built.profiles) {
      const log = built.matchLog.filter(entry => entry.playerId === stored.playerId);
      expect(log).toHaveLength(stored.matchesPlayed);
      expect(log.reduce((total, entry) => total + entry.gameOutcomes.length, 0)).toBe(stored.gamesPlayed);
      expect(log.filter(entry => entry.result === 'win')).toHaveLength(stored.wins);
      expect(log.filter(entry => entry.result === 'loss')).toHaveLength(stored.losses);
      expect(log.filter(entry => entry.result === 'draw')).toHaveLength(stored.draws);
      expect(stored.wins + stored.losses + stored.draws).toBe(stored.matchesPlayed);

      for (const [setId, scoped] of Object.entries(stored.setRatings)) {
        const forSet = log.filter(entry => entry.setId === setId);
        expect(forSet).toHaveLength(scoped.matchesPlayed);
        expect(forSet.reduce((total, entry) => total + entry.gameOutcomes.length, 0)).toBe(scoped.gamesPlayed);
      }
    }
  });

  it('states the confidence verdict in the data rather than leaving it to the UI', () => {
    const { snapshot: rated } = buildIt({ minGames: 1 });
    for (const stored of rated.profiles) {
      expect(stored.provisional).toBe(!stored.rated);
      expect(stored.rated).toBe(true);
      expect(stored.provisionalReason).toBeNull();
      expect(stored.gamesUntilRated).toBeNull();
    }

    const { snapshot: short } = buildIt({ minGames: 1000 });
    for (const stored of short.profiles) {
      expect(stored.provisional).toBe(true);
      expect(stored.provisionalReason).toBe('too-few-games');
      // Actionable: how many more games, not just "not yet".
      expect(stored.gamesUntilRated).toBe(1000 - stored.gamesPlayed);
    }

    // A tiny component keeps its rating - the internal order is real - but the
    // rank stops being presented as a position.
    const { snapshot: tiny } = buildIt({ minComponentSize: 1000 });
    expect(tiny.profiles.every(stored => stored.rating !== null)).toBe(true);
    expect(tiny.profiles.every(stored => stored.provisionalReason === 'component-too-small')).toBe(true);
    expect(tiny.rankings.every(entry => entry.suppressPosition)).toBe(true);
  });

  it('always carries componentId and componentSize, and never a null component', () => {
    const { snapshot: built } = buildIt();
    for (const stored of built.profiles) {
      expect(typeof stored.componentId).toBe('string');
      expect(stored.componentId.length).toBeGreaterThan(0);
      expect(stored.componentSize).toBeGreaterThanOrEqual(1);
      expect(stored.componentShare).toBeGreaterThan(0);
    }
  });

  it('publishes a component directory so the region selector is one query', () => {
    const { snapshot: built } = buildIt();
    expect(built.components).toHaveLength(2);
    for (const component of built.components) {
      expect(component.componentSize).toBe(component.playerCount);
      expect(component.ratedCount).toBeGreaterThan(0);
      expect(component.regionLabel).toMatch(/Oakland, CA|San Diego, CA/);
      expect(component.componentShare).toBeCloseTo(0.5, 10);
      expect(component.matchCount).toBeGreaterThan(0);
      expect(component.venueCount).toBe(1);
    }
    expect(built.components.filter(component => component.isGiant)).toHaveLength(1);
  });

  it('publishes a set directory covering every era', () => {
    const { snapshot: built } = buildIt();
    const byId = new Map(built.sets.map(set => [set.setId, set]));
    // Every era in the table gets an item, so /api/sets is complete from the
    // first refit even for sets with no data yet.
    expect(byId.size).toBe(eras.length);
    expect(byId.get('s4')).toMatchObject({ name: 'Vendetta', releaseDate: '2026-07-31', ambiguous: false });
    expect(byId.get('s5')).toMatchObject({ name: 'Radiance', releaseDate: '2026-10-23', ambiguous: false });
    // Every set through 7 has a published street date, so no era is ambiguous.
    expect(built.sets.some(set => set.ambiguous)).toBe(false);
    // The pre-release era has no set behind it at all, so no date to claim.
    expect(byId.get('pre')?.releaseDate).toBeNull();
    for (const set of built.sets) expect(set.source.length).toBeGreaterThan(0);
  });

  it('is deterministic, which is what makes a from-scratch rerun idempotent', () => {
    expect(JSON.stringify(buildIt().snapshot)).toBe(JSON.stringify(buildIt().snapshot));
  });

  it('skips a set era with too little evidence instead of publishing an empty ladder', () => {
    const { snapshot: built, diagnostics } = buildIt({ minSetMatches: 100_000 });
    expect(built.metas.some(entry => entry.kind === 'set')).toBe(false);
    expect(diagnostics.skippedEras.length).toBeGreaterThan(0);
  });

  it('fits a set era when it does have evidence, and labels ambiguity', () => {
    const { snapshot: built } = buildIt({ minSetMatches: 1 });
    const setMeta = built.metas.find(entry => entry.kind === 'set');
    expect(setMeta).toBeDefined();
    // These events are all in the undated 2025-10-31..2026-07-31 window's
    // successor era; whichever era it is, ambiguity must be reported honestly.
    expect(typeof setMeta?.setAmbiguous).toBe('boolean');
    expect(setMeta?.setEraId).toBeTruthy();
  });
});

describe('the persisted scene assignment', () => {
  /**
   * The one piece of cross-refit state the rating pass has, and the reason the
   * scene labels are stable: a refit reads this and never fits one.
   */
  function assignment(overrides: Partial<SceneAssignment> = {}): SceneAssignment {
    return {
      version: SCENE_ASSIGNMENT_VERSION,
      generatedAt: '2026-10-26T00:00:00.000Z',
      resolution: 1,
      carryJaccard: 0.5,
      venues: [
        { venue: 'shop:1', shopExternalId: 1, sceneId: 's-aaa', purity: 0.993 },
        { venue: 'shop:2', shopExternalId: 2, sceneId: 's-aaa', purity: 1 },
      ],
      scenes: [{ sceneId: 's-aaa', label: 'Oakland, CA' }],
      stats: {
        venues: 2,
        scenes: 1,
        players: 12,
        matches: 30,
        modularity: 0.83,
        communities: 1,
        medianPurity: 0.9965,
        splitVenues: 0,
      },
      previous: null,
      ...overrides,
    };
  }

  it('is null until an operator writes one, and never invented', async () => {
    // A refit on a fresh database must publish null scenes rather than
    // clustering on the fly - that is the whole premise.
    expect(await loadSceneAssignment()).toBeNull();
  });

  it('round-trips, and a second write replaces it rather than appending', async () => {
    await saveSceneAssignment(assignment());
    const stored = await loadSceneAssignment();
    expect(stored?.generatedAt).toBe('2026-10-26T00:00:00.000Z');
    expect(stored?.venues).toHaveLength(2);
    expect(stored?.scenes[0].label).toBe('Oakland, CA');
    expect(stored?.resolution).toBe(1);

    // One level of undo: the replacement carries its predecessor, and the
    // predecessor's own `previous` is not nested again.
    const second = assignment({
      generatedAt: '2026-10-27T00:00:00.000Z',
      previous: { ...assignment(), previous: undefined } as Omit<SceneAssignment, 'previous'>,
    });
    await saveSceneAssignment(second);
    const after = await loadSceneAssignment();
    expect(after?.generatedAt).toBe('2026-10-27T00:00:00.000Z');
    expect(after?.previous?.generatedAt).toBe('2026-10-26T00:00:00.000Z');
    expect(after?.previous?.venues).toHaveLength(2);
  });
});

describe('cleanup', () => {
  it('closes the pool', async () => {
    await closePool();
  });
});
