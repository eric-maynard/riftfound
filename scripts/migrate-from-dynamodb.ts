/**
 * Migration script: DynamoDB -> SQLite
 *
 * This script reads all data from DynamoDB and writes it to SQLite.
 * Use this for rollback or backup purposes.
 *
 * Usage:
 *   # Set environment variables
 *   export DYNAMODB_TABLE_NAME=riftfound
 *   export AWS_REGION=us-west-2
 *   export SQLITE_PATH=./riftfound-restored.db
 *
 *   # For local testing with DynamoDB Local:
 *   export DYNAMODB_ENDPOINT=http://localhost:8000
 *
 *   # Run migration
 *   npx ts-node scripts/migrate-from-dynamodb.ts
 */

import Database from 'better-sqlite3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from 'dotenv';

// Load environment variables
config({ path: '../.env' });
config();

// Configuration
const SQLITE_PATH = process.env.SQLITE_PATH || './riftfound-restored.db';
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'riftfound';
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT;

// Entity types
interface DynamoItem {
  PK: string;
  SK: string;
  entityType: string;
  [key: string]: unknown;
}

interface DynamoEventItem extends DynamoItem {
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
  shopExternalId: number | null;
  createdAt: string;
  updatedAt: string;
  scrapedAt: string;
}

interface DynamoShopItem extends DynamoItem {
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

interface DynamoGeocacheItem extends DynamoItem {
  entityType: 'GEOCACHE';
  query: string;
  latitude: number;
  longitude: number;
  displayName: string | null;
  createdAt: string;
}

interface DynamoScrapeRunItem extends DynamoItem {
  entityType: 'SCRAPE_RUN';
  startedAt: string;
  completedAt: string | null;
  status: string;
  eventsFound: number;
  eventsCreated: number;
  eventsUpdated: number;
  errorMessage: string | null;
}

interface DynamoZipcodeItem extends DynamoItem {
  entityType: 'ZIPCODE';
  zipcode: string;
  city: string;
  state: string;
  stateCode: string;
  latitude: number;
  longitude: number;
}

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

// Initialize SQLite database
function initSqliteSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      location_text TEXT,
      display_city TEXT,
      latitude REAL,
      longitude REAL,
      geocode_status TEXT DEFAULT 'pending',
      geocode_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_shops_external_id ON shops(external_id);
    CREATE INDEX IF NOT EXISTS idx_shops_name ON shops(name);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      location TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      country TEXT,
      latitude REAL,
      longitude REAL,
      start_date TEXT NOT NULL,
      start_time TEXT,
      end_date TEXT,
      event_type TEXT,
      organizer TEXT,
      player_count INTEGER,
      capacity INTEGER,
      price TEXT,
      url TEXT,
      image_url TEXT,
      shop_id INTEGER REFERENCES shops(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      scraped_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_external_id ON events(external_id);
    CREATE INDEX IF NOT EXISTS idx_events_start_date ON events(start_date);
    CREATE INDEX IF NOT EXISTS idx_events_shop_id ON events(shop_id);

    CREATE TABLE IF NOT EXISTS geocache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT UNIQUE NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      display_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      events_found INTEGER DEFAULT 0,
      events_created INTEGER DEFAULT 0,
      events_updated INTEGER DEFAULT 0,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS us_zipcodes (
      zipcode TEXT PRIMARY KEY,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      state_code TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL
    );
  `);
}

// Scan all items from DynamoDB
async function scanAllItems(docClient: DynamoDBDocumentClient): Promise<DynamoItem[]> {
  const items: DynamoItem[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const response = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      ExclusiveStartKey: lastKey,
    }));

    if (response.Items) {
      items.push(...(response.Items as DynamoItem[]));
    }

    lastKey = response.LastEvaluatedKey;
    process.stdout.write(`\r  Scanned ${items.length} items...`);
  } while (lastKey);

  process.stdout.write('\n');
  return items;
}

// Insert shops and return a map of external_id -> SQLite id
function insertShops(db: Database.Database, shops: DynamoShopItem[]): Map<number, number> {
  console.log(`\nInserting ${shops.length} shops...`);

  const externalToSqliteId = new Map<number, number>();

  const insertStmt = db.prepare(`
    INSERT INTO shops (external_id, name, location_text, display_city, latitude, longitude,
                       geocode_status, geocode_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((shopsToInsert: DynamoShopItem[]) => {
    for (const shop of shopsToInsert) {
      const result = insertStmt.run(
        shop.externalId,
        shop.name,
        shop.locationText,
        shop.displayCity,
        shop.latitude,
        shop.longitude,
        shop.geocodeStatus,
        shop.geocodeError,
        shop.createdAt,
        shop.updatedAt
      );
      externalToSqliteId.set(shop.externalId, result.lastInsertRowid as number);
    }
  });

  transaction(shops);
  console.log(`  Inserted ${shops.length} shops`);

  return externalToSqliteId;
}

// Insert events
function insertEvents(
  db: Database.Database,
  events: DynamoEventItem[],
  shopIdMap: Map<number, number>
): void {
  console.log(`\nInserting ${events.length} events...`);

  const insertStmt = db.prepare(`
    INSERT INTO events (external_id, name, description, location, address, city, state, country,
                        latitude, longitude, start_date, start_time, end_date, event_type,
                        organizer, player_count, capacity, price, url, image_url, shop_id,
                        created_at, updated_at, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((eventsToInsert: DynamoEventItem[]) => {
    for (const event of eventsToInsert) {
      // Look up SQLite shop ID from external_id
      const shopId = event.shopExternalId ? shopIdMap.get(event.shopExternalId) ?? null : null;

      insertStmt.run(
        event.externalId,
        event.name,
        event.description,
        event.location,
        event.address,
        event.city,
        event.state,
        event.country,
        event.latitude,
        event.longitude,
        event.startDate,
        event.startTime,
        event.endDate,
        event.eventType,
        event.organizer,
        event.playerCount,
        event.capacity,
        event.price,
        event.url,
        event.imageUrl,
        shopId,
        event.createdAt,
        event.updatedAt,
        event.scrapedAt
      );
    }
  });

  transaction(events);
  console.log(`  Inserted ${events.length} events`);
}

// Insert geocache entries
function insertGeocache(db: Database.Database, entries: DynamoGeocacheItem[]): void {
  console.log(`\nInserting ${entries.length} geocache entries...`);

  const insertStmt = db.prepare(`
    INSERT INTO geocache (query, latitude, longitude, display_name, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((entriesToInsert: DynamoGeocacheItem[]) => {
    for (const entry of entriesToInsert) {
      insertStmt.run(
        entry.query,
        entry.latitude,
        entry.longitude,
        entry.displayName,
        entry.createdAt
      );
    }
  });

  transaction(entries);
  console.log(`  Inserted ${entries.length} geocache entries`);
}

// Insert scrape runs
function insertScrapeRuns(db: Database.Database, runs: DynamoScrapeRunItem[]): void {
  console.log(`\nInserting ${runs.length} scrape runs...`);

  const insertStmt = db.prepare(`
    INSERT INTO scrape_runs (started_at, completed_at, status, events_found, events_created,
                             events_updated, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((runsToInsert: DynamoScrapeRunItem[]) => {
    for (const run of runsToInsert) {
      insertStmt.run(
        run.startedAt,
        run.completedAt,
        run.status,
        run.eventsFound,
        run.eventsCreated,
        run.eventsUpdated,
        run.errorMessage
      );
    }
  });

  transaction(runs);
  console.log(`  Inserted ${runs.length} scrape runs`);
}

// Insert zipcodes
function insertZipcodes(db: Database.Database, zipcodes: DynamoZipcodeItem[]): void {
  console.log(`\nInserting ${zipcodes.length} zipcodes...`);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO us_zipcodes (zipcode, city, state, state_code, latitude, longitude)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((zipcodesToInsert: DynamoZipcodeItem[]) => {
    for (const zip of zipcodesToInsert) {
      insertStmt.run(
        zip.zipcode,
        zip.city,
        zip.state,
        zip.stateCode,
        zip.latitude,
        zip.longitude
      );
    }
  });

  transaction(zipcodes);
  console.log(`  Inserted ${zipcodes.length} zipcodes`);
}

// Main migration function
async function migrate(): Promise<void> {
  console.log('='.repeat(60));
  console.log('DynamoDB to SQLite Migration');
  console.log('='.repeat(60));
  console.log(`\nSource: ${TABLE_NAME} (${AWS_REGION})`);
  console.log(`Target: ${SQLITE_PATH}`);
  if (DYNAMODB_ENDPOINT) {
    console.log(`Endpoint: ${DYNAMODB_ENDPOINT} (local mode)`);
  }
  console.log('');

  // Create DynamoDB client
  const docClient = createDynamoClient();

  // Scan all items from DynamoDB
  console.log('Scanning DynamoDB table...');
  const allItems = await scanAllItems(docClient);
  console.log(`  Total items: ${allItems.length}`);

  // Separate items by entity type
  const shops: DynamoShopItem[] = [];
  const events: DynamoEventItem[] = [];
  const geocacheEntries: DynamoGeocacheItem[] = [];
  const scrapeRuns: DynamoScrapeRunItem[] = [];
  const zipcodes: DynamoZipcodeItem[] = [];

  for (const item of allItems) {
    switch (item.entityType) {
      case 'SHOP':
        shops.push(item as DynamoShopItem);
        break;
      case 'EVENT':
        events.push(item as DynamoEventItem);
        break;
      case 'GEOCACHE':
        geocacheEntries.push(item as DynamoGeocacheItem);
        break;
      case 'SCRAPE_RUN':
        scrapeRuns.push(item as DynamoScrapeRunItem);
        break;
      case 'ZIPCODE':
        zipcodes.push(item as DynamoZipcodeItem);
        break;
    }
  }

  console.log(`\nEntities found:`);
  console.log(`  Shops: ${shops.length}`);
  console.log(`  Events: ${events.length}`);
  console.log(`  Geocache: ${geocacheEntries.length}`);
  console.log(`  Scrape runs: ${scrapeRuns.length}`);
  console.log(`  Zipcodes: ${zipcodes.length}`);

  // Create SQLite database
  console.log('\nCreating SQLite database...');
  const db = new Database(SQLITE_PATH);
  db.pragma('journal_mode = WAL');
  initSqliteSchema(db);

  try {
    // Insert data in order (shops first, then events with shop references)
    const shopIdMap = insertShops(db, shops);
    insertEvents(db, events, shopIdMap);
    insertGeocache(db, geocacheEntries);
    insertScrapeRuns(db, scrapeRuns);

    if (zipcodes.length > 0) {
      insertZipcodes(db, zipcodes);
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
