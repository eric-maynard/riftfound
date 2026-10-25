import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'aws-lambda';

const sent: { FunctionName?: string; Payload?: Uint8Array }[] = [];

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { async send(cmd: { input: never }) { sent.push(cmd.input); return {}; } },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class { async send() { return {}; } },
  PutMetricDataCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('../config.js', () => ({
  env: {
    PLAYRIFTBOUND_ENABLED: true,
    PLAYRIFTBOUND_REQUEST_DELAY_MS: 0,
    PLAYRIFTBOUND_MAX_ANCHORS_PER_RUN: 150,
    PLAYRIFTBOUND_RESULTS_ENABLED: true,
    PLAYRIFTBOUND_RESULTS_MAX_EVENTS_PER_RUN: 250,
    PLAYRIFTBOUND_RESULTS_LOOKBACK_DAYS: 21,
    RANKING_ENABLED: true,
    RANKING_REFIT_INTERVAL_HOURS: 24,
    RANKING_HISTORY_DAYS: 400,
    RANKING_MAX_MATCHES: 2_000_000,
    RANKING_PRIOR_SIGMA_ELO: 150,
    RANKING_DRIFT_ELO_PER_SQRT_DAY: 4,
    RANKING_OBSERVATION_LEVEL: 'game-shared',
    RANKING_WEIGHT_SCALE: 1,
    RANKING_MAX_ITERATIONS: 60,
    RANKING_MIN_GAMES: 8,
    RANKING_MAX_UNCERTAINTY_ELO: 120,
    RANKING_MIN_COMPONENT_SIZE: 8,
    RANKING_MAX_COMPONENT_LADDERS: 50,
    RANKING_MIN_SET_MATCHES: 50,
    RANKING_PRERELEASE_TYPES: 'Pre-Rift',
    RANKING_PRERELEASE_LEAD_DAYS: 14,
  },
}));
vi.mock('../api.js', () => ({
  fetchEventTemplates: vi.fn(async () => {}),
  getEventCount: vi.fn(async () => ({ total: 500, pageCount: 2 })),
  fetchEventsPage: vi.fn(),
  fetchEventLiveness: vi.fn(async () => 'gone'),
}));
vi.mock('../geocoding.js', () => ({ reverseGeocodeCity: vi.fn(async () => null) }));

const db = vi.hoisted(() => ({
  startScrapeRun: vi.fn(async () => 'run'),
  completeScrapeRun: vi.fn(async () => {}),
  failScrapeRun: vi.fn(async () => {}),
  upsertEventWithStore: vi.fn(async (_event: unknown, _store: unknown) => ({ created: true, skipped: false })),
  updateShopDisplayCity: vi.fn(),
  deleteOldEvents: vi.fn(async () => 0),
  supportsStoredEventReads: vi.fn(() => true),
  loadUpcomingEvents: vi.fn(),
  applyMergedEventFields: vi.fn(async () => true),
  deleteEventsByExternalId: vi.fn(async (ids: string[]) => ids.length),
  recordScrapeCycle: vi.fn(async () => {}),
  recordShardSeenIds: vi.fn(async () => {}),
  loadScrapeCycles: vi.fn(async () => [] as unknown[]),
  loadShopsByGeohash4: vi.fn(async () => [] as unknown[]),
  repointEventsToShop: vi.fn(async (rows: unknown[]) => rows.length),
  deleteShopsByExternalId: vi.fn(async (ids: number[]) => ids.length),
  supportsEventFacts: vi.fn(() => true),
  supportsRankingWrites: vi.fn(() => true),
  getLastRankingRefit: vi.fn(async () => null as string | null),
}));
vi.mock('../database.js', () => db);

const ranking = vi.hoisted(() => ({ runRankingPass: vi.fn(), refitDue: vi.fn(() => true) }));
vi.mock('../ranking/pass.js', () => ranking);

const prbResults = vi.hoisted(() => ({ runPlayriftboundResultsPass: vi.fn() }));
vi.mock('../sources/playriftboundResults.js', () => prbResults);

const prb = vi.hoisted(() => ({ fetchPlayriftboundEvents: vi.fn() }));
vi.mock('../sources/playriftbound.js', () => ({
  PLAYRIFTBOUND_ID_PREFIX: 'prb-',
  ANCHOR_RADIUS_METERS: 120_000,
  isSynthesizedShopId: (id: number) => id >= 2_000_000_000,
  fetchPlayriftboundEvents: prb.fetchPlayriftboundEvents,
}));

import { handler } from '../lambda.js';

function context(): Context {
  return { functionName: 'riftfound-scraper-test', getRemainingTimeInMillis: () => 900_000 } as unknown as Context;
}

const start = new Date('2026-10-16T01:00:00Z');
const uvsRow = {
  externalId: '1039321', name: 'Thursday Nexus Nights', latitude: 38.0194, longitude: -122.1341, startDate: start,
  eventType: 'Nexus Night', url: null, playerCount: 4, capacity: 16, price: '$15.00', sources: ['uvs'],
};
const prbTwin = {
  externalId: 'prb-aaa', name: 'Nexus Night', latitude: 38.01941, longitude: -122.13412, startDate: start,
  eventType: 'Nexus Night', url: 'https://playriftbound.com/en-us/events/aaa', playerCount: null, capacity: 16,
  price: '$15.00', sources: ['playriftbound'], playFormat: 'CONSTRUCTED',
  storeInfo: { id: 2_000_000_001, name: 'Games of Martinez', latitude: 38.01941, longitude: -122.13412 },
};
const prbOnly = {
  ...prbTwin, externalId: 'prb-bbb', latitude: 40.0, longitude: -120.0,
  storeInfo: { id: 2_000_000_002, name: 'Elsewhere Games', latitude: 40.0, longitude: -120.0 },
};

beforeEach(() => {
  sent.length = 0;
  vi.clearAllMocks();
});

describe('coordinator', () => {
  it('dispatches UVS shard workers plus the two playriftbound invocations', async () => {
    const res = await handler({} as never, context());
    expect(res.statusCode).toBe(202);
    const modes = sent.map(i => JSON.parse(Buffer.from(i.Payload as Uint8Array).toString()).mode);
    expect(modes.filter(m => m === 'worker').length).toBeGreaterThan(0);
    expect(modes.filter(m => m === 'playriftbound')).toHaveLength(1);
    expect(modes.filter(m => m === 'playriftboundResults')).toHaveLength(1);
    expect(modes.filter(m => m === 'ranking')).toHaveLength(1);
    // Workers carry the cycle id they record their seen event ids under.
    const cycleIds = sent.map(i => JSON.parse(Buffer.from(i.Payload as Uint8Array).toString()))
      .filter(p => p.mode === 'worker').map(p => p.cycleId);
    expect(new Set(cycleIds).size).toBe(1);
    expect(db.recordScrapeCycle).toHaveBeenCalledWith(expect.objectContaining({ cycleId: cycleIds[0] }));
  });

  it('skips the rating refit until its interval has elapsed', async () => {
    // The refit rewrites every profile and every rating point, so most cycles
    // must dispatch nothing at all.
    ranking.refitDue.mockReturnValue(false);
    db.getLastRankingRefit.mockResolvedValue('2026-10-25T00:00:00.000Z');
    const res = await handler({} as never, context());
    ranking.refitDue.mockReturnValue(true);
    expect(JSON.parse(res.body).rankingDispatched).toBe(false);
    expect(JSON.parse(res.body).rankingSkippedReason).toContain('interval');
    const modes = sent.map(i => JSON.parse(Buffer.from(i.Payload as Uint8Array).toString()).mode);
    expect(modes).not.toContain('ranking');
  });

  it('still dispatches the scrape passes when the refit check itself fails', async () => {
    // A rating problem must never cost a scrape cycle.
    db.getLastRankingRefit.mockRejectedValueOnce(new Error('dynamo unavailable'));
    const res = await handler({} as never, context());
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).rankingSkippedReason).toBe('dynamo unavailable');
    const modes = sent.map(i => JSON.parse(Buffer.from(i.Payload as Uint8Array).toString()).mode);
    expect(modes.filter(m => m === 'worker').length).toBeGreaterThan(0);
  });

  it('does not dispatch playriftbound when stored reads are unsupported', async () => {
    db.supportsStoredEventReads.mockReturnValue(false);
    await handler({} as never, context());
    db.supportsStoredEventReads.mockReturnValue(true);
    const modes = sent.map(i => JSON.parse(Buffer.from(i.Payload as Uint8Array).toString()).mode);
    expect(modes).not.toContain('playriftbound');
  });

  it('does not dispatch the results pass when facts cannot be stored', async () => {
    db.supportsEventFacts.mockReturnValue(false);
    await handler({} as never, context());
    db.supportsEventFacts.mockReturnValue(true);
    const modes = sent.map(i => JSON.parse(Buffer.from(i.Payload as Uint8Array).toString()).mode);
    expect(modes).not.toContain('playriftboundResults');
    expect(modes).toContain('playriftbound');
  });
});

describe('playriftbound results invocation', () => {
  it('runs the pass with a deadline inside the invocation budget', async () => {
    prbResults.runPlayriftboundResultsPass.mockResolvedValue({
      candidates: 10, due: 2, rosterDue: 1, resultsDue: 1, fetched: 2, withResults: 1, withoutResults: 0,
      rostersWritten: 2, resultsWritten: 1, unchanged: 0, failed: 0, notFetched: 0, requests: 2,
      partial: false, durationMs: 5,
    });

    const res = await handler({ mode: 'playriftboundResults' } as never, context());

    expect(res.statusCode).toBe(200);
    const [options] = prbResults.runPlayriftboundResultsPass.mock.calls[0] as [{ deadline: number }];
    // 15 minutes of budget minus the reserve, so the pass stops before the
    // invocation is killed and the remainder rolls over.
    expect(options.deadline).toBeLessThan(Date.now() + 900_000);
    expect(options.deadline).toBeGreaterThan(Date.now() + 700_000);
    expect(db.completeScrapeRun).toHaveBeenCalled();
  });
});

describe('playriftbound invocation', () => {
  it('seeds anchors from stored UVS rows, merges twins, deletes orphan prb rows and upserts the rest', async () => {
    // Before the sweep: an older prb row that is actually a UVS twin, plus the UVS row.
    db.loadUpcomingEvents
      .mockResolvedValueOnce([uvsRow, { ...prbTwin }])
      .mockResolvedValueOnce([uvsRow, { ...prbTwin }]);
    prb.fetchPlayriftboundEvents.mockResolvedValueOnce({
      events: [prbTwin, prbOnly], anchorsAvailable: 1, anchorsQueried: 1, anchorsFailed: 0,
      requests: 1, duplicatesWithinSource: 0, failed: false, partial: false,
      completedAnchors: [], horizon: new Date(Date.now() + 90 * 86_400_000),
    });

    const res = await handler({ mode: 'playriftbound' }, context());
    expect(res.statusCode).toBe(200);

    const opts = prb.fetchPlayriftboundEvents.mock.calls[0][0];
    // prb rows must not seed anchors
    expect(opts.coordinates).toEqual([{ latitude: uvsRow.latitude, longitude: uvsRow.longitude }]);
    expect(opts.deadline).toBeLessThan(Date.now() + 900_000);

    expect(db.applyMergedEventFields).toHaveBeenCalledWith('1039321', {
      url: prbTwin.url,
      // Riot owns the event format and UVS has none, so the merge is the only
      // way it ever reaches the UVS row of record.
      playFormat: 'CONSTRUCTED',
      sources: ['uvs', 'playriftbound'],
    });
    expect(db.deleteEventsByExternalId).toHaveBeenCalledWith(['prb-aaa']);
    expect(db.upsertEventWithStore).toHaveBeenCalledTimes(1);
    expect(db.upsertEventWithStore.mock.calls[0][0]).toMatchObject({ externalId: 'prb-bbb' });

    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ found: 2, created: 1, mergedIntoUvs: 1, mergeWritten: 1, orphansDeleted: 1 });
  });
});

describe('playriftbound shops and cancellations', () => {
  const uvsShop = { externalId: 812, name: 'Elsewhere Games', latitude: 40.0003, longitude: -120.0 };
  const sweepResult = (events: unknown[]) => ({
    events, anchorsAvailable: 1, anchorsQueried: 1, anchorsFailed: 0, requests: 1, duplicatesWithinSource: 0,
    failed: false, partial: false, completedAnchors: [{ name: '9q', latitude: 40.0, longitude: -120.0 }],
    horizon: new Date(Date.now() + 90 * 86_400_000),
  });

  it('re-homes a Riot organizer onto the matching UVS shop and removes the duplicate shop row', async () => {
    const storedOther = {
      ...prbOnly, externalId: 'prb-ccc', startDate: new Date(Date.now() + 5 * 86_400_000),
      createdAt: new Date(Date.now() - 86_400_000), shopExternalId: 2_000_000_002,
    };
    db.loadUpcomingEvents.mockResolvedValueOnce([uvsRow]).mockResolvedValueOnce([uvsRow, storedOther]);
    db.loadShopsByGeohash4.mockResolvedValueOnce([
      uvsShop,
      { externalId: 2_000_000_002, name: 'Elsewhere Games', latitude: 40.0, longitude: -120.0 },
    ]);
    // prb-ccc is still listed by Riot this run, just not rewritten (e.g. unchanged anchor overlap)
    prb.fetchPlayriftboundEvents.mockResolvedValueOnce(sweepResult([prbOnly]));

    const res = await handler({ mode: 'playriftbound' }, context());
    const body = JSON.parse(res.body);

    const [event, store, options] = db.upsertEventWithStore.mock.calls[0] as unknown as [
      { organizer: string }, { id: number }, { existingShop: boolean },
    ];
    expect(store.id).toBe(812);
    expect(event.organizer).toBe('Elsewhere Games');
    expect(options).toEqual({ existingShop: true });
    expect(db.repointEventsToShop).toHaveBeenCalledWith(
      [{ externalId: 'prb-ccc', startDate: storedOther.startDate }],
      uvsShop
    );
    expect(db.deleteShopsByExternalId).toHaveBeenCalledWith([2_000_000_002]);
    expect(body).toMatchObject({ organizersResolvedToUvsShops: 1, duplicateShopsDeleted: 1 });
  });

  it('removes a stored Riot event that a fully swept anchor no longer returns', async () => {
    const gone = {
      ...prbOnly, externalId: 'prb-gone', startDate: new Date(Date.now() + 5 * 86_400_000),
      createdAt: new Date(Date.now() - 86_400_000),
    };
    db.loadUpcomingEvents.mockResolvedValueOnce([uvsRow]).mockResolvedValueOnce([uvsRow, gone]);
    prb.fetchPlayriftboundEvents.mockResolvedValueOnce(sweepResult([prbOnly]));

    const res = await handler({ mode: 'playriftbound' }, context());

    expect(db.deleteEventsByExternalId).toHaveBeenCalledWith(['prb-gone']);
    expect(JSON.parse(res.body)).toMatchObject({ cancelledRemoved: 1 });
  });
});

describe('worker', () => {
  it('records the event ids its shard saw under the cycle id', async () => {
    const { fetchEventsPage } = await import('../api.js');
    (fetchEventsPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      events: [{ externalId: '1', storeInfo: null }, { externalId: '2', storeInfo: null }],
    });
    await handler(
      { mode: 'worker', startPage: 1, endPage: 1, totalPages: 1, shardIndex: 0, shardCount: 1, cycleId: 'c1' } as never,
      context()
    );
    expect(db.recordShardSeenIds).toHaveBeenCalledWith('c1', 0, new Set(['1', '2']), true);
  });
});

describe('ranking invocation', () => {
  it('runs the refit with the configured model and bar', async () => {
    ranking.runRankingPass.mockResolvedValue({
      matches: 10, games: 12, ratedPlayers: 2, playersWithMatches: 4, eventsWithResults: 3,
      durationMs: 5, partial: false, writes: { profiles: 4, rankingRows: 2 },
    });
    const res = await handler({ mode: 'ranking' } as never, context());
    expect(res.statusCode).toBe(200);
    expect(ranking.runRankingPass).toHaveBeenCalledWith(expect.objectContaining({
      historyDays: 400,
      whr: expect.objectContaining({ priorSigmaElo: 150, observationLevel: 'game-shared', weightScale: 1 }),
      snapshot: expect.objectContaining({ minGames: 8, maxUncertaintyElo: 120, minComponentSize: 8 }),
    }));
  });

  it('reports 202 when the refit ran out of time and wrote nothing', async () => {
    ranking.runRankingPass.mockResolvedValue({
      matches: 0, games: 0, ratedPlayers: 0, playersWithMatches: 0, eventsWithResults: 0,
      durationMs: 5, partial: true, writes: null,
    });
    const res = await handler({ mode: 'ranking' } as never, context());
    expect(res.statusCode).toBe(202);
  });

  it('fails the run rather than silently succeeding', async () => {
    ranking.runRankingPass.mockRejectedValue(new Error('fit blew up'));
    const res = await handler({ mode: 'ranking' } as never, context());
    expect(res.statusCode).toBe(500);
    expect(db.failScrapeRun).toHaveBeenCalledWith('run', 'fit blew up');
  });
});

describe('coordinator UVS cancellations', () => {
  it('deletes only missing events that UVS confirms are gone', async () => {
    const now = Date.now();
    const ids = Array.from({ length: 50 }, (_, i) => String(5000 + i));
    const cycles = [1, 2, 3].map(n => ({
      cycleId: `c${n}`, startedAt: new Date(now - n * 2 * 3_600_000), shardCount: 1, totalExpected: ids.length,
      shards: [{ shardIndex: 0, complete: true, ids }],
    }));
    const row = (externalId: string) => ({
      externalId, latitude: 38, longitude: -122, startDate: new Date(now + 2 * 86_400_000),
      createdAt: new Date(now - 7 * 86_400_000),
    });
    db.loadScrapeCycles.mockResolvedValueOnce(cycles);
    db.loadUpcomingEvents.mockResolvedValueOnce([...ids.map(row), row('900'), row('901')]);
    const { fetchEventLiveness } = await import('../api.js');
    (fetchEventLiveness as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('gone')
      .mockResolvedValueOnce('live');

    const res = await handler({} as never, context());

    expect(db.deleteEventsByExternalId).toHaveBeenCalledWith(['900']);
    expect(JSON.parse(res.body)).toMatchObject({ cancelledEventsRemoved: 1, cancelledEventsUnconfirmed: 1 });
  });
});
