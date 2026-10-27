import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeTable, queryGsi1 } from './helpers/fakeDynamo.js';
import type { RankingSnapshot } from '../ranking/items.js';

/**
 * The catalogue items the rating pass publishes - `SET#<id>`, `COMPONENT#<id>`,
 * `VENUE#<shopExternalId>` and `SCENE#<sceneId>` - have to be *enumerable*, not
 * just fetchable by an id the reader already has.
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
  VENUE_CATALOGUE_PARTITION,
  SCENE_CATALOGUE_PARTITION,
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
    venues: [
      {
        venue: 'shop:1234',
        shopExternalId: 1234,
        name: 'Martinez, CA',
        latitude: 38.0194,
        longitude: -122.1341,
        players: 209,
        ratedPlayers: 123,
        matches: 1870,
        events: 94,
        firstSeen: '2026-10-01T18:00:00.000Z',
        lastSeen: '2026-10-24T18:00:00.000Z',
        sceneId: 's-0000',
        sceneLabel: 'Martinez, CA',
        scenePurity: 0.993,
        topPlayers: [
          { playerId: 'uuid-1', displayName: 'Player One', tagLine: 'NA1', matches: 42, rating: 1620, rated: true },
        ],
        topPlayersTruncated: true,
        generatedAt: GENERATED_AT,
      },
      {
        venue: 'shop:99',
        shopExternalId: 99,
        name: null,
        latitude: 37.77,
        longitude: -122.42,
        players: 7,
        ratedPlayers: 0,
        matches: 12,
        events: 2,
        firstSeen: '2026-10-05T18:00:00.000Z',
        lastSeen: '2026-10-06T18:00:00.000Z',
        sceneId: 's-0000',
        sceneLabel: 'Martinez, CA',
        scenePurity: 1,
        topPlayers: [],
        topPlayersTruncated: false,
        generatedAt: GENERATED_AT,
      },
    ],
    scenes: [
      {
        sceneId: 's-0000',
        label: 'Martinez, CA',
        venueCount: 2,
        playerCount: 216,
        ratedCount: 123,
        matchCount: 1882,
        medianPurity: 0.9965,
        assignedAt: '2026-10-20T00:00:00.000Z',
        generatedAt: GENERATED_AT,
      },
    ],
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
        // The scene's place rides on this item so a map is one Query; see
        // ranking/sceneMap.ts. A located scene and an unlocated one, because
        // both are normal states and the catalogue has to carry either.
        latitude: 37.804,
        longitude: -122.271,
        spreadKm: 133.4,
        nearestVenueKm: 7.2,
        locatedVenues: 373,
        locatedMatches: 26102,
        topVenues: [{ shopExternalId: 4211, latitude: 38.0194, longitude: -122.1341, matchCount: 1882 }],
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
        latitude: null,
        longitude: null,
        spreadKm: null,
        nearestVenueKm: null,
        locatedVenues: 0,
        locatedMatches: 0,
        topVenues: [],
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

  it('returns the whole venue catalogue from one GSI1 query', async () => {
    // A map's first render is "every venue with a pin". Without this key it is a
    // Scan - the same retrofit SET# and COMPONENT# needed, done before anything
    // depends on inferring the list.
    await saveRankingSnapshotDynamoDB(snapshot(), 1);

    const items = queryGsi1(VENUE_CATALOGUE_PARTITION);
    expect(items.map(item => item.shopExternalId)).toEqual([1234, 99]);
    expect(items.every(item => item.entityType === 'VENUE_PROFILE')).toBe(true);
    // Keyed on the shop id, never on venueKey's `geo:` coordinate fallback.
    expect(items.map(item => item.PK)).toEqual(['VENUE#1234', 'VENUE#99']);
    expect(items.every(item => item.SK === 'PROFILE')).toBe(true);
    // What a store page and a map pin need, in one read.
    const busiest = items[0];
    expect(busiest.name).toBe('Martinez, CA');
    expect(busiest.sceneId).toBe('s-0000');
    expect(busiest.scenePurity).toBe(0.993);
    expect((busiest.topPlayers as unknown[])).toHaveLength(1);
    expect(busiest.topPlayersTruncated).toBe(true);
  });

  it('returns the whole scene catalogue from one GSI1 query', async () => {
    await saveRankingSnapshotDynamoDB(snapshot(), 1);

    const items = queryGsi1(SCENE_CATALOGUE_PARTITION);
    expect(items.map(item => item.sceneId)).toEqual(['s-0000']);
    expect(items.every(item => item.entityType === 'SCENE_PROFILE')).toBe(true);
    expect(items.map(item => item.PK)).toEqual(['SCENE#s-0000']);
    // assignedAt is when the *assignment* was made, not when the refit ran.
    expect(items[0].assignedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(items[0].generatedAt).toBe(GENERATED_AT);
  });

  it('keeps the four catalogues in separate partitions', async () => {
    await saveRankingSnapshotDynamoDB(snapshot(), 1);

    const sets = queryGsi1(SET_CATALOGUE_PARTITION);
    const components = queryGsi1(COMPONENT_CATALOGUE_PARTITION);
    const venues = queryGsi1(VENUE_CATALOGUE_PARTITION);
    const scenes = queryGsi1(SCENE_CATALOGUE_PARTITION);
    expect(sets).toHaveLength(2);
    expect(components).toHaveLength(2);
    expect(venues).toHaveLength(2);
    expect(scenes).toHaveLength(1);
    const entityTypes = (items: Record<string, unknown>[]) =>
      new Set(items.map(item => item.entityType));
    expect(entityTypes(sets)).toEqual(new Set(['SET_PROFILE']));
    expect(entityTypes(components)).toEqual(new Set(['COMPONENT_PROFILE']));
    expect(entityTypes(venues)).toEqual(new Set(['VENUE_PROFILE']));
    expect(entityTypes(scenes)).toEqual(new Set(['SCENE_PROFILE']));
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

  it('removes a venue whose last match aged out, and a scene a re-clustering retired', async () => {
    // Otherwise the catalogue Query keeps serving a pin with no data behind it.
    await saveRankingSnapshotDynamoDB(snapshot(), 1);

    const narrowed = snapshot();
    narrowed.venues = narrowed.venues.slice(0, 1);
    narrowed.scenes = [];
    await saveRankingSnapshotDynamoDB(narrowed, 1);

    expect((queryGsi1(VENUE_CATALOGUE_PARTITION)).map(item => item.shopExternalId)).toEqual([1234]);
    expect(queryGsi1(SCENE_CATALOGUE_PARTITION)).toHaveLength(0);
  });
});
