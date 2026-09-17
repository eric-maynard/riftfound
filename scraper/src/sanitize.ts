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
 * 3. Control characters are dropped. Angle brackets that don't form a tag
 *    ("Ages <18", "<3") are kept: React escapes all text on output, so they are
 *    harmless, and stripping them mangles real descriptions.
 * 4. Whitespace is collapsed to single spaces and trimmed. Descriptions are the
 *    exception: they render with pre-wrap, so their line breaks are kept (runs
 *    of blank lines are capped).
 *
 * Records are cleaned and kept, never dropped: an event with a poisoned
 * organizer name is still a real event that people want to see on the calendar.
 */

/** Elements whose *contents* are as dangerous as the tag itself. */
const DANGEROUS_BLOCK_RE =
  /<\s*(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

/** Same elements when self-closed or left unterminated, e.g. a bare `<script src=…>`.
 *  Only the tag is removed, so an unclosed `<style>` can't swallow the rest of the text. */
const DANGEROUS_OPEN_TAG_RE = /<\s*\/?\s*(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*>?/gi;

/** Any remaining tag-shaped construct (`<b>`, `</p>`, `<!-- -->`), not a bare `<` or `>`. */
const ANY_TAG_RE = /<\s*[a-zA-Z!\/?][^<>]*>/g;

/** C0/C1 control characters, except tab and newline (handled as whitespace below). */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const HORIZONTAL_WHITESPACE_RE = /[ \t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g;

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
export function sanitizeToString(value: unknown, multiline = false): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);

  let cleaned = stripUntilStable(raw, DANGEROUS_BLOCK_RE);
  cleaned = stripUntilStable(cleaned, DANGEROUS_OPEN_TAG_RE);
  cleaned = stripUntilStable(cleaned, ANY_TAG_RE);
  cleaned = cleaned.replace(/\r\n?|[\u2028\u2029]/g, '\n');
  cleaned = cleaned.replace(CONTROL_CHARS_RE, ' ');
  cleaned = cleaned.replace(HORIZONTAL_WHITESPACE_RE, ' ');
  cleaned = multiline
    ? cleaned.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n')
    : cleaned.replace(/ *\n[ \n]*/g, ' ');
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Clean an optional free-text value. Empty results become null rather than ''
 * so the DB keeps a single representation of "no value".
 */
export function sanitizeText(value: string | null | undefined, multiline = false): string | null {
  const cleaned = sanitizeToString(value, multiline);
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
    description: sanitizeText(event.description, true),
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
