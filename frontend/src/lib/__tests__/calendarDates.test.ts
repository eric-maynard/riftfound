// A west-of-UTC zone, pinned before anything reads a Date: the bug this file
// guards is invisible at UTC and east of it, so a test that merely used the
// runner's zone would pass in CI and still ship the regression.
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { dateMarkerToLocalDate, localDateKey } from '../calendarDates';

/** The marker FullCalendar hands a callback for a given cell. */
function marker(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

describe('dateMarkerToLocalDate', () => {
  it('runs in a west-of-UTC zone, or the rest of this file proves nothing', () => {
    // If TZ did not take, this marker still reads as the 7th locally and every
    // assertion below would hold for the broken code too.
    expect(marker(2025, 10, 7).getDate()).toBe(6);
  });

  it('keeps the day the cell was drawn for', () => {
    const local = dateMarkerToLocalDate(marker(2025, 10, 7));
    expect(local.getFullYear()).toBe(2025);
    expect(local.getMonth()).toBe(10);
    expect(local.getDate()).toBe(7);
    expect(local.getHours()).toBe(0);
  });

  it('heads a Nov 7 day list with Nov 7, not Nov 6', () => {
    // The exact call DayEventsModal makes on the date it is handed.
    const format = (date: Date) =>
      date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    expect(format(marker(2025, 10, 7))).toBe('Thu, Nov 6'); // the bug
    expect(format(dateMarkerToLocalDate(marker(2025, 10, 7)))).toBe('Fri, Nov 7');
  });

  it('is right on both sides of a DST transition', () => {
    // Pacific leaves DST on 2025-11-02 and enters it on 2026-03-08. A blind
    // offset taken from "now" lands an hour out on one side or the other.
    for (const [m, d] of [
      [10, 1],
      [10, 2],
      [10, 3],
      [2, 7],
      [2, 8],
      [2, 9],
    ] as const) {
      const local = dateMarkerToLocalDate(marker(m === 2 ? 2026 : 2025, m, d));
      expect([local.getMonth(), local.getDate(), local.getHours()]).toEqual([m, d, 0]);
    }
  });

  it('round-trips every day of a month', () => {
    for (let day = 1; day <= 31; day += 1) {
      expect(localDateKey(dateMarkerToLocalDate(marker(2025, 0, day)))).toBe(`2025-0-${day}`);
    }
  });

  it('leaves a date that is already local alone', () => {
    // dateClick and navLinkDayClick arrive converted; the only safe thing to
    // do with those is nothing, so the two paths must agree on the same cell.
    const fromInteraction = new Date(2025, 10, 7, 0, 0, 0, 0);
    const fromMoreLink = dateMarkerToLocalDate(marker(2025, 10, 7));
    expect(localDateKey(fromMoreLink)).toBe(localDateKey(fromInteraction));
    expect(fromMoreLink.getTime()).toBe(fromInteraction.getTime());
  });
});

describe('localDateKey', () => {
  it('buckets by local day, the way the grid does', () => {
    // 2025-11-08T02:00:00Z is still Nov 7, 6pm in Pacific - the cell the event
    // is drawn in. A UTC-date key would file it under the 8th.
    const evening = new Date('2025-11-08T02:00:00Z');
    expect(localDateKey(evening)).toBe('2025-10-7');
    expect(localDateKey(dateMarkerToLocalDate(marker(2025, 10, 7)))).toBe('2025-10-7');
  });

  it('separates two days that share a UTC date', () => {
    const lateOnThe7th = new Date('2025-11-08T02:00:00Z'); // Nov 7, 18:00 PST
    const earlyOnThe8th = new Date('2025-11-08T18:00:00Z'); // Nov 8, 10:00 PST
    expect(localDateKey(lateOnThe7th)).not.toBe(localDateKey(earlyOnThe8th));
  });
});
