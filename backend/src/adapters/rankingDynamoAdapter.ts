import {
  getDynamoClient,
  getTableName,
  playerProfileKeys,
  playerPK,
  playerRatingSKPrefix,
  rankingPK,
  PLAYER_PROFILE_SK,
  PLAYER_MATCH_SK_PREFIX,
  COMPONENT_CATALOGUE_PARTITION,
  componentProfileKeys,
  venueProfileKeys,
  sceneProfileKeys,
  GetCommand,
  QueryCommand,
  BatchGetCommand,
  ScanCommand,
} from '../config/dynamodb.js';
import { normaliseOutcome, resolveVerdict } from '../models/ranking.js';
import type { GameOutcome, MatchGame, MatchOutcome, PlayerMatch, RatingPoint, Scope } from '../models/ranking.js';
import type {
  LeaderboardPage,
  LeaderboardRecord,
  Page,
  PlayerRecord,
  RankingStore,
  SceneCatalogueEntry,
  SceneCatalogueVenue,
  SceneDirectoryEntry,
  SetCatalogueEntry,
  SetRatingRecord,
  VenueCatalogueEntry,
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

function readBoolean(item: Item, names: string[]): boolean | undefined {
  const value = pick(item, names);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

/**
 * The engine's confidence verdict as written on an item.
 *
 * Absent on items written before the engine emitted it, and absent by design on
 * leaderboard rows (the engine only writes a row for a rated player), in which
 * case every field comes back undefined and the service falls back to deriving
 * one. `provisionalReason` is kept as the engine's own string and translated in
 * `resolveVerdict`, so a reason this API has never heard of cannot be silently
 * read as a reason it has.
 */
function readVerdict(item: Item): { provisional?: boolean; provisionalReason?: string | null; gamesUntilRated?: number | null } {
  return {
    provisional: readBoolean(item, ['provisional']),
    provisionalReason: readString(item, ['provisionalReason']),
    gamesUntilRated: readNumber(item, ['gamesUntilRated']),
  };
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

/**
 * The word table lives in `models/ranking.ts` (`normaliseOutcome`) because the
 * tournament endpoints normalise against it too - one table, so `TIE` cannot
 * come out as a draw here and as a raw enum there. This wrapper adds only the
 * shape tolerance this adapter needs: an outcome nested inside an object.
 */
function readOutcome(value: unknown): GameOutcome {
  if (value && typeof value === 'object') {
    const nested = pick(value as Item, ['outcome', 'result', 'won']);
    return nested === undefined ? 'unknown' : readOutcome(nested);
  }
  return normaliseOutcome(value);
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
      // Same two-layer suppression as the profile: see the note on `rating` below.
      rating: readNumber(inner, ['rating', 'mu', 'value', 'provisionalRating']),
      uncertainty: readNumber(inner, ['uncertainty', 'sigma', 'rd']),
      gamesPlayed: readNumber(inner, ['gamesPlayed', 'games']),
      matchesPlayed: readNumber(inner, ['matchesPlayed', 'matches']),
      // Each era is gated on its own evidence, so the verdict is per entry.
      ...readVerdict(inner),
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
    // The engine suppresses too: it writes the fitted number to
    // `provisionalRating` and nulls `rating` whenever a player is below its
    // rank gate. So reading `rating` alone withholds the figure for every
    // unsettled player no matter what this API decides, which is how the
    // display floor came to publish nothing between 3 and 8 games.
    //
    // Reading the fallback does not undo a gate: `publishableRating` applies
    // the floor, and the rank gate is enforced separately by `rank`, which is
    // never derived from this number. A fitted estimate with its margin is
    // exactly what we publish now.
    rating: readNumber(item, ['rating', 'mu', 'provisionalRating']),
    uncertainty: readNumber(item, ['uncertainty', 'sigma', 'rd']),
    gamesPlayed: readNumber(item, ['gamesPlayed', 'games']),
    matchesPlayed: readNumber(item, ['matchesPlayed', 'matches']),
    firstSeen: readString(item, ['firstSeen']),
    lastSeen: readString(item, ['lastSeen']),
    componentId: readString(item, ['componentId', 'component']),
    componentSize: readNumber(item, ['componentSize']),
    regionLabel: readString(item, ['regionLabel', 'region']),
    // The engine writes both onto every profile it has placed in a scene
    // (`PlayerProfileItem` in scraper/src/ranking/items.ts). They cost nothing
    // here - this is the same item the field's BatchGet already reads - and
    // they are the only one of the three place fields that names a *scene*.
    sceneId: readString(item, ['sceneId']),
    sceneLabel: readString(item, ['sceneLabel']),
    setRatings: readSetRatings(item),
    updatedAt: readString(item, ['updatedAt', 'ratedAt', 'computedAt']),
    ...readVerdict(item),
  };
}

function toLeaderboardRecord(item: Item): LeaderboardRecord | null {
  const playerId = readString(item, ['playerId', 'id', 'player']);
  if (!playerId) return null;
  return {
    playerId,
    rank: readNumber(item, ['rank', 'position']),
    rating: readNumber(item, ['rating', 'mu', 'provisionalRating']),
    uncertainty: readNumber(item, ['uncertainty', 'sigma', 'rd']),
    gamesPlayed: readNumber(item, ['gamesPlayed', 'games']),
    matchesPlayed: readNumber(item, ['matchesPlayed', 'matches']),
    displayName: readString(item, ['displayName', 'gameName', 'name']),
    tagLine: readString(item, ['tagLine', 'tag']),
    componentId: readString(item, ['componentId', 'component']),
    componentSize: readNumber(item, ['componentSize']),
    regionLabel: readString(item, ['regionLabel', 'region']),
    ...readVerdict(item),
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

/**
 * Pages of the component catalogue Query the scene map will follow.
 *
 * The Query is bounded by one GSI1 partition, so in practice this never binds
 * - 1,235 items of ~250 bytes is a third of one 1MB page. It is here so the
 * endpoint cannot loop indefinitely against a table that has grown in a way
 * nobody expected, and four pages is ~16,000 scenes of headroom.
 */
const SCENE_CATALOGUE_PAGES = 4;

/**
 * A venue pin off a `COMPONENT#` item.
 *
 * Both coordinates are required - half a coordinate pair is not a position,
 * and the alternative is a pin at 0,0 - so an entry missing either is dropped
 * rather than defaulted.
 */
function readSceneVenue(value: unknown): SceneCatalogueVenue | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Item;
  const latitude = readNumber(item, ['latitude', 'lat']);
  const longitude = readNumber(item, ['longitude', 'lng', 'lon']);
  if (latitude === null || longitude === null) return null;
  return {
    shopExternalId: readNumber(item, ['shopExternalId', 'shopId']),
    latitude,
    longitude,
    matchCount: readNumber(item, ['matchCount', 'matches']) ?? 0,
  };
}

function toSceneCatalogueEntry(item: Item): SceneCatalogueEntry | null {
  const componentId =
    readString(item, ['componentId']) ?? readString(item, ['PK'])?.replace(/^COMPONENT#/, '') ?? null;
  if (!componentId) return null;

  // A coordinate is only published as a pair. An item carrying one half is a
  // bug upstream, and reading it as "latitude with longitude 0" would put the
  // scene in the Gulf of Guinea rather than reporting it unlocated.
  const latitude = readNumber(item, ['latitude', 'lat']);
  const longitude = readNumber(item, ['longitude', 'lng', 'lon']);
  const located = latitude !== null && longitude !== null;

  const rawVenues = pick(item, ['topVenues']);
  const topVenues = Array.isArray(rawVenues)
    ? rawVenues.map(readSceneVenue).filter((venue): venue is SceneCatalogueVenue => venue !== null)
    : [];

  return {
    componentId,
    regionLabel: readString(item, ['regionLabel', 'region']),
    componentSize: readNumber(item, ['componentSize', 'playerCount']),
    playerCount: readNumber(item, ['playerCount', 'componentSize']),
    ratedCount: readNumber(item, ['ratedCount', 'ratedPlayers']),
    matchCount: readNumber(item, ['matchCount', 'matches']),
    venueCount: readNumber(item, ['venueCount', 'venues']),
    isGiant: readBoolean(item, ['isGiant']) ?? false,
    latitude: located ? latitude : null,
    longitude: located ? longitude : null,
    spreadKm: located ? readNumber(item, ['spreadKm']) : null,
    nearestVenueKm: located ? readNumber(item, ['nearestVenueKm']) : null,
    locatedVenues: readNumber(item, ['locatedVenues']),
    locatedMatches: readNumber(item, ['locatedMatches']),
    topVenues,
    generatedAt: readString(item, ['generatedAt', 'updatedAt', 'computedAt']),
  };
}

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

  async listSceneCatalogue(): Promise<SceneCatalogueEntry[]> {
    // One shared GSI1 partition holds every component, so the whole catalogue
    // is a single Query - the access pattern the items were given GSI1 keys
    // for. Production holds 1,235 of them at ~250 bytes, so this is one Query
    // returning ~300KB, around 38 read units, and it is paged rather than
    // capped because a *partial* map is worse than a slow one: a reader cannot
    // tell a missing scene from an unlocated one.
    const client = getDynamoClient();
    const entries: SceneCatalogueEntry[] = [];
    let startKey: Record<string, unknown> | undefined;

    try {
      // A page cap rather than a trusting `while (startKey)`: the Query is
      // bounded by one partition's size, but an endpoint that can loop
      // forever against an unexpected table is not one to deploy. Four pages
      // of a 1MB Query is ~16,000 of these items - an order of magnitude of
      // headroom on today's 1,235.
      for (let page = 0; page < SCENE_CATALOGUE_PAGES; page++) {
        const result = await client.send(
          new QueryCommand({
            TableName: getTableName(),
            IndexName: 'GSI1',
            KeyConditionExpression: 'GSI1PK = :pk',
            ExpressionAttributeValues: { ':pk': COMPONENT_CATALOGUE_PARTITION },
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          })
        );

        for (const item of (result.Items ?? []) as Item[]) {
          const entry = toSceneCatalogueEntry(item);
          if (entry) entries.push(entry);
        }

        startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
        if (!startKey) break;
      }
    } catch (error) {
      // A missing index or a transient failure must not take the map down with
      // a 500: the service reads an empty catalogue as "cannot tell", which is
      // the page's own state and says so. Same posture as listSetCatalogue.
      console.warn('[ranking] scene catalogue query failed:', error);
      return [];
    }

    return entries;
  },

  async getComponent(componentId: string): Promise<SceneCatalogueEntry | null> {
    // One GetItem, ~1 read unit, and the same `toSceneCatalogueEntry` mapping
    // the catalogue Query uses - so a scene named on an event page and the
    // same scene drawn on the map can never read two different labels off one
    // item.
    try {
      const client = getDynamoClient();
      const result = await client.send(
        new GetCommand({ TableName: getTableName(), Key: componentProfileKeys(componentId) })
      );
      if (!result.Item) return null;
      return toSceneCatalogueEntry(result.Item as Item);
    } catch (error) {
      // Same posture as `listSceneCatalogue`: the caller reads null as "we
      // have no label for this scene", which is a state it already has to
      // render (the engine writes `regionLabel: null` for a scene whose stores
      // are not geocoded). A 500 here would take down a whole event page for
      // the sake of one line on it.
      console.warn('[ranking] component profile read failed:', error);
      return null;
    }
  },

  async getVenue(shopExternalId: number): Promise<VenueCatalogueEntry | null> {
    // One GetItem, ~1 read unit, on a route already edge-cached for 15
    // minutes. This is the whole cost of an event page knowing its scene, and
    // it is cheaper than the component tally it replaced was *correct*.
    try {
      const client = getDynamoClient();
      const result = await client.send(
        new GetCommand({ TableName: getTableName(), Key: venueProfileKeys(shopExternalId) })
      );
      if (!result.Item) return null;
      const item = result.Item as Item;
      const latitude = readNumber(item, ['latitude', 'lat']);
      const longitude = readNumber(item, ['longitude', 'lng', 'lon']);
      // A coordinate is only ever read as a pair, for the reason the scene
      // map's reader gives: half of one lands a pin in the Gulf of Guinea.
      const located = latitude !== null && longitude !== null;
      return {
        shopExternalId,
        name: readString(item, ['name']),
        latitude: located ? latitude : null,
        longitude: located ? longitude : null,
        players: readNumber(item, ['players', 'playerCount']),
        ratedPlayers: readNumber(item, ['ratedPlayers', 'ratedCount']),
        matches: readNumber(item, ['matches', 'matchCount']),
        events: readNumber(item, ['events', 'eventCount']),
        sceneId: readString(item, ['sceneId']),
        sceneLabel: readString(item, ['sceneLabel']),
        scenePurity: readNumber(item, ['scenePurity']),
        generatedAt: readString(item, ['generatedAt', 'updatedAt']),
      };
    } catch (error) {
      // Same posture as `getComponent`: the caller reads null as "we do not
      // know this store's scene", which is a state the page already has to
      // render, because `sceneId` is null on every venue until an operator
      // accepts a re-clustering. A 500 here would take down a whole event
      // page for the sake of one line on it.
      console.warn('[ranking] venue profile read failed:', error);
      return null;
    }
  },

  async getScene(sceneId: string): Promise<SceneDirectoryEntry | null> {
    try {
      const client = getDynamoClient();
      const result = await client.send(
        new GetCommand({ TableName: getTableName(), Key: sceneProfileKeys(sceneId) })
      );
      if (!result.Item) return null;
      const item = result.Item as Item;
      return {
        sceneId,
        label: readString(item, ['label', 'sceneLabel']),
        venueCount: readNumber(item, ['venueCount', 'venues']),
        playerCount: readNumber(item, ['playerCount', 'players']),
        ratedCount: readNumber(item, ['ratedCount', 'ratedPlayers']),
        matchCount: readNumber(item, ['matchCount', 'matches']),
        medianPurity: readNumber(item, ['medianPurity']),
        assignedAt: readString(item, ['assignedAt']),
      };
    } catch (error) {
      console.warn('[ranking] scene profile read failed:', error);
      return null;
    }
  },

  async listComponents() {
    const board = await dynamoRankingStore.getLeaderboard({ raw: 'all', setId: null, componentId: null }, 100);

    // Only the rows that cannot answer for themselves. The engine denormalises
    // componentId, componentSize, regionLabel and the rating triple onto every
    // leaderboard row precisely so a board can be summarised without profile
    // fetches, and in production none of them is missing - so this used to be
    // an unconditional 100-key BatchGet on every single /api/rankings request,
    // around 50 read units and a round trip spent to re-read what the first
    // Query had already returned. Still conditional rather than removed,
    // because a row written before those attributes existed must not quietly
    // drop out of the component list. Same shape as `needsHydration` in
    // services/rankingService.ts.
    const sparse = board.items
      .filter(
        (entry) =>
          entry.componentId == null ||
          entry.rating == null ||
          entry.uncertainty == null ||
          entry.gamesPlayed == null
      )
      .map((entry) => entry.playerId);
    const profiles =
      sparse.length > 0 ? await dynamoRankingStore.getPlayers(sparse) : new Map<string, PlayerRecord>();

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
      const verdict = resolveVerdict({
        rating: entry.rating ?? profile?.rating ?? null,
        uncertainty: entry.uncertainty ?? profile?.uncertainty ?? null,
        gamesPlayed: entry.gamesPlayed ?? profile?.gamesPlayed ?? null,
        provisional: entry.provisional ?? profile?.provisional,
        provisionalReason: entry.provisionalReason ?? profile?.provisionalReason,
        gamesUntilRated: entry.gamesUntilRated ?? profile?.gamesUntilRated,
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
