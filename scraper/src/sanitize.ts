import type { ScrapedEvent, StoreInfo } from './database.js';

/**
 * Free-text sanitisation for everything that reaches the database.
 *
 * Both upstream sources are user-editable: store owners type their own event
 * names, descriptions and organizer names. Riot's live API currently returns 11
 * events whose organizer name is
 *
 *   Forever After Antiques and Collectibles Inc<script src="https://…/jquery.js?v=2"></script>
 *
 * i.e. a stored-XSS payload sitting in production data. The UVS feed has no such
 * string today, but nothing stops it from having one tomorrow, so every free
 * text field from *either* source goes through here on its way to the DB.
 *
 * Policy (strip, not escape - one consistent rule everywhere):
 *
 * 1. Script-ish elements (script/style/iframe/object/embed/svg/…) are removed
 *    together with their contents, so the payload's body never survives as text.
 * 2. Any remaining tags are removed, repeatedly, so nested constructions like
 *    `<scr<b>ipt>` cannot re-form a tag once the inner tag is stripped.
 * 3. Stray angle brackets and control characters are dropped, so no partial tag
 *    can be reassembled downstream.
 * 4. Whitespace (including NBSP and newlines) is collapsed to single spaces and
 *    the result is trimmed.
 *
 * Records are cleaned and kept, never dropped: an event with a poisoned
 * organizer name is still a real event that people want to see on the calendar.
 */

/** Elements whose *contents* are as dangerous as the tag itself. */
const DANGEROUS_BLOCK_RE =
  /<\s*(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*>[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi;

/** Same elements when self-closed or left unterminated, e.g. a bare `<script src=…>`. */
const DANGEROUS_OPEN_TAG_RE = /<\s*\/?\s*(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*>?/gi;

/** Any remaining tag, including comments and CDATA-ish `<!… >` constructs. */
const ANY_TAG_RE = /<[^<>]*>/g;

/** C0/C1 control characters (keep nothing: tabs/newlines are handled as whitespace first). */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

const WHITESPACE_RE = /[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

/** Repeatedly apply a replacement until the string stops changing. */
function stripUntilStable(value: string, pattern: RegExp): string {
  let current = value;
  // Bounded so a pathological input cannot spin forever.
  for (let i = 0; i < 8; i++) {
    const next = current.replace(pattern, ' ');
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Clean a single free-text value. Always returns a string (possibly empty).
 */
export function sanitizeToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);

  let cleaned = stripUntilStable(raw, DANGEROUS_BLOCK_RE);
  cleaned = stripUntilStable(cleaned, DANGEROUS_OPEN_TAG_RE);
  cleaned = stripUntilStable(cleaned, ANY_TAG_RE);
  // Whatever is left cannot be a tag any more; drop the brackets so nothing can
  // be reassembled into one further down the stack.
  cleaned = cleaned.replace(/[<>]/g, '');
  cleaned = cleaned.replace(CONTROL_CHARS_RE, ' ');
  cleaned = cleaned.replace(WHITESPACE_RE, ' ').trim();

  return cleaned;
}

/**
 * Clean an optional free-text value. Empty results become null rather than ''
 * so the DB keeps a single representation of "no value".
 */
export function sanitizeText(value: string | null | undefined): string | null {
  const cleaned = sanitizeToString(value);
  return cleaned.length > 0 ? cleaned : null;
}

/** Clean a value that must be a string in the DB (falls back when nothing survives). */
export function sanitizeRequiredText(value: string | null | undefined, fallback = ''): string {
  return sanitizeText(value) ?? fallback;
}

/** Free-text event fields that are written to the events table. */
export function sanitizeScrapedEvent<T extends ScrapedEvent>(event: T): T {
  return {
    ...event,
    name: sanitizeRequiredText(event.name),
    description: sanitizeText(event.description),
    location: sanitizeText(event.location),
    organizer: sanitizeText(event.organizer),
    address: sanitizeText(event.address),
    city: sanitizeText(event.city),
    state: sanitizeText(event.state),
    country: sanitizeText(event.country),
  };
}

/** Free-text store fields that are written to the shops table. */
export function sanitizeStoreInfo<T extends StoreInfo>(store: T): T {
  return {
    ...store,
    name: sanitizeRequiredText(store.name, 'Unknown organizer'),
    full_address: sanitizeRequiredText(store.full_address),
    city: sanitizeRequiredText(store.city),
    state: sanitizeRequiredText(store.state),
    country: sanitizeRequiredText(store.country),
  };
}
