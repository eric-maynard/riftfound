import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
  BatchGetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import geohash from 'ngeohash';
import { gzipSync, gunzipSync } from 'node:zlib';
import { env } from './config.js';
import type { ScrapeCycle } from './cancellations.js';
import type { ShopCandidate } from './shopMatch.js';
import type {
  EventFactCandidate,
  EventFactContext,
  EventResults,
  EventResultsStatus,
  EventRoster,
  ResultPlayer,
  ResultRound,
  ResultStanding,
  RosterEntry,
  RosterSource,
  ScrapedEvent,
  StoreInfo,
  UpsertEventResult,
  UpsertShopResult,
} from './database.js';
import type { PlayerProfile, RankingRow, RankingSnapshot } from './ranking/items.js';
import type { SceneAssignment } from './ranking/scenes.js';
import { buildPlayerSearchIndex } from './ranking/searchIndex.js';
import { preserveMergedFields, type MergeOwnedFields } from './merge.js';
// Value import; everything on the way back here is type-only, so no cycle.
import { resultsCandidateTournamentId } from './sources/playriftbound.js';

// DynamoDB client singleton
let docClient: DynamoDBDocumentClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!docClient) {
    const clientConfig: ConstructorParameters<typeof DynamoDBClient>[0] = {
      region: env.AWS_REGION,
    };

    // Use local endpoint for development (DynamoDB Local)
    if (env.DYNAMODB_ENDPOINT) {
      clientConfig.endpoint = env.DYNAMODB_ENDPOINT;
      clientConfig.credentials = {
        accessKeyId: 'local',
        secretAccessKey: 'local',
      };
    }

    const client = new DynamoDBClient(clientConfig);
    docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertClassInstanceToMap: true,
      },
    });
  }
  return docClient;
}

function getTableName(): string {
  return env.DYNAMODB_TABLE_NAME;
}

// Entity key prefixes
const EntityPrefix = {
  EVENT: 'EVENT#',
  SHOP: 'SHOP#',
  GEOCACHE: 'GEOCACHE#',
  SCRAPE_RUN: 'SCRAPE_RUN',
} as const;

// Helper to create event keys
function eventKeys(externalId: string) {
  return {
    PK: `${EntityPrefix.EVENT}${externalId}`,
    SK: `${EntityPrefix.EVENT}${externalId}`,
  };
}

// Helper to create event GSI1 keys (for date-based queries)
function eventGSI1Keys(startDate: Date, externalId: string) {
  const dateStr = startDate.toISOString().split('T')[0]; // YYYY-MM-DD
  return {
    GSI1PK: `DATE#${dateStr}`,
    GSI1SK: `${EntityPrefix.EVENT}${externalId}`,
  };
}

// Helper to create shop keys
function shopKeys(externalId: number) {
  return {
    PK: `${EntityPrefix.SHOP}${externalId}`,
    SK: `${EntityPrefix.SHOP}${externalId}`,
  };
}

// Helper to create scrape run keys
function scrapeRunKeys(timestamp: string) {
  return {
    PK: EntityPrefix.SCRAPE_RUN,
    SK: timestamp,
  };
}

// DynamoDB Event item structure
export interface DynamoEventItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK?: string;
  GSI2SK?: string;
  entityType: 'EVENT';
  externalId: string;
  name: string;
  description: string | null;
  location: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  geohash3?: string;  // For GeohashEventIndex - query events directly by location
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  eventType: string | null;
  organizer: string | null;
  playerCount: number | null;
  capacity: number | null;
  price: string | null;
  url: string | null;
  imageUrl: string | null;
  /** Contributing source(s): ['uvs'], ['playriftbound'] or both when field-merged. */
  sources: string[] | null;
  /**
   * Riot's `RiftboundTournamentConfig.format`, verbatim (see
   * ScrapedEvent.playFormat). Null on every row stored before this field
   * shipped and on every UVS-only row - permanently, because it cannot be
   * backfilled.
   */
  playFormat: string | null;
  shopId: number | null;
  shopExternalId: number | null;
  shopName: string | null;
  shopLatitude: number | null;
  shopLongitude: number | null;
  createdAt: string;
  updatedAt: string;
  scrapedAt: string;
  ttl?: number;
}

// DynamoDB Shop item structure
interface DynamoShopItem {
  PK: string;
  SK: string;
  entityType: 'SHOP';
  externalId: number;
  name: string;
  locationText: string | null;
  displayCity: string | null;
  latitude: number | null;
  longitude: number | null;
  geohash3?: string;  // Precision 3 (~156km cells) for large radius queries
  geohash4?: string;  // Precision 4 (~39km cells) for small radius queries
  geocodeStatus: string;
  geocodeError: string | null;
  createdAt: string;
  updatedAt: string;
}

// Change detection helpers to avoid unnecessary writes
// Comparing only data fields, not metadata like updatedAt/scrapedAt/createdAt

function hasShopChanged(existing: DynamoShopItem, newItem: DynamoShopItem): boolean {
  return (
    existing.name !== newItem.name ||
    existing.locationText !== newItem.locationText ||
    existing.latitude !== newItem.latitude ||
    existing.longitude !== newItem.longitude ||
    existing.geohash3 !== newItem.geohash3 ||
    existing.geohash4 !== newItem.geohash4
  );
}

/**
 * Whether a stored event row differs from the one we are about to write.
 *
 * Exported for tests: every field this misses is a field that silently never
 * reaches rows that are otherwise unchanged, which is a failure mode with no
 * other symptom.
 */
export function hasEventChanged(existing: DynamoEventItem, newItem: DynamoEventItem): boolean {
  // Excluded fields:
  // - imageUrl: CDN URLs include tokens/versions that change on every API call
  return (
    existing.name !== newItem.name ||
    existing.description !== newItem.description ||
    existing.location !== newItem.location ||
    existing.address !== newItem.address ||
    existing.city !== newItem.city ||
    existing.state !== newItem.state ||
    existing.country !== newItem.country ||
    existing.latitude !== newItem.latitude ||
    existing.longitude !== newItem.longitude ||
    existing.geohash3 !== newItem.geohash3 ||
    existing.startDate !== newItem.startDate ||
    existing.startTime !== newItem.startTime ||
    existing.endDate !== newItem.endDate ||
    existing.eventType !== newItem.eventType ||
    existing.organizer !== newItem.organizer ||
    existing.playerCount !== newItem.playerCount ||
    existing.capacity !== newItem.capacity ||
    existing.price !== newItem.price ||
    existing.url !== newItem.url ||
    (existing.sources ?? []).join(',') !== (newItem.sources ?? []).join(',') ||
    // Load-bearing: without this, a row that is otherwise identical would be
    // skipped and would never acquire a playFormat, so the field would stay
    // empty for every currently-stored event instead of filling in on the next
    // sweep. (existing has no attribute at all on pre-migration rows, hence the
    // ?? null on both sides.)
    (existing.playFormat ?? null) !== (newItem.playFormat ?? null) ||
    existing.shopId !== newItem.shopId ||
    existing.shopName !== newItem.shopName ||
    existing.shopLatitude !== newItem.shopLatitude ||
    existing.shopLongitude !== newItem.shopLongitude
  );
}

// DynamoDB ScrapeRun item structure
interface DynamoScrapeRunItem {
  PK: string;
  SK: string;
  entityType: 'SCRAPE_RUN';
  startedAt: string;
  completedAt: string | null;
  status: string;
  eventsFound: number;
  eventsCreated: number;
  eventsUpdated: number;
  errorMessage: string | null;
}

// Start a new scrape run
export async function startScrapeRunDynamoDB(): Promise<string> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const timestamp = new Date().toISOString();
  const keys = scrapeRunKeys(timestamp);

  const item: DynamoScrapeRunItem = {
    ...keys,
    entityType: 'SCRAPE_RUN',
    startedAt: timestamp,
    completedAt: null,
    status: 'running',
    eventsFound: 0,
    eventsCreated: 0,
    eventsUpdated: 0,
    errorMessage: null,
  };

  await client.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));

  return timestamp; // Use timestamp as the run ID
}

// Complete a scrape run
export async function completeScrapeRunDynamoDB(
  runId: string,
  stats: { eventsFound: number; eventsCreated: number; eventsUpdated: number }
): Promise<void> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const keys = scrapeRunKeys(runId);

  // Get existing item and update it
  const response = await client.send(new GetCommand({
    TableName: tableName,
    Key: keys,
  }));

  if (response.Item) {
    const item = response.Item as DynamoScrapeRunItem;
    item.completedAt = new Date().toISOString();
    item.status = 'completed';
    item.eventsFound = stats.eventsFound;
    item.eventsCreated = stats.eventsCreated;
    item.eventsUpdated = stats.eventsUpdated;

    await client.send(new PutCommand({
      TableName: tableName,
      Item: item,
    }));
  }
}

// Fail a scrape run
export async function failScrapeRunDynamoDB(runId: string, errorMessage: string): Promise<void> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const keys = scrapeRunKeys(runId);

  const response = await client.send(new GetCommand({
    TableName: tableName,
    Key: keys,
  }));

  if (response.Item) {
    const item = response.Item as DynamoScrapeRunItem;
    item.completedAt = new Date().toISOString();
    item.status = 'failed';
    item.errorMessage = errorMessage;

    await client.send(new PutCommand({
      TableName: tableName,
      Item: item,
    }));
  }
}

// Upsert a shop from API data
export async function upsertShopFromApiDynamoDB(store: StoreInfo): Promise<UpsertShopResult> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const keys = shopKeys(store.id);

  // Check if shop exists
  const existing = await client.send(new GetCommand({
    TableName: tableName,
    Key: keys,
  }));

  const now = new Date().toISOString();
  const isNew = !existing.Item;
  const existingShop = existing.Item as DynamoShopItem | undefined;

  // Calculate geohashes for spatial indexing at multiple precisions
  const geohash3 = store.latitude && store.longitude
    ? geohash.encode(store.latitude, store.longitude, 3)
    : undefined;
  const geohash4 = store.latitude && store.longitude
    ? geohash.encode(store.latitude, store.longitude, 4)
    : undefined;

  const item: DynamoShopItem = {
    ...keys,
    entityType: 'SHOP',
    externalId: store.id,
    name: store.name,
    locationText: store.full_address,
    displayCity: existingShop?.displayCity ?? null,
    latitude: store.latitude,
    longitude: store.longitude,
    geohash3,
    geohash4,
    geocodeStatus: 'completed',
    geocodeError: null,
    createdAt: existingShop?.createdAt ?? now,
    updatedAt: now,
  };

  // Skip write if nothing changed (saves WCUs)
  if (!isNew && existingShop && !hasShopChanged(existingShop, item)) {
    return {
      shopId: store.id,
      isNew: false,
      needsCityGeocode: !item.displayCity,
      latitude: store.latitude,
      longitude: store.longitude,
    };
  }

  await client.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));

  return {
    shopId: store.id,
    isNew,
    needsCityGeocode: !item.displayCity,
    latitude: store.latitude,
    longitude: store.longitude,
  };
}

// Update shop display city after reverse geocoding
export async function updateShopDisplayCityDynamoDB(shopExternalId: number, displayCity: string): Promise<void> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const keys = shopKeys(shopExternalId);

  const response = await client.send(new GetCommand({
    TableName: tableName,
    Key: keys,
  }));

  if (response.Item) {
    const item = response.Item as DynamoShopItem;
    item.displayCity = displayCity;
    item.updatedAt = new Date().toISOString();

    await client.send(new PutCommand({
      TableName: tableName,
      Item: item,
    }));
  }
}

// Upsert event with store info
export async function upsertEventWithStoreDynamoDB(
  event: ScrapedEvent,
  storeInfo: StoreInfo | null,
  options: { existingShop?: boolean } = {}
): Promise<UpsertEventResult> {
  const client = getDynamoClient();
  const tableName = getTableName();

  // First, upsert the shop if provided. `existingShop` means storeInfo points at a
  // shop row owned by another source (a UVS shop a Riot organizer resolved to),
  // which must be referenced but never overwritten.
  let shopResult: UpsertShopResult | undefined;
  if (storeInfo && !options.existingShop) {
    shopResult = await upsertShopFromApiDynamoDB(storeInfo);
  }

  // Check if event exists
  const eventKeysVal = eventKeys(event.externalId);
  const existing = await client.send(new GetCommand({
    TableName: tableName,
    Key: eventKeysVal,
  }));

  const isNew = !existing.Item;
  const existingEvent = existing.Item as DynamoEventItem | undefined;
  const now = new Date().toISOString();
  const gsi1Keys = eventGSI1Keys(event.startDate, event.externalId);

  // GSI2 keys for shop-based event queries
  const gsi2Keys = storeInfo?.id ? {
    GSI2PK: `SHOP#${storeInfo.id}`,
    GSI2SK: event.startDate.toISOString(),
  } : {};

  // Calculate TTL (90 days after event date)
  const eventDate = new Date(event.startDate);
  const ttlDate = new Date(eventDate);
  ttlDate.setDate(ttlDate.getDate() + 90);
  const ttl = Math.floor(ttlDate.getTime() / 1000);

  // Compute geohash3 from shop coordinates for GeohashEventIndex
  const eventGeohash3 = storeInfo?.latitude && storeInfo?.longitude
    ? geohash.encode(storeInfo.latitude, storeInfo.longitude, 3)
    : undefined;

  let item: DynamoEventItem = {
    ...eventKeysVal,
    ...gsi1Keys,
    ...gsi2Keys,
    entityType: 'EVENT',
    externalId: event.externalId,
    name: event.name,
    description: event.description ?? null,
    location: event.location ?? null,
    address: event.address ?? null,
    city: event.city ?? null,
    state: event.state ?? null,
    country: event.country ?? null,
    latitude: event.latitude ?? null,
    longitude: event.longitude ?? null,
    geohash3: eventGeohash3,
    startDate: event.startDate.toISOString(),
    startTime: event.startTime ?? null,
    endDate: event.endDate?.toISOString() ?? null,
    eventType: event.eventType ?? null,
    organizer: event.organizer ?? null,
    playerCount: event.playerCount ?? null,
    capacity: event.capacity ?? null,
    price: event.price ?? null,
    url: event.url ?? null,
    imageUrl: event.imageUrl ?? null,
    sources: event.sources?.length ? event.sources : null,
    playFormat: event.playFormat ?? null,
    shopId: storeInfo?.id ?? null,
    shopExternalId: storeInfo?.id ?? null,
    shopName: storeInfo?.name ?? null,
    shopLatitude: storeInfo?.latitude ?? null,
    shopLongitude: storeInfo?.longitude ?? null,
    createdAt: existingEvent?.createdAt ?? now,
    updatedAt: now,
    scrapedAt: now,
    ttl,
  };

  // A row the playriftbound pass field-merged stays merged when the UVS pass
  // re-writes it; otherwise every UVS cycle reverts the merge (see merge.ts).
  if (existingEvent) {
    item = preserveMergedFields(item, existingEvent, item.startDate);
  }

  // Skip write if nothing changed (saves WCUs)
  if (!isNew && existingEvent && !hasEventChanged(existingEvent, item)) {
    return {
      created: false,
      skipped: true,
      shopResult,
    };
  }

  await client.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));

  return {
    created: isNew,
    skipped: false,
    shopResult,
  };
}

// Delete old events (using TTL is preferred, but this is for manual cleanup)
export async function deleteOldEventsDynamoDB(daysOld = 60): Promise<number> {
  const client = getDynamoClient();
  const tableName = getTableName();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  // Query events older than cutoff using GSI1
  // This is expensive - in production, rely on DynamoDB TTL instead
  let deletedCount = 0;
  const startDate = new Date('2020-01-01'); // Arbitrary old date

  // Generate date range
  const dates: string[] = [];
  const current = new Date(startDate);
  while (current < cutoffDate) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }

  // Query and delete in batches
  for (const date of dates) {
    const response = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `DATE#${date}`,
      },
    }));

    if (response.Items && response.Items.length > 0) {
      // Delete in batches of 25 (DynamoDB limit)
      const items = response.Items as DynamoEventItem[];
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        await client.send(new BatchWriteCommand({
          RequestItems: {
            [tableName]: batch.map(item => ({
              DeleteRequest: {
                Key: { PK: item.PK, SK: item.SK },
              },
            })),
          },
        }));
        deletedCount += batch.length;
      }
    }
  }

  return deletedCount;
}

// Get the last time stale event cleanup ran
export async function getLastStaleCleanupTimeDynamoDB(): Promise<string | null> {
  const client = getDynamoClient();
  const tableName = getTableName();

  const response = await client.send(new GetCommand({
    TableName: tableName,
    Key: { PK: 'CONFIG#STALE_CLEANUP', SK: 'CONFIG#STALE_CLEANUP' },
  }));

  return (response.Item?.lastRunAt as string) ?? null;
}

// Record that stale event cleanup ran
export async function setLastStaleCleanupTimeDynamoDB(timestamp: string): Promise<void> {
  const client = getDynamoClient();
  const tableName = getTableName();

  await client.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: 'CONFIG#STALE_CLEANUP',
      SK: 'CONFIG#STALE_CLEANUP',
      entityType: 'CONFIG',
      lastRunAt: timestamp,
    },
  }));
}

// Remove upcoming events that no longer appear in the upstream API
export async function cleanupStaleEventsDynamoDB(
  seenExternalIds: Set<string>,
  protectedExternalIdPrefixes: string[] = []
): Promise<number> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const today = new Date().toISOString();

  // Scan for all EVENT items with startDate >= today
  let deletedCount = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await client.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'entityType = :et AND startDate >= :today',
      ExpressionAttributeValues: {
        ':et': 'EVENT',
        ':today': today,
      },
      ProjectionExpression: 'PK, SK, externalId, #n',
      ExpressionAttributeNames: { '#n': 'name' },
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    if (response.Items) {
      const staleItems = response.Items.filter(item => {
        const externalId = item.externalId as string;
        if (seenExternalIds.has(externalId)) return false;
        // Never delete events from a source that did not run this cycle
        return !protectedExternalIdPrefixes.some(prefix => externalId.startsWith(prefix));
      });

      // Delete in batches of 25
      for (let i = 0; i < staleItems.length; i += 25) {
        const batch = staleItems.slice(i, i + 25);
        await client.send(new BatchWriteCommand({
          RequestItems: {
            [tableName]: batch.map(item => ({
              DeleteRequest: {
                Key: { PK: item.PK, SK: item.SK },
              },
            })),
          },
        }));
        for (const item of batch) {
          console.log(`  Removed stale event: ${item.name} (${item.externalId})`);
        }
        deletedCount += batch.length;
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return deletedCount;
}

// Get shop by external ID (for geocoding queue)
export async function getShopByExternalIdDynamoDB(externalId: number): Promise<DynamoShopItem | null> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const keys = shopKeys(externalId);

  const response = await client.send(new GetCommand({
    TableName: tableName,
    Key: keys,
  }));

  return response.Item as DynamoShopItem | null;
}

/** The subset of a stored event needed to seed and de-duplicate the playriftbound pass. */
export interface StoredEventSummary extends MergeOwnedFields {
  externalId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  startDate: Date;
  createdAt?: Date | null;
  shopExternalId?: number | null;
  shopName?: string | null;
  shopLatitude?: number | null;
  shopLongitude?: number | null;
}

/**
 * Load every stored event starting from yesterday up to `daysForward` days out,
 * via the GSI1 date partitions (one Query per day, a few in parallel).
 *
 * The sharded Lambda scraper has no single invocation that sees the whole UVS
 * feed, so the playriftbound invocation reads the UVS rows back from the table
 * instead of collecting them in memory.
 */
export async function loadUpcomingEventsDynamoDB(daysForward: number): Promise<StoredEventSummary[]> {
  // Yesterday through daysForward+1: a day either side of the window, because
  // an event's UTC date and its local date are not the same day.
  return loadEventSummariesForDates(eventDatePartitions(-1, daysForward + 1));
}

/** UTC `YYYY-MM-DD` partition keys from `fromOffset` to `toOffset` days from today. */
function eventDatePartitions(fromOffset: number, toOffset: number): string[] {
  const dates: string[] = [];
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + fromOffset);
  for (let i = fromOffset; i <= toOffset; i++) {
    dates.push(day.toISOString().split('T')[0]);
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

/** Stored events in the given GSI1 date partitions (one Query per day, a few in parallel). */
async function loadEventSummariesForDates(dates: string[]): Promise<StoredEventSummary[]> {
  const client = getDynamoClient();
  const tableName = getTableName();

  const results: StoredEventSummary[] = [];
  const CONCURRENCY = 8;

  const loadDate = async (date: string) => {
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const response = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `DATE#${date}` },
        ProjectionExpression:
          'externalId, #name, latitude, longitude, startDate, eventType, #url, playerCount, #capacity, price, sources, ' +
          'playFormat, ' +
          'createdAt, shopExternalId, shopName, shopLatitude, shopLongitude',
        // name, url and capacity are DynamoDB reserved words
        ExpressionAttributeNames: { '#url': 'url', '#name': 'name', '#capacity': 'capacity' },
        ExclusiveStartKey: lastEvaluatedKey,
      }));
      for (const item of response.Items ?? []) {
        if (typeof item.externalId !== 'string' || typeof item.startDate !== 'string') continue;
        results.push({
          externalId: item.externalId,
          name: (item.name as string) ?? '',
          latitude: (item.latitude as number | null) ?? null,
          longitude: (item.longitude as number | null) ?? null,
          startDate: new Date(item.startDate),
          eventType: (item.eventType as string | null) ?? null,
          url: (item.url as string | null) ?? null,
          playerCount: (item.playerCount as number | null) ?? null,
          capacity: (item.capacity as number | null) ?? null,
          price: (item.price as string | null) ?? null,
          sources: (item.sources as string[] | null) ?? null,
          playFormat: (item.playFormat as string | null) ?? null,
          createdAt: typeof item.createdAt === 'string' ? new Date(item.createdAt) : null,
          shopExternalId: (item.shopExternalId as number | null) ?? null,
          shopName: (item.shopName as string | null) ?? null,
          shopLatitude: (item.shopLatitude as number | null) ?? null,
          shopLongitude: (item.shopLongitude as number | null) ?? null,
        });
      }
      lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);
  };

  for (let i = 0; i < dates.length; i += CONCURRENCY) {
    await Promise.all(dates.slice(i, i + CONCURRENCY).map(loadDate));
  }

  return results;
}

/**
 * Event names for a date window, as `externalId -> name`.
 *
 * The fact rows deliberately carry no event name - they denormalise only what a
 * rating *fit* needs, and a name is presentation. The per-player match log does
 * want one, so it is resolved from the event rows that still exist. Events
 * older than `deleteOldEvents(60)` simply have no name, and the log entry
 * records null rather than a fabricated one.
 */
export async function loadEventNamesDynamoDB(
  daysBack: number,
  daysForward: number
): Promise<Map<string, string>> {
  const rows = await loadEventSummariesForDates(eventDatePartitions(-daysBack, daysForward));
  const names = new Map<string, string>();
  for (const row of rows) if (row.name) names.set(row.externalId, row.name);
  return names;
}

/**
 * Write only the field-merge-owned attributes onto an existing event row.
 * Never creates a row: if the UVS row vanished in the meantime this is a no-op.
 */
export async function applyMergedEventFieldsDynamoDB(
  externalId: string,
  changes: Partial<MergeOwnedFields>
): Promise<boolean> {
  const entries = Object.entries(changes);
  if (entries.length === 0) return false;

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ':now': new Date().toISOString() };
  const sets = entries.map(([key, value], i) => {
    names[`#f${i}`] = key;
    values[`:v${i}`] = value ?? null;
    return `#f${i} = :v${i}`;
  });
  sets.push('updatedAt = :now');

  try {
    await getDynamoClient().send(new UpdateCommand({
      TableName: getTableName(),
      Key: eventKeys(externalId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

/** Delete event rows by external id (batched, 25 per request). */
export async function deleteEventsDynamoDB(externalIds: string[]): Promise<number> {
  const client = getDynamoClient();
  const tableName = getTableName();
  let deleted = 0;
  for (let i = 0; i < externalIds.length; i += 25) {
    const batch = externalIds.slice(i, i + 25);
    await client.send(new BatchWriteCommand({
      RequestItems: {
        [tableName]: batch.map(id => ({ DeleteRequest: { Key: eventKeys(id) } })),
      },
    }));
    deleted += batch.length;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Scrape cycles: which UVS event ids each sharded run saw (cancellation checks)
// ---------------------------------------------------------------------------

const SCRAPE_CYCLE_PK = 'SCRAPE_CYCLE';
const SCRAPE_CYCLE_TTL_SECONDS = 3 * 24 * 60 * 60;

function cycleTtl(): number {
  return Math.floor(Date.now() / 1000) + SCRAPE_CYCLE_TTL_SECONDS;
}

/** Coordinator: record a cycle before dispatching its shards. */
export async function recordScrapeCycleDynamoDB(cycle: {
  cycleId: string;
  shardCount: number;
  totalExpected: number;
}): Promise<void> {
  await getDynamoClient().send(new PutCommand({
    TableName: getTableName(),
    Item: {
      PK: SCRAPE_CYCLE_PK,
      SK: cycle.cycleId,
      entityType: 'SCRAPE_CYCLE',
      startedAt: cycle.cycleId,
      shardCount: cycle.shardCount,
      totalExpected: cycle.totalExpected,
      ttl: cycleTtl(),
    },
  }));
}

/**
 * Worker: record the event ids its shard saw. Stored gzipped (a shard sees ~10k
 * ids, ~80KB raw) to stay far below DynamoDB's 400KB item limit.
 */
export async function recordShardSeenIdsDynamoDB(
  cycleId: string,
  shardIndex: number,
  ids: Iterable<string>,
  complete: boolean
): Promise<void> {
  const list = [...ids];
  await getDynamoClient().send(new PutCommand({
    TableName: getTableName(),
    Item: {
      PK: `${SCRAPE_CYCLE_PK}#${cycleId}`,
      SK: `SHARD#${String(shardIndex).padStart(3, '0')}`,
      entityType: 'SCRAPE_CYCLE_SHARD',
      shardIndex,
      complete,
      idCount: list.length,
      idsGz: gzipSync(Buffer.from(list.join(','))),
      ttl: cycleTtl(),
    },
  }));
}

/** Cycles started within [since, until], newest first, with their shard records. */
export async function loadScrapeCyclesDynamoDB(since: Date, until: Date): Promise<ScrapeCycle[]> {
  const client = getDynamoClient();
  const tableName = getTableName();

  const cycles: ScrapeCycle[] = [];
  const response = await client.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND SK BETWEEN :since AND :until',
    ExpressionAttributeValues: {
      ':pk': SCRAPE_CYCLE_PK,
      ':since': since.toISOString(),
      ':until': until.toISOString(),
    },
    ScanIndexForward: false,
  }));

  for (const item of response.Items ?? []) {
    const cycleId = item.SK as string;
    const shards: ScrapeCycle['shards'] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const shardResponse = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `${SCRAPE_CYCLE_PK}#${cycleId}` },
        ExclusiveStartKey: lastEvaluatedKey,
      }));
      for (const shard of shardResponse.Items ?? []) {
        const raw = shard.idsGz ? gunzipSync(Buffer.from(shard.idsGz as Uint8Array)).toString() : '';
        shards.push({
          shardIndex: shard.shardIndex as number,
          complete: shard.complete === true,
          ids: raw ? raw.split(',') : [],
        });
      }
      lastEvaluatedKey = shardResponse.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    cycles.push({
      cycleId,
      startedAt: new Date(item.startedAt as string),
      shardCount: item.shardCount as number,
      totalExpected: item.totalExpected as number,
      shards,
    });
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Shop de-duplication across sources
// ---------------------------------------------------------------------------

/** Every shop row in the given precision-4 geohash cells (GeohashIndex holds only shops). */
export async function loadShopsByGeohash4DynamoDB(cells: string[]): Promise<ShopCandidate[]> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const shops: ShopCandidate[] = [];
  const CONCURRENCY = 16;

  const loadCell = async (cell: string) => {
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const response = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GeohashIndex',
        KeyConditionExpression: 'geohash4 = :gh',
        FilterExpression: 'entityType = :shop',
        ExpressionAttributeValues: { ':gh': cell, ':shop': 'SHOP' },
        ProjectionExpression: 'externalId, #name, latitude, longitude',
        ExpressionAttributeNames: { '#name': 'name' },
        ExclusiveStartKey: lastEvaluatedKey,
      }));
      for (const item of response.Items ?? []) {
        if (typeof item.externalId !== 'number' || typeof item.latitude !== 'number' || typeof item.longitude !== 'number') {
          continue;
        }
        shops.push({
          externalId: item.externalId,
          name: (item.name as string) ?? '',
          latitude: item.latitude,
          longitude: item.longitude,
        });
      }
      lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);
  };

  for (let i = 0; i < cells.length; i += CONCURRENCY) {
    await Promise.all(cells.slice(i, i + CONCURRENCY).map(loadCell));
  }
  return shops;
}

/** Point existing event rows at a different shop (and its name/location). */
export async function repointEventsToShopDynamoDB(
  events: { externalId: string; startDate: Date }[],
  shop: ShopCandidate
): Promise<number> {
  const client = getDynamoClient();
  const tableName = getTableName();
  let updated = 0;
  for (const event of events) {
    try {
      await client.send(new UpdateCommand({
        TableName: tableName,
        Key: eventKeys(event.externalId),
        UpdateExpression:
          'SET shopId = :id, shopExternalId = :id, shopName = :name, shopLatitude = :lat, shopLongitude = :lon, ' +
          '#location = :name, organizer = :name, GSI2PK = :gsi2pk, GSI2SK = :start, geohash3 = :gh3, updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#location': 'location' },
        ExpressionAttributeValues: {
          ':id': shop.externalId,
          ':name': shop.name,
          ':lat': shop.latitude,
          ':lon': shop.longitude,
          ':gsi2pk': `SHOP#${shop.externalId}`,
          ':start': event.startDate.toISOString(),
          ':gh3': geohash.encode(shop.latitude, shop.longitude, 3),
          ':now': new Date().toISOString(),
        },
      }));
      updated++;
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  return updated;
}

/** Delete shop rows by external id (batched, 25 per request). */
export async function deleteShopsDynamoDB(externalIds: number[]): Promise<number> {
  const client = getDynamoClient();
  const tableName = getTableName();
  let deleted = 0;
  for (let i = 0; i < externalIds.length; i += 25) {
    const batch = externalIds.slice(i, i + 25);
    await client.send(new BatchWriteCommand({
      RequestItems: {
        [tableName]: batch.map(id => ({ DeleteRequest: { Key: shopKeys(id) } })),
      },
    }));
    deleted += batch.length;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Tournament facts: rosters and results (sources/playriftboundResults.ts)
// ---------------------------------------------------------------------------

/**
 * One item per event per fact, not one per match or per standing.
 *
 * The access patterns decide this:
 *
 * - "the results for this event" is a single GetItem on `RESULTS#<externalId>`.
 *   Split per match it would be a Query plus client-side reassembly, and the
 *   standings would have to be stitched back together from their own rows.
 * - "every match in chronological order", which a rating pass replaying history
 *   needs, is one Query per day against GSI1's `RESULTS#<date>` partition. No
 *   scan, and each day comes back in whole events rather than thousands of
 *   fragments: a 16-player event's results normalise to ~10KB, so a busy day's
 *   ~350 events are ~350 items instead of ~8,000.
 * - A capture is written once and never edited (results are immutable once the
 *   organizer finalises them), so the usual argument for row-level items -
 *   updating one match without rewriting the event - never applies.
 *
 * The 400KB item limit is the one risk, which trimToItemLimit in the source
 * module handles by dropping the pairings from an outsized tournament.
 *
 * These items carry **no TTL**: event rows age out after 60-90 days, but the
 * facts are the input to a rating history and have to outlive them.
 */
const RESULTS_PREFIX = 'RESULTS#';
const ROSTER_PREFIX = 'ROSTER#';

function resultsKeys(externalId: string) {
  return { PK: `${RESULTS_PREFIX}${externalId}`, SK: `${RESULTS_PREFIX}${externalId}` };
}

function rosterKeys(externalId: string) {
  return { PK: `${ROSTER_PREFIX}${externalId}`, SK: `${ROSTER_PREFIX}${externalId}` };
}

/** Chronological index: one GSI1 partition per UTC day the events started on. */
function factGSI1Keys(prefix: string, eventStartDate: Date, externalId: string) {
  return {
    GSI1PK: `${prefix}${eventStartDate.toISOString().split('T')[0]}`,
    GSI1SK: `${prefix}${externalId}`,
  };
}

interface DynamoFactContext {
  externalId: string;
  tournamentId: string;
  eventStartDate: string;
  eventType: string | null;
  /** Riot's event format, copied off the event row (see EventFactContext). */
  playFormat: string | null;
  shopExternalId: number | null;
  latitude: number | null;
  longitude: number | null;
}

interface DynamoEventResultsItem extends DynamoFactContext {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entityType: 'EVENT_RESULTS';
  status: EventResultsStatus;
  roundCount: number;
  playerCount: number;
  openMatches: number;
  trimmed: boolean;
  sourceUpdatedAt: string | null;
  /** Fingerprint of the content, so a re-check can skip rewriting the row. */
  digest: string;
  players: ResultPlayer[];
  standings: ResultStanding[];
  rounds: ResultRound[];
  attempts: number;
  capturedAt: string;
  lastCheckedAt: string;
}

interface DynamoEventRosterItem extends DynamoFactContext {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entityType: 'EVENT_ROSTER';
  source: RosterSource;
  playerCount: number;
  entries: RosterEntry[];
  capturedAt: string;
}

function factContext(fact: EventFactContext): DynamoFactContext {
  return {
    externalId: fact.externalId,
    tournamentId: fact.tournamentId,
    eventStartDate: fact.eventStartDate.toISOString(),
    eventType: fact.eventType,
    playFormat: fact.playFormat ?? null,
    shopExternalId: fact.shopExternalId,
    latitude: fact.latitude,
    longitude: fact.longitude,
  };
}

/**
 * Stored events in the window that identify a Riot tournament, with the
 * bookkeeping for what has already been captured for each.
 *
 * Candidacy is `resultsCandidateTournamentId`, not a `prb-` prefix test. Selecting
 * on the prefix alone made every **merged** row structurally invisible to the
 * results pass: a matched cross-source pair keeps the UVS identity, so the
 * surviving row has a numeric externalId and no prefix to match, was never a
 * candidate, and therefore could never have results. Their tournament id
 * survives on `url`, which the merge policy hands to Riot.
 *
 * Measured against production on 2026-10-27 at lookback 45: 4,052 merged rows in
 * the window, **0** of them carrying any capture (which is the proof that none
 * was ever queued), 3,424 of them results-due and 173 roster-due. At the
 * measured 71% of finished events that hold real pairings that is roughly 2,400
 * additional events with standings.
 *
 * Note which id goes where, because they differ for a merged row: the fact keys
 * are built from the row's own `externalId` (so a merged event's capture lands
 * under its UVS id, which is the id the calendar and the backend's availability
 * BatchGet already ask about), while `tournamentId` is the Riot id the page
 * fetch needs.
 *
 * Only the *metadata* of the fact rows is read (BatchGetItem with a projection),
 * never their payloads - so deciding that 8,000 events need nothing costs a few
 * dozen RCUs rather than megabytes of transfer.
 */
export async function loadEventFactCandidatesDynamoDB(
  window: { daysBack: number; daysForward: number }
): Promise<EventFactCandidate[]> {
  const rows = await loadEventSummariesForDates(
    eventDatePartitions(-window.daysBack, window.daysForward)
  );
  const events: { row: StoredEventSummary; tournamentId: string }[] = [];
  for (const row of rows) {
    const tournamentId = resultsCandidateTournamentId(row);
    if (tournamentId !== null) events.push({ row, tournamentId });
  }
  if (events.length === 0) return [];

  const keys = events.flatMap(({ row }) => [resultsKeys(row.externalId), rosterKeys(row.externalId)]);
  const meta = await batchGetFactMeta(keys);

  return events.map(({ row, tournamentId }) => {
    const results = meta.get(`${RESULTS_PREFIX}${row.externalId}`);
    return {
      externalId: row.externalId,
      tournamentId,
      eventStartDate: row.startDate,
      eventType: row.eventType ?? null,
      playFormat: row.playFormat ?? null,
      shopExternalId: row.shopExternalId ?? null,
      latitude: row.latitude,
      longitude: row.longitude,
      results: results
        ? {
            status: (results.status as EventResultsStatus) ?? 'none',
            attempts: (results.attempts as number) ?? 0,
            lastCheckedAt: typeof results.lastCheckedAt === 'string' ? new Date(results.lastCheckedAt) : null,
          }
        : null,
      hasRoster: meta.has(`${ROSTER_PREFIX}${row.externalId}`),
    };
  });
}

/** Fact-row metadata by PK, 100 keys per request. */
async function batchGetFactMeta(
  keys: { PK: string; SK: string }[]
): Promise<Map<string, Record<string, unknown>>> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const found = new Map<string, Record<string, unknown>>();

  for (let i = 0; i < keys.length; i += 100) {
    let pending: Record<string, unknown>[] = keys.slice(i, i + 100);
    // DynamoDB may hand back UnprocessedKeys under load; retry them.
    for (let attempt = 0; pending.length > 0 && attempt < 4; attempt++) {
      const response = await client.send(new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: pending,
            // status is a DynamoDB reserved word
            ProjectionExpression: 'PK, #status, attempts, lastCheckedAt',
            ExpressionAttributeNames: { '#status': 'status' },
          },
        },
      }));
      for (const item of response.Responses?.[tableName] ?? []) {
        if (typeof item.PK === 'string') found.set(item.PK, item);
      }
      pending = response.UnprocessedKeys?.[tableName]?.Keys ?? [];
    }
  }

  return found;
}

/**
 * Store one event's results capture.
 *
 * A re-check that reads back the same content writes only the attempt counter
 * and the timestamp (UpdateItem), never the whole row - the same
 * skip-unchanged discipline as hasEventChanged above.
 */
export async function putEventResultsDynamoDB(
  results: EventResults,
  digest: string
): Promise<{ skipped: boolean }> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const keys = resultsKeys(results.externalId);
  const now = new Date().toISOString();

  const existing = await client.send(new GetCommand({
    TableName: tableName,
    Key: keys,
    ProjectionExpression: 'digest, attempts, capturedAt',
  }));
  const attempts = ((existing.Item?.attempts as number) ?? 0) + 1;

  if (existing.Item && existing.Item.digest === digest) {
    await client.send(new UpdateCommand({
      TableName: tableName,
      Key: keys,
      UpdateExpression: 'SET attempts = :a, lastCheckedAt = :now',
      ExpressionAttributeValues: { ':a': attempts, ':now': now },
    }));
    return { skipped: true };
  }

  const item: DynamoEventResultsItem = {
    ...keys,
    ...factGSI1Keys(RESULTS_PREFIX, results.eventStartDate, results.externalId),
    ...factContext(results),
    entityType: 'EVENT_RESULTS',
    status: results.status,
    roundCount: results.roundCount,
    playerCount: results.playerCount,
    openMatches: results.openMatches,
    trimmed: results.trimmed ?? false,
    sourceUpdatedAt: results.sourceUpdatedAt,
    digest,
    players: results.players,
    standings: results.standings,
    rounds: results.rounds,
    attempts,
    capturedAt: (existing.Item?.capturedAt as string) ?? results.capturedAt,
    lastCheckedAt: now,
  };

  await client.send(new PutCommand({ TableName: tableName, Item: item }));
  return { skipped: false };
}

/**
 * Store one event's roster, write-once.
 *
 * The condition is the point: a dated registrant list cannot be reconstructed
 * after the event, so a roster already on file is never replaced by the thinner
 * participants list a post-event fetch would produce.
 */
export async function putEventRosterDynamoDB(roster: EventRoster): Promise<{ skipped: boolean }> {
  const item: DynamoEventRosterItem = {
    ...rosterKeys(roster.externalId),
    ...factGSI1Keys(ROSTER_PREFIX, roster.eventStartDate, roster.externalId),
    ...factContext(roster),
    entityType: 'EVENT_ROSTER',
    source: roster.source,
    playerCount: roster.playerCount,
    entries: roster.entries,
    capturedAt: roster.capturedAt,
  };

  try {
    await getDynamoClient().send(new PutCommand({
      TableName: getTableName(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return { skipped: false };
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return { skipped: true };
    throw error;
  }
}

/** The results for one event, in a single GetItem. */
export async function getEventResultsDynamoDB(externalId: string): Promise<EventResults | null> {
  const response = await getDynamoClient().send(new GetCommand({
    TableName: getTableName(),
    Key: resultsKeys(externalId),
  }));
  return response.Item ? resultsFromItem(response.Item as DynamoEventResultsItem) : null;
}

/** Every fact for events that started on one UTC day: two GSI1 Queries, no scan. */
export async function loadEventFactsByDateDynamoDB(
  date: string
): Promise<{ results: EventResults[]; rosters: EventRoster[] }> {
  const [results, rosters] = await Promise.all([
    queryFactPartition(`${RESULTS_PREFIX}${date}`),
    queryFactPartition(`${ROSTER_PREFIX}${date}`),
  ]);
  return {
    results: results.map(item => resultsFromItem(item as unknown as DynamoEventResultsItem)),
    rosters: rosters.map(item => rosterFromItem(item as unknown as DynamoEventRosterItem)),
  };
}

async function queryFactPartition(partition: string): Promise<Record<string, unknown>[]> {
  const client = getDynamoClient();
  const items: Record<string, unknown>[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const response = await client.send(new QueryCommand({
      TableName: getTableName(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': partition },
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    items.push(...((response.Items ?? []) as Record<string, unknown>[]));
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);
  return items;
}

function resultsFromItem(item: DynamoEventResultsItem): EventResults {
  return {
    externalId: item.externalId,
    tournamentId: item.tournamentId,
    eventStartDate: new Date(item.eventStartDate),
    eventType: item.eventType ?? null,
    playFormat: item.playFormat ?? null,
    shopExternalId: item.shopExternalId ?? null,
    latitude: item.latitude ?? null,
    longitude: item.longitude ?? null,
    status: item.status,
    roundCount: item.roundCount ?? 0,
    playerCount: item.playerCount ?? 0,
    openMatches: item.openMatches ?? 0,
    players: item.players ?? [],
    standings: item.standings ?? [],
    rounds: item.rounds ?? [],
    sourceUpdatedAt: item.sourceUpdatedAt ?? null,
    capturedAt: item.capturedAt,
    trimmed: item.trimmed ?? false,
  };
}

function rosterFromItem(item: DynamoEventRosterItem): EventRoster {
  return {
    externalId: item.externalId,
    tournamentId: item.tournamentId,
    eventStartDate: new Date(item.eventStartDate),
    eventType: item.eventType ?? null,
    playFormat: item.playFormat ?? null,
    shopExternalId: item.shopExternalId ?? null,
    latitude: item.latitude ?? null,
    longitude: item.longitude ?? null,
    source: item.source,
    playerCount: item.playerCount ?? 0,
    entries: item.entries ?? [],
    capturedAt: item.capturedAt,
  };
}

// ---------------------------------------------------------------------------
// Derived player ratings (ranking/)
// ---------------------------------------------------------------------------

/**
 * The rating pass's output, as items a reader can fetch without a scan.
 *
 * Key shapes (the output contract - see ranking/items.ts):
 *
 * | item | PK | SK |
 * |---|---|---|
 * | player profile | `PLAYER#<uuid>` | `PROFILE` |
 * | rating history point | `PLAYER#<uuid>` | `RATING#<scope>#<YYYY-MM-DD>` |
 * | match log entry | `PLAYER#<uuid>` | `MATCH#<iso>#<matchId>` |
 * | leaderboard row | `RANKING#<scope>` | `RANK#<rank, 6 digits>#<playerId>` |
 * | leaderboard header | `RANKING_META#<scope>` | `PROFILE` |
 * | component profile | `COMPONENT#<id>` | `PROFILE` |
 * | set profile | `SET#<id>` | `PROFILE` |
 * | scope directory | `RANKING_INDEX` | `RANKING_INDEX` |
 * | match-log marker | `RANKING_LOG#<eventId>` | `RANKING_LOG#<eventId>` |
 * | display-name index | `PLAYER_SEARCH` | `SHARD#<nnn>` |
 *
 * Everything a reader needs is one Query on a single partition: a player page
 * is `PLAYER#<uuid>` (profile, chart and match log arrive together, and the SK
 * prefixes separate them), and a leaderboard is `RANKING#<scope>` read
 * SK-ascending, which comes back in rank order because the rank is zero-padded
 * into the sort key. The board's header is deliberately in its *own* partition
 * rather than a `META` row inside the board, so a reader Querying a board never
 * has to filter a non-player item out of its results.
 *
 * Name search is the one access pattern with no key to arrive on, and the
 * `PLAYER_SEARCH` shards are the answer: the whole display-name corpus,
 * gzipped, in one base-table partition, so finding a player by name is one
 * Query rather than the capped Scan the API used to serve - which examined
 * 2,000 raw items of a 441,555-item table and therefore saw 0.43% of players.
 * See `ranking/searchIndex.ts`.
 *
 * No GSI entries are added, the search shards included. These items would
 * otherwise multiply GSI1's size for no read that needs it, and the shards
 * already share a partition of their own, so an index entry would duplicate
 * the payload to answer a Query that is already one Query.
 *
 * Write volume is the real cost here. A refit rewrites every profile and every
 * rating point because WHR revises the whole past curve, and a rank change
 * moves a leaderboard row's sort key, so the pass is on a multi-hour cadence
 * rather than every cycle, rating history is emitted only for players who clear
 * the publishing bar, and the per-player match log - the one deliberately
 * duplicated item, two per match - is written once per event and then guarded by
 * a marker so a refit does not re-emit it.
 */
const RANKING_LOG_PREFIX = 'RANKING_LOG#';
const RANKING_PREFIX = 'RANKING#';
const RANKING_META_PREFIX = 'RANKING_META#';
const RANK_SK_PREFIX = 'RANK#';
const RANKING_INDEX_KEY = 'RANKING_INDEX';
const RANKING_STATE_KEY = 'CONFIG#RANKING_REFIT';

function playerKeys(playerId: string) {
  return { PK: `PLAYER#${playerId}`, SK: 'PROFILE' };
}

function ratingPointKeys(playerId: string, scope: string, date: string) {
  return { PK: `PLAYER#${playerId}`, SK: `RATING#${scope}#${date}` };
}

function matchLogKeys(playerId: string, playedAt: string, matchId: string) {
  return { PK: `PLAYER#${playerId}`, SK: `MATCH#${playedAt}#${matchId}` };
}

/** Rank is zero-padded to 6 digits so an SK-ascending Query is rank order. */
function rankingRowKeys(scope: string, rank: number, playerId: string) {
  return {
    PK: `${RANKING_PREFIX}${scope}`,
    SK: `${RANK_SK_PREFIX}${String(rank).padStart(6, '0')}#${playerId}`,
  };
}

function rankingMetaKeys(scope: string) {
  return { PK: `${RANKING_META_PREFIX}${scope}`, SK: 'PROFILE' };
}

function componentKeys(componentId: string) {
  return { PK: `COMPONENT#${componentId}`, SK: 'PROFILE' };
}

function setKeys(setId: string) {
  return { PK: `SET#${setId}`, SK: 'PROFILE' };
}

function venueKeys(shopExternalId: number) {
  return { PK: `VENUE#${shopExternalId}`, SK: 'PROFILE' };
}

function sceneKeys(sceneId: string) {
  return { PK: `SCENE#${sceneId}`, SK: 'PROFILE' };
}

/**
 * The display-name index's shards.
 *
 * One partition, `SHARD#<nnn>` zero-padded so an SK-ascending Query returns
 * them in order, exactly like `SCRAPE_CYCLE`'s shards and for the same reason.
 * The whole index is therefore **one Query** on one partition - no GSI, no
 * scan, and no new infrastructure. See `ranking/searchIndex.ts` for the format
 * and for why the index exists at all.
 */
const PLAYER_SEARCH_PK = 'PLAYER_SEARCH';

function playerSearchShardKeys(shardIndex: number) {
  return { PK: PLAYER_SEARCH_PK, SK: `SHARD#${String(shardIndex).padStart(3, '0')}` };
}

/** GSI1 partitions the catalogue items are enumerable in. */
export const SET_CATALOGUE_PARTITION = 'SET';
export const COMPONENT_CATALOGUE_PARTITION = 'COMPONENT';
export const VENUE_CATALOGUE_PARTITION = 'VENUE';
export const SCENE_CATALOGUE_PARTITION = 'SCENE';

/** The single row holding the persisted venue -> scene assignment. */
const SCENE_ASSIGNMENT_KEY = 'SCENE_ASSIGNMENT';

/**
 * Enumeration index for the catalogue items (`SET#<id>`, `COMPONENT#<id>`).
 *
 * Without these keys those items can only be fetched by an id the reader
 * already has, which is not a list: `/api/sets` could not enumerate the set
 * catalogue and fell back to inferring set ids from player profiles (serving
 * them with no name, and missing any set nobody is rated in yet).
 *
 * One shared partition per catalogue is the right shape here - there are a
 * handful of sets, ever, and components are counted in dozens - so the whole
 * catalogue is a single Query against GSI1, which already exists and projects
 * ALL. No scan, no new index.
 *
 * Deliberately *not* folded into componentKeys/setKeys: those same objects are
 * handed to BatchWriteItem as delete keys, where a key may carry nothing but
 * PK and SK.
 */
function catalogueGSI1Keys(partition: string, id: string) {
  return { GSI1PK: partition, GSI1SK: `${partition}#${id}` };
}

function matchLogMarkerKeys(eventExternalId: string) {
  return {
    PK: `${RANKING_LOG_PREFIX}${eventExternalId}`,
    SK: `${RANKING_LOG_PREFIX}${eventExternalId}`,
  };
}

/** Write items in parallel BatchWrite batches, retrying what DynamoDB defers. */
async function batchPut(items: Record<string, unknown>[], concurrency = 6): Promise<number> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const batches: Record<string, unknown>[][] = [];
  for (let i = 0; i < items.length; i += 25) batches.push(items.slice(i, i + 25));

  let written = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      let pending = batch.map(Item => ({ PutRequest: { Item } }));
      for (let attempt = 0; pending.length > 0 && attempt < 6; attempt++) {
        if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
        const response = await client.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
        const unprocessed = (response.UnprocessedItems?.[tableName] ?? []) as typeof pending;
        written += pending.length - unprocessed.length;
        pending = unprocessed;
      }
    }
  });
  await Promise.all(workers);
  return written;
}

async function batchDelete(keys: { PK: string; SK: string }[], concurrency = 6): Promise<number> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const batches: { PK: string; SK: string }[][] = [];
  for (let i = 0; i < keys.length; i += 25) batches.push(keys.slice(i, i + 25));

  let deleted = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      let pending = batch.map(Key => ({ DeleteRequest: { Key } }));
      for (let attempt = 0; pending.length > 0 && attempt < 6; attempt++) {
        if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
        const response = await client.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
        const unprocessed = (response.UnprocessedItems?.[tableName] ?? []) as typeof pending;
        deleted += pending.length - unprocessed.length;
        pending = unprocessed;
      }
    }
  });
  await Promise.all(workers);
  return deleted;
}

/**
 * Which of these events already have their match log written at the current
 * version.
 *
 * One BatchGet per 100 events, projection-limited to the version - so deciding
 * that 20,000 events need nothing costs a few hundred RCUs rather than
 * re-emitting over a million log items.
 */
export async function loadMatchLogMarkersDynamoDB(
  eventExternalIds: string[],
  version: number
): Promise<Set<string>> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const done = new Set<string>();
  const keys = eventExternalIds.map(matchLogMarkerKeys);

  for (let i = 0; i < keys.length; i += 100) {
    let pending: Record<string, unknown>[] = keys.slice(i, i + 100);
    for (let attempt = 0; pending.length > 0 && attempt < 4; attempt++) {
      const response = await client.send(new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: pending,
            ProjectionExpression: 'PK, #v',
            ExpressionAttributeNames: { '#v': 'version' },
          },
        },
      }));
      for (const item of response.Responses?.[tableName] ?? []) {
        if (typeof item.PK !== 'string') continue;
        if ((item.version as number) === version) {
          done.add(item.PK.slice(RANKING_LOG_PREFIX.length));
        }
      }
      pending = response.UnprocessedKeys?.[tableName]?.Keys ?? [];
    }
  }
  return done;
}

/** Human-readable labels for shop venues, for a player's region. */
export async function loadShopLabelsDynamoDB(externalIds: number[]): Promise<Map<number, string>> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const labels = new Map<number, string>();
  const keys = externalIds.map(shopKeys);

  for (let i = 0; i < keys.length; i += 100) {
    let pending: Record<string, unknown>[] = keys.slice(i, i + 100);
    for (let attempt = 0; pending.length > 0 && attempt < 4; attempt++) {
      const response = await client.send(new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: pending,
            ProjectionExpression: 'externalId, displayCity, locationText',
          },
        },
      }));
      for (const item of response.Responses?.[tableName] ?? []) {
        const externalId = item.externalId as number | undefined;
        if (typeof externalId !== 'number') continue;
        // displayCity is the reverse-geocoded "City, ST" the frontend already
        // shows; locationText is the raw address and only a fallback.
        const label = (item.displayCity as string | null) ?? (item.locationText as string | null);
        if (label) labels.set(externalId, label);
      }
      pending = response.UnprocessedKeys?.[tableName]?.Keys ?? [];
    }
  }
  return labels;
}

/** What the previous refit published, so this one can prune what it replaces. */
export interface RankingScopeIndex {
  scopes: string[];
  componentIds: string[];
  setIds: string[];
  /** Shop ids with a `VENUE#` item. Numbers, because that is the key. */
  venueIds: number[];
  sceneIds: string[];
  /**
   * How many `PLAYER_SEARCH` shards the previous refit wrote.
   *
   * A count rather than a list because the shard keys are `SHARD#000` upward
   * with no gaps, so the count *is* the key set - and because this is the one
   * entry here that has to be right for a **correctness** reason rather than a
   * tidiness one. A corpus that shrinks leaves high-numbered shards behind,
   * and a leftover shard is not a dangling pin a reader can shrug off: it is a
   * block of names the index would keep serving after their profiles were
   * pruned.
   */
  searchShards: number;
}

export async function loadRankingScopeIndexDynamoDB(): Promise<RankingScopeIndex> {
  const response = await getDynamoClient().send(new GetCommand({
    TableName: getTableName(),
    Key: { PK: RANKING_INDEX_KEY, SK: RANKING_INDEX_KEY },
  }));
  const item = response.Item ?? {};
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  const numbers = (value: unknown): number[] =>
    Array.isArray(value) ? value.map(Number).filter(entry => Number.isFinite(entry)) : [];
  return {
    scopes: list(item.scopes),
    componentIds: list(item.componentIds),
    setIds: list(item.setIds),
    venueIds: numbers(item.venueIds),
    sceneIds: list(item.sceneIds),
    // Absent on an index written before the search shards shipped, which reads
    // as "no shards to prune" - correct, because there were none.
    searchShards: Number.isFinite(Number(item.searchShards)) ? Number(item.searchShards) : 0,
  };
}

/** Every stored leaderboard row key for one scope (keys only, so it stays cheap). */
async function loadRankingRowKeys(scope: string): Promise<{ PK: string; SK: string }[]> {
  const client = getDynamoClient();
  const keys: { PK: string; SK: string }[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const response = await client.send(new QueryCommand({
      TableName: getTableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `${RANKING_PREFIX}${scope}`, ':sk': RANK_SK_PREFIX },
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    for (const item of response.Items ?? []) {
      if (typeof item.PK === 'string' && typeof item.SK === 'string') keys.push({ PK: item.PK, SK: item.SK });
    }
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);
  return keys;
}

export interface RankingWriteSummary {
  profiles: number;
  historyPoints: number;
  matchLogEntries: number;
  rankingRows: number;
  metas: number;
  components: number;
  sets: number;
  venues: number;
  scenes: number;
  markers: number;
  /** `PLAYER_SEARCH` shards written. See `ranking/searchIndex.ts`. */
  searchShards: number;
  /** Players in the display-name index, across every shard. */
  searchEntries: number;
  deletedRows: number;
  deletedScopes: number;
}

/**
 * Store one refit.
 *
 * Idempotent by construction: every key is a deterministic function of the
 * snapshot's content, so re-running the pass over the same facts overwrites the
 * same items with the same values.
 *
 * The destructive part is pruning, and it has to happen because a rank lives in
 * the sort key: a player who moves from rank 7 to rank 5 writes a *new* item and
 * the old one would otherwise linger as a duplicate. So each scope's existing
 * `RANK#` keys are read (keys only) and whatever this snapshot did not write is
 * deleted - along with any whole scope, component or set the previous refit
 * published and this one did not, tracked in the scope directory.
 */
export async function saveRankingSnapshotDynamoDB(
  snapshot: RankingSnapshot,
  matchLogVersion: number
): Promise<RankingWriteSummary> {
  const now = new Date().toISOString();

  const profileItems = snapshot.profiles.map(profile => ({
    ...playerKeys(profile.playerId),
    entityType: 'PLAYER_PROFILE' as const,
    ...profile,
  }));
  const historyItems = snapshot.history.map(point => ({
    ...ratingPointKeys(point.playerId, point.scope, point.date),
    entityType: 'PLAYER_RATING' as const,
    ...point,
  }));
  const matchItems = snapshot.matchLog.map(entry => ({
    ...matchLogKeys(entry.playerId, entry.playedAt, entry.matchId),
    entityType: 'PLAYER_MATCH' as const,
    ...entry,
  }));
  const rankingItems = snapshot.rankings.map(row => ({
    ...rankingRowKeys(row.scope, row.rank, row.playerId),
    entityType: 'RANKING_ROW' as const,
    ...row,
  }));
  const metaItems = snapshot.metas.map(meta => ({
    ...rankingMetaKeys(meta.scope),
    entityType: 'RANKING_META' as const,
    ...meta,
  }));
  const componentItems = snapshot.components.map(component => ({
    ...componentKeys(component.componentId),
    ...catalogueGSI1Keys(COMPONENT_CATALOGUE_PARTITION, component.componentId),
    entityType: 'COMPONENT_PROFILE' as const,
    ...component,
  }));
  const setItems = snapshot.sets.map(set => ({
    ...setKeys(set.setId),
    ...catalogueGSI1Keys(SET_CATALOGUE_PARTITION, set.setId),
    entityType: 'SET_PROFILE' as const,
    ...set,
  }));
  // Venues and scenes are enumerable for the same reason sets and components
  // are: a map's first render is "every venue with a pin", which has to be one
  // Query and not a Scan. The id is the shop id, never venueKey's `geo:`
  // fallback - that one moves if the geocode moves.
  const venueItems = snapshot.venues.map(venue => ({
    ...venueKeys(venue.shopExternalId),
    ...catalogueGSI1Keys(VENUE_CATALOGUE_PARTITION, String(venue.shopExternalId)),
    entityType: 'VENUE_PROFILE' as const,
    ...venue,
  }));
  const sceneItems = snapshot.scenes.map(scene => ({
    ...sceneKeys(scene.sceneId),
    ...catalogueGSI1Keys(SCENE_CATALOGUE_PARTITION, scene.sceneId),
    entityType: 'SCENE_PROFILE' as const,
    ...scene,
  }));

  // The display-name index. Built from the same profiles this refit is about to
  // write, so it can never disagree with them about who exists, and gzipped the
  // way the `SCRAPE_CYCLE` shards are. Deliberately **not** given GSI1 keys:
  // the shards live in their own base-table partition, so listing them is
  // already one Query and an index entry would only duplicate the payload.
  const searchIndex = buildPlayerSearchIndex(snapshot.profiles);
  const searchIndexItems = searchIndex.shards.map(shard => ({
    ...playerSearchShardKeys(shard.shardIndex),
    entityType: 'PLAYER_SEARCH_SHARD' as const,
    format: searchIndex.format,
    shardIndex: shard.shardIndex,
    shardCount: searchIndex.shards.length,
    entries: shard.entries,
    entriesGz: gzipSync(Buffer.from(shard.body, 'utf8')),
    generatedAt: now,
  }));

  // Prune before writing markers, so a crash mid-run leaves the log un-marked
  // (and therefore retried) rather than marked but unwritten.
  const previous = await loadRankingScopeIndexDynamoDB();
  const currentScopes = new Set(snapshot.metas.map(meta => meta.scope));
  const written = new Set(rankingItems.map(item => `${item.PK}|${item.SK}`));
  const staleKeys: { PK: string; SK: string }[] = [];
  let deletedScopes = 0;

  for (const scope of new Set([...previous.scopes, ...currentScopes])) {
    for (const key of await loadRankingRowKeys(scope)) {
      if (!written.has(`${key.PK}|${key.SK}`)) staleKeys.push(key);
    }
    if (!currentScopes.has(scope)) {
      deletedScopes++;
      staleKeys.push(rankingMetaKeys(scope));
    }
  }

  const currentComponents = new Set(snapshot.components.map(component => component.componentId));
  for (const componentId of previous.componentIds) {
    if (!currentComponents.has(componentId)) staleKeys.push(componentKeys(componentId));
  }
  const currentSets = new Set(snapshot.sets.map(set => set.setId));
  for (const setId of previous.setIds) {
    if (!currentSets.has(setId)) staleKeys.push(setKeys(setId));
  }
  // A venue only disappears when its last match ages out of the replay window,
  // and a scene only when a re-clustering retires it - but both have to be
  // pruned or the catalogue Query would keep serving a pin with no data behind
  // it.
  const currentVenues = new Set(snapshot.venues.map(venue => venue.shopExternalId));
  for (const shopExternalId of previous.venueIds) {
    if (!currentVenues.has(shopExternalId)) staleKeys.push(venueKeys(shopExternalId));
  }
  const currentScenes = new Set(snapshot.scenes.map(scene => scene.sceneId));
  for (const sceneId of previous.sceneIds) {
    if (!currentScenes.has(sceneId)) staleKeys.push(sceneKeys(sceneId));
  }
  // A shrinking corpus leaves high-numbered search shards behind, and those are
  // not harmless: the reader concatenates every shard it finds, so a leftover
  // would keep serving names whose profiles this refit decided not to write.
  for (let index = searchIndexItems.length; index < previous.searchShards; index++) {
    staleKeys.push(playerSearchShardKeys(index));
  }

  const deletedRows = staleKeys.length > 0 ? await batchDelete(staleKeys) : 0;

  await batchPut([
    ...profileItems,
    ...historyItems,
    ...matchItems,
    ...rankingItems,
    ...metaItems,
    ...componentItems,
    ...setItems,
    ...venueItems,
    ...sceneItems,
    ...searchIndexItems,
  ]);

  const markerItems = snapshot.matchLogEvents.map(eventExternalId => ({
    ...matchLogMarkerKeys(eventExternalId),
    entityType: 'RANKING_LOG' as const,
    eventExternalId,
    version: matchLogVersion,
    writtenAt: now,
  }));
  if (markerItems.length > 0) await batchPut(markerItems);

  await getDynamoClient().send(new PutCommand({
    TableName: getTableName(),
    Item: {
      PK: RANKING_INDEX_KEY,
      SK: RANKING_INDEX_KEY,
      entityType: 'RANKING_INDEX',
      scopes: [...currentScopes],
      componentIds: [...currentComponents],
      setIds: [...currentSets],
      venueIds: [...currentVenues],
      sceneIds: [...currentScenes],
      searchShards: searchIndexItems.length,
      generatedAt: now,
    },
  }));

  return {
    profiles: profileItems.length,
    historyPoints: historyItems.length,
    matchLogEntries: matchItems.length,
    rankingRows: rankingItems.length,
    metas: metaItems.length,
    components: componentItems.length,
    sets: setItems.length,
    venues: venueItems.length,
    scenes: sceneItems.length,
    markers: markerItems.length,
    searchShards: searchIndexItems.length,
    searchEntries: searchIndex.entries,
    deletedRows,
    deletedScopes,
  };
}

/**
 * The persisted venue -> scene assignment.
 *
 * One row, read in full at the start of every refit and written only when an
 * operator re-clusters, so a single item is the right shape and a Query would
 * be ceremony. Stored **gzipped** for the same reason `SCRAPE_CYCLE` is: the
 * payload is a list that scales with the number of stores, and the uncompressed
 * JSON for a national assignment (plus one level of rollback history) would run
 * at DynamoDB's 400KB item limit. Gzip buys roughly an order of magnitude on
 * this kind of repetitive JSON.
 */
export async function loadSceneAssignmentDynamoDB(): Promise<SceneAssignment | null> {
  const response = await getDynamoClient().send(new GetCommand({
    TableName: getTableName(),
    Key: { PK: SCENE_ASSIGNMENT_KEY, SK: SCENE_ASSIGNMENT_KEY },
  }));
  const raw = response.Item?.assignmentGz;
  if (!raw) return null;
  try {
    return JSON.parse(gunzipSync(Buffer.from(raw as Uint8Array)).toString()) as SceneAssignment;
  } catch (error) {
    // A corrupt assignment must not take the ladder down: the refit simply
    // publishes null scenes until an operator re-clusters.
    console.error(
      `[scenes] stored assignment unreadable (${error instanceof Error ? error.message : error}); ` +
        'treating scenes as unassigned'
    );
    return null;
  }
}

export async function saveSceneAssignmentDynamoDB(assignment: SceneAssignment): Promise<void> {
  const payload = Buffer.from(JSON.stringify(assignment));
  await getDynamoClient().send(new PutCommand({
    TableName: getTableName(),
    Item: {
      PK: SCENE_ASSIGNMENT_KEY,
      SK: SCENE_ASSIGNMENT_KEY,
      entityType: 'SCENE_ASSIGNMENT',
      version: assignment.version,
      generatedAt: assignment.generatedAt,
      resolution: assignment.resolution,
      venueCount: assignment.venues.length,
      sceneCount: assignment.scenes.length,
      assignmentGz: gzipSync(payload),
    },
  }));
}

/** When the rating pass last completed, for the refit-interval gate. */
export async function getLastRankingRefitDynamoDB(): Promise<string | null> {
  const response = await getDynamoClient().send(new GetCommand({
    TableName: getTableName(),
    Key: { PK: RANKING_STATE_KEY, SK: RANKING_STATE_KEY },
  }));
  return (response.Item?.completedAt as string) ?? null;
}

export async function setLastRankingRefitDynamoDB(timestamp: string): Promise<void> {
  await getDynamoClient().send(new PutCommand({
    TableName: getTableName(),
    Item: {
      PK: RANKING_STATE_KEY,
      SK: RANKING_STATE_KEY,
      entityType: 'CONFIG',
      completedAt: timestamp,
    },
  }));
}

/** One player's stored profile. Used by tests and the metrics CLI. */
export async function getPlayerProfileDynamoDB(playerId: string): Promise<PlayerProfile | null> {
  const response = await getDynamoClient().send(new GetCommand({
    TableName: getTableName(),
    Key: playerKeys(playerId),
  }));
  return response.Item ? (response.Item as unknown as PlayerProfile) : null;
}

/** One leaderboard, in rank order: a single SK-ascending Query. */
export async function getRankingRowsDynamoDB(scope: string, limit = 100): Promise<RankingRow[]> {
  const response = await getDynamoClient().send(new QueryCommand({
    TableName: getTableName(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `${RANKING_PREFIX}${scope}`, ':sk': RANK_SK_PREFIX },
    Limit: limit,
  }));
  return (response.Items ?? []) as unknown as RankingRow[];
}
