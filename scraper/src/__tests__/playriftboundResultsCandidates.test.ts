import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeTable, type FakeItem } from './helpers/fakeDynamo.js';

/**
 * Which stored rows the results pass is allowed to see - the production
 * (DynamoDB) half of it.
 *
 * The selection used to be `externalId.startsWith('prb-')`, and that quietly
 * excluded every **merged** event. A matched cross-source pair keeps the UVS
 * identity (merge.ts), so the surviving row's externalId is a UVS number with no
 * prefix to match, and the pass never queued it at all. Measured on production
 * 2026-10-26: 5,738 merged rows in the table, ~3,476 of them finished and inside
 * the 45-day lookback. Their Riot tournament id survives on `url`, which the
 * merge policy hands to Riot.
 *
 * Two properties are pinned here, and they are the two that could regress:
 * a merged candidate is **indistinguishable downstream** from a `prb-` one, and
 * the `prb-` path still behaves exactly as it did - including that the fact keys
 * are built from the row's own externalId, so a merged event's capture lands
 * under its UVS id (which is the id the backend's availability BatchGet asks
 * about) rather than under the Riot id.
 *
 * The table is faked in memory rather than mocked call-by-call, for the same
 * reason rankingCatalogue.test.ts does it: what matters is what a reader gets
 * back out.
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

import { loadEventFactCandidatesDynamoDB } from '../dynamodb.js';

/** The loader walks UTC day partitions relative to now, so build the key the same way. */
const TODAY = new Date().toISOString().split('T')[0];
const START = new Date(`${TODAY}T01:00:00.000Z`);

/** The fake table is keyed `PK|SK`, exactly as a BatchGet will look an item up. */
function putFake(item: FakeItem): void {
  fakeTable.set(`${item.PK}|${item.SK}`, item);
}

function eventRow(externalId: string, overrides: Partial<FakeItem> = {}): FakeItem {
  return {
    PK: `EVENT#${externalId}`,
    SK: `EVENT#${externalId}`,
    GSI1PK: `DATE#${TODAY}`,
    GSI1SK: `EVENT#${externalId}`,
    externalId,
    name: 'Thursday Nexus Nights',
    startDate: START.toISOString(),
    eventType: 'Nexus Night',
    playFormat: null,
    url: null,
    latitude: 38.0194,
    longitude: -122.1341,
    shopExternalId: 4242,
    ...overrides,
  };
}

describe('loadEventFactCandidatesDynamoDB', () => {
  beforeEach(() => {
    fakeTable.clear();
  });

  it('accepts a prb- row off its externalId, exactly as before', async () => {
    putFake(eventRow('prb-117209411862156256'));

    const candidates = await loadEventFactCandidatesDynamoDB({ daysBack: 1, daysForward: 1 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      externalId: 'prb-117209411862156256',
      tournamentId: '117209411862156256',
      eventType: 'Nexus Night',
      shopExternalId: 4242,
      results: null,
      hasRoster: false,
    });
    expect(candidates[0].eventStartDate.toISOString()).toBe(START.toISOString());
  });

  it('accepts a merged row off its URL, with the same shape downstream', async () => {
    putFake(eventRow('853410', {
      url: 'https://playriftbound.com/en-us/events/117087016664758142',
      sources: ['uvs', 'playriftbound'],
    }));

    const candidates = await loadEventFactCandidatesDynamoDB({ daysBack: 1, daysForward: 1 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      // The UVS id the capture will be keyed on...
      externalId: '853410',
      // ...and the Riot id the page fetch needs. For a `prb-` row these are the
      // same number with a prefix; for a merged row they are unrelated.
      tournamentId: '117087016664758142',
      eventType: 'Nexus Night',
      shopExternalId: 4242,
      results: null,
      hasRoster: false,
    });
  });

  it('reads a merged row\'s existing captures under its UVS id, not the Riot id', async () => {
    // This is the half that decides whether the backend can ever find the
    // capture: the fact keys come from the event row's own externalId.
    putFake(eventRow('853410', {
      url: 'https://playriftbound.com/en-US/events/117087016664758142',
    }));
    putFake({
      PK: 'RESULTS#853410',
      SK: 'RESULTS#853410',
      status: 'partial',
      attempts: 1,
      lastCheckedAt: '2026-10-26T12:00:00.000Z',
    });
    putFake({ PK: 'ROSTER#853410', SK: 'ROSTER#853410' });
    // A capture filed under the Riot id would be a capture nothing reads.
    putFake({ PK: 'RESULTS#117087016664758142', SK: 'RESULTS#117087016664758142', status: 'final' });

    const [candidate] = await loadEventFactCandidatesDynamoDB({ daysBack: 1, daysForward: 1 });
    expect(candidate.results).toMatchObject({ status: 'partial', attempts: 1 });
    expect(candidate.results?.lastCheckedAt?.toISOString()).toBe('2026-10-26T12:00:00.000Z');
    expect(candidate.hasRoster).toBe(true);
  });

  it('leaves out rows that identify no Riot tournament', async () => {
    // A UVS-only row carries no URL at all (389 of 389 in the measured day
    // partition), and a row pointing at a store's own site is not an event page.
    putFake(eventRow('853411', { url: null, sources: ['uvs'] }));
    putFake(eventRow('853412', { url: 'https://gamesofmartinez.com/calendar' }));
    putFake(eventRow('853413', { url: 'https://playriftbound.com.evil.test/en-us/events/117' }));
    putFake(eventRow('prb-117209411862156256'));

    const candidates = await loadEventFactCandidatesDynamoDB({ daysBack: 1, daysForward: 1 });
    expect(candidates.map(c => c.externalId)).toEqual(['prb-117209411862156256']);
  });

  it('queues both shapes together, oldest first once the pass sorts them', async () => {
    // The new candidates have to interleave with the existing backlog rather
    // than jumping ahead of it, and they do because the only ordering the queue
    // applies is on the event's start time (selectDueEventFacts).
    putFake(eventRow('prb-1', { startDate: `${TODAY}T01:00:00.000Z` }));
    putFake(eventRow('853410', {
      startDate: `${TODAY}T02:00:00.000Z`,
      url: 'https://playriftbound.com/en-us/events/117087016664758142',
    }));
    putFake(eventRow('prb-2', { startDate: `${TODAY}T03:00:00.000Z` }));

    const candidates = await loadEventFactCandidatesDynamoDB({ daysBack: 1, daysForward: 1 });
    const byStart = [...candidates].sort(
      (x, y) => x.eventStartDate.getTime() - y.eventStartDate.getTime()
    );
    expect(byStart.map(c => c.externalId)).toEqual(['prb-1', '853410', 'prb-2']);
  });
});
