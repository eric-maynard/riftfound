import type {
  EventResultsRecord,
  EventRosterRecord,
  FactAvailabilityRecord,
  FactContextRecord,
  ResultMatchRecord,
  ResultPlayerRecord,
  ResultRoundRecord,
  ResultStandingRecord,
  RosterEntryRecord,
  TournamentStore,
} from './tournamentStore.js';

/**
 * In-memory tournament-facts store.
 *
 * Stands in for the DynamoDB items in dev (`./dev.sh` runs on SQLite, which the
 * API has no facts reader for) and in tests, implementing `TournamentStore`
 * exactly as the DynamoDB adapter does.
 *
 * Its player ids are the ranking fixture's own seed ids, so the rating
 * enrichment resolves against `rankingFixtureAdapter` and the two fixtures tell
 * one coherent story. The dataset deliberately models the *launch* state: a
 * played event whose field is a handful of rated regulars among mostly unrated
 * attendees, and an upcoming event where almost nobody is rated. Those are the
 * cases the page has to look right in.
 *
 * Four events, covering every state a tournament page can be in:
 *
 * | event                       | state                                        |
 * |-----------------------------|----------------------------------------------|
 * | `48812`                     | played: final results + a participants roster |
 * | `prb-upcoming-sanjose-1`    | upcoming: roster only, mostly unrated         |
 * | `48666`                     | listing-only: a results capture holding nothing |
 * | `48540`                     | played, pairings trimmed out: standings only  |
 * | anything else               | no facts at all -> 404                        |
 */

export interface TournamentFixtureData {
  results: Record<string, EventResultsRecord>;
  rosters: Record<string, EventRosterRecord>;
}

export const EMPTY_TOURNAMENT_FIXTURE_DATA: TournamentFixtureData = { results: {}, rosters: {} };

// --- event contexts ---------------------------------------------------------

const BERKELEY = { shopExternalId: 1041, latitude: 37.8716, longitude: -122.2727 };
const SAN_JOSE = { shopExternalId: 1132, latitude: 37.3688, longitude: -122.0363 };
const BELLEVUE = { shopExternalId: 2210, latitude: 47.6101, longitude: -122.2015 };
const SAN_FRANCISCO = { shopExternalId: 1088, latitude: 37.7749, longitude: -122.4394 };

function context(
  externalId: string,
  eventStartDate: string,
  eventType: string,
  playFormat: string | null,
  venue: { shopExternalId: number; latitude: number; longitude: number }
): FactContextRecord {
  return {
    externalId,
    tournamentId: externalId.startsWith('prb-') ? externalId.slice(4) : null,
    eventStartDate,
    eventType,
    playFormat,
    ...venue,
  };
}

// --- the played event: 48812 ------------------------------------------------

/**
 * Seven players, so every round has a bye - the case a pairings table is most
 * likely to render wrong. `u-*` ids are in no ranking fixture, standing in for
 * the majority of a real field that the engine has never seen play.
 *
 * Three upstream oddities are deliberately encoded, because each one has
 * already been got wrong once and a fixture that smooths them over lets it
 * happen again:
 *
 * - a **drawn** match (round 2, `t-2` v `t-3`, 1-1), carried as Riot carries
 *   it: `outcome: 'TIE'`, never `DRAW`;
 * - a bye published **twice**, in `byeTeamIds` *and* as a synthesised
 *   `bye: true` match (`buildByeMatch`);
 * - matches in **capture order**, which is not table order;
 *
 * plus the one that was already here: a match reading `IN_PROGRESS` inside a
 * `FINALIZED` round.
 */
const PLAYED_FIELD: ResultPlayerRecord[] = [
  { teamId: 't-1', playerId: 'p-kira', displayName: 'Kirabosc', tagLine: 'NA1' },
  { teamId: 't-2', playerId: 'p-volto', displayName: 'Voltomancer', tagLine: 'EUW' },
  { teamId: 't-3', playerId: 'p-mari', displayName: 'Marigold', tagLine: 'NA1' },
  { teamId: 't-4', playerId: 'p-tess', displayName: 'Tessellate', tagLine: 'NA1' },
  { teamId: 't-5', playerId: 'p-juno', displayName: 'Junobell', tagLine: 'NA1' },
  { teamId: 't-6', playerId: 'p-quill', displayName: 'Quillon', tagLine: 'NA1' },
  { teamId: 't-7', playerId: 'u-fieldguest-1', displayName: 'Ashgrove', tagLine: 'NA1' },
];

/** One pairing: the two teams, how many games each took, and who won overall. */
type Pairing = [teamA: string, teamB: string, gamesA: number, gamesB: number];

interface RoundSpec {
  byeTeamId: string | null;
  pairings: Pairing[];
}

const PLAYED_ROUNDS: RoundSpec[] = [
  {
    byeTeamId: 't-7',
    pairings: [
      ['t-1', 't-6', 2, 0],
      ['t-2', 't-5', 2, 1],
      ['t-3', 't-4', 1, 2],
    ],
  },
  {
    byeTeamId: 't-6',
    pairings: [
      ['t-1', 't-4', 2, 1],
      ['t-2', 't-3', 1, 1],
      ['t-5', 't-7', 2, 0],
    ],
  },
  {
    byeTeamId: 't-5',
    pairings: [
      ['t-1', 't-2', 2, 0],
      ['t-3', 't-7', 2, 1],
      ['t-4', 't-6', 2, 0],
    ],
  },
];

/**
 * Riot's side outcome enum, as the capture actually carries it.
 *
 * **A drawn match is `TIE`.** Measured over 30 live captures the vocabulary is
 * `WIN` / `LOSS` / `TIE` and `DRAW` never appears once. This fixture said
 * `DRAW` for a while, which is exactly how a consumer came to match on `DRAW`
 * and print "no result" over a recorded draw. It says `TIE` now so the mapping
 * cannot be re-learned from the tests.
 */
function buildMatch(round: number, table: number, pairing: Pairing): ResultMatchRecord {
  const [teamA, teamB, gamesA, gamesB] = pairing;
  const outcome = (mine: number, theirs: number) =>
    mine > theirs ? 'WIN' : mine < theirs ? 'LOSS' : 'TIE';

  // Riot records a winner per game; a drawn match is modelled as one game each.
  const games = [];
  for (let i = 0; i < gamesA; i++) games.push({ number: games.length + 1, winnerTeamId: teamA });
  for (let i = 0; i < gamesB; i++) games.push({ number: games.length + 1, winnerTeamId: teamB });

  return {
    matchId: `m-${round}-${table}`,
    tableNumber: table,
    // Riot's software routinely leaves matches IN_PROGRESS inside a FINALIZED
    // round; the fixture carries that so nothing downstream starts trusting it.
    status: round === 3 && table === 3 ? 'IN_PROGRESS' : 'COMPLETED',
    bye: false,
    sides: [
      { teamId: teamA, outcome: outcome(gamesA, gamesB), gameWins: gamesA },
      { teamId: teamB, outcome: outcome(gamesB, gamesA), gameWins: gamesB },
    ],
    games,
  };
}

/**
 * Riot's synthesised half of a bye, as the capture carries it: a `bye-`
 * prefixed match id, the real team opposite a `bye-opponent-…` placeholder with
 * no player, no table, `COMPLETED`, and pre-created games nobody won.
 *
 * It is in the fixture **because it is a duplicate** - the same bye is already
 * in `byeTeamIds` - and serving both printed every bye player twice. Encoding
 * it here is what makes "a bye leaves this API once" a test rather than a note.
 */
function buildByeMatch(round: number, teamId: string): ResultMatchRecord {
  return {
    matchId: `bye-${teamId}-r${round}`,
    tableNumber: null,
    status: 'COMPLETED',
    bye: true,
    sides: [
      { teamId, outcome: 'WIN', gameWins: 0 },
      { teamId: `bye-opponent-${teamId}`, outcome: 'LOSS', gameWins: 0 },
    ],
    games: [
      { number: 1, winnerTeamId: null },
      { number: 2, winnerTeamId: null },
    ],
  };
}

/**
 * The matches of a round, in the order Riot's software returns them - which is
 * **not** table order. Round 1 of the live event this was measured against
 * arrives 7, 6, 4, 3, 2, 1, 5, so the fixture shuffles the tables the same way
 * and the bye match lands in the middle rather than conveniently last.
 */
function buildRounds(specs: RoundSpec[]): ResultRoundRecord[] {
  return specs.map((spec, index) => {
    const round = index + 1;
    const played = spec.pairings.map((pairing, table) => buildMatch(round, table + 1, pairing));
    const matches: ResultMatchRecord[] = [...played].reverse();
    if (spec.byeTeamId) matches.splice(1, 0, buildByeMatch(round, spec.byeTeamId));

    return {
      section: 0,
      roundNumber: round,
      status: 'FINALIZED',
      byeTeamIds: spec.byeTeamId ? [spec.byeTeamId] : [],
      matches,
    };
  });
}

/**
 * Standings derived from the pairings above, so every count in the fixture
 * agrees with the matches it serves - the same invariant the real engine holds,
 * and the reason a test can assert on a W/L/D without a second source of truth.
 *
 * A bye is scored as a match win with no games, which is how Riot's Swiss
 * software treats one.
 */
function buildStandings(field: ResultPlayerRecord[], rounds: ResultRoundRecord[]): ResultStandingRecord[] {
  interface Tally {
    wins: number;
    losses: number;
    draws: number;
    gameWins: number;
    games: number;
    opponents: string[];
  }
  const tally = new Map<string, Tally>(
    field.map((player) => [
      player.teamId,
      { wins: 0, losses: 0, draws: 0, gameWins: 0, games: 0, opponents: [] },
    ])
  );

  for (const round of rounds) {
    for (const teamId of round.byeTeamIds) {
      const entry = tally.get(teamId);
      if (entry) entry.wins += 1;
    }
    for (const match of round.matches) {
      // The bye is already scored off `byeTeamIds` above. Counting its
      // synthesised match too would double it - the same duplicate the API
      // used to publish, showing up here as a wrong standings row.
      if (match.bye) continue;
      const totalGames = match.games.length;
      for (const side of match.sides) {
        const entry = tally.get(side.teamId);
        if (!entry) continue;
        if (side.outcome === 'WIN') entry.wins += 1;
        else if (side.outcome === 'LOSS') entry.losses += 1;
        else entry.draws += 1;
        entry.gameWins += side.gameWins;
        entry.games += totalGames;
        for (const other of match.sides) {
          if (other.teamId !== side.teamId) entry.opponents.push(other.teamId);
        }
      }
    }
  }

  const matchWinPct = (teamId: string): number => {
    const entry = tally.get(teamId);
    if (!entry) return 0;
    const played = entry.wins + entry.losses + entry.draws;
    return played === 0 ? 0 : (entry.wins + entry.draws * 0.5) / played;
  };
  const gameWinPct = (teamId: string): number => {
    const entry = tally.get(teamId);
    if (!entry || entry.games === 0) return 0;
    return entry.gameWins / entry.games;
  };
  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

  return [...tally.entries()]
    .map(([teamId, entry]) => ({
      teamId,
      matchPoints: entry.wins * 3 + entry.draws,
      matchWins: entry.wins,
      matchLosses: entry.losses,
      matchDraws: entry.draws,
      opponentMatchWinPct: round4(mean(entry.opponents.map(matchWinPct))),
      gameWinPct: round4(gameWinPct(teamId)),
      opponentGameWinPct: round4(mean(entry.opponents.map(gameWinPct))),
    }))
    .sort(
      (a, b) =>
        (b.matchPoints ?? 0) - (a.matchPoints ?? 0) ||
        (b.opponentMatchWinPct ?? 0) - (a.opponentMatchWinPct ?? 0) ||
        a.teamId.localeCompare(b.teamId)
    )
    .map((entry, index) => ({ rank: index + 1, ...entry }));
}

const PLAYED_ROUND_RECORDS = buildRounds(PLAYED_ROUNDS);

const PLAYED_RESULTS: EventResultsRecord = {
  ...context('48812', '2026-10-22T02:00:00.000Z', 'Nexus Night', 'CONSTRUCTED', BERKELEY),
  status: 'final',
  roundCount: PLAYED_ROUND_RECORDS.length,
  playerCount: PLAYED_FIELD.length,
  openMatches: PLAYED_ROUND_RECORDS.reduce(
    (total, round) =>
      total + round.matches.filter((match) => !match.bye && match.status !== 'COMPLETED').length,
    0
  ),
  trimmed: false,
  sourceUpdatedAt: '2026-10-22T05:41:00.000Z',
  capturedAt: '2026-10-22T08:12:00.000Z',
  players: PLAYED_FIELD,
  standings: buildStandings(PLAYED_FIELD, PLAYED_ROUND_RECORDS),
  rounds: PLAYED_ROUND_RECORDS,
};

/**
 * The roster we recovered from the played event's own field, so it carries
 * `esportsTeamId`s and no signup times - the `participants` case.
 */
const PLAYED_ROSTER: EventRosterRecord = {
  ...context('48812', '2026-10-22T02:00:00.000Z', 'Nexus Night', 'CONSTRUCTED', BERKELEY),
  source: 'participants',
  playerCount: PLAYED_FIELD.length,
  capturedAt: '2026-10-22T08:12:00.000Z',
  entries: PLAYED_FIELD.map((player) => ({
    playerId: player.playerId as string,
    displayName: player.displayName,
    tagLine: player.tagLine,
    teamId: player.teamId,
    status: 'PLAYED',
    checkedIn: null,
    waitlistPosition: null,
    registeredAt: null,
  })),
};

// --- the upcoming event: roster only ---------------------------------------

/**
 * The strength-of-field preview case, and the most interesting state for an
 * event that has not happened yet: twelve registrants, two of whom are rated.
 * That ratio is the real one at launch, and it is why the aggregate publishes
 * the sample size next to the average.
 */
const UPCOMING_SIGNUPS: { playerId: string; name: string; tag: string; minutes: number; waitlist?: number }[] = [
  { playerId: 'p-kira', name: 'Kirabosc', tag: 'NA1', minutes: 0 },
  { playerId: 'p-mari', name: 'Marigold', tag: 'NA1', minutes: 37 },
  { playerId: 'p-cyn', name: 'Cynosure', tag: 'NA1', minutes: 95 },
  { playerId: 'p-lark', name: 'Larkspur', tag: 'NA1', minutes: 140 },
  { playerId: 'p-mott', name: 'Mottle', tag: 'NA1', minutes: 212 },
  { playerId: 'p-ovra', name: 'Ovranne', tag: 'NA1', minutes: 288 },
  { playerId: 'p-quill', name: 'Quillon', tag: 'NA1', minutes: 331 },
  { playerId: 'u-newcomer-1', name: 'Brightfall', tag: 'NA1', minutes: 402 },
  { playerId: 'u-newcomer-2', name: 'Cindermoth', tag: 'NA1', minutes: 455 },
  { playerId: 'u-newcomer-3', name: 'Dunlin', tag: 'NA2', minutes: 509 },
  { playerId: 'u-newcomer-4', name: 'Emberlace', tag: 'NA1', minutes: 561 },
  { playerId: 'u-newcomer-5', name: 'Fernwhistle', tag: 'NA1', minutes: 640, waitlist: 1 },
];

const UPCOMING_OPENED_AT = Date.parse('2026-10-26T16:00:00.000Z');

const UPCOMING_ROSTER: EventRosterRecord = {
  ...context('prb-upcoming-sanjose-1', '2026-11-07T02:30:00.000Z', 'Summoner Skirmish', 'CONSTRUCTED', SAN_JOSE),
  source: 'registrants',
  playerCount: UPCOMING_SIGNUPS.length,
  capturedAt: '2026-11-06T03:00:00.000Z',
  entries: UPCOMING_SIGNUPS.map(
    (signup): RosterEntryRecord => ({
      playerId: signup.playerId,
      displayName: signup.name,
      tagLine: signup.tag,
      // A registrant carries a per-tournament team uuid, not an esportsTeamId,
      // so the scraper stores none.
      teamId: null,
      status: signup.waitlist ? 'WAITLISTED' : 'REGISTERED',
      checkedIn: signup.waitlist ? null : signup.minutes < 300,
      waitlistPosition: signup.waitlist ?? null,
      registeredAt: new Date(UPCOMING_OPENED_AT + signup.minutes * 60_000).toISOString(),
    })
  ),
};

// --- the listing-only event: a capture that holds nothing -------------------

/**
 * ~29% of finished events look like this: the organizer never ran pairings
 * through Riot's software. The capture exists so the scraper stops fetching the
 * page, and it is a fact rather than an error - but it is not a page worth
 * sending anyone to, which is what `hasResults: false` says.
 */
const LISTING_ONLY_RESULTS: EventResultsRecord = {
  ...context('48666', '2026-10-21T02:00:00.000Z', 'Nexus Night', null, BELLEVUE),
  status: 'none',
  roundCount: 0,
  playerCount: 0,
  openMatches: 0,
  trimmed: false,
  sourceUpdatedAt: null,
  capturedAt: '2026-10-21T08:30:00.000Z',
  players: [],
  standings: [],
  rounds: [],
};

// --- the trimmed event: standings survived, pairings did not ----------------

const TRIMMED_FIELD: ResultPlayerRecord[] = [
  { teamId: 'tt-1', playerId: 'p-pell', displayName: 'Pellingard', tagLine: 'NA1' },
  { teamId: 'tt-2', playerId: 'p-ruan', displayName: 'Ruan', tagLine: 'NA2' },
  { teamId: 'tt-3', playerId: 'p-sable', displayName: 'Sablewing', tagLine: 'NA1' },
  { teamId: 'tt-4', playerId: 'u-fieldguest-2', displayName: 'Hollowreed', tagLine: 'NA1' },
];

const TRIMMED_RESULTS: EventResultsRecord = {
  ...context('48540', '2026-10-15T02:00:00.000Z', 'Nexus Night', null, SAN_FRANCISCO),
  status: 'final',
  roundCount: 9,
  playerCount: TRIMMED_FIELD.length,
  openMatches: 0,
  trimmed: true,
  sourceUpdatedAt: '2026-10-15T05:10:00.000Z',
  capturedAt: '2026-10-15T08:20:00.000Z',
  players: TRIMMED_FIELD,
  standings: TRIMMED_FIELD.map((player, index) => ({
    rank: index + 1,
    teamId: player.teamId,
    matchPoints: 9 - index * 3,
    matchWins: 3 - index,
    matchLosses: index,
    matchDraws: 0,
    opponentMatchWinPct: 0.5,
    gameWinPct: 0.6 - index * 0.1,
    opponentGameWinPct: 0.5,
  })),
  rounds: [],
};

export const LAUNCH_TOURNAMENT_FIXTURE_DATA: TournamentFixtureData = {
  results: {
    [PLAYED_RESULTS.externalId]: PLAYED_RESULTS,
    [LISTING_ONLY_RESULTS.externalId]: LISTING_ONLY_RESULTS,
    [TRIMMED_RESULTS.externalId]: TRIMMED_RESULTS,
  },
  rosters: {
    [PLAYED_ROSTER.externalId]: PLAYED_ROSTER,
    [UPCOMING_ROSTER.externalId]: UPCOMING_ROSTER,
  },
};

// --- the adapter ------------------------------------------------------------

export function createFixtureTournamentStore(
  data: TournamentFixtureData = LAUNCH_TOURNAMENT_FIXTURE_DATA
): TournamentStore {
  return {
    kind: 'fixture',

    async getResults(externalId: string): Promise<EventResultsRecord | null> {
      return data.results[externalId] ?? null;
    },

    async getRoster(externalId: string): Promise<EventRosterRecord | null> {
      return data.rosters[externalId] ?? null;
    },

    async getAvailability(externalIds: string[]): Promise<Map<string, FactAvailabilityRecord>> {
      const out = new Map<string, FactAvailabilityRecord>();
      for (const externalId of new Set(externalIds)) {
        const results = data.results[externalId] ?? null;
        const roster = data.rosters[externalId] ?? null;
        out.set(externalId, {
          hasResults: results !== null && results.status !== 'none',
          resultsStatus: results?.status ?? null,
          hasRoster: roster !== null,
          playerCount:
            (results !== null && results.playerCount > 0 ? results.playerCount : null) ??
            roster?.playerCount ??
            null,
        });
      }
      return out;
    },
  };
}

export const fixtureTournamentStore = createFixtureTournamentStore();
