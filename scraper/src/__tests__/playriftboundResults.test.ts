import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventFactCandidate, EventFactContext, EventResults, EventRoster } from '../database.js';

// The pure parsing/normalising half of the module needs no database at all; the
// pass does, so it is stubbed and asserted on.
const db = vi.hoisted(() => ({
  supportsEventFacts: vi.fn((): boolean => true),
  loadEventFactCandidates: vi.fn(
    async (_window: { daysBack: number; daysForward: number }): Promise<EventFactCandidate[]> => []
  ),
  saveEventResults: vi.fn(async (_results: EventResults) => ({ skipped: false })),
  saveEventRoster: vi.fn(async (_roster: EventRoster) => ({ skipped: false })),
}));
vi.mock('../database.js', () => db);

import {
  MAX_ATTEMPTS,
  ROSTER_LEAD_MS,
  RESULTS_RECHECK_AFTER_MS,
  RESULTS_SETTLE_MS,
  ResultsBackoffError,
  ResultsFetchError,
  extractFlightPayload,
  extractRegistrantArrays,
  extractTournamentJson,
  normalizeResults,
  normalizeRosterFromRegistrants,
  normalizeRosterFromResults,
  parseEventPage,
  runPlayriftboundResultsPass,
  selectDueEventFacts,
  tournamentIdFromExternalId,
  type PrbTournamentDetail,
} from '../sources/playriftboundResults.js';

// ---------------------------------------------------------------------------
// Fixtures: real captures of Riot's event pages, trimmed. See the comment at
// the top of each file for what was cut.
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', `playriftbound-${name}.html`), 'utf8');
}

/** A finished 16-player, 3-round Nexus Night with full standings and pairings. */
const FULL_ID = '117209411862156256';
const FULL_HTML = fixture('results-full');
/** A second finished event, every match still reading IN_PROGRESS. */
const FULL2_ID = '117254754592259615';
const FULL2_HTML = fixture('results-full-2');
/** Finished, but the organizer never ran pairings: one registrant, no rounds. */
const NONE_ID = '117248820934100462';
const NONE_HTML = fixture('results-none');
const NONE2_ID = '117289613891032443';
const NONE2_HTML = fixture('results-none-2');
/** Upcoming, 34 registered players. */
const UPCOMING_ID = '117344785462202738';
const UPCOMING_HTML = fixture('roster-upcoming');
/** A second upcoming event, 32 registered players. */
const UPCOMING2_ID = '117402614206721336';
const UPCOMING2_HTML = fixture('roster-upcoming-2');

function context(tournamentId: string, start = '2026-10-02T01:00:00Z'): EventFactContext {
  return {
    externalId: `prb-${tournamentId}`,
    tournamentId,
    eventStartDate: new Date(start),
    eventType: 'Nexus Night',
    playFormat: 'CONSTRUCTED',
    shopExternalId: 2_000_123_456,
    latitude: 38.0162814,
    longitude: -121.816311,
  };
}

/** Rebuild a page around a modified flight payload, escaped the way Riot does. */
function rewrapFlight(html: string, transform: (flight: string) => string): string {
  const flight = transform(extractFlightPayload(html));
  return (
    '<!DOCTYPE html><html><body><script>self.__next_f.push([1,' +
    JSON.stringify(flight) +
    ')]</script></body></html>'
  );
}

// ---------------------------------------------------------------------------

describe('tournamentIdFromExternalId', () => {
  it('strips the prb- prefix and leaves a bare id alone', () => {
    expect(tournamentIdFromExternalId('prb-117209411862156256')).toBe('117209411862156256');
    expect(tournamentIdFromExternalId('117209411862156256')).toBe('117209411862156256');
  });
});

describe('extractFlightPayload', () => {
  it('un-escapes the RSC payload out of the page', () => {
    const flight = extractFlightPayload(FULL_HTML);
    // Inside the HTML every quote is \"; after extraction they are real quotes.
    expect(FULL_HTML).toContain('\\"__typename\\":\\"CompeteTournament\\"');
    expect(flight).toContain('"__typename":"CompeteTournament"');
  });

  it('returns nothing for a page with no flight payload', () => {
    expect(extractFlightPayload('<html><body>nope</body></html>')).toBe('');
  });
});

describe('extractTournamentJson / extractRegistrantArrays', () => {
  it('brace-matches the tournament object out of the middle of the payload', () => {
    const json = extractTournamentJson(extractFlightPayload(FULL_HTML));
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json as string) as PrbTournamentDetail;
    expect(parsed.id).toBe(FULL_ID);
    expect(Array.isArray(parsed.stages)).toBe(true);
  });

  it('returns null when the page has no tournament object', () => {
    expect(extractTournamentJson(extractFlightPayload(UPCOMING_HTML))).toBeNull();
  });

  it('collects the registrant list a page carries', () => {
    const arrays = extractRegistrantArrays(extractFlightPayload(UPCOMING_HTML));
    expect(arrays).toHaveLength(1);
    expect(JSON.parse(arrays[0])).toHaveLength(34);
  });
});

describe('parseEventPage', () => {
  it('reads a finished event with results', () => {
    const page = parseEventPage(FULL_HTML, FULL_ID);
    expect(page.detail?.id).toBe(FULL_ID);
    // Once rounds exist Riot drops the "Registered Players" list from the page.
    expect(page.registrants).toHaveLength(0);
  });

  it('reads an upcoming event as registrants with no results', () => {
    const page = parseEventPage(UPCOMING_HTML, UPCOMING_ID);
    expect(page.detail).toBeNull();
    expect(page.registrants).toHaveLength(34);
    expect(page.registrants[0].player?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.registrants[0].acceptedTermsAt).toBeTruthy();
  });

  it('reads a finished event the organizer never ran pairings for', () => {
    const page = parseEventPage(NONE_HTML, NONE_ID);
    expect(page.detail).toBeNull();
    // Listing-only events keep their registrant list, so the roster survives.
    expect(page.registrants).toHaveLength(1);
  });

  it('rejects a page that does not identify the tournament', () => {
    // Someone else's event page, a redirect to a listing, an error page…
    expect(() => parseEventPage(FULL_HTML, '999999999999999999')).toThrow(ResultsFetchError);
  });

  // The important failure mode: a short read must never look like "no results",
  // or one bad minute at Riot would permanently blank an event.
  it('rejects a response truncated before the tournament object', () => {
    const cut = FULL_HTML.slice(0, FULL_HTML.length / 2);
    expect(() => parseEventPage(cut, FULL_ID)).toThrow(ResultsFetchError);
  });

  it('rejects a payload truncated inside the tournament object', () => {
    const malformed = rewrapFlight(FULL_HTML, flight =>
      flight.slice(0, flight.indexOf('"endOfRoundStandings"'))
    );
    expect(malformed).toContain(`esportsTournamentId`);
    expect(() => parseEventPage(malformed, FULL_ID)).toThrow(/unterminated/);
  });

  it('rejects a payload truncated inside the registrant list', () => {
    const malformed = rewrapFlight(UPCOMING_HTML, flight => flight.slice(0, flight.length - 2000));
    expect(() => parseEventPage(malformed, UPCOMING_ID)).toThrow(/unterminated/);
  });

  it('rejects markup with no flight payload at all', () => {
    expect(() => parseEventPage('<html><body>maintenance</body></html>', FULL_ID)).toThrow(
      ResultsFetchError
    );
  });
});

describe('normalizeResults', () => {
  const detail = parseEventPage(FULL_HTML, FULL_ID).detail as PrbTournamentDetail;
  const results = normalizeResults(context(FULL_ID), detail);

  it('keeps the event context the rating pass needs alongside the facts', () => {
    expect(results.externalId).toBe(`prb-${FULL_ID}`);
    expect(results.tournamentId).toBe(FULL_ID);
    expect(results.eventType).toBe('Nexus Night');
    expect(results.shopExternalId).toBe(2_000_123_456);
    expect(results.latitude).toBeCloseTo(38.0162814);
  });

  it('collects the rounds and their pairings', () => {
    expect(results.roundCount).toBe(3);
    expect(results.rounds.map(r => r.roundNumber)).toEqual([1, 2, 3]);
    expect(results.rounds.every(r => r.status === 'FINALIZED')).toBe(true);
    expect(results.rounds.reduce((n, r) => n + r.matches.length, 0)).toBe(22);
  });

  it('records both sides of a pairing with their per-game outcomes', () => {
    const match = results.rounds[0].matches.find(m => m.tableNumber === 1);
    expect(match?.sides).toHaveLength(2);
    expect(match?.sides.map(s => s.outcome).sort()).toEqual(['LOSS', 'WIN']);
    // Bo3: a game Riot has not scored yet carries no winner.
    expect(match?.games).toHaveLength(3);
    expect(match?.games.filter(g => g.winnerTeamId !== null)).toHaveLength(2);
    const winner = match?.sides.find(s => s.outcome === 'WIN');
    expect(winner?.gameWins).toBe(2);
  });

  it('flags byes so they can never count towards a rating', () => {
    expect(results.rounds[0].byeTeamIds).toHaveLength(1);
    const byes = results.rounds.flatMap(r => r.matches).filter(m => m.bye);
    expect(byes).toHaveLength(1);
    expect(byes[0].sides.some(s => s.outcome === 'WIN')).toBe(true);
  });

  it('keeps the final standings, ranked', () => {
    expect(results.standings).toHaveLength(15);
    expect(results.standings[0].rank).toBe(1);
    expect(results.standings[0].matchPoints).toBe(9);
    expect(results.standings[0].matchWins).toBe(3);
    expect(results.standings[0].matchLosses).toBe(0);
    // Riot sends tiebreakers as decimal strings; they are stored as numbers.
    expect(results.standings[0].opponentMatchWinPct).toBeCloseTo(0.5544, 4);
    expect(results.standings.map(s => s.rank)).toEqual([...results.standings].map(s => s.rank).sort((a, b) => a - b));
  });

  it('maps every team to a stable player UUID and excludes the bye pseudo-player', () => {
    expect(results.players).toHaveLength(15);
    expect(results.playerCount).toBe(15);
    for (const player of results.players) {
      expect(player.playerId).toMatch(/^[0-9a-f-]{36}$/);
      expect(player.teamId).not.toMatch(/^bye-/);
    }
    expect(results.players.some(p => p.name === 'BYE')).toBe(false);
    // The standings' team ids all resolve through the players list.
    const known = new Set(results.players.map(p => p.teamId));
    expect(results.standings.every(s => known.has(s.teamId))).toBe(true);
  });

  it('treats finalised rounds as final even when matches read IN_PROGRESS', () => {
    // Riot's software leaves matches open inside rounds it has FINALIZED: 21 of
    // 22 here, all 23 in the second fixture, with complete standings either way.
    // If match status gated finality nothing would ever be final and every
    // event would cost a second fetch for no new data.
    expect(results.openMatches).toBe(21);
    expect(results.status).toBe('final');

    const second = normalizeResults(
      context(FULL2_ID),
      parseEventPage(FULL2_HTML, FULL2_ID).detail as PrbTournamentDetail
    );
    expect(second.openMatches).toBe(23);
    expect(second.status).toBe('final');
    expect(second.standings).toHaveLength(16);
  });

  it('marks a capture partial while a round is still live', () => {
    const live: PrbTournamentDetail = {
      id: '1',
      stages: [
        {
          sections: [
            {
              rounds: [
                {
                  roundNumber: 1,
                  status: 'IN_PROGRESS',
                  matches: [
                    {
                      esportsMatchId: 'm1',
                      status: 'IN_PROGRESS',
                      teamOutcomes: [{ outcome: 'WIN', esportsTeamId: 't1' }],
                      teams: [{ esportsTeamId: 't1', players: [{ id: 'p1', displayName: 'One' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(normalizeResults(context('1'), live).status).toBe('partial');
  });

  it('marks a capture final once every round is closed out', () => {
    const closed: PrbTournamentDetail = {
      id: '1',
      updatedAt: '2026-10-02T04:00:00Z',
      stages: [
        {
          sections: [
            {
              rounds: [
                {
                  roundNumber: 1,
                  status: 'FINALIZED',
                  byeTeamIds: [],
                  matches: [
                    {
                      esportsMatchId: 'm1',
                      tableNumber: 1,
                      status: 'COMPLETED',
                      teamOutcomes: [
                        { outcome: 'WIN', esportsTeamId: 't1' },
                        { outcome: 'LOSS', esportsTeamId: 't2' },
                      ],
                      games: [{ number: 1, teamOutcomes: [{ outcome: 'WIN', esportsTeamId: 't1' }] }],
                      teams: [
                        { esportsTeamId: 't1', players: [{ id: 'p1', displayName: 'One' }] },
                        { esportsTeamId: 't2', players: [{ id: 'p2', displayName: 'Two' }] },
                      ],
                    },
                  ],
                  endOfRoundStandings: [
                    { rank: 1, esportsTeamId: 't1', matchPoints: 3, matchWins: 1, matchLosses: 0, matchDraws: 0 },
                    { rank: 2, esportsTeamId: 't2', matchPoints: 0, matchWins: 0, matchLosses: 1, matchDraws: 0 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const closedResults = normalizeResults(context('1'), closed);
    expect(closedResults.status).toBe('final');
    expect(closedResults.openMatches).toBe(0);
  });

  it('records no results for a tournament with no rounds', () => {
    const empty = normalizeResults(context('1'), { id: '1', stages: [] });
    expect(empty.status).toBe('none');
    expect(empty.players).toEqual([]);
    expect(empty.rounds).toEqual([]);
  });

  it('strips markup out of player names at the converter', () => {
    const poisoned: PrbTournamentDetail = {
      id: '1',
      stages: [
        {
          sections: [
            {
              rounds: [
                {
                  roundNumber: 1,
                  status: 'FINALIZED',
                  matches: [
                    {
                      esportsMatchId: 'm1',
                      status: 'COMPLETED',
                      teamOutcomes: [{ outcome: 'WIN', esportsTeamId: 't1' }],
                      teams: [{ esportsTeamId: 't1', players: [{ id: 'p1', displayName: 'Nice<script>bad()</script>' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      tournamentParticipants: [
        { esportsTeamId: 't2', player: { id: 'p2', displayName: 'Ok<b>x</b>', tagLine: 'NA<img src=x>' } },
      ],
    };
    const cleaned = normalizeResults(context('1'), poisoned);
    const names = cleaned.players.map(p => p.name);
    expect(names).toContain('Nice');
    expect(names).toContain('Ok x');
    expect(cleaned.players.find(p => p.teamId === 't2')?.tagLine).toBe('NA');
    expect(JSON.stringify(cleaned)).not.toContain('<');
  });
});

describe('normalizeRosterFromRegistrants', () => {
  const page = parseEventPage(UPCOMING_HTML, UPCOMING_ID);
  const roster = normalizeRosterFromRegistrants(context(UPCOMING_ID, '2026-10-25T21:30:00Z'), page.registrants);

  it('records every signup with the moment it happened', () => {
    expect(roster?.source).toBe('registrants');
    expect(roster?.playerCount).toBe(34);
    expect(roster?.entries).toHaveLength(34);
    // acceptedTermsAt is why one snapshot is enough: the whole signup curve is
    // reconstructible after the fact, so nothing has to be polled.
    expect(roster?.entries.every(e => e.registeredAt !== null)).toBe(true);
    expect(roster?.entries.every(e => /^[0-9a-f-]{36}$/.test(e.playerId))).toBe(true);
    const first = roster?.entries.find(e => e.name === 'aaron1423');
    expect(first?.tagLine).toBe('NA2');
    expect(first?.registeredAt).toBe('2026-10-19T19:18:23.464Z');
    expect(first?.status).toBe('REGISTERED');
    expect(first?.checkedIn).toBe(false);
  });

  it('keeps the event context on the roster too', () => {
    expect(roster?.externalId).toBe(`prb-${UPCOMING_ID}`);
    expect(roster?.eventType).toBe('Nexus Night');
    expect(roster?.shopExternalId).toBe(2_000_123_456);
  });

  it('reads a second real page the same way', () => {
    // Two independent captures, so the extraction is not fitted to one page.
    const second = normalizeRosterFromRegistrants(
      context(UPCOMING2_ID),
      parseEventPage(UPCOMING2_HTML, UPCOMING2_ID).registrants
    );
    expect(second?.playerCount).toBe(32);
    expect(second?.entries.every(e => e.registeredAt !== null)).toBe(true);
    expect(second?.entries.every(e => e.name !== null)).toBe(true);
  });

  it('returns null when nobody has signed up', () => {
    expect(normalizeRosterFromRegistrants(context('1'), [])).toBeNull();
  });

  it('keeps the single registrant of a listing-only event', () => {
    const only = normalizeRosterFromRegistrants(
      context(NONE2_ID),
      parseEventPage(NONE2_HTML, NONE2_ID).registrants
    );
    expect(only?.playerCount).toBe(1);
  });

  it('drops Riot\'s bye pseudo-player and de-duplicates by player id', () => {
    const roster = normalizeRosterFromRegistrants(context('1'), [
      { id: 'r1', player: { id: 'bye-player-123', displayName: 'BYE' } },
      { id: 'r2', player: { id: 'p1', displayName: 'Real' } },
      { id: 'r3', player: { id: 'p1', displayName: 'Real again' } },
    ]);
    expect(roster?.entries.map(e => e.playerId)).toEqual(['p1']);
  });

  it('strips markup out of registrant names', () => {
    const roster = normalizeRosterFromRegistrants(context('1'), [
      { id: 'r1', player: { id: 'p1', displayName: 'Hi<script>x</script>', tagLine: '<b>NA1</b>' } },
    ]);
    expect(roster?.entries[0].name).toBe('Hi');
    expect(roster?.entries[0].tagLine).toBe('NA1');
  });
});

describe('normalizeRosterFromResults', () => {
  it('recovers the field from a played event we never caught while upcoming', () => {
    const results = normalizeResults(
      context(FULL_ID),
      parseEventPage(FULL_HTML, FULL_ID).detail as PrbTournamentDetail
    );
    const roster = normalizeRosterFromResults(context(FULL_ID), results);
    expect(roster?.source).toBe('participants');
    expect(roster?.playerCount).toBe(15);
    // No signup timestamps this way, but the esportsTeamId join key survives.
    expect(roster?.entries.every(e => e.registeredAt === null)).toBe(true);
    expect(roster?.entries.every(e => e.teamId !== null)).toBe(true);
    expect(roster?.entries.some(e => e.playerId.startsWith('bye-'))).toBe(false);
  });

  it('returns null when no player could be identified', () => {
    expect(normalizeRosterFromResults(context('1'), normalizeResults(context('1'), { stages: [] }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-25T12:00:00Z');

function candidate(overrides: Partial<EventFactCandidate> & { startOffsetMs: number }): EventFactCandidate {
  const { startOffsetMs, ...rest } = overrides;
  const id = rest.externalId ?? `prb-${Math.abs(startOffsetMs)}`;
  return {
    externalId: id,
    tournamentId: id.replace('prb-', ''),
    eventStartDate: new Date(NOW.getTime() + startOffsetMs),
    eventType: 'Nexus Night',
    // Null is the normal, permanent value for an event discovered before the
    // field was captured - it must never make a candidate ineligible.
    playFormat: null,
    shopExternalId: null,
    latitude: null,
    longitude: null,
    results: null,
    hasRoster: false,
    ...rest,
  };
}

describe('selectDueEventFacts', () => {
  const opts = { now: NOW };

  it('takes a roster snapshot only once the event is close to starting', () => {
    const soon = candidate({ startOffsetMs: 6 * 60 * 60 * 1000, externalId: 'prb-soon' });
    const later = candidate({ startOffsetMs: 10 * DAY, externalId: 'prb-later' });
    const work = selectDueEventFacts([soon, later], opts);
    expect(work).toEqual([{ candidate: soon, kind: 'roster' }]);
    expect(ROSTER_LEAD_MS).toBe(DAY);
  });

  it('never re-snapshots a roster it already has', () => {
    const done = candidate({ startOffsetMs: 6 * 60 * 60 * 1000, hasRoster: true });
    expect(selectDueEventFacts([done], opts)).toEqual([]);
  });

  it('leaves an event alone until it has plausibly finished', () => {
    const running = candidate({ startOffsetMs: -2 * 60 * 60 * 1000 });
    expect(selectDueEventFacts([running], opts)).toEqual([]);
    expect(RESULTS_SETTLE_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('captures results for a finished event with nothing stored', () => {
    const finished = candidate({ startOffsetMs: -2 * DAY });
    expect(selectDueEventFacts([finished], opts)).toEqual([{ candidate: finished, kind: 'results' }]);
  });

  it('never fetches a final capture again - results are immutable', () => {
    const final = candidate({
      startOffsetMs: -2 * DAY,
      results: { status: 'final', attempts: 1, lastCheckedAt: new Date(NOW.getTime() - 30 * DAY) },
    });
    expect(selectDueEventFacts([final], opts)).toEqual([]);
  });

  it('re-checks an incomplete capture once, a day later', () => {
    const fresh = candidate({
      startOffsetMs: -2 * DAY,
      externalId: 'prb-fresh',
      results: { status: 'partial', attempts: 1, lastCheckedAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
    });
    const stale = candidate({
      startOffsetMs: -2 * DAY,
      externalId: 'prb-stale',
      results: { status: 'partial', attempts: 1, lastCheckedAt: new Date(NOW.getTime() - 2 * DAY) },
    });
    expect(selectDueEventFacts([fresh, stale], opts).map(w => w.candidate.externalId)).toEqual(['prb-stale']);
    expect(RESULTS_RECHECK_AFTER_MS).toBe(DAY);
  });

  it('stops re-checking once the attempt budget is spent', () => {
    const spent = candidate({
      startOffsetMs: -5 * DAY,
      results: { status: 'partial', attempts: MAX_ATTEMPTS, lastCheckedAt: new Date(NOW.getTime() - 3 * DAY) },
    });
    expect(selectDueEventFacts([spent], opts)).toEqual([]);
  });

  it('accepts a listing-only event as settled after its re-check', () => {
    const once = candidate({
      startOffsetMs: -5 * DAY,
      externalId: 'prb-once',
      results: { status: 'none', attempts: 1, lastCheckedAt: new Date(NOW.getTime() - 3 * DAY) },
    });
    const twice = candidate({
      startOffsetMs: -5 * DAY,
      externalId: 'prb-twice',
      results: { status: 'none', attempts: 2, lastCheckedAt: new Date(NOW.getTime() - 3 * DAY) },
    });
    expect(selectDueEventFacts([once, twice], opts).map(w => w.candidate.externalId)).toEqual(['prb-once']);
  });

  it('puts rosters first (their window closes) and queues results oldest-first', () => {
    const roster = candidate({ startOffsetMs: 2 * 60 * 60 * 1000, externalId: 'prb-roster' });
    const recent = candidate({ startOffsetMs: -1 * DAY, externalId: 'prb-recent' });
    const old = candidate({ startOffsetMs: -9 * DAY, externalId: 'prb-old' });
    expect(selectDueEventFacts([recent, old, roster], opts).map(w => w.candidate.externalId)).toEqual([
      'prb-roster',
      'prb-old',
      'prb-recent',
    ]);
  });

  it('caps a run and leaves the rest for the next one', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      candidate({ startOffsetMs: -(i + 2) * DAY, externalId: `prb-${i}` })
    );
    expect(selectDueEventFacts(many, { ...opts, max: 3 })).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------

/** A fetch stub that serves fixture HTML keyed by tournament id. */
function fakeFetch(
  pages: Record<string, { body?: string; status?: number } | undefined>,
  log?: string[]
): typeof fetch {
  return (async (url: string | URL) => {
    const id = String(url).split('/').pop() as string;
    log?.push(id);
    const page = pages[id];
    if (!page) return new Response('not found', { status: 404 });
    return new Response(page.body ?? '', { status: page.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe('runPlayriftboundResultsPass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.supportsEventFacts.mockReturnValue(true);
    db.saveEventResults.mockResolvedValue({ skipped: false });
    db.saveEventRoster.mockResolvedValue({ skipped: false });
  });

  it('skips cleanly when the backend cannot store facts', async () => {
    db.supportsEventFacts.mockReturnValue(false);
    const summary = await runPlayriftboundResultsPass();
    expect(summary.skippedReason).toMatch(/SQLite or DynamoDB/);
    expect(db.loadEventFactCandidates).not.toHaveBeenCalled();
  });

  it('captures a roster before the event and results after it', async () => {
    const upcoming = candidate({ startOffsetMs: 6 * 60 * 60 * 1000, externalId: `prb-${UPCOMING_ID}` });
    const finished = candidate({ startOffsetMs: -2 * DAY, externalId: `prb-${FULL_ID}` });
    db.loadEventFactCandidates.mockResolvedValue([upcoming, finished]);

    const requested: string[] = [];
    const summary = await runPlayriftboundResultsPass({
      requestDelayMs: 0,
      now: NOW,
      fetchImpl: fakeFetch({ [UPCOMING_ID]: { body: UPCOMING_HTML }, [FULL_ID]: { body: FULL_HTML } }, requested),
    });

    expect(requested).toEqual([UPCOMING_ID, FULL_ID]);
    expect(summary).toMatchObject({
      candidates: 2,
      due: 2,
      rosterDue: 1,
      resultsDue: 1,
      fetched: 2,
      withResults: 1,
      withoutResults: 0,
      failed: 0,
      notFetched: 0,
      requests: 2,
      partial: false,
    });
    // Two rosters: the registrants of the upcoming event, and the participants
    // of the finished one (which we never caught while it was upcoming).
    expect(summary.rostersWritten).toBe(2);
    expect(summary.resultsWritten).toBe(1);

    // The pre-event fetch must not record an empty results capture: that would
    // burn the event's attempt budget before it had been played.
    const savedResults = db.saveEventResults.mock.calls.map(([r]) => r);
    expect(savedResults.map(r => r.externalId)).toEqual([`prb-${FULL_ID}`]);
    const savedRosters = db.saveEventRoster.mock.calls.map(([r]) => r);
    expect(savedRosters.map(r => r.source)).toEqual(['registrants', 'participants']);
  });

  it('records a finished event with no results rather than retrying it forever', async () => {
    db.loadEventFactCandidates.mockResolvedValue([
      candidate({ startOffsetMs: -2 * DAY, externalId: `prb-${NONE_ID}` }),
    ]);
    const summary = await runPlayriftboundResultsPass({
      requestDelayMs: 0,
      now: NOW,
      fetchImpl: fakeFetch({ [NONE_ID]: { body: NONE_HTML } }),
    });
    expect(summary.withoutResults).toBe(1);
    expect(summary.withResults).toBe(0);
    expect(db.saveEventResults.mock.calls[0][0].status).toBe('none');
    // Its one registrant is still worth keeping.
    expect(summary.rostersWritten).toBe(1);
  });

  it('never overwrites a roster it already has with a thinner one', async () => {
    db.loadEventFactCandidates.mockResolvedValue([
      candidate({ startOffsetMs: -2 * DAY, externalId: `prb-${FULL_ID}`, hasRoster: true }),
    ]);
    const summary = await runPlayriftboundResultsPass({
      requestDelayMs: 0,
      now: NOW,
      fetchImpl: fakeFetch({ [FULL_ID]: { body: FULL_HTML } }),
    });
    expect(db.saveEventRoster).not.toHaveBeenCalled();
    expect(summary.rostersWritten).toBe(0);
    expect(summary.resultsWritten).toBe(1);
  });

  it('counts a re-check that found nothing new as unchanged', async () => {
    db.loadEventFactCandidates.mockResolvedValue([
      candidate({
        startOffsetMs: -2 * DAY,
        externalId: `prb-${FULL_ID}`,
        hasRoster: true,
        results: { status: 'partial', attempts: 1, lastCheckedAt: new Date(NOW.getTime() - 2 * DAY) },
      }),
    ]);
    db.saveEventResults.mockResolvedValue({ skipped: true });
    const summary = await runPlayriftboundResultsPass({
      requestDelayMs: 0,
      now: NOW,
      fetchImpl: fakeFetch({ [FULL_ID]: { body: FULL_HTML } }),
    });
    expect(summary.unchanged).toBe(1);
    expect(summary.resultsWritten).toBe(0);
  });

  it('keeps going after one unreadable page', async () => {
    db.loadEventFactCandidates.mockResolvedValue([
      candidate({ startOffsetMs: -9 * DAY, externalId: 'prb-111' }),
      candidate({ startOffsetMs: -2 * DAY, externalId: `prb-${FULL_ID}` }),
    ]);
    const summary = await runPlayriftboundResultsPass({
      requestDelayMs: 0,
      now: NOW,
      fetchImpl: fakeFetch({ '111': { body: '<html>broken</html>' }, [FULL_ID]: { body: FULL_HTML } }),
    });
    expect(summary.failed).toBe(1);
    expect(summary.fetched).toBe(1);
    expect(summary.resultsWritten).toBe(1);
    expect(summary.partial).toBe(false);
  });

  it('backs off the whole run when Riot rate limits us', async () => {
    const log: string[] = [];
    db.loadEventFactCandidates.mockResolvedValue([
      candidate({ startOffsetMs: -9 * DAY, externalId: 'prb-111' }),
      candidate({ startOffsetMs: -2 * DAY, externalId: `prb-${FULL_ID}` }),
    ]);
    const summary = await runPlayriftboundResultsPass({
      requestDelayMs: 0,
      now: NOW,
      fetchImpl: fakeFetch({ '111': { status: 429 }, [FULL_ID]: { body: FULL_HTML } }, log),
    });
    expect(log).toEqual(['111']); // stopped before touching Riot again
    expect(summary.partial).toBe(true);
    expect(summary.failed).toBe(1);
    expect(summary.notFetched).toBe(2);
  });

  it('skips one permanently broken event page without stopping the run', async () => {
    // Measured in production: prb-117243252865991615 returns 500 on every
    // attempt while control events return 200. Treating a 5xx as a backoff
    // signal aborted a backfill run after 84 of 250 items, and since the queue
    // is deterministic and oldest-first, a broken page would eventually head it
    // and reduce every run to zero progress.
    const log: string[] = [];
    db.loadEventFactCandidates.mockResolvedValue([
      candidate({ startOffsetMs: -9 * DAY, externalId: 'prb-111' }),
      candidate({ startOffsetMs: -2 * DAY, externalId: `prb-${FULL_ID}` }),
    ]);
    const summary = await runPlayriftboundResultsPass({
      requestDelayMs: 0,
      now: NOW,
      fetchImpl: fakeFetch({ '111': { status: 500 }, [FULL_ID]: { body: FULL_HTML } }, log),
    });
    expect(log).toEqual(['111', FULL_ID]); // kept going past the broken page
    expect(summary.partial).toBe(false);
    expect(summary.failed).toBe(1);
    expect(summary.fetched).toBe(1);
    expect(summary.resultsWritten).toBe(1);
    expect(summary.notFetched).toBe(1); // the broken event stays due, nothing recorded
  });

  it('still backs off when 5xx arrives from Riot repeatedly rather than once', async () => {
    const log: string[] = [];
    const ids = ['prb-501', 'prb-502', 'prb-503', 'prb-504', 'prb-505', `prb-${FULL_ID}`];
    db.loadEventFactCandidates.mockResolvedValue(
      ids.map((externalId, i) => candidate({ startOffsetMs: -(9 - i) * DAY, externalId }))
    );
    const summary = await runPlayriftboundResultsPass({
      requestDelayMs: 0,
      now: NOW,
      fetchImpl: fakeFetch(
        Object.fromEntries(ids.slice(0, 5).map(id => [id.replace('prb-', ''), { status: 503 }])),
        log
      ),
    });
    expect(summary.partial).toBe(true);
    expect(summary.failed).toBe(5);
    expect(log).not.toContain(FULL_ID); // stopped before the 6th request
  });

  it('records a tournament Riot has taken down as resultless', async () => {
    db.loadEventFactCandidates.mockResolvedValue([
      candidate({ startOffsetMs: -2 * DAY, externalId: 'prb-404404404' }),
    ]);
    const summary = await runPlayriftboundResultsPass({
      requestDelayMs: 0,
      now: NOW,
      fetchImpl: fakeFetch({}),
    });
    expect(summary.withoutResults).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('stops at the deadline and rolls the remainder over to the next run', async () => {
    const log: string[] = [];
    db.loadEventFactCandidates.mockResolvedValue([
      candidate({ startOffsetMs: -9 * DAY, externalId: `prb-${FULL_ID}` }),
      candidate({ startOffsetMs: -2 * DAY, externalId: `prb-${FULL2_ID}` }),
    ]);
    const summary = await runPlayriftboundResultsPass({
      requestDelayMs: 0,
      now: NOW,
      // Already past: the very first event is left for the next run.
      deadline: Date.now() - 1,
      fetchImpl: fakeFetch({ [FULL_ID]: { body: FULL_HTML } }, log),
    });
    expect(log).toEqual([]);
    expect(summary.partial).toBe(true);
    expect(summary.notFetched).toBe(2);
  });

  it('does nothing when nothing is due', async () => {
    db.loadEventFactCandidates.mockResolvedValue([candidate({ startOffsetMs: 30 * DAY })]);
    const summary = await runPlayriftboundResultsPass({ requestDelayMs: 0, now: NOW });
    expect(summary).toMatchObject({ candidates: 1, due: 0, fetched: 0, requests: 0 });
  });
});

describe('errors', () => {
  it('treats a backoff as a kind of fetch failure', () => {
    expect(new ResultsBackoffError('429')).toBeInstanceOf(ResultsFetchError);
  });
});
