import type { ScrapedEvent } from './database.js';

/**
 * Cross-source event de-duplication.
 *
 * The UVS Games API and Riot's playriftbound API have no shared identifier for
 * the same real-world event, so events are matched on the only things both
 * sources agree on: where the event is and when it starts.
 *
 * Key = round(lat, 3) | round(lon, 3) | start time truncated to the minute.
 * 3 decimal places of latitude/longitude is roughly 110m, which is tight enough
 * to keep two different stores in the same strip mall apart but loose enough to
 * absorb the small differences between the two APIs' geocoders.
 *
 * Lookups additionally check the eight neighbouring cells, because a store the
 * two APIs geocode ~20m apart can still land either side of a rounding boundary.
 * Measured against the live feeds in the Bay Area, where 42 events matched, the
 * neighbour-cell lookup reaches 98.5% recall on provably identical events; the 6
 * remaining misses are geocode drift wider than one cell, not different events.
 *
 * Location + time alone is *not* sufficient on its own, though: of 391 pairs
 * that matched on location and time across the whole feed, 192 were not the same
 * event. They are overwhelmingly a store's stale recurring UVS series sitting on
 * top of the same store's Riot prerelease - e.g. Games of Martinez at
 * 2026-10-16T01:00Z, UVS "Thursday Nexus Nights" ($15, Nexus Night) against Riot
 * "Radiance Pre-Rift Event" ($40, Pre-Rift). The audit found a clean
 * discriminator for exactly these:
 *
 *   - where the two sources agree on category, the price agrees 86.9% of the time
 *   - where the two sources disagree on category, the price agrees  3.6% of the time
 *
 * So a candidate match is rejected when price *and* category both differ (see
 * looksLikeDifferentEvent) and the two events are kept as separate events. A
 * null/missing value on either side is not a difference - only two present,
 * conflicting values count.
 */

export type DedupeableEvent = Pick<ScrapedEvent, 'latitude' | 'longitude' | 'startDate'> &
  Partial<Pick<ScrapedEvent, 'eventType' | 'price'>>;

function roundCoord(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'na';
  }
  // Math.round can produce -0; toFixed normalises it back to "0.000".
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

function startMinute(startDate: Date): string {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
    return 'na';
  }
  // "2026-10-02T01:00:00.000Z" -> "2026-10-02T01:00Z"
  return `${startDate.toISOString().slice(0, 16)}Z`;
}

/**
 * Build the de-duplication key for an event.
 * Two events from different sources with the same key are candidates for being
 * the same event (see looksLikeDifferentEvent for the guard that vets them).
 */
export function eventDedupeKey(event: DedupeableEvent): string {
  return [roundCoord(event.latitude), roundCoord(event.longitude), startMinute(event.startDate)].join('|');
}

/** One cell step: the rounding granularity of the key, ~110m. */
const CELL = 0.001;
const OFFSETS = [-CELL, 0, CELL];

function shiftCoord(rounded: string, offset: number): string {
  if (rounded === 'na') return 'na';
  const shifted = Number(rounded) + offset;
  // Keep longitudes inside [-180, 180] so antimeridian neighbours still match.
  const wrapped = shifted > 180 ? shifted - 360 : shifted < -180 ? shifted + 360 : shifted;
  return (Math.round(wrapped * 1000) / 1000).toFixed(3);
}

/**
 * Every key that should be treated as "this same event", i.e. the event's own
 * cell plus the eight cells around it.
 */
export function dedupeKeyCandidates(event: DedupeableEvent): string[] {
  const lat = roundCoord(event.latitude);
  const lon = roundCoord(event.longitude);
  const minute = startMinute(event.startDate);

  const keys: string[] = [];
  for (const dLat of OFFSETS) {
    for (const dLon of OFFSETS) {
      keys.push(`${shiftCoord(lat, dLat)}|${shiftCoord(lon, dLon)}|${minute}`);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Price / category guard
// ---------------------------------------------------------------------------

/** "Free", "free event", "$0.00" and "0" all mean the same thing. */
function normalizePrice(price: string | null | undefined): string | null {
  if (price === null || price === undefined) return null;
  const value = price.trim().toLowerCase();
  if (!value) return null;
  if (value === 'free' || value === 'free event') return 'free';
  const numeric = value.replace(/[^0-9.]/g, '');
  if (numeric && Number(numeric) === 0) return 'free';
  return value.replace(/\s+/g, '');
}

function normalizeCategory(eventType: string | null | undefined): string | null {
  if (eventType === null || eventType === undefined) return null;
  const value = eventType.trim().toLowerCase();
  return value || null;
}

/** Two values conflict only when both are present and differ. */
function conflicts(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== b;
}

/**
 * Guard against over-merging two genuinely different events that a store
 * happens to run at the same place and minute.
 *
 * Rejects the match when the price and the category *both* conflict; a missing
 * price or category on either side is not evidence of anything.
 */
export function looksLikeDifferentEvent(a: DedupeableEvent, b: DedupeableEvent): boolean {
  const priceConflict = conflicts(normalizePrice(a.price), normalizePrice(b.price));
  const categoryConflict = conflicts(normalizeCategory(a.eventType), normalizeCategory(b.eventType));
  return priceConflict && categoryConflict;
}

// ---------------------------------------------------------------------------
// Primary-source index
// ---------------------------------------------------------------------------

/**
 * Location+time index of the primary (UVS) source's events.
 *
 * A key holds a *list*, because one store legitimately runs several events at
 * the same minute; the guard above then picks which of them (if any) a
 * secondary-source event actually is.
 */
export type DedupeIndex<T extends DedupeableEvent> = Map<string, T[]>;

export function addToDedupeIndex<T extends DedupeableEvent>(index: DedupeIndex<T>, event: T): void {
  const key = eventDedupeKey(event);
  const bucket = index.get(key);
  if (bucket) {
    bucket.push(event);
  } else {
    index.set(key, [event]);
  }
}

export function buildDedupeIndex<T extends DedupeableEvent>(events: Iterable<T>): DedupeIndex<T> {
  const index: DedupeIndex<T> = new Map();
  for (const event of events) {
    addToDedupeIndex(index, event);
  }
  return index;
}

/**
 * Find the primary-source event that `event` duplicates, or null.
 *
 * Candidates come from the event's own cell plus the eight around it; the first
 * one that survives the price/category guard wins. Primary events listed in
 * `claimed` are skipped: one primary record can only be the duplicate of one
 * secondary record, so a store's second Riot tournament at the same minute is a
 * separate event rather than a second copy of the same UVS row.
 */
export function findDuplicate<T extends DedupeableEvent>(
  event: DedupeableEvent,
  index: ReadonlyMap<string, T[]>,
  claimed?: ReadonlySet<T>
): T | null {
  for (const key of dedupeKeyCandidates(event)) {
    const bucket = index.get(key);
    if (!bucket) continue;
    for (const candidate of bucket) {
      if (claimed?.has(candidate)) continue;
      if (!looksLikeDifferentEvent(event, candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export interface DedupeMatch<S extends DedupeableEvent, P extends DedupeableEvent> {
  /** The secondary-source (playriftbound) event. */
  secondary: S;
  /** The primary-source (UVS) event it duplicates - the row of record. */
  primary: P;
}

/**
 * Split a secondary source's events into the ones the primary source has not
 * already reported and the ones it has (paired with their primary-source match,
 * so callers can merge the two records rather than discard one of them).
 *
 * The index is intentionally *not* extended as events are inspected: a single
 * store legitimately runs two different tournaments starting at the same minute,
 * so two events from the same source sharing a key are both kept. Only overlap
 * with the primary source counts as a duplicate.
 */
export function splitDuplicates<S extends DedupeableEvent, P extends DedupeableEvent>(
  events: S[],
  index: ReadonlyMap<string, P[]>
): { unique: S[]; matched: DedupeMatch<S, P>[] } {
  const unique: S[] = [];
  const matched: DedupeMatch<S, P>[] = [];
  const claimed = new Set<P>();

  for (const event of events) {
    const primary = findDuplicate(event, index, claimed);
    if (primary) {
      claimed.add(primary);
      matched.push({ secondary: event, primary });
    } else {
      unique.push(event);
    }
  }

  return { unique, matched };
}

// ---------------------------------------------------------------------------
// Within-run identity de-duplication
// ---------------------------------------------------------------------------

/**
 * Record an event id as seen in this run, returning false if it was already
 * seen.
 *
 * The UVS API paginates by offset over a result set that shifts underneath us,
 * so a single run sees the same event id on more than one page: the audit
 * counted 607 repeated ids across 40,433 rows (1.5%). Upserting those twice is
 * pure waste (and, on DynamoDB, pure cost), so callers skip the repeats.
 */
export function markEventSeen(seen: Set<string>, externalId: string): boolean {
  if (seen.has(externalId)) return false;
  seen.add(externalId);
  return true;
}
