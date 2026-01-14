import {
  getDynamoClient,
  getTableName,
  eventKeys,
  eventGSI1Keys,
  eventGSI2Keys,
  shopKeys,
  geocacheKeys,
  geocacheGSI3Keys,
  scrapeRunKeys,
  EntityPrefix,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
  ScanCommand,
} from '../config/dynamodb.js';
import type { Event, EventQuery } from '../models/event.js';
import geohash from 'ngeohash';

// DynamoDB Event item structure
export interface DynamoEventItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK?: string; // SHOP#<shopExternalId>
  GSI2SK?: string; // startDate ISO string
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
  startDate: string; // ISO string
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
  // Denormalized shop data
  shopExternalId: number | null;
  shopName: string | null;
  shopLatitude: number | null;
  shopLongitude: number | null;
  // Timestamps
  createdAt: string;
  updatedAt: string;
  scrapedAt: string;
  // TTL for automatic cleanup (optional)
  ttl?: number;
}

// DynamoDB Shop item structure
export interface DynamoShopItem {
  PK: string;
  SK: string;
  entityType: 'SHOP';
  externalId: number;
  name: string;
  locationText: string | null;
  displayCity: string | null;
  latitude: number | null;
  longitude: number | null;
  geohash4?: string; // 4-character geohash for spatial indexing
  geocodeStatus: string;
  geocodeError: string | null;
  createdAt: string;
  updatedAt: string;
}

// DynamoDB Geocache item structure
export interface DynamoGeocacheItem {
  PK: string;
  SK: string;
  GSI3PK: string; // 'GEOCACHE_LRU' - constant for all geocache items
  GSI3SK: string; // lastAccessedAt ISO timestamp for LRU sorting
  entityType: 'GEOCACHE';
  query: string;
  latitude: number;
  longitude: number;
  displayName: string | null;
  lastAccessedAt: string;
  createdAt: string;
}

// Maximum geocache entries before LRU eviction
const GEOCACHE_MAX_ENTRIES = 10000;
const GEOCACHE_EVICTION_BATCH = 100; // Delete oldest 100 when limit exceeded

// DynamoDB ScrapeRun item structure
export interface DynamoScrapeRunItem {
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

// Helper functions
function getCalendarDateRange(): { startDate: string; endDate: string } {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - 3);
  const endDate = new Date(now);
  endDate.setMonth(endDate.getMonth() + 3);
  return {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
  };
}

// Haversine formula to calculate distance between two points in km
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

// Calculate bounding box for a given center point and radius
function getBoundingBox(lat: number, lng: number, radiusKm: number): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} {
  // 1 degree of latitude is ~111km
  const latDelta = radiusKm / 111;
  // 1 degree of longitude varies by latitude: ~111km * cos(lat)
  const lngDelta = radiusKm / (111 * Math.cos(toRad(lat)));

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

// Map DynamoDB item to Event
function mapDynamoItemToEvent(item: DynamoEventItem): Event {
  return {
    id: item.externalId, // Using externalId as id for DynamoDB
    externalId: item.externalId,
    name: item.name,
    description: item.description,
    location: item.location,
    address: item.address,
    city: item.city,
    state: item.state,
    country: item.country,
    latitude: item.latitude,
    longitude: item.longitude,
    startDate: new Date(item.startDate),
    startTime: item.startTime,
    endDate: item.endDate ? new Date(item.endDate) : null,
    eventType: item.eventType,
    organizer: item.organizer,
    playerCount: item.playerCount,
    capacity: item.capacity,
    price: item.price,
    url: item.url,
    imageUrl: item.imageUrl,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
    scrapedAt: new Date(item.scrapedAt),
    shopLatitude: item.shopLatitude,
    shopLongitude: item.shopLongitude,
  };
}

// Maximum number of geohash queries before falling back to date-based query
const MAX_GEOHASH_QUERIES = 50;

// Geohash precision thresholds (approximate cell sizes):
// Precision 3: ~156km x 156km cells - use for radius > 40km
// Precision 4: ~39km x 20km cells - use for radius <= 40km
const GEOHASH_PRECISION_THRESHOLD_KM = 40;

// Choose optimal geohash precision based on search radius
function chooseGeohashPrecision(radiusKm: number): { precision: number; indexName: string; keyName: string } {
  if (radiusKm > GEOHASH_PRECISION_THRESHOLD_KM) {
    return { precision: 3, indexName: 'GeohashIndex3', keyName: 'geohash3' };
  }
  return { precision: 4, indexName: 'GeohashIndex', keyName: 'geohash4' };
}

// Get all geohash cells that cover a bounding box around a point
// Returns null if too many cells (caller should use fallback)
function getGeohashesForRadius(lat: number, lng: number, radiusKm: number, precision: number): string[] | null {
  // Calculate bounding box
  const latDelta = radiusKm / 111; // 1 degree latitude ≈ 111km
  const lngDelta = radiusKm / (111 * Math.cos(lat * Math.PI / 180));

  const minLat = lat - latDelta;
  const maxLat = lat + latDelta;
  const minLng = lng - lngDelta;
  const maxLng = lng + lngDelta;

  // Get all geohashes that cover this bounding box
  // ngeohash.bboxes returns all geohashes of given precision within the bbox
  const hashes = geohash.bboxes(minLat, minLng, maxLat, maxLng, precision);

  // Filter out any undefined/empty values and dedupe
  const uniqueHashes = [...new Set(hashes.filter((h: string) => !!h && h.length > 0))];

  // If too many cells, return null to signal fallback to date-based query
  if (uniqueHashes.length > MAX_GEOHASH_QUERIES) {
    console.log(`Geohash query would require ${uniqueHashes.length} cells, using date-based fallback`);
    return null;
  }

  return uniqueHashes;
}

// Query shops by geohash using the appropriate GeohashIndex
// Returns null if index doesn't exist (fallback to date-based query)
async function getShopsByGeohash(
  geohashes: string[],
  indexName: string,
  keyName: string
): Promise<DynamoShopItem[] | null> {
  if (!geohashes.length) {
    return [];
  }

  const client = getDynamoClient();
  const tableName = getTableName();
  const shops: DynamoShopItem[] = [];

  // Query function for a single geohash
  const queryGeohash = async (gh: string): Promise<DynamoShopItem[]> => {
    let lastEvaluatedKey: Record<string, any> | undefined;
    const results: DynamoShopItem[] = [];

    do {
      const response = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression: `${keyName} = :gh`,
        ExpressionAttributeValues: {
          ':gh': gh,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }));

      results.push(...(response.Items || []) as DynamoShopItem[]);
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return results;
  };

  try {
    // Query all geohashes in parallel - DynamoDB handles concurrent requests well
    const results = await Promise.all(geohashes.map(queryGeohash));
    for (const result of results) {
      shops.push(...result);
    }

    return shops;
  } catch (error: any) {
    // If index doesn't exist or is still being created, return null to trigger fallback
    if (error.message?.includes('specified index') || error.name === 'ValidationException') {
      console.warn(`${indexName} not available, falling back to date-based query`);
      return null;
    }
    throw error;
  }
}

// Query events by shop ID and date range using GSI2
async function queryEventsByShopAndDateRange(
  shopExternalId: number,
  startDate: string,
  endDate: string
): Promise<DynamoEventItem[]> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const events: DynamoEventItem[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const response = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':pk': `SHOP#${shopExternalId}`,
        ':start': startDate,
        ':end': endDate,
      },
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    events.push(...(response.Items || []) as DynamoEventItem[]);
    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return events;
}

// Query events by date range using GSI1 (legacy - slower, used as fallback)
async function queryEventsByDateRange(startDate: string, endDate: string): Promise<DynamoEventItem[]> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const events: DynamoEventItem[] = [];

  // Generate date range (YYYY-MM-DD format)
  const start = new Date(startDate);
  const end = new Date(endDate);
  const dates: string[] = [];

  const current = new Date(start);
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }

  // Query each date in parallel (batched to avoid throttling)
  const batchSize = 10;
  for (let i = 0; i < dates.length; i += batchSize) {
    const batch = dates.slice(i, i + batchSize);
    const promises = batch.map(async (date) => {
      const response = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `DATE#${date}`,
        },
      }));
      return (response.Items || []) as DynamoEventItem[];
    });

    const results = await Promise.all(promises);
    for (const result of results) {
      events.push(...result);
    }
  }

  return events;
}

// Main event query function for DynamoDB
export async function getEventsDynamoDB(
  query: EventQuery,
  offset: number,
  limit: number
): Promise<{ events: Event[]; total: number }> {
  // Step 1: Determine date range
  let startDate: string;
  let endDate: string;

  if (query.calendarMode) {
    const range = getCalendarDateRange();
    startDate = range.startDate;
    endDate = range.endDate;
  } else {
    startDate = query.startDateFrom || new Date().toISOString();
    endDate = query.startDateTo || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  }

  // Step 2: Query events - use shop-first approach when location filter is present
  let allEvents: DynamoEventItem[];
  const hasLocationFilter = query.lat !== undefined && query.lng !== undefined;

  if (hasLocationFilter) {
    // Geohash-based shop lookup: query only relevant geographic cells
    // 1. Choose optimal precision based on search radius
    // 2. Get geohash cells that cover the search radius bounding box
    // 3. Query shops in those cells using appropriate GeohashIndex
    // 4. Filter by exact distance
    // 5. Query events for matching shops

    const { precision, indexName, keyName } = chooseGeohashPrecision(query.radiusKm);
    const geohashes = getGeohashesForRadius(query.lat!, query.lng!, query.radiusKm, precision);

    // If too many geohash cells or GeohashIndex unavailable, fall back to date-based query
    let nearbyShops = geohashes ? await getShopsByGeohash(geohashes, indexName, keyName) : null;

    // If GeohashIndex3 returned empty (possibly still backfilling), fall back to date-based query
    if (nearbyShops !== null && nearbyShops.length === 0 && precision === 3) {
      console.log('GeohashIndex3 returned empty, falling back to date-based query');
      nearbyShops = null; // Trigger date-based fallback
    }

    // Fall back to date-based query with in-memory filtering
    if (nearbyShops === null) {
      allEvents = await queryEventsByDateRange(startDate, endDate);
      // Filter by distance in memory
      allEvents = allEvents.filter(e =>
        e.shopLatitude !== null &&
        e.shopLongitude !== null &&
        haversineDistance(query.lat!, query.lng!, e.shopLatitude!, e.shopLongitude!) <= query.radiusKm
      );
    } else {
      // Filter by exact Haversine distance
      const shopsInRange = nearbyShops.filter(s =>
        s.latitude !== null &&
        s.longitude !== null &&
        haversineDistance(query.lat!, query.lng!, s.latitude!, s.longitude!) <= query.radiusKm
      );

      // Query events for each shop in parallel
      allEvents = [];
      const promises = shopsInRange.map(shop =>
        queryEventsByShopAndDateRange(shop.externalId, startDate, endDate)
      );
      const results = await Promise.all(promises);
      for (const events of results) {
        allEvents.push(...events);
      }
    }
  } else {
    // No location filter - use date-based query (slower but comprehensive)
    allEvents = await queryEventsByDateRange(startDate, endDate);
  }

  // Step 3: Apply remaining filters
  let filtered = allEvents;

  // City filter (case-insensitive partial match)
  if (query.city) {
    const cityLower = query.city.toLowerCase();
    filtered = filtered.filter(e =>
      e.city?.toLowerCase().includes(cityLower)
    );
  }

  // State filter (case-insensitive partial match)
  if (query.state) {
    const stateLower = query.state.toLowerCase();
    filtered = filtered.filter(e =>
      e.state?.toLowerCase().includes(stateLower)
    );
  }

  // Country filter (case-insensitive partial match)
  if (query.country) {
    const countryLower = query.country.toLowerCase();
    filtered = filtered.filter(e =>
      e.country?.toLowerCase().includes(countryLower)
    );
  }

  // Event type filter (exact match)
  if (query.eventType) {
    filtered = filtered.filter(e => e.eventType === query.eventType);
  }

  // Search filter (name, description, location)
  if (query.search) {
    const searchLower = query.search.toLowerCase();
    filtered = filtered.filter(e =>
      e.name?.toLowerCase().includes(searchLower) ||
      e.description?.toLowerCase().includes(searchLower) ||
      e.location?.toLowerCase().includes(searchLower)
    );
  }

  // Step 4: Sort by start date
  filtered.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

  // Step 5: Get total and paginate
  const total = filtered.length;
  const paginatedItems = filtered.slice(offset, offset + limit);

  return {
    events: paginatedItems.map(mapDynamoItemToEvent),
    total,
  };
}

// Get single event by ID
export async function getEventByIdDynamoDB(externalId: string): Promise<Event | null> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const keys = eventKeys(externalId);

  const response = await client.send(new GetCommand({
    TableName: tableName,
    Key: keys,
  }));

  if (!response.Item) {
    return null;
  }

  return mapDynamoItemToEvent(response.Item as DynamoEventItem);
}

// Get scrape info (last scrape time and total events)
export async function getScrapeInfoDynamoDB(): Promise<{ lastScrapeAt: Date | null; totalEvents: number }> {
  const client = getDynamoClient();
  const tableName = getTableName();

  // Query recent scrape runs and find the most recent completed one
  // DynamoDB applies Limit before FilterExpression, so we query more items and filter in code
  const scrapeResponse = await client.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': EntityPrefix.SCRAPE_RUN,
    },
    ScanIndexForward: false, // Descending order
    Limit: 20,
  }));

  // Find the most recent completed scrape run
  const completedRun = scrapeResponse.Items?.find(
    item => (item as DynamoScrapeRunItem).status === 'completed'
  ) as DynamoScrapeRunItem | undefined;

  const lastScrapeAt = completedRun?.completedAt
    ? new Date(completedRun.completedAt)
    : null;

  // Count events by querying the date range
  // For better performance, we could maintain a counter item, but this works at our scale
  const now = new Date();
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const events = await queryEventsByDateRange(threeMonthsAgo.toISOString(), now.toISOString());
  const totalEvents = events.length;

  return {
    lastScrapeAt: lastScrapeAt && !isNaN(lastScrapeAt.getTime()) ? lastScrapeAt : null,
    totalEvents,
  };
}

// Geocache operations with LRU eviction

// Get geocache entry and update lastAccessedAt
export async function getGeocacheDynamoDB(normalizedQuery: string): Promise<{
  latitude: number;
  longitude: number;
  displayName: string | null;
} | null> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const keys = geocacheKeys(normalizedQuery);

  const response = await client.send(new GetCommand({
    TableName: tableName,
    Key: keys,
  }));

  if (!response.Item) {
    return null;
  }

  const item = response.Item as DynamoGeocacheItem;

  // Update lastAccessedAt (fire and forget - don't block on this)
  const now = new Date().toISOString();
  const gsi3Keys = geocacheGSI3Keys(now);
  client.send(new PutCommand({
    TableName: tableName,
    Item: {
      ...item,
      ...gsi3Keys,
      lastAccessedAt: now,
    },
  })).catch(() => {}); // Ignore errors - cache hit is more important

  return {
    latitude: item.latitude,
    longitude: item.longitude,
    displayName: item.displayName,
  };
}

// Set geocache entry with LRU eviction
export async function setGeocacheDynamoDB(
  normalizedQuery: string,
  latitude: number,
  longitude: number,
  displayName: string | null
): Promise<void> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const keys = geocacheKeys(normalizedQuery);
  const now = new Date().toISOString();
  const gsi3Keys = geocacheGSI3Keys(now);

  const item: DynamoGeocacheItem = {
    ...keys,
    ...gsi3Keys,
    entityType: 'GEOCACHE',
    query: normalizedQuery,
    latitude,
    longitude,
    displayName,
    lastAccessedAt: now,
    createdAt: now,
  };

  await client.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));

  // Trigger eviction check (fire and forget)
  evictOldGeocacheEntries().catch(() => {});
}

// Count geocache entries using GSI3
async function countGeocacheEntries(): Promise<number> {
  const client = getDynamoClient();
  const tableName = getTableName();

  const response = await client.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'GSI3',
    KeyConditionExpression: 'GSI3PK = :pk',
    ExpressionAttributeValues: {
      ':pk': 'GEOCACHE_LRU',
    },
    Select: 'COUNT',
  }));

  return response.Count || 0;
}

// Get oldest geocache entries for eviction
async function getOldestGeocacheEntries(limit: number): Promise<{ PK: string; SK: string }[]> {
  const client = getDynamoClient();
  const tableName = getTableName();

  const response = await client.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'GSI3',
    KeyConditionExpression: 'GSI3PK = :pk',
    ExpressionAttributeValues: {
      ':pk': 'GEOCACHE_LRU',
    },
    ScanIndexForward: true, // Ascending order (oldest first)
    Limit: limit,
    ProjectionExpression: 'PK, SK',
  }));

  return (response.Items || []).map(item => ({
    PK: item.PK as string,
    SK: item.SK as string,
  }));
}

// Evict oldest geocache entries if over limit
async function evictOldGeocacheEntries(): Promise<void> {
  const count = await countGeocacheEntries();

  if (count <= GEOCACHE_MAX_ENTRIES) {
    return;
  }

  const entriesToDelete = await getOldestGeocacheEntries(GEOCACHE_EVICTION_BATCH);

  if (entriesToDelete.length === 0) {
    return;
  }

  const client = getDynamoClient();
  const tableName = getTableName();

  // BatchWrite can handle up to 25 items at a time
  const batchSize = 25;
  for (let i = 0; i < entriesToDelete.length; i += batchSize) {
    const batch = entriesToDelete.slice(i, i + batchSize);
    const deleteRequests = batch.map(key => ({
      DeleteRequest: { Key: key },
    }));

    await client.send(new BatchWriteCommand({
      RequestItems: {
        [tableName]: deleteRequests,
      },
    }));
  }

  console.log(`Evicted ${entriesToDelete.length} old geocache entries`);
}
