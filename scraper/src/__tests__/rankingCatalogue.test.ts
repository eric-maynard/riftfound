import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeTable, queryGsi1 } from './helpers/fakeDynamo.js';
import type { RankingSnapshot } from '../ranking/items.js';

/**
 * The catalogue items the rating pass publishes - `SET#<id>` and
 * `COMPONENT#<id>` - have to be *enumerable*, not just fetchable by an id the
 * reader already has.
 *
 * They were not. Verified live, `SET#s4` and `SET#s5` carried the whole
 * authoritative set catalogue (name, release date, match and rated counts) and
 * no GSI1 keys at all, so `/api/sets` could not list them: it fell back to
 * discovering set ids from player profiles, served them with `name: null`, and
 * missed Radiance entirely because nobody was rated in it yet. The component
 * list had the same shape of problem and was being rebuilt by reading the
 * global board and unioning player profiles.
 *
 * So this pins the index: one Query per catalogue, against the GSI1 that
 * already exists and already projects ALL.
 *
 * The table is faked in memory rather than mocked call-by-call, because the
 * thing under test is what a *reader* can get back out - which a call
 * assertion cannot show.
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

import {
  saveRankingSnapshotDynamoDB,
  SET_CATALOGUE_PARTITION,
  COMPONENT_CATALOGUE_PARTITION,
} from '../dynamodb.js';

const GENERATED_AT = '2026-10-25T12:00:00.000Z';

function snapshot(): RankingSnapshot {
  return {
    profiles: [],
    history: [],
    matchLog: [],
    matchLogEvents: [],
    rankings: [],
    metas: [],
    components: [
      {
        componentId: 'c-0000',
        componentSize: 7531,
        playerCount: 7531,
        ratedCount: 2603,
        regionLabel: 'Martinez, CA',
        componentShare: 0.974,
        matchCount: 26102,
        venueCount: 373,
        isGiant: true,
        positionsSuppressed: false,
        generatedAt: GENERATED_AT,
      },
      {
        componentId: 'c-0001',
        componentSize: 2,
        playerCount: 2,
        ratedCount: 0,
        regionLabel: null,
        componentShare: 0.0003,
        matchCount: 1,
        venueCount: 1,
        isGiant: false,
        positionsSuppressed: true,
        generatedAt: GENERATED_AT,
      },
    ],
    sets: [
      {
        setId: 's4',
        name: 'Vendetta',
        releaseDate: '2026-07-31',
        endDate: '2026-10-23',
        ambiguous: false,
        setIds: ['4'],
        source: 'https://riftbound.com/vendetta',
        matchCount: 1228,
        ratedCount: 78,
        fitted: true,
        generatedAt: GENERATED_AT,
      },
      {
        // The case that broke the fallback: a set nobody is rated in yet is
        // invisible to any list derived from player profiles.
        setId: 's5',
        name: 'Radiance',
        releaseDate: '2026-10-23',
        endDate: '2027-01-29',
        ambiguous: false,
        setIds: ['5'],
        source: 'https://riftbound.com/radiance',
        matchCount: 4,
        ratedCount: 0,
        fitted: false,
        generatedAt: GENERATED_AT,
      },
    ],
  };
}

describe('the ranking catalogue items are enumerable via GSI1', () => {
  beforeEach(() => {
    fakeTable.clear();
  });

  it('returns the whole set catalogue from one GSI1 query', async () => {
    await saveRankingSnapshotDynamoDB(snapshot(), 1);

    const items = queryGsi1(SET_CATALOGUE_PARTITION);
    expect(items.map(item => item.setId)).toEqual(['s4', 's5']);
    // The names are the point: the profile-derived fallback had none.
    expect(items.map(item => item.name)).toEqual(['Vendetta', 'Radiance']);
    expect(items.every(item => item.entityType === 'SET_PROFILE')).toBe(true);
    // Still addressable by id - the index is additive, the main keys unchanged.
    expect(items.map(item => item.PK)).toEqual(['SET#s4', 'SET#s5']);
    expect(items.every(item => item.SK === 'PROFILE')).toBe(true);
  });

  it('returns the whole component catalogue from one GSI1 query', async () => {
    await saveRankingSnapshotDynamoDB(snapshot(), 1);

    const items = queryGsi1(COMPONENT_CATALOGUE_PARTITION);
    expect(items.map(item => item.componentId)).toEqual(['c-0000', 'c-0001']);
    expect(items.every(item => item.entityType === 'COMPONENT_PROFILE')).toBe(true);
    expect(items.map(item => item.PK)).toEqual(['COMPONENT#c-0000', 'COMPONENT#c-0001']);
  });

  it('keeps the two catalogues in separate partitions', async () => {
    await saveRankingSnapshotDynamoDB(snapshot(), 1);

    const sets = queryGsi1(SET_CATALOGUE_PARTITION);
    const components = queryGsi1(COMPONENT_CATALOGUE_PARTITION);
    expect(sets).toHaveLength(2);
    expect(components).toHaveLength(2);
    expect(sets.some(item => item.entityType === 'COMPONENT_PROFILE')).toBe(false);
    expect(components.some(item => item.entityType === 'SET_PROFILE')).toBe(false);
  });

  it('indexes rows written over an un-indexed predecessor', async () => {
    // Production rows predate the index. A refit rewrites the whole item, so
    // the keys arrive with the next refit and need no migration.
    fakeTable.set('SET#s4|PROFILE', { PK: 'SET#s4', SK: 'PROFILE', setId: 's4', name: 'Vendetta' });
    expect(queryGsi1(SET_CATALOGUE_PARTITION)).toHaveLength(0);

    await saveRankingSnapshotDynamoDB(snapshot(), 1);
    expect((queryGsi1(SET_CATALOGUE_PARTITION)).map(item => item.setId)).toEqual(['s4', 's5']);
  });

  it('removes a catalogue entry that a later refit no longer publishes', async () => {
    await saveRankingSnapshotDynamoDB(snapshot(), 1);

    const narrowed = snapshot();
    narrowed.sets = narrowed.sets.slice(0, 1);
    narrowed.components = narrowed.components.slice(0, 1);
    await saveRankingSnapshotDynamoDB(narrowed, 1);

    expect((queryGsi1(SET_CATALOGUE_PARTITION)).map(item => item.setId)).toEqual(['s4']);
    expect((queryGsi1(COMPONENT_CATALOGUE_PARTITION)).map(item => item.componentId)).toEqual(['c-0000']);
  });
});
