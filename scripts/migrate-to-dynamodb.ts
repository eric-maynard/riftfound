/**
 * Migration script: SQLite -> DynamoDB
 *
 * This script reads all data from SQLite and writes it to DynamoDB.
 * It preserves all data including events, shops, geocache, and scrape runs.
 *
 * Usage:
 *   # Set environment variables
 *   export DYNAMODB_TABLE_NAME=riftfound
 *   export AWS_REGION=us-west-2
 *   export SQLITE_PATH=./riftfound.db
 *
 *   # For local testing with DynamoDB Local:
 *   export DYNAMODB_ENDPOINT=http://localhost:8000
 *
 *   # Run migration
 *   npx ts-node scripts/migrate-to-dynamodb.ts
 */

import Database from 'better-sqlite3';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from 'dotenv';

// Load environment variables
config({ path: '../.env' });
config();

// Configuration
const SQLITE_PATH = process.env.SQLITE_PATH || './riftfound.db';
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'riftfound';
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT;

// Entity prefixes
const EntityPrefix = {
  EVENT: 'EVENT#',
  SHOP: 'SHOP#',
  GEOCACHE: 'GEOCACHE#',
  SCRAPE_RUN: 'SCRAPE_RUN',
  ZIPCODE: 'ZIPCODE#',
} as const;

// Initialize DynamoDB client
function createDynamoClient(): DynamoDBDocumentClient {
  const clientConfig: ConstructorParameters<typeof DynamoDBClient>[0] = {
    region: AWS_REGION,
  };

  if (DYNAMODB_ENDPOINT) {
    clientConfig.endpoint = DYNAMODB_ENDPOINT;
    clientConfig.credentials = {
      accessKeyId: 'local',
      secretAccessKey: 'local',
    };
  }

  const client = new DynamoDBClient(clientConfig);
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertClassInstanceToMap: true,
    },
  });
}

// Create DynamoDB table if it doesn't exist
async function ensureTableExists(client: DynamoDBClient): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    console.log(`Table ${TABLE_NAME} already exists`);
  } catch (error: unknown) {
    if ((error as { name: string }).name === 'ResourceNotFoundException') {
      console.log(`Creating table ${TABLE_NAME}...`);
      await client.send(new CreateTableCommand({
        TableName: TABLE_NAME,
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'GSI1PK', AttributeType: 'S' },
          { AttributeName: 'GSI1SK', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }));

      // Wait for table to be active
      console.log('Waiting for table to become active...');
      let tableActive = false;
      while (!tableActive) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const desc = await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
        tableActive = desc.Table?.TableStatus === 'ACTIVE';
      }
      console.log('Table is now active');
    } else {
      throw error;
    }
  }
}

// Batch write items to DynamoDB (max 25 items per batch)
async function batchWriteItems(
  docClient: DynamoDBDocumentClient,
  items: Record<string, unknown>[]
): Promise<void> {
  const batchSize = 25;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const putRequests = batch.map(item => ({
      PutRequest: { Item: item },
    }));

    await docClient.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: putRequests,
      },
    }));

    // Progress indicator
    const progress = Math.min(i + batchSize, items.length);
    process.stdout.write(`\r  Written ${progress}/${items.length} items`);
  }
  process.stdout.write('\n');
}

// Migrate shops
async function migrateShops(db: Database.Database, docClient: DynamoDBDocumentClient): Promise<Map<number, number>> {
  console.log('\nMigrating shops...');

  const shops = db.prepare(`
    SELECT id, external_id, name, location_text, display_city, latitude, longitude,
           geocode_status, geocode_error, created_at, updated_at
    FROM shops
  `).all() as Array<{
    id: number;
    external_id: number;
    name: string;
    location_text: string | null;
    display_city: string | null;
    latitude: number | null;
    longitude: number | null;
    geocode_status: string;
    geocode_error: string | null;
    created_at: string;
    updated_at: string;
  }>;

  console.log(`  Found ${shops.length} shops`);

  // Map from SQLite ID to external_id (for event references)
  const shopIdMap = new Map<number, number>();

  const items = shops.map(shop => {
    shopIdMap.set(shop.id, shop.external_id);

    return {
      PK: `${EntityPrefix.SHOP}${shop.external_id}`,
      SK: `${EntityPrefix.SHOP}${shop.external_id}`,
      entityType: 'SHOP',
      externalId: shop.external_id,
      name: shop.name,
      locationText: shop.location_text,
      displayCity: shop.display_city,
      latitude: shop.latitude,
      longitude: shop.longitude,
      geocodeStatus: shop.geocode_status,
      geocodeError: shop.geocode_error,
      createdAt: shop.created_at,
      updatedAt: shop.updated_at,
    };
  });

  if (items.length > 0) {
    await batchWriteItems(docClient, items);
  }

  return shopIdMap;
}

// Migrate events
async function migrateEvents(
  db: Database.Database,
  docClient: DynamoDBDocumentClient,
  shopIdMap: Map<number, number>
): Promise<void> {
  console.log('\nMigrating events...');

  const events = db.prepare(`
    SELECT e.*, s.external_id as shop_external_id, s.name as shop_name,
           s.latitude as shop_latitude, s.longitude as shop_longitude
    FROM events e
    LEFT JOIN shops s ON e.shop_id = s.id
  `).all() as Array<{
    id: number;
    external_id: string;
    name: string;
    description: string | null;
    location: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    latitude: number | null;
    longitude: number | null;
    start_date: string;
    start_time: string | null;
    end_date: string | null;
    event_type: string | null;
    organizer: string | null;
    player_count: number | null;
    capacity: number | null;
    price: string | null;
    url: string | null;
    image_url: string | null;
    shop_id: number | null;
    shop_external_id: number | null;
    shop_name: string | null;
    shop_latitude: number | null;
    shop_longitude: number | null;
    created_at: string;
    updated_at: string;
    scraped_at: string;
  }>;

  console.log(`  Found ${events.length} events`);

  const items = events.map(event => {
    const startDate = new Date(event.start_date);
    const dateStr = startDate.toISOString().split('T')[0];

    // Calculate TTL (90 days after event date)
    const ttlDate = new Date(startDate);
    ttlDate.setDate(ttlDate.getDate() + 90);
    const ttl = Math.floor(ttlDate.getTime() / 1000);

    return {
      PK: `${EntityPrefix.EVENT}${event.external_id}`,
      SK: `${EntityPrefix.EVENT}${event.external_id}`,
      GSI1PK: `DATE#${dateStr}`,
      GSI1SK: `${EntityPrefix.EVENT}${event.external_id}`,
      entityType: 'EVENT',
      externalId: event.external_id,
      name: event.name,
      description: event.description,
      location: event.location,
      address: event.address,
      city: event.city,
      state: event.state,
      country: event.country,
      latitude: event.latitude,
      longitude: event.longitude,
      startDate: event.start_date,
      startTime: event.start_time,
      endDate: event.end_date,
      eventType: event.event_type,
      organizer: event.organizer,
      playerCount: event.player_count,
      capacity: event.capacity,
      price: event.price,
      url: event.url,
      imageUrl: event.image_url,
      shopId: event.shop_external_id, // Use external_id for DynamoDB
      shopExternalId: event.shop_external_id,
      shopName: event.shop_name,
      shopLatitude: event.shop_latitude,
      shopLongitude: event.shop_longitude,
      createdAt: event.created_at,
      updatedAt: event.updated_at,
      scrapedAt: event.scraped_at,
      ttl,
    };
  });

  if (items.length > 0) {
    await batchWriteItems(docClient, items);
  }
}

// Migrate geocache
async function migrateGeocache(db: Database.Database, docClient: DynamoDBDocumentClient): Promise<void> {
  console.log('\nMigrating geocache...');

  const entries = db.prepare(`
    SELECT query, latitude, longitude, display_name, created_at
    FROM geocache
  `).all() as Array<{
    query: string;
    latitude: number;
    longitude: number;
    display_name: string | null;
    created_at: string;
  }>;

  console.log(`  Found ${entries.length} geocache entries`);

  const items = entries.map(entry => ({
    PK: `${EntityPrefix.GEOCACHE}${entry.query}`,
    SK: 'GEOCACHE',
    entityType: 'GEOCACHE',
    query: entry.query,
    latitude: entry.latitude,
    longitude: entry.longitude,
    displayName: entry.display_name,
    createdAt: entry.created_at,
  }));

  if (items.length > 0) {
    await batchWriteItems(docClient, items);
  }
}

// Migrate scrape runs
async function migrateScrapeRuns(db: Database.Database, docClient: DynamoDBDocumentClient): Promise<void> {
  console.log('\nMigrating scrape runs...');

  const runs = db.prepare(`
    SELECT started_at, completed_at, status, events_found, events_created, events_updated, error_message
    FROM scrape_runs
  `).all() as Array<{
    started_at: string;
    completed_at: string | null;
    status: string;
    events_found: number;
    events_created: number;
    events_updated: number;
    error_message: string | null;
  }>;

  console.log(`  Found ${runs.length} scrape runs`);

  const items = runs.map(run => ({
    PK: EntityPrefix.SCRAPE_RUN,
    SK: run.started_at,
    entityType: 'SCRAPE_RUN',
    startedAt: run.started_at,
    completedAt: run.completed_at,
    status: run.status,
    eventsFound: run.events_found,
    eventsCreated: run.events_created,
    eventsUpdated: run.events_updated,
    errorMessage: run.error_message,
  }));

  if (items.length > 0) {
    await batchWriteItems(docClient, items);
  }
}

// Migrate US zipcodes (optional, large dataset)
async function migrateZipcodes(db: Database.Database, docClient: DynamoDBDocumentClient): Promise<void> {
  console.log('\nMigrating US zipcodes...');

  const zipcodes = db.prepare(`
    SELECT zipcode, city, state, state_code, latitude, longitude
    FROM us_zipcodes
  `).all() as Array<{
    zipcode: string;
    city: string;
    state: string;
    state_code: string;
    latitude: number;
    longitude: number;
  }>;

  console.log(`  Found ${zipcodes.length} zipcodes`);

  const items = zipcodes.map(zip => ({
    PK: `${EntityPrefix.ZIPCODE}${zip.zipcode}`,
    SK: 'ZIPCODE',
    entityType: 'ZIPCODE',
    zipcode: zip.zipcode,
    city: zip.city,
    state: zip.state,
    stateCode: zip.state_code,
    latitude: zip.latitude,
    longitude: zip.longitude,
  }));

  if (items.length > 0) {
    await batchWriteItems(docClient, items);
  }
}

// Main migration function
async function migrate(): Promise<void> {
  console.log('='.repeat(60));
  console.log('SQLite to DynamoDB Migration');
  console.log('='.repeat(60));
  console.log(`\nSource: ${SQLITE_PATH}`);
  console.log(`Target: ${TABLE_NAME} (${AWS_REGION})`);
  if (DYNAMODB_ENDPOINT) {
    console.log(`Endpoint: ${DYNAMODB_ENDPOINT} (local mode)`);
  }
  console.log('');

  // Open SQLite database
  console.log('Opening SQLite database...');
  const db = new Database(SQLITE_PATH, { readonly: true });

  // Create DynamoDB client
  const rawClient = new DynamoDBClient({
    region: AWS_REGION,
    ...(DYNAMODB_ENDPOINT ? {
      endpoint: DYNAMODB_ENDPOINT,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    } : {}),
  });
  const docClient = createDynamoClient();

  try {
    // Ensure table exists
    await ensureTableExists(rawClient);

    // Run migrations
    const shopIdMap = await migrateShops(db, docClient);
    await migrateEvents(db, docClient, shopIdMap);
    await migrateGeocache(db, docClient);
    await migrateScrapeRuns(db, docClient);

    // Optional: migrate zipcodes (can be skipped for faster migration)
    const skipZipcodes = process.argv.includes('--skip-zipcodes');
    if (!skipZipcodes) {
      await migrateZipcodes(db, docClient);
    } else {
      console.log('\nSkipping zipcodes (--skip-zipcodes flag)');
    }

    console.log('\n' + '='.repeat(60));
    console.log('Migration completed successfully!');
    console.log('='.repeat(60));

  } finally {
    db.close();
  }
}

// Run migration
migrate().catch(error => {
  console.error('\nMigration failed:', error);
  process.exit(1);
});
