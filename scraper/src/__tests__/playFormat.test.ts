import { describe, it, expect } from 'vitest';
// Must come before the ../database.js import: it chooses the backend *and*
// seeds a pre-migration database. See the comment in that file.
import { LEGACY_EVENT_ID, LEGACY_EVENT_START } from './helpers/legacySqliteEnv.js';
import {
  closePool,
  loadEventFactCandidates,
  loadEventFactsByDate,
  saveEventResults,
  saveEventRoster,
  upsertEventWithStore,
  type EventResults,
  type EventRoster,
  type ScrapedEvent,
} from '../database.js';
import { hasEventChanged, type DynamoEventItem } from '../dynamodb.js';

/**
 * Storage for Riot's event `format` (`playFormat` in TypeScript, `play_format`
 * in SQL), against a real throwaway SQLite file that starts in the shape a
 * long-lived dev database is actually in.
 *
 * What makes this field different from every other one in the schema: it is
 * **capturable only at discovery time, and only once**. Riot's search API is
 * upcoming-only so it will never return a past event, and the event detail page
 * the results pass reads carries no format field at all. So an event that is
 * written without it is unanalysable for format forever. Every rule pinned here
 * follows from that:
 *
 * - a null never makes a record invalid, because ~90,000 rows have one
 *   permanently;
 * - the DynamoDB change check must *notice* the field appearing, or the rows
 *   already in the table would never acquire it;
 * - a UVS re-write must not drop it, because the UVS pass never has one.
 */

const SHOP = {
  id: 2_000_123_456,
  name: 'Pokerecyclers',
  full_address: '806 W 3rd St, Antioch, CA 94509, USA',
  city: 'Antioch',
  state: 'CA',
  country: 'US',
  latitude: 38.0162814,
  longitude: -121.816311,
  website: null,
  email: null,
};

function event(externalId: string, overrides: Partial<ScrapedEvent> = {}): ScrapedEvent {
  return {
    externalId,
    name: 'Pokerecyclers Weekly Bo3 Nexus Night',
    startDate: new Date('2026-10-20T01:00:00Z'),
    eventType: 'Nexus Night',
    latitude: SHOP.latitude,
    longitude: SHOP.longitude,
    sources: ['playriftbound'],
    ...overrides,
  };
}

async function candidateFor(externalId: string) {
  const candidates = await loadEventFactCandidates({ daysBack: 365, daysForward: 2 });
  const candidate = candidates.find(entry => entry.externalId === externalId);
  expect(candidate, `no candidate for ${externalId}`).toBeDefined();
  return candidate!;
}

describe('the play_format column migrates onto an existing database', () => {
  it('stores and reads back a format on a table created without the column', async () => {
    // Opening the database ran the additive ALTER TABLE; if it had not, this
    // insert would fail on an unknown column rather than silently skip it.
    await upsertEventWithStore(event('prb-200000000000000001', { playFormat: 'SEALED' }), SHOP);

    expect((await candidateFor('prb-200000000000000001')).playFormat).toBe('SEALED');
  });

  it('leaves the pre-existing row null, and still offers it as a candidate', async () => {
    // The whole point: this row predates the column and can never be
    // backfilled. Null must read as null and must not disqualify the event from
    // the facts passes.
    const candidate = await candidateFor(LEGACY_EVENT_ID);
    expect(candidate.playFormat).toBeNull();
    expect(candidate.eventType).toBe('Nexus Night');
    expect(candidate.eventStartDate.toISOString()).toBe(LEGACY_EVENT_START);
  });

  it('round-trips a null for a freshly written event, without dropping it', async () => {
    await upsertEventWithStore(event('prb-200000000000000002'), SHOP);
    expect((await candidateFor('prb-200000000000000002')).playFormat).toBeNull();
  });

  it('stores the upstream value verbatim rather than normalising it', async () => {
    await upsertEventWithStore(
      event('prb-200000000000000003', { playFormat: 'SOMETHING_RIOT_ADDS_LATER' }),
      SHOP
    );
    expect((await candidateFor('prb-200000000000000003')).playFormat).toBe('SOMETHING_RIOT_ADDS_LATER');
  });

  it('updates the column on an event that was first stored without one', async () => {
    await upsertEventWithStore(event('prb-200000000000000004'), SHOP);
    expect((await candidateFor('prb-200000000000000004')).playFormat).toBeNull();

    await upsertEventWithStore(event('prb-200000000000000004', { playFormat: 'CONSTRUCTED' }), SHOP);
    expect((await candidateFor('prb-200000000000000004')).playFormat).toBe('CONSTRUCTED');
  });

  it('sanitises the value at the storage boundary as well as the converter', async () => {
    await upsertEventWithStore(
      event('prb-200000000000000005', { playFormat: 'SEALED<script>alert(1)</script>' }),
      SHOP
    );
    expect((await candidateFor('prb-200000000000000005')).playFormat).toBe('SEALED');
  });
});

describe('the facts carry the format they were captured with', () => {
  const factContext = {
    externalId: 'prb-300000000000000001',
    tournamentId: '300000000000000001',
    eventStartDate: new Date('2026-10-21T01:00:00Z'),
    eventType: 'Nexus Night',
    playFormat: 'CONSTRUCTED',
    shopExternalId: SHOP.id,
    latitude: SHOP.latitude,
    longitude: SHOP.longitude,
  };

  const roster = (playFormat: string | null): EventRoster => ({
    ...factContext,
    playFormat,
    source: 'registrants',
    playerCount: 1,
    entries: [
      {
        playerId: 'p1',
        name: 'One',
        tagLine: 'NA1',
        teamId: null,
        status: 'REGISTERED',
        checkedIn: false,
        waitlistPosition: null,
        registeredAt: '2026-10-20T19:18:23.464Z',
      },
    ],
    capturedAt: '2026-10-20T20:00:00Z',
  });

  const results = (playFormat: string | null): EventResults => ({
    ...factContext,
    playFormat,
    status: 'none',
    roundCount: 0,
    playerCount: 0,
    openMatches: 0,
    players: [],
    standings: [],
    rounds: [],
    sourceUpdatedAt: null,
    capturedAt: '2026-10-21T08:00:00Z',
  });

  it('writes the format onto a roster and a results row, and reads it back', async () => {
    // This is the only route by which a rating pass could ever see format: the
    // facts are written from the detail page, which has none, so they inherit
    // the event row's value or nothing.
    expect(await saveEventRoster(roster('CONSTRUCTED'))).toEqual({ skipped: false });
    expect(await saveEventResults(results('CONSTRUCTED'))).toEqual({ skipped: false });

    const { rosters, results: stored } = await loadEventFactsByDate('2026-10-21');
    expect(rosters.map(entry => entry.playFormat)).toEqual(['CONSTRUCTED']);
    expect(stored.map(entry => entry.playFormat)).toEqual(['CONSTRUCTED']);
  });

  it('accepts a null format on a fact without dropping the capture', async () => {
    const nullFormat = { ...factContext, externalId: 'prb-300000000000000002', tournamentId: '300000000000000002' };
    expect(await saveEventRoster({ ...roster(null), ...nullFormat, playFormat: null })).toEqual({ skipped: false });

    const { rosters } = await loadEventFactsByDate('2026-10-21');
    const captured = rosters.find(entry => entry.externalId === 'prb-300000000000000002');
    expect(captured).toBeDefined();
    expect(captured!.playFormat).toBeNull();
    expect(captured!.playerCount).toBe(1);
  });
});

/**
 * The deploy-day question: will the ~90,000 rows already in DynamoDB pick the
 * field up?
 *
 * They only can if the change check sees it. `upsertEventWithStoreDynamoDB`
 * skips the write entirely when `hasEventChanged` says nothing moved, and for a
 * stable weekly event nothing else *does* move - so a check that ignored
 * playFormat would mean the column populated for new events only, and never for
 * anything currently stored.
 */
describe('hasEventChanged notices the format appearing', () => {
  const base = {
    PK: 'EVENT#prb-1',
    SK: 'EVENT#prb-1',
    GSI1PK: 'DATE#2026-10-20',
    GSI1SK: 'EVENT#prb-1',
    entityType: 'EVENT' as const,
    externalId: 'prb-1',
    name: 'Thursday Nexus Nights',
    description: null,
    location: 'Games of Martinez',
    address: '123 Main St, Martinez, CA 94553, USA',
    city: 'Martinez',
    state: 'CA',
    country: 'US',
    latitude: 38.0194,
    longitude: -122.1341,
    startDate: '2026-10-20T01:00:00.000Z',
    startTime: null,
    endDate: null,
    eventType: 'Nexus Night',
    organizer: 'Games of Martinez',
    playerCount: 4,
    capacity: 16,
    price: '$15.00',
    url: 'https://playriftbound.com/en-us/events/1',
    imageUrl: null,
    sources: ['playriftbound'],
    playFormat: null,
    shopId: 2_000_000_001,
    shopExternalId: 2_000_000_001,
    shopName: 'Games of Martinez',
    shopLatitude: 38.0194,
    shopLongitude: -122.1341,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    scrapedAt: '2026-10-01T00:00:00.000Z',
  } satisfies DynamoEventItem;

  /** An item as it sits in the table today: no playFormat attribute at all. */
  function preMigrationItem(): DynamoEventItem {
    const { playFormat: _absent, ...rest } = base;
    return rest as DynamoEventItem;
  }

  it('is a change when a stored row with no format is about to get one', () => {
    expect(hasEventChanged(base, { ...base, playFormat: 'CONSTRUCTED' })).toBe(true);
  });

  it('is a change on a row stored before the attribute existed at all', () => {
    // Pre-migration items have no playFormat attribute, not a null one.
    expect(hasEventChanged(preMigrationItem(), { ...base, playFormat: 'SEALED' })).toBe(true);
  });

  it('is not a change when the format is unchanged, however it is spelled', () => {
    expect(hasEventChanged(base, { ...base })).toBe(false);
    expect(hasEventChanged({ ...base, playFormat: 'SEALED' }, { ...base, playFormat: 'SEALED' })).toBe(false);

    // A missing attribute and an explicit null are the same absence, so an
    // untouched pre-migration row does not churn a write every cycle.
    expect(hasEventChanged(preMigrationItem(), { ...base, playFormat: null })).toBe(false);
  });

  it('is a change when the format changes value', () => {
    expect(
      hasEventChanged({ ...base, playFormat: 'CONSTRUCTED' }, { ...base, playFormat: 'SEALED' })
    ).toBe(true);
  });
});

describe('cleanup', () => {
  it('closes the pool', async () => {
    await closePool();
  });
});
