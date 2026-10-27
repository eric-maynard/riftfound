import {
  getDynamoClient,
  getTableName,
  eventResultsKeys,
  eventRosterKeys,
  EntityPrefix,
  GetCommand,
  BatchGetCommand,
} from '../config/dynamodb.js';
import type { EventResultsStatus, RosterSource } from '../models/tournament.js';
import type {
  EventResultsRecord,
  EventRosterRecord,
  FactAvailabilityRecord,
  FactContextRecord,
  ResultGameRecord,
  ResultMatchRecord,
  ResultMatchSideRecord,
  ResultPlayerRecord,
  ResultRoundRecord,
  ResultStandingRecord,
  RosterEntryRecord,
  TournamentStore,
} from './tournamentStore.js';

/**
 * Reads the tournament facts the scraper's third pass writes.
 *
 * Same discipline as `rankingDynamoAdapter`: the item keys are fixed by the
 * contract but attribute names are read tolerantly, most-likely first, and
 * anything missing comes back null rather than invented. Nothing here writes -
 * these captures are immutable and owned by the scraper.
 */

type Item = Record<string, unknown>;

function pick(item: Item, names: string[]): unknown {
  for (const name of names) {
    const value = item[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function readString(item: Item, names: string[]): string | null {
  const value = pick(item, names);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function readNumber(item: Item, names: string[]): number | null {
  const value = pick(item, names);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readBoolean(item: Item, names: string[]): boolean | null {
  const value = pick(item, names);
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function readArray(item: Item, names: string[]): Item[] {
  const value = pick(item, names);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Item => !!entry && typeof entry === 'object');
}

function readStringArray(item: Item, names: string[]): string[] {
  const value = pick(item, names);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

const RESULTS_STATUSES: ReadonlySet<string> = new Set(['final', 'partial', 'none']);

function readResultsStatus(item: Item): EventResultsStatus {
  const raw = readString(item, ['status']);
  // An unrecognised status is treated as `none`: the honest reading is "we
  // cannot claim this capture holds results", and the content check below
  // decides anyway.
  return raw !== null && RESULTS_STATUSES.has(raw) ? (raw as EventResultsStatus) : 'none';
}

function readRosterSource(item: Item): RosterSource {
  return readString(item, ['source']) === 'participants' ? 'participants' : 'registrants';
}

/**
 * The denormalised event context. Dates are stored as ISO strings; a `Date`
 * cannot come back out of DynamoDB, but the SQLite-shaped callers in dev can
 * hand one over, so both are accepted.
 */
function readContext(item: Item, externalId: string): FactContextRecord {
  const rawStart = pick(item, ['eventStartDate', 'startDate']);
  const eventStartDate =
    rawStart instanceof Date
      ? rawStart.toISOString()
      : typeof rawStart === 'string'
        ? rawStart
        : null;

  return {
    externalId: readString(item, ['externalId']) ?? externalId,
    tournamentId: readString(item, ['tournamentId']),
    eventStartDate,
    eventType: readString(item, ['eventType']),
    playFormat: readString(item, ['playFormat']),
    shopExternalId: readNumber(item, ['shopExternalId']),
    latitude: readNumber(item, ['latitude', 'lat']),
    longitude: readNumber(item, ['longitude', 'lng', 'lon']),
  };
}

function readResultPlayers(item: Item): ResultPlayerRecord[] {
  return readArray(item, ['players']).flatMap((entry) => {
    const teamId = readString(entry, ['teamId', 'esportsTeamId']);
    if (!teamId) return [];
    return [
      {
        teamId,
        playerId: readString(entry, ['playerId', 'id']),
        // The scraper stores the display name as `name` on a fact; the ranking
        // items call it `displayName`. Accept either.
        displayName: readString(entry, ['name', 'displayName']),
        tagLine: readString(entry, ['tagLine', 'tag']),
      },
    ];
  });
}

function readStandings(item: Item): ResultStandingRecord[] {
  return readArray(item, ['standings'])
    .flatMap((entry) => {
      const rank = readNumber(entry, ['rank']);
      const teamId = readString(entry, ['teamId', 'esportsTeamId']);
      if (rank === null || !teamId) return [];
      return [
        {
          rank,
          teamId,
          matchPoints: readNumber(entry, ['matchPoints']),
          matchWins: readNumber(entry, ['matchWins']),
          matchLosses: readNumber(entry, ['matchLosses']),
          matchDraws: readNumber(entry, ['matchDraws']),
          opponentMatchWinPct: readNumber(entry, ['opponentMatchWinPct', 'opponentMatchWinPercentage']),
          gameWinPct: readNumber(entry, ['gameWinPct', 'gameWinPercentage']),
          opponentGameWinPct: readNumber(entry, ['opponentGameWinPct', 'opponentGameWinPercentage']),
        },
      ];
    })
    .sort((a, b) => a.rank - b.rank);
}

function readSides(item: Item): ResultMatchSideRecord[] {
  return readArray(item, ['sides', 'teamOutcomes']).flatMap((entry) => {
    const teamId = readString(entry, ['teamId', 'esportsTeamId']);
    if (!teamId) return [];
    return [
      {
        teamId,
        outcome: readString(entry, ['outcome']),
        gameWins: readNumber(entry, ['gameWins']) ?? 0,
      },
    ];
  });
}

function readGames(item: Item): ResultGameRecord[] {
  return readArray(item, ['games']).map((entry, index) => ({
    number: readNumber(entry, ['number', 'gameNumber']) ?? index + 1,
    winnerTeamId: readString(entry, ['winnerTeamId']),
  }));
}

function readMatches(item: Item): ResultMatchRecord[] {
  return readArray(item, ['matches']).flatMap((entry) => {
    const matchId = readString(entry, ['matchId', 'esportsMatchId', 'id']);
    if (!matchId) return [];
    const sides = readSides(entry);
    return [
      {
        matchId,
        tableNumber: readNumber(entry, ['tableNumber']),
        status: readString(entry, ['status']),
        bye: readBoolean(entry, ['bye']) ?? false,
        sides,
        games: readGames(entry),
      },
    ];
  });
}

function readRounds(item: Item): ResultRoundRecord[] {
  return readArray(item, ['rounds']).map((entry, index) => ({
    section: readNumber(entry, ['section']) ?? 0,
    roundNumber: readNumber(entry, ['roundNumber']) ?? index + 1,
    status: readString(entry, ['status']),
    byeTeamIds: readStringArray(entry, ['byeTeamIds']),
    matches: readMatches(entry),
  }));
}

function toResultsRecord(item: Item, externalId: string): EventResultsRecord {
  const players = readResultPlayers(item);
  return {
    ...readContext(item, externalId),
    status: readResultsStatus(item),
    roundCount: readNumber(item, ['roundCount']) ?? 0,
    playerCount: readNumber(item, ['playerCount']) ?? players.length,
    openMatches: readNumber(item, ['openMatches']) ?? 0,
    trimmed: readBoolean(item, ['trimmed']) ?? false,
    sourceUpdatedAt: readString(item, ['sourceUpdatedAt']),
    capturedAt: readString(item, ['capturedAt']),
    players,
    standings: readStandings(item),
    rounds: readRounds(item),
  };
}

function readRosterEntries(item: Item): RosterEntryRecord[] {
  return readArray(item, ['entries']).flatMap((entry) => {
    const playerId = readString(entry, ['playerId', 'id']);
    // Identity is the stable UUID. An entry without one cannot be joined to a
    // rating or linked to a player page, so it is dropped rather than shown
    // under a name we could not verify.
    if (!playerId) return [];
    return [
      {
        playerId,
        displayName: readString(entry, ['name', 'displayName']),
        tagLine: readString(entry, ['tagLine', 'tag']),
        teamId: readString(entry, ['teamId', 'esportsTeamId']),
        status: readString(entry, ['status']),
        checkedIn: readBoolean(entry, ['checkedIn']),
        waitlistPosition: readNumber(entry, ['waitlistPosition']),
        registeredAt: readString(entry, ['registeredAt', 'acceptedTermsAt']),
      },
    ];
  });
}

function toRosterRecord(item: Item, externalId: string): EventRosterRecord {
  const entries = readRosterEntries(item);
  return {
    ...readContext(item, externalId),
    source: readRosterSource(item),
    playerCount: readNumber(item, ['playerCount']) ?? entries.length,
    capturedAt: readString(item, ['capturedAt']),
    entries,
  };
}

/** BatchGet caps at 100 keys, and each event costs two (results + roster). */
const BATCH_KEY_LIMIT = 100;
/** DynamoDB may hand back UnprocessedKeys under load; retry them a few times. */
const BATCH_RETRIES = 4;

export const dynamoTournamentStore: TournamentStore = {
  kind: 'dynamodb',

  async getResults(externalId: string): Promise<EventResultsRecord | null> {
    const result = await getDynamoClient().send(
      new GetCommand({ TableName: getTableName(), Key: eventResultsKeys(externalId) })
    );
    return result.Item ? toResultsRecord(result.Item as Item, externalId) : null;
  },

  async getRoster(externalId: string): Promise<EventRosterRecord | null> {
    const result = await getDynamoClient().send(
      new GetCommand({ TableName: getTableName(), Key: eventRosterKeys(externalId) })
    );
    return result.Item ? toRosterRecord(result.Item as Item, externalId) : null;
  },

  async getAvailability(externalIds: string[]): Promise<Map<string, FactAvailabilityRecord>> {
    const unique = [...new Set(externalIds)];
    const out = new Map<string, FactAvailabilityRecord>(
      unique.map((id) => [
        id,
        { hasResults: false, resultsStatus: null, hasRoster: false, playerCount: null },
      ])
    );
    if (unique.length === 0) return out;

    const table = getTableName();
    const keys = unique.flatMap((id) => [eventResultsKeys(id), eventRosterKeys(id)]);

    for (let i = 0; i < keys.length; i += BATCH_KEY_LIMIT) {
      let pending: Record<string, unknown>[] = keys.slice(i, i + BATCH_KEY_LIMIT);
      for (let attempt = 0; pending.length > 0 && attempt < BATCH_RETRIES; attempt++) {
        const response = await getDynamoClient().send(
          new BatchGetCommand({
            RequestItems: {
              [table]: {
                Keys: pending,
                // Metadata only. Deciding that 50 events have nothing to show
                // must not transfer their standings. `status` is a DynamoDB
                // reserved word, hence the alias.
                ProjectionExpression: 'PK, #status, playerCount, roundCount',
                ExpressionAttributeNames: { '#status': 'status' },
              },
            },
          })
        );

        for (const item of (response.Responses?.[table] ?? []) as Item[]) {
          const pk = readString(item, ['PK']);
          if (!pk) continue;

          if (pk.startsWith(EntityPrefix.EVENT_RESULTS)) {
            const externalId = pk.slice(EntityPrefix.EVENT_RESULTS.length);
            const entry = out.get(externalId);
            if (!entry) continue;
            const status = readResultsStatus(item);
            entry.resultsStatus = status;
            // A capture with status `none` exists precisely so the event stops
            // being fetched. It holds nothing, so it is not a page worth
            // opening - a trophy leading to one is worse than no trophy.
            entry.hasResults = status !== 'none';
            const playerCount = readNumber(item, ['playerCount']);
            if (playerCount !== null && playerCount > 0) entry.playerCount = playerCount;
          } else if (pk.startsWith(EntityPrefix.EVENT_ROSTER)) {
            const externalId = pk.slice(EntityPrefix.EVENT_ROSTER.length);
            const entry = out.get(externalId);
            if (!entry) continue;
            entry.hasRoster = true;
            if (entry.playerCount === null) entry.playerCount = readNumber(item, ['playerCount']);
          }
        }

        pending = (response.UnprocessedKeys?.[table]?.Keys ?? []) as Record<string, unknown>[];
      }
    }

    return out;
  },
};
