import { describe, it, expect } from 'vitest';
import {
  findCancelledPlayriftboundEvents,
  findCancelledUvsEvents,
  isCycleComplete,
  type ScrapeCycle,
} from '../cancellations.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date('2026-09-17T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const isUvs = (id: string) => !id.startsWith('prb-');
const isPrb = (id: string) => id.startsWith('prb-');

function cycle(hoursAgo: number, ids: string[], overrides: Partial<ScrapeCycle> = {}): ScrapeCycle {
  const half = Math.ceil(ids.length / 2);
  return {
    cycleId: at(-hoursAgo * HOUR).toISOString(),
    startedAt: at(-hoursAgo * HOUR),
    shardCount: 2,
    totalExpected: ids.length,
    shards: [
      { shardIndex: 0, complete: true, ids: ids.slice(0, half) },
      { shardIndex: 1, complete: true, ids: ids.slice(half) },
    ],
    ...overrides,
  };
}

const row = (externalId: string, startInMs: number, createdAgoMs = 7 * DAY, lat = 38.0, lon = -122.0) => ({
  externalId,
  latitude: lat,
  longitude: lon,
  startDate: at(startInMs),
  createdAt: at(-createdAgoMs),
});

describe('isCycleComplete', () => {
  it('needs every shard complete and ~all expected ids', () => {
    const ids = Array.from({ length: 100 }, (_, i) => String(i));
    expect(isCycleComplete(cycle(2, ids))).toBe(true);
    const missingShard = cycle(2, ids);
    missingShard.shards = missingShard.shards.slice(0, 1);
    expect(isCycleComplete(missingShard)).toBe(false);
    const bailed = cycle(2, ids);
    bailed.shards[1].complete = false;
    expect(isCycleComplete(bailed)).toBe(false);
    expect(isCycleComplete(cycle(2, ids, { totalExpected: 200 }))).toBe(false);
  });
});

describe('findCancelledUvsEvents', () => {
  const live = Array.from({ length: 300 }, (_, i) => String(1000 + i));
  const rows = [...live.map(id => row(id, 2 * DAY)), row('999', 2 * DAY)];

  it('removes an event that three complete cycles did not see', () => {
    const cycles = [cycle(2, live), cycle(4, live), cycle(6, live)];
    expect(findCancelledUvsEvents(rows, cycles, isUvs, now).stale).toEqual(['999']);
  });

  it('keeps an event seen by any one of those cycles (pagination drift)', () => {
    const cycles = [cycle(2, live), cycle(4, [...live, '999']), cycle(6, live)];
    expect(findCancelledUvsEvents(rows, cycles, isUvs, now).stale).toEqual([]);
  });

  it('does nothing without three complete cycles', () => {
    const incomplete = cycle(4, live);
    incomplete.shards[0].complete = false;
    const result = findCancelledUvsEvents(rows, [cycle(2, live), incomplete, cycle(6, live)], isUvs, now);
    expect(result.stale).toEqual([]);
    expect(result.skippedReason).toMatch(/2\/3/);
  });

  it('ignores playriftbound rows, imminent events, and rows newer than the oldest cycle', () => {
    const cycles = [cycle(2, live), cycle(4, live), cycle(6, live)];
    const extra = [row('prb-1', 2 * DAY), row('998', HOUR), row('997', 2 * DAY, 3 * HOUR)];
    expect(findCancelledUvsEvents([...rows, ...extra], cycles, isUvs, now).stale).toEqual(['999']);
  });

  it('refuses a mass deletion that looks like an outage', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => String(i));
    const seen = big.slice(0, 17_000);
    const cycles = [cycle(2, seen), cycle(4, seen), cycle(6, seen)];
    const result = findCancelledUvsEvents(big.map(id => row(id, 2 * DAY)), cycles, isUvs, now);
    expect(result.stale).toEqual([]);
    expect(result.skippedReason).toMatch(/safety limit/);
  });
});

describe('findCancelledPlayriftboundEvents', () => {
  const anchor = { latitude: 38.0, longitude: -122.0 };
  const sweep = (returned: string[], completedAnchors = [anchor]) => ({
    completedAnchors,
    returnedIds: new Set(returned),
    radiusMeters: 120_000,
    startedAt: at(-10 * 60 * 1000),
    horizon: at(90 * DAY),
  });
  const kept = Array.from({ length: 30 }, (_, i) => `prb-${i}`);
  const rows = [...kept.map(id => row(id, 3 * DAY)), row('prb-gone', 3 * DAY)];

  it('removes a Riot event inside a fully swept anchor that was not returned', () => {
    expect(findCancelledPlayriftboundEvents(rows, sweep(kept), isPrb, now).stale).toEqual(['prb-gone']);
  });

  it('leaves events outside every completed anchor alone', () => {
    const far = { latitude: 45.0, longitude: -100.0 };
    expect(findCancelledPlayriftboundEvents(rows, sweep(kept, [far]), isPrb, now).stale).toEqual([]);
    expect(findCancelledPlayriftboundEvents(rows, sweep(kept, []), isPrb, now).skippedReason).toBeDefined();
  });

  it('ignores UVS rows, imminent events and rows created during the sweep', () => {
    const extra = [row('555', 3 * DAY), row('prb-soon', HOUR), row('prb-new', 3 * DAY, 60 * 1000)];
    expect(findCancelledPlayriftboundEvents([...rows, ...extra], sweep(kept), isPrb, now).stale).toEqual(['prb-gone']);
  });

  it('refuses when an anchor suddenly returns nothing', () => {
    const result = findCancelledPlayriftboundEvents(
      Array.from({ length: 200 }, (_, i) => row(`prb-${i}`, 3 * DAY)),
      sweep([]),
      isPrb,
      now
    );
    expect(result.stale).toEqual([]);
    expect(result.skippedReason).toMatch(/safety limit/);
  });
});
