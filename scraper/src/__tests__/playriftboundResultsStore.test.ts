import { describe, it, expect } from 'vitest';
// Must come before the ../database.js import: it chooses the backend. See the
// comment in that file.
import './helpers/sqliteEnv.js';
import {
  closePool,
  eventResultsDigest,
  getEventResults,
  loadEventFactCandidates,
  loadEventFactsByDate,
  saveEventResults,
  saveEventRoster,
  supportsEventFacts,
  upsertEventWithStore,
  type EventResults,
  type EventRoster,
  type RosterSource,
} from '../database.js';

/**
 * Storage discipline for tournament facts, against a real throwaway SQLite file.
 *
 * The rules being pinned down here are the ones a rating pass depends on:
 * a roster is write-once, a results re-check that finds nothing new writes only
 * its bookkeeping, and nothing reaches a table without being sanitised.
 */

const START = new Date('2026-10-20T01:00:00Z');
const EXTERNAL_ID = 'prb-117209411862156256';

const context = {
  externalId: EXTERNAL_ID,
  tournamentId: '117209411862156256',
  eventStartDate: START,
  eventType: 'Nexus Night',
  playFormat: 'CONSTRUCTED',
  shopExternalId: 2_000_123_456,
  latitude: 38.0162814,
  longitude: -121.816311,
};

function results(overrides: Partial<EventResults> = {}): EventResults {
  return {
    ...context,
    status: 'partial',
    roundCount: 1,
    playerCount: 2,
    openMatches: 1,
    players: [
      { teamId: 't1', playerId: 'p1', name: 'One', tagLine: 'NA1' },
      { teamId: 't2', playerId: 'p2', name: 'Two', tagLine: 'NA2' },
    ],
    standings: [
      {
        rank: 1,
        teamId: 't1',
        matchPoints: 3,
        matchWins: 1,
        matchLosses: 0,
        matchDraws: 0,
        opponentMatchWinPct: 0.5,
        gameWinPct: 1,
        opponentGameWinPct: 0.5,
      },
    ],
    rounds: [
      {
        section: 0,
        roundNumber: 1,
        status: 'FINALIZED',
        byeTeamIds: [],
        matches: [
          {
            matchId: 'm1',
            tableNumber: 1,
            status: 'IN_PROGRESS',
            bye: false,
            sides: [
              { teamId: 't1', outcome: 'WIN', gameWins: 2 },
              { teamId: 't2', outcome: 'LOSS', gameWins: 1 },
            ],
            games: [
              { number: 1, winnerTeamId: 't1' },
              { number: 2, winnerTeamId: 't2' },
              { number: 3, winnerTeamId: 't1' },
            ],
          },
        ],
      },
    ],
    sourceUpdatedAt: '2026-10-20T05:00:00Z',
    capturedAt: '2026-10-21T00:00:00Z',
    ...overrides,
  };
}

function roster(source: RosterSource, playerCount: number): EventRoster {
  return {
    ...context,
    source,
    playerCount,
    entries: Array.from({ length: playerCount }, (_, i) => ({
      playerId: `p${i}`,
      name: `Player ${i}`,
      tagLine: 'NA1',
      teamId: source === 'participants' ? `t${i}` : null,
      status: 'REGISTERED',
      checkedIn: false,
      waitlistPosition: null,
      registeredAt: source === 'registrants' ? '2026-10-19T19:18:23.464Z' : null,
    })),
    capturedAt: '2026-10-19T20:00:00Z',
  };
}

describe('tournament fact storage (SQLite)', () => {
  it('is supported on this backend', () => {
    expect(supportsEventFacts()).toBe(true);
  });

  it('offers a stored prb- event as a candidate with nothing captured yet', async () => {
    await upsertEventWithStore(
      {
        externalId: EXTERNAL_ID,
        name: 'Pokerecyclers Weekly Bo3 Nexus Night',
        startDate: START,
        eventType: 'Nexus Night',
        latitude: context.latitude,
        longitude: context.longitude,
        sources: ['playriftbound'],
      },
      {
        id: context.shopExternalId as number,
        name: 'Pokerecyclers',
        full_address: '806 W 3rd St, Antioch, CA 94509, USA',
        city: 'Antioch',
        state: 'CA',
        country: 'US',
        latitude: context.latitude,
        longitude: context.longitude,
        website: null,
        email: null,
      }
    );

    const candidates = await loadEventFactCandidates({ daysBack: 365, daysForward: 2 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      externalId: EXTERNAL_ID,
      tournamentId: '117209411862156256',
      eventType: 'Nexus Night',
      shopExternalId: context.shopExternalId,
      results: null,
      hasRoster: false,
    });
    expect(candidates[0].eventStartDate.toISOString()).toBe(START.toISOString());
  });

  it('writes a roster once and never replaces it', async () => {
    expect(await saveEventRoster(roster('registrants', 3))).toEqual({ skipped: false });
    // A later post-event fetch would offer the thinner participants list; the
    // dated registrant list cannot be reconstructed, so it has to win.
    expect(await saveEventRoster(roster('participants', 2))).toEqual({ skipped: true });

    const { rosters } = await loadEventFactsByDate('2026-10-20');
    expect(rosters).toHaveLength(1);
    expect(rosters[0].source).toBe('registrants');
    expect(rosters[0].playerCount).toBe(3);
    expect(rosters[0].entries[0].registeredAt).toBe('2026-10-19T19:18:23.464Z');
  });

  it('stores a results capture and reads it back in one lookup', async () => {
    expect(await saveEventResults(results())).toEqual({ skipped: false });

    const stored = await getEventResults(EXTERNAL_ID);
    expect(stored).not.toBeNull();
    expect(stored).toMatchObject({
      externalId: EXTERNAL_ID,
      status: 'partial',
      roundCount: 1,
      playerCount: 2,
      openMatches: 1,
      eventType: 'Nexus Night',
      shopExternalId: context.shopExternalId,
    });
    expect(stored?.rounds[0].matches[0].games).toHaveLength(3);
    expect(stored?.rounds[0].matches[0].sides.map(s => s.outcome)).toEqual(['WIN', 'LOSS']);
    expect(stored?.standings[0].opponentMatchWinPct).toBe(0.5);
    expect(stored?.players.map(p => p.playerId)).toEqual(['p1', 'p2']);
  });

  it('skips the rewrite when a re-check finds nothing new, but counts the attempt', async () => {
    expect(await saveEventResults(results())).toEqual({ skipped: true });

    const candidates = await loadEventFactCandidates({ daysBack: 365, daysForward: 2 });
    expect(candidates[0].results).toMatchObject({ status: 'partial', attempts: 2 });
    expect(candidates[0].results?.lastCheckedAt).toBeInstanceOf(Date);
    expect(candidates[0].hasRoster).toBe(true);
  });

  it('rewrites the row when the organizer finally closes the event out', async () => {
    const final = results({ status: 'final', openMatches: 0 });
    final.rounds[0].matches[0].status = 'COMPLETED';
    expect(eventResultsDigest(final)).not.toBe(eventResultsDigest(results()));
    expect(await saveEventResults(final)).toEqual({ skipped: false });

    const stored = await getEventResults(EXTERNAL_ID);
    expect(stored?.status).toBe('final');
    expect(stored?.openMatches).toBe(0);
    // The first capture's timestamp survives the rewrite.
    expect(stored?.capturedAt).toBe('2026-10-21T00:00:00Z');
  });

  it('sanitises player names at the storage boundary, not just the converter', async () => {
    const poisoned = results({
      externalId: 'prb-999',
      tournamentId: '999',
      players: [{ teamId: 't1', playerId: 'p1', name: 'Hi<script>x()</script>', tagLine: '<b>NA1</b>' }],
    });
    await saveEventResults(poisoned);
    const stored = await getEventResults('prb-999');
    expect(stored?.players[0].name).toBe('Hi');
    expect(stored?.players[0].tagLine).toBe('NA1');

    await saveEventRoster({
      ...roster('registrants', 1),
      externalId: 'prb-999',
      tournamentId: '999',
      entries: [
        {
          playerId: 'p1',
          name: 'Evil<iframe src="x"></iframe>',
          tagLine: 'NA<img src=y>',
          teamId: null,
          status: 'REGISTERED',
          checkedIn: false,
          waitlistPosition: null,
          registeredAt: null,
        },
      ],
    });
    const { rosters } = await loadEventFactsByDate('2026-10-20');
    const poisonedRoster = rosters.find(r => r.externalId === 'prb-999');
    expect(poisonedRoster?.entries[0].name).toBe('Evil');
    expect(poisonedRoster?.entries[0].tagLine).toBe('NA');
  });

  it('offers a merged row as a candidate, reading its tournament id off the URL', async () => {
    // A matched cross-source pair keeps the UVS identity (merge.ts), so this row
    // has a numeric externalId and no `prb-` prefix to select on - which is why
    // merged events used to be structurally invisible to this pass. Riot's event
    // page URL is what survives on it, and that carries the tournament id.
    await upsertEventWithStore(
      {
        externalId: '853410',
        name: 'Thursday Nexus Nights',
        startDate: START,
        eventType: 'Nexus Night',
        url: 'https://playriftbound.com/en-us/events/117087016664758142',
        latitude: context.latitude,
        longitude: context.longitude,
        sources: ['uvs', 'playriftbound'],
      },
      {
        id: 4242,
        name: 'Games of Martinez',
        full_address: '610 Main St, Martinez, CA 94553, USA',
        city: 'Martinez',
        state: 'CA',
        country: 'US',
        latitude: context.latitude,
        longitude: context.longitude,
        website: null,
        email: null,
      }
    );
    // A UVS-only row is still not a candidate: it has no URL at all (389 of 389
    // in the measured day partition), so there is no id to derive.
    await upsertEventWithStore(
      {
        externalId: '853411',
        name: 'Friday Casual',
        startDate: START,
        latitude: context.latitude,
        longitude: context.longitude,
        sources: ['uvs'],
      },
      {
        id: 4242,
        name: 'Games of Martinez',
        full_address: '610 Main St, Martinez, CA 94553, USA',
        city: 'Martinez',
        state: 'CA',
        country: 'US',
        latitude: context.latitude,
        longitude: context.longitude,
        website: null,
        email: null,
      }
    );

    const candidates = await loadEventFactCandidates({ daysBack: 365, daysForward: 2 });
    expect(candidates.map(c => c.externalId).sort()).toEqual(['853410', EXTERNAL_ID]);

    const merged = candidates.find(c => c.externalId === '853410');
    // Downstream nothing can tell this candidate from a `prb-` one: the Riot id
    // is what the page fetch uses, the UVS id is what the capture is keyed on.
    expect(merged).toMatchObject({
      externalId: '853410',
      tournamentId: '117087016664758142',
      eventType: 'Nexus Night',
      shopExternalId: 4242,
      results: null,
      hasRoster: false,
    });

    // And the existing path is untouched.
    expect(candidates.find(c => c.externalId === EXTERNAL_ID)?.tournamentId).toBe('117209411862156256');
  });

  it('returns nothing for an event with no capture', async () => {
    expect(await getEventResults('prb-does-not-exist')).toBeNull();
    await closePool();
  });
});
