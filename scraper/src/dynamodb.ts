import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import geohash from 'ngeohash';
import { env } from './config.js';
import type { ScrapedEvent, StoreInfo, UpsertEventResult, UpsertShopResult } from './database.js';

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
  geohash4?: string;
  geocodeStatus: string;
  geocodeError: string | null;
  createdAt: string;
  updatedAt: string;
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

  // Calculate geohash4 for spatial indexing
  const geohash4 = store.latitude && store.longitude
    ? geohash.encode(store.latitude, store.longitude, 4)
    : undefined;

  const item: DynamoShopItem = {
    ...keys,
    entityType: 'SHOP',
    externalId: store.id,
    name: store.name,
    locationText: store.full_address,
    displayCity: existing.Item ? (existing.Item as DynamoShopItem).displayCity : null,
    latitude: store.latitude,
    longitude: store.longitude,
    geohash4,
    geocodeStatus: 'completed',
    geocodeError: null,
    createdAt: existing.Item ? (existing.Item as DynamoShopItem).createdAt : now,
    updatedAt: now,
  };

  await client.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));

  return {
    shopId: store.id, // Using external_id as the ID in DynamoDB
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
  storeInfo: StoreInfo | null
): Promise<UpsertEventResult> {
  const client = getDynamoClient();
  const tableName = getTableName();

  // First, upsert the shop if provided
  let shopResult: UpsertShopResult | undefined;
  if (storeInfo) {
    shopResult = await upsertShopFromApiDynamoDB(storeInfo);
  }

  // Check if event exists
  const eventKeysVal = eventKeys(event.externalId);
  const existing = await client.send(new GetCommand({
    TableName: tableName,
    Key: eventKeysVal,
  }));

  const isNew = !existing.Item;
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

  const item: DynamoEventItem = {
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
    shopId: storeInfo?.id ?? null,
    shopExternalId: storeInfo?.id ?? null,
    shopName: storeInfo?.name ?? null,
    shopLatitude: storeInfo?.latitude ?? null,
    shopLongitude: storeInfo?.longitude ?? null,
    createdAt: existing.Item ? (existing.Item as DynamoEventItem).createdAt : now,
    updatedAt: now,
    scrapedAt: now,
    ttl,
  };

  await client.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));

  return {
    created: isNew,
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
