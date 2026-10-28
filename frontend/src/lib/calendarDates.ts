/**
 * Dates as FullCalendar hands them over.
 *
 * FullCalendar works internally in **date markers**: `DateMarker = Date` in
 * `@fullcalendar/core`'s internals, but a marker's *UTC* fields carry the
 * wall-clock values of the calendar's timezone. A Nov 7 cell is the marker
 * `2025-11-07T00:00:00Z` no matter where the reader is sitting.
 *
 * Most public callbacks convert a marker back to a real `Date` before handing
 * it out - `DateEnv.toDate`, which for the default `timeZone: 'local'` is
 * `arrayToLocalDate(dateToUtcArray(marker))`. Two of ours get that conversion
 * for free: `dateClick` and `navLinkDayClick` come from the interaction plugin
 * and arrive already converted, as does the `start` on every segment of
 * `moreLinkClick`'s `allSegs`.
 *
 * `moreLinkClick`'s own `date` does **not**. It is `computeRange(props).start`,
 * a raw marker, passed straight through. Read with local getters anywhere west
 * of UTC that Nov 7 marker is Nov 6 - which is how the "+N more" day list came
 * to be headed with the previous day.
 *
 * The fix is not an offset. Adding the current zone's offset gets the wrong
 * answer across a DST boundary, because the offset that matters is the one in
 * force on the marker's own day, not today's. Reading the UTC fields and
 * rebuilding a local `Date` from them is what the library itself does, and it
 * is right on both sides of a transition.
 */
export function dateMarkerToLocalDate(marker: Date): Date {
  return new Date(
    marker.getUTCFullYear(),
    marker.getUTCMonth(),
    marker.getUTCDate(),
    marker.getUTCHours(),
    marker.getUTCMinutes(),
    marker.getUTCSeconds(),
    marker.getUTCMilliseconds()
  );
}

/**
 * A date's local calendar day, as a comparable key.
 *
 * FullCalendar buckets events into cells by **local** day, so anything that
 * has to agree with the grid compares local date components. A UTC-date key
 * would put a Friday evening event in Saturday's cell for every reader west of
 * UTC and mix the wrong day's events into a day list.
 */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * The day a grid cell was drawn for, read back off its `data-date`.
 *
 * FullCalendar stamps every day cell with `data-date="YYYY-MM-DD"`, formatted
 * from the cell's own marker - so the string carries the cell's wall-clock day
 * and nothing about any timezone. It is the only handle on a cell's identity
 * available to code that walks the rendered grid rather than being handed a
 * callback argument, which is how the day-cell control gets re-labelled when
 * the events change.
 *
 * Parsed with the `Date(y, m, d)` constructor rather than `new Date(string)`.
 * `new Date('2025-11-07')` is defined to be **UTC** midnight, so west of UTC
 * it reads back as the 6th - the same off-by-one-day as the marker bug above,
 * arriving by a different route.
 *
 * Returns `null` rather than an Invalid Date for anything that is not that
 * shape, so a caller cannot accidentally key a map on `NaN`.
 */
export function dayStringToLocalDate(dayString: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayString);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  // A rolled-over date means the string named a day that does not exist, e.g.
  // "2025-02-30": the constructor takes it and silently lands in March.
  if (date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) {
    return null;
  }
  return date;
}
