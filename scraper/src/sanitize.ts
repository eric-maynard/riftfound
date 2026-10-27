import type { EventResults, EventRoster, ScrapedEvent, StoreInfo } from './database.js';
import type {
  ComponentProfile,
  PlayerMatchLogEntry,
  PlayerProfile,
  RankingMeta,
  RankingRow,
  RankingSnapshot,
  SceneProfile,
  SetProfile,
  VenueProfile,
} from './ranking/items.js';

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
    // An enum, but one that comes out of a user-editable system like every
    // other field here, so it gets the same treatment. Null stays null.
    playFormat: sanitizeText(event.playFormat),
  };
}

/**
 * Player-identifying free text from Riot's tournament pages.
 *
 * `displayName` and `tagLine` come from a user-editable account system - a
 * player chooses both - so they are exactly the kind of field the organizer-name
 * payload above turned up in, and they get the same treatment. Ids are left
 * alone: they are opaque UUIDs, not free text, and they are the identity key the
 * stored facts depend on.
 */
function sanitizePlayerText<T extends { name: string | null; tagLine: string | null }>(player: T): T {
  return { ...player, name: sanitizeText(player.name), tagLine: sanitizeText(player.tagLine) };
}

/** Player names written into an event's results row. */
export function sanitizeEventResults<T extends EventResults>(results: T): T {
  return {
    ...results,
    players: results.players.map(sanitizePlayerText),
    playFormat: sanitizeText(results.playFormat),
  };
}

/** Player names written into an event's roster row. */
export function sanitizeEventRoster<T extends EventRoster>(roster: T): T {
  return {
    ...roster,
    entries: roster.entries.map(sanitizePlayerText),
    playFormat: sanitizeText(roster.playFormat),
  };
}

/**
 * Free text on the derived ranking items.
 *
 * These items carry player names, event names, shop-derived region labels and
 * set labels - every one of them either user-editable upstream or built from a
 * field that is. They are re-sanitised here even though the facts they were
 * derived from were already cleaned: the rule in this codebase is that
 * sanitisation happens at the converter *and* at the storage boundary, so that
 * no code path can put raw text in a table, and a derived writer is exactly the
 * kind of new code path that rule exists for.
 */
export function sanitizePlayerProfile<T extends PlayerProfile>(profile: T): T {
  const setRatings: PlayerProfile['setRatings'] = {};
  for (const [setId, rating] of Object.entries(profile.setRatings)) {
    setRatings[setId] = { ...rating, label: sanitizeRequiredText(rating.label, setId) };
  }
  return {
    ...profile,
    displayName: sanitizeText(profile.displayName),
    tagLine: sanitizeText(profile.tagLine),
    regionLabel: sanitizeText(profile.regionLabel),
    sceneLabel: sanitizeText(profile.sceneLabel),
    setRatings,
  };
}

export function sanitizeMatchLogEntry<T extends PlayerMatchLogEntry>(entry: T): T {
  return {
    ...entry,
    opponentDisplayName: sanitizeText(entry.opponentDisplayName),
    opponentTagLine: sanitizeText(entry.opponentTagLine),
    eventName: sanitizeText(entry.eventName),
    tournamentType: sanitizeText(entry.tournamentType),
  };
}

export function sanitizeRankingRow<T extends RankingRow>(row: T): T {
  return {
    ...row,
    displayName: sanitizeText(row.displayName),
    tagLine: sanitizeText(row.tagLine),
    regionLabel: sanitizeText(row.regionLabel),
    sceneLabel: sanitizeText(row.sceneLabel),
  };
}

export function sanitizeRankingMeta<T extends RankingMeta>(meta: T): T {
  return {
    ...meta,
    label: sanitizeRequiredText(meta.label, meta.scope),
    regionLabel: sanitizeText(meta.regionLabel),
  };
}

export function sanitizeComponentProfile<T extends ComponentProfile>(component: T): T {
  return { ...component, regionLabel: sanitizeText(component.regionLabel) };
}

export function sanitizeSetProfile<T extends SetProfile>(set: T): T {
  return {
    ...set,
    name: sanitizeRequiredText(set.name, set.setId),
    source: sanitizeRequiredText(set.source),
  };
}

/**
 * A venue item. The name is a shop-table label and the roster carries player
 * display names, so both go through the same policy as everything else.
 */
export function sanitizeVenueProfile<T extends VenueProfile>(venue: T): T {
  return {
    ...venue,
    name: sanitizeText(venue.name),
    sceneLabel: sanitizeText(venue.sceneLabel),
    topPlayers: venue.topPlayers.map(entry => ({
      ...entry,
      displayName: sanitizeText(entry.displayName),
      tagLine: sanitizeText(entry.tagLine),
    })),
  };
}

export function sanitizeSceneProfile<T extends SceneProfile>(scene: T): T {
  return { ...scene, label: sanitizeText(scene.label) };
}

/**
 * The whole snapshot, at the storage boundary.
 *
 * The converter in ranking/snapshot.ts already cleans every item it builds.
 * This is the second application the house rule requires, and it is not
 * ceremony: it is what stops a future code path that assembles items some other
 * way - a backfill script, a repair tool - from putting markup in a table.
 */
export function sanitizeRankingSnapshot(snapshot: RankingSnapshot): RankingSnapshot {
  return {
    profiles: snapshot.profiles.map(sanitizePlayerProfile),
    history: snapshot.history,
    matchLog: snapshot.matchLog.map(sanitizeMatchLogEntry),
    matchLogEvents: snapshot.matchLogEvents,
    rankings: snapshot.rankings.map(sanitizeRankingRow),
    metas: snapshot.metas.map(sanitizeRankingMeta),
    components: snapshot.components.map(sanitizeComponentProfile),
    sets: snapshot.sets.map(sanitizeSetProfile),
    venues: snapshot.venues.map(sanitizeVenueProfile),
    scenes: snapshot.scenes.map(sanitizeSceneProfile),
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
