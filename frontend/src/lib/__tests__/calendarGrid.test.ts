// Same west-of-UTC pin as calendarDates.test.ts, and for the same reason: the
// day-count map is keyed on local days, so a runner sitting at UTC would pass
// a version of `dayEventCounts` that filed evening events under tomorrow.
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { clampCardX, dayEventCounts, dayListLabel } from '../calendarGrid';
import { localDateKey } from '../calendarDates';
import type { Event } from '../../types/event';

function event(id: string, startDate: string): Event {
  return {
    id,
    externalId: `ext-${id}`,
    name: `Event ${id}`,
    description: null,
    location: null,
    address: null,
    city: null,
    state: null,
    country: null,
    latitude: null,
    longitude: null,
    startDate,
    startTime: null,
    endDate: null,
    eventType: null,
    organizer: null,
    playerCount: null,
    capacity: null,
    price: null,
    url: null,
    imageUrl: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    scrapedAt: '2026-10-01T00:00:00Z',
  };
}

describe('dayEventCounts', () => {
  it('counts nothing for no events', () => {
    expect(dayEventCounts([]).size).toBe(0);
  });

  it('groups by local day, the way the grid buckets', () => {
    const counts = dayEventCounts([
      event('a', '2025-11-08T02:00:00Z'), // Nov 7, 18:00 PST
      event('b', '2025-11-08T03:30:00Z'), // Nov 7, 19:30 PST
      event('c', '2025-11-08T18:00:00Z'), // Nov 8, 10:00 PST
    ]);
    expect(counts.get(localDateKey(new Date(2025, 10, 7)))).toBe(2);
    expect(counts.get(localDateKey(new Date(2025, 10, 8)))).toBe(1);
    expect(counts.size).toBe(2);
  });

  it('does not file an evening event under the next day', () => {
    // The whole point of the local key: a UTC date would put this on the 8th,
    // and the cell's `+` would then say "no events" for the day it is drawn on.
    const counts = dayEventCounts([event('a', '2025-11-08T02:00:00Z')]);
    expect(counts.has(localDateKey(new Date(2025, 10, 8)))).toBe(false);
  });

  it('agrees with the key a day cell is looked up by', () => {
    const counts = dayEventCounts([event('a', '2025-07-04T19:00:00Z')]);
    // Both sides of the lookup the day-cell button performs.
    expect([...counts.keys()]).toEqual([localDateKey(new Date(2025, 6, 4))]);
  });
});

describe('dayListLabel', () => {
  const nov7 = new Date(2025, 10, 7);

  it('names the day in full, not as a numeral', () => {
    // A button announced on its own has no cell around it to say what "7"
    // means.
    expect(dayListLabel(nov7, 3)).toBe('Show all 3 events on Friday, November 7');
  });

  it('counts one event as one', () => {
    expect(dayListLabel(nov7, 1)).toBe('Show the 1 event on Friday, November 7');
  });

  it('never promises events it cannot show', () => {
    // A day with none gets no button at all; this is the belt to that braces.
    expect(dayListLabel(nov7, 0)).toBe('Events on Friday, November 7');
  });

  it('gives two days two different names', () => {
    expect(dayListLabel(nov7, 2)).not.toBe(dayListLabel(new Date(2025, 10, 8), 2));
  });
});

describe('clampCardX', () => {
  const WIDTH = 300;
  const MARGIN = 8;
  const clamp = (x: number, viewport = 1280) => clampCardX(x, WIDTH, viewport, MARGIN);

  it('leaves a cursor in the middle of the viewport alone', () => {
    expect(clamp(640)).toBe(640);
  });

  it('keeps the card off the left edge', () => {
    expect(clamp(20)).toBe(158);
  });

  it('lets the card touch an edge rather than leave the cursor', () => {
    // A chip hard against the side of the window: the 8px gap is what gives
    // way, because sliding the card off the pointer would take the footer with
    // it.
    expect(clamp(2)).toBe(152);
    expect(clamp(1278)).toBe(1128);
  });

  it('keeps the card off the right edge', () => {
    expect(clamp(1270)).toBe(1280 - 150 - 8);
  });

  it('still leaves the cursor underneath the card', () => {
    // The property the footer's reachability rests on: wherever the cursor is,
    // the clamped card still spans it, so a full-width footer is directly
    // above it.
    for (const viewport of [390, 768, 1280, 1920]) {
      for (let x = 0; x <= viewport; x += 7) {
        const centre = clamp(x, viewport);
        expect(x).toBeGreaterThanOrEqual(centre - WIDTH / 2);
        expect(x).toBeLessThanOrEqual(centre + WIDTH / 2);
      }
    }
  });

  it('centres the card in a viewport too narrow to hold it', () => {
    // 300 + two 8px margins needs 316px; below that both edges overflow
    // equally rather than one of them losing everything.
    expect(clamp(10, 310)).toBe(155);
    expect(clamp(300, 310)).toBe(155);
  });
});
