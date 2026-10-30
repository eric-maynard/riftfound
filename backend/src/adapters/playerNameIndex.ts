/**
 * Display-name search: the matcher, and the reader for the index it runs over.
 *
 * ## The bug this replaces
 *
 * `searchPlayers` was a Scan with `Limit: 500` over four pages and a
 * `SK = 'PROFILE'` filter. `Limit` on a Scan caps the items **examined before
 * the filter**, not the matches, so the endpoint looked at 2,000 raw items and
 * returned whatever had matched by then. Measured against production on
 * 2026-10-29, with 441,214 items in the table:
 *
 * | | |
 * |---|---|
 * | items examined per query | 2,000 |
 * | `PROFILE` rows among them | **178** |
 * | `PROFILE` rows in the table | **40,979** |
 * | **share of players searched** | **0.43%** |
 * | read units spent doing it | **203.5** |
 *
 * The visible failure was not that search was slow. It was that search was
 * **anti-correlated with relevance**: `sealsmasher` and `Dromex13` were found
 * because they sit at the front of scan order, while `illusionz#1337` and
 * `tpcstld#NA1` returned nothing - and both of those are *on the public
 * leaderboard*, rated, with a profile this API serves in full by id. A player
 * the ladder lists and the search cannot find is the headline, and no amount
 * of raising the page count fixes it: four pages of 500 is 0.43% of the corpus,
 * and covering the corpus that way is the full-table Scan per keystroke that
 * is not an option.
 *
 * ## What replaces it
 *
 * The refit publishes the whole display-name corpus as a handful of gzipped
 * `PLAYER_SEARCH` / `SHARD#<nnn>` items (scraper/src/ranking/searchIndex.ts).
 * This module decodes them into a flat in-memory index and matches against it.
 * The adapter holds the decoded index in module scope between invocations, so
 * the steady-state cost of a query is **the BatchGet for the hits it is about
 * to publish and nothing else** - ~10 keys, ~5 read units, against 203.5 for a
 * 0.43% answer.
 *
 * Three properties the shape buys that a name-keyed index could not:
 *
 * - **Substring search survives.** A GSI can answer `begins_with`, and
 *   nothing else. Measured over 8,000 real display names pulled from the live
 *   ladder, of every 2-to-4 character substring that actually occurs in a name
 *   a whole-name prefix match finds **14.8%** and a word-prefix match finds
 *   **17.3%** - because this corpus is overwhelmingly single-token handles
 *   (`SealSmasher`, `illusionz`), so splitting on whitespace buys 2.5
 *   percentage points. Prefix search would have fixed all four reported
 *   failures, which are exact names, and would have quietly stopped answering
 *   `smasher`.
 * - **Identity stays the UUID.** Nothing here is a key. The index is a payload
 *   keyed on a shard number, so a renamed player is renamed by the next refit
 *   rewriting a shard body, and no stored key anywhere ever contained a name.
 *   A name-keyed GSI would have put mutable presentation data in a key - and
 *   while DynamoDB would maintain it correctly, the contract would then be
 *   that a display name is addressable, which is exactly what the rating
 *   pass's privacy posture says it is not.
 * - **Results can be ranked.** With the whole corpus in hand the capped
 *   result set can be the *best* matches rather than the first ones scan order
 *   happened to reach. See `scoreNameMatch`.
 */
import { gunzipSync } from 'node:zlib';
import { PLAYER_SEARCH_INDEX_FORMAT } from '../config/dynamodb.js';

/** One player, as the index carries them. Three fields, deliberately. */
export interface PlayerNameEntry {
  playerId: string;
  displayName: string;
  tagLine: string;
  /** `displayName` lowercased. Precomputed: it is compared on every query. */
  name: string;
  /** `tagLine` lowercased. */
  tag: string;
}

export interface PlayerNameIndex {
  entries: PlayerNameEntry[];
  /** Shards the index was built from, for the log line and the tests. */
  shards: number;
  /** Lines a shard carried that could not be read. Expected zero. */
  malformed: number;
}

/**
 * How well a needle matches one entry. **Lower is better**, and the order is
 * the product decision in this module.
 *
 * Today's endpoint returns matches in table scan order, which is to say in no
 * order at all: a reader typing `sea` gets whichever ten `sea` players the
 * scan reached, and the cap then throws away the rest without having compared
 * them. With the whole corpus in hand the cap can mean "the ten closest", and
 * that is what makes a cap of 25 enough to never need a cursor.
 *
 * The tiers are the ones a person typing a name is actually expressing:
 *
 * 0. the needle **is** the display name - they know who they want
 * 1. the display name starts with it - they are part-way through typing it
 * 2. a word of the display name starts with it - `smash` for `Seal Smasher`
 * 3. the display name contains it - `smasher` for `SealSmasher`, the case the
 *    corpus's single-token handles make common
 * 4. the tag line matches or contains it - a weaker signal than any name
 *    match, because a tag line is short and shared (`NA1` is thousands of
 *    players), so it must never outrank a name hit
 *
 * Ties break on the **shorter display name** first: a five-character name
 * containing `ill` is a closer answer than a thirty-character one that happens
 * to contain it too. Then lexicographically, then on `playerId`, so the answer
 * to a given query is fully determined - an edge-cached endpoint whose result
 * order wobbled between origin hits would be a cache that serves two different
 * answers for one URL.
 */
export const NO_MATCH = Number.POSITIVE_INFINITY;

export function scoreNameMatch(needle: string, entry: PlayerNameEntry): number {
  const { name, tag } = entry;

  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;

  // Word-prefix. Split on anything that is not a letter or digit, which is
  // what separates words in a handle that uses spaces, dots or underscores.
  // It cannot see `Smasher` inside `SealSmasher`; tier 3 is what catches that.
  if (name.length > 0) {
    for (const word of name.split(/[^\p{L}\p{N}]+/u)) {
      if (word.length > 0 && word.startsWith(needle)) return 2;
    }
  }

  if (name.includes(needle)) return 3;
  if (tag === needle || tag.startsWith(needle) || tag.includes(needle)) return 4;
  return NO_MATCH;
}

/** The comparison the ranking above describes, as a sort. */
function compareHits(
  a: { score: number; entry: PlayerNameEntry },
  b: { score: number; entry: PlayerNameEntry }
): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.entry.name.length !== b.entry.name.length) return a.entry.name.length - b.entry.name.length;
  if (a.entry.name !== b.entry.name) return a.entry.name < b.entry.name ? -1 : 1;
  return a.entry.playerId < b.entry.playerId ? -1 : a.entry.playerId > b.entry.playerId ? 1 : 0;
}

export interface NameSearchResult {
  /** Player ids, best match first, already capped. */
  playerIds: string[];
  /** How many entries matched in total, before the cap. */
  matched: number;
}

/**
 * Match a needle against the whole index.
 *
 * A linear pass over 40,979 entries of two short strings each. That is not a
 * trade-off being managed, it is simply cheap: there is no index structure
 * here because a 41,000-element scan in memory is sub-millisecond, and a trie
 * or an n-gram map would be a data structure to keep correct in exchange for
 * nothing a reader could perceive. If the corpus ever grows two orders of
 * magnitude, this is the function to revisit and the measurement to take
 * first.
 *
 * `matched` is returned alongside the capped ids because the number is what
 * lets a page say "showing 25 of 112, keep typing" instead of silently
 * truncating - the same reasoning as publishing `coverage` beside a ladder
 * rather than a filtered list on its own.
 */
export function searchNameIndex(
  index: PlayerNameIndex,
  query: string,
  limit: number
): NameSearchResult {
  const needle = normaliseNeedle(query);
  if (needle.length < MIN_NEEDLE_LENGTH) return { playerIds: [], matched: 0 };

  const hits: { score: number; entry: PlayerNameEntry }[] = [];
  for (const entry of index.entries) {
    const score = scoreNameMatch(needle, entry);
    if (score !== NO_MATCH) hits.push({ score, entry });
  }

  hits.sort(compareHits);
  return {
    playerIds: hits.slice(0, limit).map((hit) => hit.entry.playerId),
    matched: hits.length,
  };
}

/**
 * The shortest needle this endpoint will answer.
 *
 * Two, unchanged, and it is a guard rather than a performance knob: a
 * single-character query matches a large fraction of 40,979 players, so
 * answering it would be handing out a slice of the corpus in response to no
 * information at all. The route's Zod schema rejects one character with a 400;
 * this is the matcher refusing it too, so a caller that reaches the matcher by
 * some other route gets the same answer.
 */
export const MIN_NEEDLE_LENGTH = 2;

/** Lowercase and collapse whitespace, the same way the index's names were. */
export function normaliseNeedle(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** One stored shard, as the adapter reads it off the item. */
export interface RawSearchShard {
  format?: unknown;
  shardIndex?: unknown;
  entries?: unknown;
  entriesGz?: unknown;
}

/**
 * Decode stored shards into an index.
 *
 * Returns null when there is nothing usable, and the distinction matters: a
 * null is "this API cannot search the whole corpus right now", which the
 * endpoint publishes as `coverage.complete: false` and the page explains,
 * rather than an empty result set that would read as "no such player". Same
 * discipline as `catalogueUnavailable` on the scene map.
 *
 * The format check is the load-bearing part. The writer is in the scraper and
 * the reader is here, so the two can be deployed apart; a format this build
 * does not know is **refused**, because a half-parsed index is a search that
 * works and is wrong, which is the failure this whole module exists to remove.
 */
export function decodeSearchShards(shards: RawSearchShard[]): PlayerNameIndex | null {
  const ordered = [...shards].sort((a, b) => Number(a.shardIndex ?? 0) - Number(b.shardIndex ?? 0));
  const entries: PlayerNameEntry[] = [];
  let malformed = 0;
  let used = 0;

  for (const shard of ordered) {
    if (shard.format !== PLAYER_SEARCH_INDEX_FORMAT) {
      malformed++;
      continue;
    }
    const raw = shard.entriesGz;
    if (!raw) {
      malformed++;
      continue;
    }

    let body: string;
    try {
      body = gunzipSync(Buffer.from(raw as Uint8Array)).toString('utf8');
    } catch {
      malformed++;
      continue;
    }
    used++;

    for (const line of body.split('\n')) {
      if (line.length === 0) continue;
      const fields = line.split('\t');
      // A line whose field count is wrong is dropped rather than read
      // positionally: reading a display name as a player id would publish a
      // link to a profile that does not exist. The writer strips tabs for
      // exactly this reason; this is the other half of that contract.
      if (fields.length !== 3) {
        malformed++;
        continue;
      }
      const [playerId, displayName, tagLine] = fields;
      if (!playerId) {
        malformed++;
        continue;
      }
      entries.push({
        playerId,
        displayName,
        tagLine,
        name: displayName.toLowerCase(),
        tag: tagLine.toLowerCase(),
      });
    }
  }

  if (used === 0) return null;
  return { entries, shards: used, malformed };
}

/** Build an index straight from records, for the fixture store and the tests. */
export function buildNameIndex(
  players: { playerId: string; displayName: string | null; tagLine: string | null }[]
): PlayerNameIndex {
  return {
    entries: players.map((player) => ({
      playerId: player.playerId,
      displayName: player.displayName ?? '',
      tagLine: player.tagLine ?? '',
      name: (player.displayName ?? '').toLowerCase(),
      tag: (player.tagLine ?? '').toLowerCase(),
    })),
    shards: 0,
    malformed: 0,
  };
}
