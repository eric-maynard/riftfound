/**
 * The published display-name index: the one derived artifact that exists so a
 * reader can find a player by name without walking the table.
 *
 * ## Why this exists at all
 *
 * The output contract gives every other read a key to arrive on. A player page
 * is one Query on `PLAYER#<uuid>`, a board is one Query on `RANKING#<scope>`,
 * a catalogue is one Query on a GSI1 partition. **Name search had none**, so
 * the API served it as a capped Scan - and `Limit` on a Scan caps the items
 * *examined before the filter*, not the matches, so the whole endpoint looked
 * at the first 2,000 raw items of a 441,555-item table and stopped. Measured
 * against production on 2026-10-29, those 2,000 items held **178 profiles of
 * 40,979 (0.43%)**, and the observable consequence was that
 * `/api/players/search?q=tpcstld` returned nothing for a player sitting on the
 * public leaderboard with 1,380 +/- 97 over 8 games.
 *
 * So the refit publishes the index, for the same reason it publishes the scene
 * map: the join is affordable in exactly one place, and this is it. Every
 * profile already passes through `snapshot.profiles`, so the index is a second
 * pass over a list already in hand.
 *
 * ## What is in it, and what is deliberately not
 *
 * Three fields per player: `playerId`, `displayName`, `tagLine`. Nothing else
 * - not the rating, not the region, not the game count. The index answers
 * *which ids match this text*, and the API then fetches those ids' profiles
 * with the `getPlayers` BatchGet it already has. Keeping the rating out is
 * partly cost (the index is read in full and a rating would not help the
 * match) and partly posture: this is the most widely-read item the pass
 * writes, so it carries the minimum that answers the question.
 *
 * **The index is not published to readers.** It is read by the API, in the
 * Lambda, and the endpoint on top of it keeps the shape it has always had -
 * minimum two characters, a capped result set, no cursor, `noindex`. Shipping
 * the list to the browser would make search free per query, and would also
 * hand every reader every player's name in one request; see
 * "Privacy of the derived ratings" for why aggregation is treated as a change
 * in kind here even when every underlying fact is public.
 *
 * ## The format, and why it is self-describing
 *
 * One tab-separated line per player, gzipped, split across as many
 * `PLAYER_SEARCH` / `SHARD#<nnn>` items as the budget below needs - the same
 * shape (and the same `gzipSync` of a joined string) as the `SCRAPE_CYCLE`
 * shards the cancellation pass already writes.
 *
 * The shard carries `format: 'tsv-1'`, and the reader is required to refuse a
 * format it does not know rather than guess at the bytes. That matters because
 * the writer is in this repository and the reader is in another package: a
 * format change that silently half-parsed would produce a search index that
 * *works* and is *wrong*, which is the failure mode this whole module exists
 * to remove.
 */
import type { PlayerProfile } from './items.js';

/** Bumped when the encoding below changes. Readers refuse what they do not know. */
export const PLAYER_SEARCH_INDEX_FORMAT = 'tsv-1';

/**
 * Uncompressed bytes allowed in one shard's body.
 *
 * This is a budget on the **uncompressed** payload on purpose, and it is the
 * one design decision in this module worth defending. DynamoDB's ceiling is
 * 400KB on the stored item, and gzip never expands data of this shape, so an
 * uncompressed budget under 400KB is a *proof* that the item fits - whatever
 * any particular set of names happens to compress to, and whatever a future
 * corpus of mostly-unique non-Latin handles compresses to.
 *
 * The alternative is to fill a shard, compress it, measure, and re-split when
 * it came out too big. That loop's failure mode is a shard that overflows and
 * is dropped by `BatchWriteItem`, which would show up as a *partially*
 * populated index - a search that works for most names and silently cannot see
 * the rest. That is precisely the bug being fixed, so the fix does not get to
 * reintroduce it in a smaller form.
 *
 * 300,000 bytes is chosen with room to spare: measured on production profiles
 * a line is ~52 bytes uncompressed and ~30 compressed, so a shard holds ~5,800
 * players as ~175KB of stored gzip, and 40,979 players is 8 shards.
 */
export const SEARCH_SHARD_MAX_UNCOMPRESSED_BYTES = 300_000;

/** One shard's worth of index, ready to be stored. */
export interface PlayerSearchIndexShard {
  shardIndex: number;
  /** Players in this shard. */
  entries: number;
  /** The encoded, *uncompressed* body. The storage layer gzips it. */
  body: string;
}

export interface PlayerSearchIndex {
  format: string;
  shards: PlayerSearchIndexShard[];
  /** Players across every shard. */
  entries: number;
  /** Profiles skipped for having no id. Expected to be zero; logged if not. */
  skipped: number;
}

/**
 * A field value, with the two characters the format reserves removed.
 *
 * `sanitize.ts` already collapses whitespace, so a tab or a newline should
 * never reach here. "Should never" is not a format guarantee, though, and the
 * cost of being wrong is asymmetric: one stray tab in one display name would
 * shift every field on that line, so the encoder strips rather than trusts.
 * The decoder is defensive in the matching way - it drops a line whose field
 * count is wrong instead of reading a name as an id.
 */
function field(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

/**
 * Build the index from the profiles a refit is about to write.
 *
 * Sorted by `playerId` so the shard boundaries are a deterministic function of
 * the corpus rather than of the order the replay happened to visit players in.
 * That is the same discipline as every other key in this pass: re-running over
 * the same facts has to rewrite the same items with the same contents, or a
 * refit that changed nothing still bills for every shard.
 */
export function buildPlayerSearchIndex(profiles: PlayerProfile[]): PlayerSearchIndex {
  const lines: string[] = [];
  let skipped = 0;

  const ordered = [...profiles].sort((a, b) =>
    a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0
  );

  for (const profile of ordered) {
    // No id, no entry: a name that cannot be joined back to a player is not a
    // search result, it is a dead row in a list. Same rule as the roster
    // entries the results pass drops.
    const playerId = field(profile.playerId);
    if (!playerId) {
      skipped++;
      continue;
    }
    lines.push(`${playerId}\t${field(profile.displayName)}\t${field(profile.tagLine)}`);
  }

  const shards: PlayerSearchIndexShard[] = [];
  let current: string[] = [];
  let currentBytes = 0;

  const flush = () => {
    if (current.length === 0) return;
    shards.push({ shardIndex: shards.length, entries: current.length, body: current.join('\n') });
    current = [];
    currentBytes = 0;
  };

  for (const line of lines) {
    // +1 for the newline that will join it. A single line longer than the
    // whole budget still gets its own shard rather than being dropped - a
    // 300KB display name is not reachable (`sanitize.ts` and Riot both bound
    // them) but losing a player would be worse than an oversized shard, and
    // the storage layer reports the size it wrote.
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (currentBytes + size > SEARCH_SHARD_MAX_UNCOMPRESSED_BYTES && current.length > 0) flush();
    current.push(line);
    currentBytes += size;
  }
  flush();

  return { format: PLAYER_SEARCH_INDEX_FORMAT, shards, entries: lines.length, skipped };
}
