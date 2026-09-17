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
}));
vi.mock('../geocoding.js', () => ({ reverseGeocodeCity: vi.fn(async () => null) }));

const db = vi.hoisted(() => ({
  startScrapeRun: vi.fn(async () => 'run'),
  completeScrapeRun: vi.fn(async () => {}),
  failScrapeRun: vi.fn(async () => {}),
  upsertEventWithStore: vi.fn(async (_event: unknown, _store: unknown) => ({ created: true, skipped: false })),
  updateShopDisplayCity: vi.fn(),
  deleteOldEvents: vi.fn(async () => 0),
  shouldRunStaleCleanup: vi.fn(),
  cleanupStaleEvents: vi.fn(),
  supportsStoredEventReads: vi.fn(() => true),
  loadUpcomingEvents: vi.fn(),
  applyMergedEventFields: vi.fn(async () => true),
  deleteEventsByExternalId: vi.fn(async (ids: string[]) => ids.length),
}));
vi.mock('../database.js', () => db);

const prb = vi.hoisted(() => ({ fetchPlayriftboundEvents: vi.fn() }));
vi.mock('../sources/playriftbound.js', () => ({
  PLAYRIFTBOUND_ID_PREFIX: 'prb-',
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
  price: '$15.00', sources: ['playriftbound'], storeInfo: { id: 2_000_000_001, name: 'Games of Martinez' },
};
const prbOnly = {
  ...prbTwin, externalId: 'prb-bbb', latitude: 40.0, longitude: -120.0,
  storeInfo: { id: 2_000_000_002, name: 'Elsewhere Games' },
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
  });

  it('does not dispatch playriftbound when stored reads are unsupported', async () => {
    db.supportsStoredEventReads.mockReturnValueOnce(false);
    await handler({} as never, context());
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
