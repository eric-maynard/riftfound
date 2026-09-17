import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import geohash from 'ngeohash';
import { gzipSync, gunzipSync } from 'node:zlib';
import { env } from './config.js';
import type { ScrapeCycle } from './cancellations.js';
import type { ShopCandidate } from './shopMatch.js';
import type { ScrapedEvent, StoreInfo, UpsertEventResult, UpsertShopResult } from './database.js';
import { preserveMergedFields, type MergeOwnedFields } from './merge.js';

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
interface DynamoEventItem {
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

function hasEventChanged(existing: DynamoEventItem, newItem: DynamoEventItem): boolean {
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
  const client = getDynamoClient();
  const tableName = getTableName();

  const dates: string[] = [];
  const day = new Date();
  day.setUTCDate(day.getUTCDate() - 1);
  for (let i = 0; i <= daysForward + 2; i++) {
    dates.push(day.toISOString().split('T')[0]);
    day.setUTCDate(day.getUTCDate() + 1);
  }

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
