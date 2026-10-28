import type { Event } from '../types/event';
import { localDateKey } from './calendarDates';

/**
 * The pure parts of the calendar grid's two *click* paths.
 *
 * Hovering a chip is how the month grid is browsed and that is not changing,
 * but a hover card is a terrible place to put a link: reaching it means moving
 * the pointer off the thing that opened it. So every day with events also has
 * a plain button that opens that day's list, and the hover card keeps a
 * footer the pointer can actually land on. Three decisions in that are
 * arithmetic or wording rather than DOM, and they live here where they can be
 * tested without a browser:
 *
 * - which days get a button at all, and what it is called;
 * - where the hover card is allowed to sit so the footer stays on screen.
 */

/**
 * How many events each local day holds, keyed the way the grid buckets them.
 *
 * Built once per set of displayed events rather than filtered per cell: the
 * day-cell control has to be re-labelled for all 42 cells of a month whenever
 * the events change, and 42 passes over the whole list to count them is work
 * for nothing.
 *
 * The key is `localDateKey`'s, so it agrees with `getEventsForDate` - and so a
 * cell whose button says "3 events" opens a list of exactly those three. A UTC
 * date would file a Friday evening event under Saturday for every reader west
 * of UTC; see lib/calendarDates.ts.
 */
export function dayEventCounts(events: Event[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = localDateKey(new Date(event.startDate));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * What the day-cell control is called, to a screen reader and in its tooltip.
 *
 * A grid of forty-two buttons all named "+" is worse than no buttons at all -
 * a screen reader reads out a column of identical controls with nothing to
 * choose between them - so the name carries both the count and the date it
 * belongs to. The date is spelled out in full (`Friday, November 7`) rather
 * than in the cell's bare numeral, because a button announced on its own,
 * which is how a screen reader's control list reads it, has no cell around it
 * to say which day the numeral means.
 *
 * `count` is never 0: a day with no events gets no button, because a control
 * that promises a list and opens an empty one is a broken promise. The caller
 * enforces that; this guards the wording anyway.
 */
export function dayListLabel(date: Date, count: number): string {
  const when = date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  if (count <= 0) return `Events on ${when}`;
  if (count === 1) return `Show the 1 event on ${when}`;
  return `Show all ${count} events on ${when}`;
}

/**
 * Where the hover card's horizontal centre may sit, given the cursor.
 *
 * The card is centred on the pointer (`translateX(-50%)`), so within half a
 * card of either viewport edge it hangs off the screen and the reader loses
 * whichever half went over the side. Clamping the centre keeps the whole card
 * visible.
 *
 * The clamp cannot take the card out from under the pointer, which is the
 * property the footer's reachability rests on: the centre moves by at most the
 * amount the card overhangs, so the cursor stays inside
 * `[centre - cardWidth / 2, centre + cardWidth / 2]` and the full-width footer
 * is still directly above it. `cardWidth` is the card's *maximum* width, so a
 * card with little in it is nudged further from the edge than it strictly
 * needs to be - a few pixels of asymmetry, against measuring a DOM node
 * mid-render to shave them off.
 *
 * In a viewport too narrow to hold the card at all, centring it is the least
 * bad answer: both edges overflow equally instead of one losing everything.
 */
export function clampCardX(
  cursorX: number,
  cardWidth: number,
  viewportWidth: number,
  margin: number
): number {
  const half = cardWidth / 2;
  const min = half + margin;
  const max = viewportWidth - half - margin;
  if (min > max) return viewportWidth / 2;
  const inside = Math.min(Math.max(cursorX, min), max);
  // The margin gives way before the pointer does. Inside `margin` pixels of an
  // edge - a chip hard against the side of the window - holding the gap would
  // slide the card off the cursor and take the footer with it, so the card is
  // allowed to touch the edge instead.
  return Math.min(Math.max(inside, cursorX - half), cursorX + half);
}
