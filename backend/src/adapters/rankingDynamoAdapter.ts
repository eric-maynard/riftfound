import {
  getDynamoClient,
  getTableName,
  playerProfileKeys,
  playerPK,
  playerRatingSKPrefix,
  rankingPK,
  PLAYER_PROFILE_SK,
  PLAYER_MATCH_SK_PREFIX,
  GetCommand,
  QueryCommand,
  BatchGetCommand,
  ScanCommand,
} from '../config/dynamodb.js';
import { assessConfidence } from '../models/ranking.js';
import type { GameOutcome, MatchGame, MatchOutcome, PlayerMatch, RatingPoint, Scope } from '../models/ranking.js';
import type {
  LeaderboardPage,
  LeaderboardRecord,
  Page,
  PlayerRecord,
  RankingStore,
  SetCatalogueEntry,
  SetRatingRecord,
} from './rankingStore.js';

/**
 * Reads the derived ranking items the scraper's rating engine writes.
 *
 * The contract fixes the item *keys* but not every attribute name, so each
 * reader below lists the names it accepts, most-likely first. Anything it
 * cannot find comes back null and the API says so rather than inventing a
 * number. Nothing here writes.
 */

// --- tolerant field readers -------------------------------------------------

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

const OUTCOMES: Record<string, GameOutcome> = {
  w: 'win', win: 'win', won: 'win', victory: 'win', '1': 'win',
  l: 'loss', loss: 'loss', lose: 'loss', lost: 'loss', defeat: 'loss', '0': 'loss',
  d: 'draw', draw: 'draw', drawn: 'draw', tie: 'draw', tied: 'draw',
};

function readOutcome(value: unknown): GameOutcome {
  if (typeof value === 'string') return OUTCOMES[value.trim().toLowerCase()] ?? 'unknown';
  if (typeof value === 'boolean') return value ? 'win' : 'loss';
  if (typeof value === 'number') return OUTCOMES[String(value)] ?? 'unknown';
  if (value && typeof value === 'object') {
    const nested = pick(value as Item, ['outcome', 'result', 'won']);
    if (nested !== undefined) return readOutcome(nested);
  }
  return 'unknown';
}

function readGames(item: Item): MatchGame[] {
  const raw = pick(item, ['gameOutcomes', 'games', 'gameResults', 'perGameOutcomes']);
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => {
    const gameNumber =
      entry && typeof entry === 'object'
        ? readNumber(entry as Item, ['gameNumber', 'game', 'number', 'index']) ?? index + 1
        : index + 1;
    return { gameNumber, outcome: readOutcome(entry) };
  });
}

/** The per-set ratings map; the contract names the map but not its key. */
function readSetRatings(item: Item): SetRatingRecord[] {
  const raw = pick(item, ['setRatings', 'ratingsBySet', 'perSetRatings', 'sets']);
  if (!raw || typeof raw !== 'object') return [];

  const entries: SetRatingRecord[] = [];
  for (const [setId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'number') {
      entries.push({ setId, rating: value, uncertainty: null, gamesPlayed: null, matchesPlayed: null });
      continue;
    }
    if (typeof value !== 'object') continue;
    const inner = value as Item;
    entries.push({
      setId,
      rating: readNumber(inner, ['rating', 'mu', 'value']),
      uncertainty: readNumber(inner, ['uncertainty', 'sigma', 'rd']),
      gamesPlayed: readNumber(inner, ['gamesPlayed', 'games']),
      matchesPlayed: readNumber(inner, ['matchesPlayed', 'matches']),
    });
  }
  return entries;
}

function toPlayerRecord(item: Item): PlayerRecord | null {
  const pk = readString(item, ['PK']);
  const playerId = readString(item, ['playerId', 'id']) ?? (pk ? pk.replace(/^PLAYER#/, '') : null);
  if (!playerId) return null;

  return {
    playerId,
    displayName: readString(item, ['displayName', 'gameName', 'name']),
    tagLine: readString(item, ['tagLine', 'tag']),
    rating: readNumber(item, ['rating', 'mu']),
    uncertainty: readNumber(item, ['uncertainty', 'sigma', 'rd']),
    gamesPlayed: readNumber(item, ['gamesPlayed', 'games']),
    matchesPlayed: readNumber(item, ['matchesPlayed', 'matches']),
    firstSeen: readString(item, ['firstSeen']),
    lastSeen: readString(item, ['lastSeen']),
    componentId: readString(item, ['componentId', 'component']),
    componentSize: readNumber(item, ['componentSize']),
    regionLabel: readString(item, ['regionLabel', 'region']),
    setRatings: readSetRatings(item),
    updatedAt: readString(item, ['updatedAt', 'ratedAt', 'computedAt']),
  };
}

function toLeaderboardRecord(item: Item): LeaderboardRecord | null {
  const playerId = readString(item, ['playerId', 'id', 'player']);
  if (!playerId) return null;
  return {
    playerId,
    rank: readNumber(item, ['rank', 'position']),
    rating: readNumber(item, ['rating', 'mu']),
    uncertainty: readNumber(item, ['uncertainty', 'sigma', 'rd']),
    gamesPlayed: readNumber(item, ['gamesPlayed', 'games']),
    matchesPlayed: readNumber(item, ['matchesPlayed', 'matches']),
    displayName: readString(item, ['displayName', 'gameName', 'name']),
    tagLine: readString(item, ['tagLine', 'tag']),
    componentId: readString(item, ['componentId', 'component']),
    componentSize: readNumber(item, ['componentSize']),
    regionLabel: readString(item, ['regionLabel', 'region']),
  };
}

/**
 * A `RANKING#<scope>` item may be one row per player or a page item holding an
 * `entries` array ("leaderboard pages" in the contract, which does not pin the
 * sort key down). Accept both.
 */
function expandRankingItem(item: Item): LeaderboardRecord[] {
  const entries = pick(item, ['entries', 'players', 'rows', 'leaderboard']);
  if (Array.isArray(entries)) {
    return entries
      .filter((entry): entry is Item => !!entry && typeof entry === 'object')
      .map(toLeaderboardRecord)
      .filter((entry): entry is LeaderboardRecord => entry !== null);
  }
  const single = toLeaderboardRecord(item);
  return single ? [single] : [];
}

// --- cursors ----------------------------------------------------------------

function encodeCursor(sortKey: string | undefined): string | null {
  if (!sortKey) return null;
  return Buffer.from(sortKey, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

// --- the adapter ------------------------------------------------------------

/** Hard ceiling on a display-name search scan, so it can never walk the table. */
const SEARCH_SCAN_PAGES = 4;
const SEARCH_SCAN_PAGE_SIZE = 500;

export const dynamoRankingStore: RankingStore = {
  kind: 'dynamodb',

  async getLeaderboard(scope: Scope, limit: number, cursor?: string): Promise<LeaderboardPage> {
    const client = getDynamoClient();
    const startSK = decodeCursor(cursor);

    const result = await client.send(
      new QueryCommand({
        TableName: getTableName(),
        KeyConditionExpression: startSK ? 'PK = :pk AND SK > :sk' : 'PK = :pk',
        ExpressionAttributeValues: startSK
          ? { ':pk': rankingPK(scope.raw), ':sk': startSK }
          : { ':pk': rankingPK(scope.raw) },
        Limit: limit,
      })
    );

    const items = (result.Items ?? []) as Item[];
    const records = items.flatMap(expandRankingItem);

    return {
      items: records,
      cursor: encodeCursor(result.LastEvaluatedKey?.SK as string | undefined),
      updatedAt: items.length > 0 ? readString(items[items.length - 1], ['updatedAt', 'computedAt']) : null,
      totalPlayers: items.length > 0 ? readNumber(items[0], ['totalPlayers', 'playerCount']) : null,
    };
  },

  async getPlayer(playerId: string): Promise<PlayerRecord | null> {
    const result = await getDynamoClient().send(
      new GetCommand({ TableName: getTableName(), Key: playerProfileKeys(playerId) })
    );
    return result.Item ? toPlayerRecord(result.Item as Item) : null;
  },

  async getPlayers(playerIds: string[]): Promise<Map<string, PlayerRecord>> {
    const out = new Map<string, PlayerRecord>();
    const unique = [...new Set(playerIds)];
    if (unique.length === 0) return out;

    const table = getTableName();
    // BatchGet caps at 100 keys per request.
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      const result = await getDynamoClient().send(
        new BatchGetCommand({
          RequestItems: {
            [table]: { Keys: batch.map((id) => playerProfileKeys(id)) },
          },
        })
      );
      for (const item of (result.Responses?.[table] ?? []) as Item[]) {
        const record = toPlayerRecord(item);
        if (record) out.set(record.playerId, record);
      }
    }
    return out;
  },

  async getMatches(playerId: string, limit: number, cursor?: string, setId?: string): Promise<Page<PlayerMatch>> {
    const startSK = decodeCursor(cursor);
    const values: Record<string, unknown> = {
      ':pk': playerPK(playerId),
      ':prefix': PLAYER_MATCH_SK_PREFIX,
    };
    // Match sort keys are MATCH#<iso-timestamp>#<matchId>, so descending order
    // is newest first and the cursor walks backwards through time.
    let keyCondition = 'PK = :pk AND begins_with(SK, :prefix)';
    if (startSK) {
      keyCondition = 'PK = :pk AND SK BETWEEN :prefix AND :sk';
      values[':sk'] = startSK;
    }
    if (setId) values[':setId'] = setId;

    const result = await getDynamoClient().send(
      new QueryCommand({
        TableName: getTableName(),
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: values,
        ...(setId ? { FilterExpression: 'setId = :setId' } : {}),
        ScanIndexForward: false,
        Limit: limit,
      })
    );

    const items = (result.Items ?? []) as Item[];
    return {
      items: items.map(toPlayerMatch).filter((match): match is PlayerMatch => match !== null),
      cursor: encodeCursor(result.LastEvaluatedKey?.SK as string | undefined),
    };
  },

  async getRatingHistory(playerId: string, scope: Scope, limit: number): Promise<RatingPoint[]> {
    const result = await getDynamoClient().send(
      new QueryCommand({
        TableName: getTableName(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': playerPK(playerId),
          ':prefix': playerRatingSKPrefix(scope.raw),
        },
        ScanIndexForward: true,
        Limit: limit,
      })
    );

    return ((result.Items ?? []) as Item[])
      .map(toRatingPoint)
      .filter((point): point is RatingPoint => point !== null);
  },

  async searchPlayers(query: string, limit: number): Promise<PlayerRecord[]> {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];

    const matches: PlayerRecord[] = [];
    let startKey: Record<string, unknown> | undefined;

    for (let page = 0; page < SEARCH_SCAN_PAGES && matches.length < limit; page++) {
      const result = await getDynamoClient().send(
        new ScanCommand({
          TableName: getTableName(),
          FilterExpression: 'SK = :sk',
          ExpressionAttributeValues: { ':sk': PLAYER_PROFILE_SK },
          Limit: SEARCH_SCAN_PAGE_SIZE,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        })
      );

      for (const item of (result.Items ?? []) as Item[]) {
        const record = toPlayerRecord(item);
        if (!record) continue;
        const haystack = `${record.displayName ?? ''}#${record.tagLine ?? ''}`.toLowerCase();
        if (haystack.includes(needle)) matches.push(record);
        if (matches.length >= limit) break;
      }

      startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!startKey) break;
    }

    return matches.slice(0, limit);
  },

  async listSetIds(): Promise<string[]> {
    // Set ids are discovered from the scopes the engine has written. There is
    // no SET# item in the contract and no index over scope keys, so this reads
    // the global board and unions the per-set maps of the players on it.
    const board = await dynamoRankingStore.getLeaderboard({ raw: 'all', setId: null, componentId: null }, 100);
    const ids = new Set<string>();

    const known = board.items
      .map((entry) => entry.playerId)
      .filter((id): id is string => typeof id === 'string');
    const profiles = await dynamoRankingStore.getPlayers(known.slice(0, 100));
    for (const profile of profiles.values()) {
      for (const setRating of profile.setRatings) ids.add(setRating.setId);
    }
    return [...ids];
  },

  async listSetCatalogue(): Promise<SetCatalogueEntry[]> {
    // One shared GSI1 partition holds every set era, so the whole catalogue is
    // a single Query. Returns empty against an engine that has not written the
    // index keys yet, which the service treats as "fall back to discovery".
    const client = getDynamoClient();
    try {
      const result = await client.send(
        new QueryCommand({
          TableName: getTableName(),
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': 'SET' },
        })
      );

      return ((result.Items ?? []) as Item[]).flatMap((item) => {
        const setId = readString(item, ['setId']) ?? readString(item, ['PK'])?.replace(/^SET#/, '');
        if (!setId) return [];
        // matchCount of 0 means the engine knows the era but nobody has played
        // in it - a real state for a set that released days ago.
        const matchCount = readNumber(item, ['matchCount']);
        return [
          {
            setId,
            name: readString(item, ['name']),
            releaseDate: readString(item, ['releaseDate']),
            endDate: readString(item, ['endDate']),
            hasRatingData: (readNumber(item, ['ratedCount']) ?? 0) > 0 || (matchCount ?? 0) > 0,
          },
        ];
      });
    } catch (error) {
      // A missing index or a transient failure must not take down /api/sets.
      console.warn('[ranking] set catalogue query failed, falling back to discovery:', error);
      return [];
    }
  },

  async listComponents() {
    const board = await dynamoRankingStore.getLeaderboard({ raw: 'all', setId: null, componentId: null }, 100);
    const ids = board.items.map((entry) => entry.playerId);
    const profiles = await dynamoRankingStore.getPlayers(ids);

    const out = new Map<string, { regionLabel: string | null; componentSize: number | null; ratedPlayers: number; totalPlayers: number }>();
    for (const entry of board.items) {
      const profile = profiles.get(entry.playerId);
      const componentId = entry.componentId ?? profile?.componentId ?? null;
      if (!componentId) continue;
      const existing = out.get(componentId) ?? {
        regionLabel: entry.regionLabel ?? profile?.regionLabel ?? null,
        componentSize: entry.componentSize ?? profile?.componentSize ?? null,
        ratedPlayers: 0,
        totalPlayers: 0,
      };
      existing.totalPlayers += 1;
      const verdict = assessConfidence({
        rating: entry.rating ?? profile?.rating ?? null,
        uncertainty: entry.uncertainty ?? profile?.uncertainty ?? null,
        gamesPlayed: entry.gamesPlayed ?? profile?.gamesPlayed ?? null,
      });
      if (!verdict.provisional) existing.ratedPlayers += 1;
      out.set(componentId, existing);
    }
    return out;
  },
};

function toPlayerMatch(item: Item): PlayerMatch | null {
  const sk = readString(item, ['SK']) ?? '';
  // MATCH#<iso-timestamp>#<matchId>
  const [, skTimestamp, ...skRest] = sk.split('#');
  const matchId = readString(item, ['matchId', 'id']) ?? (skRest.length > 0 ? skRest.join('#') : null);
  if (!matchId) return null;

  return {
    matchId,
    playedAt: readString(item, ['playedAt', 'matchedAt', 'timestamp']) ?? skTimestamp ?? '',
    opponentId: readString(item, ['opponentId', 'opponentPlayerId', 'opponentUuid', 'opponent']),
    opponentDisplayName: readString(item, ['opponentDisplayName', 'opponentName']),
    outcome: readOutcome(pick(item, ['outcome', 'result', 'matchOutcome'])) as MatchOutcome,
    games: readGames(item),
    eventExternalId: readString(item, ['eventExternalId', 'externalId', 'eventId']),
    eventName: readString(item, ['eventName']),
    shopId: readString(item, ['shopId', 'venueId', 'venue']),
    latitude: readNumber(item, ['latitude', 'lat']),
    longitude: readNumber(item, ['longitude', 'lng', 'lon']),
    eventDate: readString(item, ['eventDate', 'startDate']),
    tournamentType: readString(item, ['tournamentType']),
    setId: readString(item, ['setId', 'set']),
  };
}

function toRatingPoint(item: Item): RatingPoint | null {
  const rating = readNumber(item, ['rating', 'mu', 'value']);
  if (rating === null) return null;
  const sk = readString(item, ['SK']) ?? '';
  // RATING#<scope>#<iso-date> - the date is the last segment.
  const skDate = sk.split('#').pop() ?? '';
  return {
    date: readString(item, ['date', 'asOf', 'ratedAt']) ?? skDate,
    rating,
    uncertainty: readNumber(item, ['uncertainty', 'sigma', 'rd']),
    gamesPlayed: readNumber(item, ['gamesPlayed', 'games']),
  };
}
