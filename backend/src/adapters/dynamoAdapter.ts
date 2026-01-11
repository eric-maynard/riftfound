import {
  getDynamoClient,
  getTableName,
  eventKeys,
  eventGSI1Keys,
  shopKeys,
  geocacheKeys,
  scrapeRunKeys,
  EntityPrefix,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '../config/dynamodb.js';
import type { Event, EventQuery } from '../models/event.js';

// DynamoDB Event item structure
export interface DynamoEventItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
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
  geocodeStatus: string;
  geocodeError: string | null;
  createdAt: string;
  updatedAt: string;
}

// DynamoDB Geocache item structure
export interface DynamoGeocacheItem {
  PK: string;
  SK: string;
  entityType: 'GEOCACHE';
  query: string;
  latitude: number;
  longitude: number;
  displayName: string | null;
  createdAt: string;
}

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

// Query events by date range using GSI1
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

  // Step 2: Query events by date range
  const allEvents = await queryEventsByDateRange(startDate, endDate);

  // Step 3: Apply filters
  let filtered = allEvents;

  // Location filter (bounding box + Haversine)
  const hasLocationFilter = query.lat !== undefined && query.lng !== undefined;
  if (hasLocationFilter) {
    const bbox = getBoundingBox(query.lat!, query.lng!, query.radiusKm);

    // Pre-filter with bounding box
    filtered = filtered.filter(e =>
      e.shopLatitude !== null &&
      e.shopLongitude !== null &&
      e.shopLatitude >= bbox.minLat &&
      e.shopLatitude <= bbox.maxLat &&
      e.shopLongitude >= bbox.minLng &&
      e.shopLongitude <= bbox.maxLng
    );

    // Refine with exact Haversine distance
    filtered = filtered.filter(e =>
      haversineDistance(query.lat!, query.lng!, e.shopLatitude!, e.shopLongitude!) <= query.radiusKm
    );
  }

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

// Geocache operations
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
  return {
    latitude: item.latitude,
    longitude: item.longitude,
    displayName: item.displayName,
  };
}

export async function setGeocacheDynamoDB(
  normalizedQuery: string,
  latitude: number,
  longitude: number,
  displayName: string | null
): Promise<void> {
  const client = getDynamoClient();
  const tableName = getTableName();
  const keys = geocacheKeys(normalizedQuery);

  const item: DynamoGeocacheItem = {
    ...keys,
    entityType: 'GEOCACHE',
    query: normalizedQuery,
    latitude,
    longitude,
    displayName,
    createdAt: new Date().toISOString(),
  };

  await client.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));
}
