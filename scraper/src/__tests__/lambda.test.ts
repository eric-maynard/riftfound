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
  env: { PLAYRIFTBOUND_ENABLED: true, PLAYRIFTBOUND_REQUEST_DELAY_MS: 0, PLAYRIFTBOUND_MAX_ANCHORS_PER_RUN: 150 },
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
}));
vi.mock('../database.js', () => db);

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
  price: '$15.00', sources: ['playriftbound'], storeInfo: { id: 2_000_000_001, name: 'Games of Martinez', latitude: 38.01941, longitude: -122.13412 },
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
  it('dispatches UVS shard workers plus one playriftbound invocation', async () => {
    const res = await handler({} as never, context());
    expect(res.statusCode).toBe(202);
    const modes = sent.map(i => JSON.parse(Buffer.from(i.Payload as Uint8Array).toString()).mode);
    expect(modes.filter(m => m === 'worker').length).toBeGreaterThan(0);
    expect(modes.filter(m => m === 'playriftbound')).toHaveLength(1);
    // Workers carry the cycle id they record their seen event ids under.
    const cycleIds = sent.map(i => JSON.parse(Buffer.from(i.Payload as Uint8Array).toString()))
      .filter(p => p.mode === 'worker').map(p => p.cycleId);
    expect(new Set(cycleIds).size).toBe(1);
    expect(db.recordScrapeCycle).toHaveBeenCalledWith(expect.objectContaining({ cycleId: cycleIds[0] }));
  });

  it('does not dispatch playriftbound when stored reads are unsupported', async () => {
    db.supportsStoredEventReads.mockReturnValue(false);
    await handler({} as never, context());
    db.supportsStoredEventReads.mockReturnValue(true);
    const modes = sent.map(i => JSON.parse(Buffer.from(i.Payload as Uint8Array).toString()).mode);
    expect(modes).not.toContain('playriftbound');
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
