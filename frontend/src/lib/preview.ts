/**
 * The Rankings preview flag.
 *
 * Rankings is deployed but unlisted, and **everything that points at it is
 * gated on the same flag** - the mode switch, and the trophy that leads to an
 * event's standings. A reader without the parameter should see no trace of the
 * section, which means one predicate, used everywhere, rather than each
 * surface deciding for itself.
 *
 * The URL is the whole switch. Nothing is persisted: an earlier version wrote
 * it to `localStorage` so it would survive navigation, which meant a single
 * visit turned the section on permanently for that browser - an opt-in nobody
 * could find their way out of. Persistence is not needed, because every link
 * this app generates inside the preview carries the current query string along.
 *
 * `?preview=ranking` (singular) is still honoured: that link was handed out
 * before the section was renamed.
 */
export function isRankingsPreview(search: string): boolean {
  return previewValue(search) !== null;
}

/**
 * Carry the flag onto an internal link.
 *
 * This is the other half of the deal the comment above makes. Nothing is
 * persisted, so the parameter survives exactly as long as the app keeps
 * putting it back - and **one surface that drops it strands the reader**, not
 * merely inconveniences them: the flag gates the mode switch, so the moment a
 * link lands without it the switch unmounts and there is no visible control
 * left anywhere on the page to get back out of the section. That is what the
 * Rankings half of the mode switch itself used to do, pointing at a bare
 * `/rankings`. So every link this app generates while the preview is on goes
 * through here, including the ones that only lead back to the calendar: a
 * reader who walks out of the preview and returns should find it still on.
 *
 * `target` may be a path, a path with a query and a hash, or a bare query
 * string (the mode switch stores each section's `location.search` and hands it
 * over as-is). `current` is the query string the reader is on now - passed in
 * rather than read off `window`, so this stays a pure function and the tests
 * need no DOM.
 *
 * An existing `preview` on the target wins: a link that deliberately names a
 * value, including the legacy singular, is not second-guessed. When there is
 * nothing to carry the target comes back untouched, character for character,
 * so this can be wrapped around a link unconditionally.
 */
export function carryPreview(target: string, current: string): string {
  const flag = previewValue(current);
  if (flag === null) return target;

  // Split off the hash first: the flag belongs in the query, and a hash that
  // swallowed `?preview=rankings` would simply be a dead anchor.
  const hashAt = target.indexOf('#');
  const hash = hashAt === -1 ? '' : target.slice(hashAt);
  const beforeHash = hashAt === -1 ? target : target.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const pathname = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? '' : beforeHash.slice(queryAt + 1));

  if (!params.has('preview')) params.set('preview', flag);

  const search = params.toString();
  // Never a bare `?`: an empty query string is no query string at all, and
  // react-router would otherwise put one in the address bar.
  return `${pathname}${search === '' ? '' : `?${search}`}${hash}`;
}

/**
 * The requested preview, or `null` when none was asked for. Both the predicate
 * and the carrier read the flag through here, so the set of accepted values -
 * and the legacy singular among them - is written down once.
 */
function previewValue(search: string): string | null {
  const requested = new URLSearchParams(search).get('preview');
  return requested === 'rankings' || requested === 'ranking' ? requested : null;
}
