import { describe, it, expect, beforeEach, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import type { PlayerProfile, RankingSnapshot } from '../ranking/items.js';

/**
 * The published display-name index, from the writer's side.
 *
 * It exists because name search was the one access pattern the output contract
 * gave a reader no key to arrive on, so the API served it as a capped Scan -
 * and `Limit` on a Scan caps items *examined before the filter*. Measured
 * against production on 2026-10-29: 2,000 items examined held **178 of 40,979
 * profiles (0.43%)**, and `tpcstld#NA1` - rated, 1,380 +/- 97, on the public
 * leaderboard - was unfindable by name.
 *
 * What this file pins is the half the scraper owns: that **every** profile
 * reaches the index, that a shard provably fits DynamoDB's 400KB item limit,
 * that the bytes are the format the reader promises to read, and that a
 * shrinking corpus does not leave names behind. The reader's side is in
 * `backend/src/__tests__/playerSearch.test.ts`, deliberately decoding the
 * format by hand rather than importing this builder, because the two packages
 * deploy apart.
 */

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    constructor(public readonly config: unknown) {}
  },
}));

vi.mock('@aws-sdk/lib-dynamodb', async () => {
  const { fakeSend, FAKE_COMMANDS } = await import('./helpers/fakeDynamo.js');
  return { DynamoDBDocumentClient: { from: () => ({ send: fakeSend }) }, ...FAKE_COMMANDS };
});

import { fakeTable } from './helpers/fakeDynamo.js';
import { saveRankingSnapshotDynamoDB } from '../dynamodb.js';
import {
  buildPlayerSearchIndex,
  PLAYER_SEARCH_INDEX_FORMAT,
  SEARCH_SHARD_MAX_UNCOMPRESSED_BYTES,
} from '../ranking/searchIndex.js';

/** DynamoDB's hard ceiling on one item. The budget exists to stay under it. */
const DYNAMO_ITEM_LIMIT_BYTES = 400 * 1024;

/**
 * One item's size the way DynamoDB charges for it: the UTF-8 length of every
 * attribute name plus the size of its value, with a binary value counted as
 * its raw bytes.
 *
 * Spelled out rather than approximated with `JSON.stringify`, which was the
 * first attempt and is wrong by a factor of five: a `Buffer` serialises as
 * `{"0":120,"1":45,...}`, so the test reported a 180KB shard as 578KB and
 * failed a limit the writer was comfortably inside.
 */
function dynamoItemSize(item: Record<string, unknown>): number {
  let bytes = 0;
  for (const [name, value] of Object.entries(item)) {
    bytes += Buffer.byteLength(name, 'utf8');
    if (value instanceof Uint8Array) bytes += value.length;
    else if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8');
    else if (typeof value === 'number') bytes += 8;
    else bytes += Buffer.byteLength(String(value), 'utf8');
  }
  return bytes;
}

const GENERATED_AT = '2026-10-29T12:00:00.000Z';

function profile(playerId: string, displayName: string | null, tagLine: string | null): PlayerProfile {
  return {
    playerId,
    displayName,
    tagLine,
    rating: 1380,
    provisionalRating: 1380,
    uncertainty: 97,
    uncertaintyLogOdds: 0.56,
    crossComponentUncertainty: 97,
    gamesPlayed: 8,
    matchesPlayed: 8,
    wins: 5,
    losses: 3,
    draws: 0,
    rated: true,
    provisional: false,
    provisionalReason: null,
    gamesUntilRated: 0,
    componentId: 'c1',
    componentSize: 40,
    regionLabel: 'Somewhere',
    sceneId: null,
    sceneLabel: null,
    setRatings: [],
    firstSeen: '2026-10-01',
    lastSeen: '2026-10-28',
    modelVersion: 'whr-1',
    eloOrigin: 1200,
    generatedAt: GENERATED_AT,
  } as unknown as PlayerProfile;
}

function snapshot(profiles: PlayerProfile[]): RankingSnapshot {
  return {
    profiles,
    history: [],
    matchLog: [],
    matchLogEvents: [],
    rankings: [],
    metas: [],
    components: [],
    sets: [],
    venues: [],
    scenes: [],
  };
}

/**
 * A filler profile whose display name is long on purpose.
 *
 * Shard boundaries are decided by bytes, not by player count, so a long name
 * reaches a multi-shard index in hundreds of profiles instead of tens of
 * thousands - which keeps the storage-backed tests below fast while still
 * exercising the real sharding, padding and pruning. The *coverage* tests
 * below use the pure builder, where 40,000 profiles cost nothing.
 */
function bulkyProfile(index: number): PlayerProfile {
  return profile(
    `p-${String(index).padStart(6, '0')}`,
    `Filler${index} ${'y'.repeat(900)}`,
    `NA${index % 10}`
  );
}

/** Every `PLAYER_SEARCH` shard in the fake table, in shard order. */
function storedShards() {
  return [...fakeTable.values()]
    .filter((item) => item.PK === 'PLAYER_SEARCH')
    .sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
}

/** The whole index as the reader would reconstruct it. */
function storedEntries(): { playerId: string; displayName: string; tagLine: string }[] {
  return storedShards().flatMap((shard) =>
    gunzipSync(Buffer.from(shard.entriesGz as Uint8Array))
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [playerId, displayName, tagLine] = line.split('\t');
        return { playerId, displayName, tagLine };
      })
  );
}

beforeEach(() => {
  fakeTable.clear();
});

describe('every profile reaches the index', () => {
  it('indexes all of them, not a page of them', () => {
    const profiles = Array.from({ length: 40_000 }, (_, i) =>
      profile(`p-${String(i).padStart(6, '0')}`, `Filler${i}`, `NA${i % 10}`)
    );
    const index = buildPlayerSearchIndex(profiles);
    expect(index.entries).toBe(40_000);
    expect(index.skipped).toBe(0);
  });

  it('round-trips a player at the very back of the corpus through storage', async () => {
    // The position `tpcstld` was in: last, where four pages of 500 never
    // reached. The whole point is that position stops mattering.
    const profiles = [
      ...Array.from({ length: 2_000 }, (_, i) => bulkyProfile(i)),
      profile('u-tpcstld', 'tpcstld', 'NA1'),
    ];
    await saveRankingSnapshotDynamoDB(snapshot(profiles), 2);

    const entries = storedEntries();
    expect(entries).toHaveLength(2_001);
    // Past the 178 profiles four pages of 500 could examine, and spread over
    // more than one shard, so neither the old cap nor a single-item index
    // could have produced this.
    expect(storedShards().length).toBeGreaterThan(1);
    expect(entries).toContainEqual({ playerId: 'u-tpcstld', displayName: 'tpcstld', tagLine: 'NA1' });
  });

  it('reports the shard and name counts in the write summary', async () => {
    const profiles = Array.from({ length: 1_000 }, (_, i) => bulkyProfile(i));
    const summary = await saveRankingSnapshotDynamoDB(snapshot(profiles), 2);
    expect(summary.searchEntries).toBe(1_000);
    expect(summary.searchShards).toBe(storedShards().length);
    expect(summary.searchShards).toBeGreaterThan(1);
  });

  it('drops a profile with no id rather than indexing an unjoinable name', () => {
    const index = buildPlayerSearchIndex([
      profile('p-1', 'Alice', 'NA1'),
      profile('', 'Nameless', 'NA1'),
    ]);
    expect(index.entries).toBe(1);
    expect(index.skipped).toBe(1);
  });

  it('indexes a player with no display name, so an id is never silently dropped', () => {
    const index = buildPlayerSearchIndex([profile('p-1', null, null)]);
    expect(index.entries).toBe(1);
    expect(index.shards[0].body).toBe('p-1\t\t');
  });
});

describe('a shard provably fits the item limit', () => {
  /**
   * The budget is on the **uncompressed** payload, and that is the design
   * decision worth a test of its own: gzip never expands data of this shape,
   * so an uncompressed budget under 400KB is a proof the item fits whatever
   * any particular corpus compresses to. The alternative - fill, compress,
   * measure, re-split - fails by overflowing a `BatchWriteItem`, which would
   * show up as a *partially* populated index: a search that works for most
   * names and silently cannot see the rest, which is the bug being fixed.
   */
  it('keeps every shard under the budget, measured uncompressed', () => {
    const profiles = Array.from({ length: 40_000 }, (_, i) =>
      profile(`p-${String(i).padStart(6, '0')}`, `A Reasonably Long Display Name ${i}`, `TAG${i}`)
    );
    for (const shard of buildPlayerSearchIndex(profiles).shards) {
      expect(Buffer.byteLength(shard.body, 'utf8')).toBeLessThanOrEqual(
        SEARCH_SHARD_MAX_UNCOMPRESSED_BYTES
      );
    }
  });

  it('keeps every stored shard under the item limit even when nothing compresses', async () => {
    // Deliberately incompressible names: random hex, so gzip has nothing to
    // work with. This is the case the uncompressed budget is a proof for.
    const profiles = Array.from({ length: 2_000 }, (_, i) =>
      profile(
        `p-${String(i).padStart(6, '0')}`,
        Array.from({ length: 30 }, () => Math.random().toString(16).slice(2)).join(''),
        Math.random().toString(16).slice(2, 8)
      )
    );
    await saveRankingSnapshotDynamoDB(snapshot(profiles), 2);

    expect(storedShards().length).toBeGreaterThan(1);
    for (const shard of storedShards()) {
      expect(dynamoItemSize(shard)).toBeLessThan(DYNAMO_ITEM_LIMIT_BYTES);
    }
  });

  it('gives an over-budget single line its own shard rather than losing the player', () => {
    const index = buildPlayerSearchIndex([
      profile('p-1', 'x'.repeat(SEARCH_SHARD_MAX_UNCOMPRESSED_BYTES + 10), 'NA1'),
      profile('p-2', 'Alice', 'NA1'),
    ]);
    expect(index.entries).toBe(2);
    expect(index.shards).toHaveLength(2);
  });
});

describe('the format is the contract the reader reads', () => {
  it('stores the format marker, so a reader can refuse what it does not know', async () => {
    await saveRankingSnapshotDynamoDB(snapshot([profile('p-1', 'Alice', 'NA1')]), 2);
    expect(storedShards()[0]).toMatchObject({
      PK: 'PLAYER_SEARCH',
      SK: 'SHARD#000',
      entityType: 'PLAYER_SEARCH_SHARD',
      format: PLAYER_SEARCH_INDEX_FORMAT,
      shardIndex: 0,
      entries: 1,
    });
  });

  it('zero-pads the shard number, so an SK-ascending Query is shard order', async () => {
    const profiles = Array.from({ length: 3_400 }, (_, i) => bulkyProfile(i));
    await saveRankingSnapshotDynamoDB(snapshot(profiles), 2);
    const keys = storedShards().map((shard) => shard.SK);
    expect(keys.length).toBeGreaterThan(9);
    // Unpadded, `SHARD#10` would sort before `SHARD#2` - the same reason the
    // ladder's rank is padded to six digits.
    expect(keys).toEqual([...keys].sort());
  });

  it('strips a tab out of a name rather than shifting every field on the line', () => {
    // `sanitize.ts` collapses whitespace so this should be unreachable, but a
    // single stray tab would silently turn one player's name into the next
    // player's id, so the encoder does not trust it.
    const index = buildPlayerSearchIndex([profile('p-1', 'Al\tice', 'N\nA1')]);
    expect(index.shards[0].body).toBe('p-1\tAl ice\tN A1');
    expect(index.shards[0].body.split('\n')).toHaveLength(1);
  });

  it('adds no GSI1 keys, because the shards already share a partition', async () => {
    await saveRankingSnapshotDynamoDB(snapshot([profile('p-1', 'Alice', 'NA1')]), 2);
    const shard = storedShards()[0];
    expect(shard.GSI1PK).toBeUndefined();
    expect(shard.GSI1SK).toBeUndefined();
  });
});

describe('idempotency and pruning', () => {
  it('writes identical shards for the same corpus whatever order it arrives in', () => {
    const profiles = Array.from({ length: 5_000 }, (_, i) =>
      profile(`p-${String(i).padStart(6, '0')}`, `Filler${i}`, 'NA1')
    );
    const forward = buildPlayerSearchIndex(profiles);
    const reversed = buildPlayerSearchIndex([...profiles].reverse());
    // Sorted by playerId, so shard boundaries are a function of the corpus and
    // not of the order the replay visited players in - otherwise a refit that
    // changed nothing would still rewrite every shard.
    expect(reversed.shards.map((shard) => shard.body)).toEqual(forward.shards.map((shard) => shard.body));
  });

  it('deletes the shards a shrunken corpus no longer fills', async () => {
    const many = Array.from({ length: 1_500 }, (_, i) => bulkyProfile(i));
    await saveRankingSnapshotDynamoDB(snapshot(many), 2);
    const before = storedShards().length;
    expect(before).toBeGreaterThan(1);

    await saveRankingSnapshotDynamoDB(snapshot([profile('p-1', 'Alice', 'NA1')]), 2);
    const after = storedShards();

    // A leftover shard is not a dangling pin a reader can shrug off: the
    // reader concatenates every shard it finds, so it would keep serving
    // names whose profiles this refit decided not to write.
    expect(after).toHaveLength(1);
    expect(storedEntries()).toEqual([{ playerId: 'p-1', displayName: 'Alice', tagLine: 'NA1' }]);
  });

  it('records the shard count in the scope directory, which is what drives the prune', async () => {
    const profiles = Array.from({ length: 1_500 }, (_, i) => bulkyProfile(i));
    await saveRankingSnapshotDynamoDB(snapshot(profiles), 2);
    const directory = fakeTable.get('RANKING_INDEX|RANKING_INDEX');
    expect(directory?.searchShards).toBe(storedShards().length);
  });
});
