import { Pool } from 'pg';
import Database from 'better-sqlite3';
import { env } from './config.js';
import {
  startScrapeRunDynamoDB,
  completeScrapeRunDynamoDB,
  failScrapeRunDynamoDB,
  upsertShopFromApiDynamoDB,
  updateShopDisplayCityDynamoDB,
  upsertEventWithStoreDynamoDB,
  deleteOldEventsDynamoDB,
} from './dynamodb.js';

// Unified database interface
export interface ScrapedEvent {
  externalId: string;
  name: string;
  description?: string | null;
  location?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  startDate: Date;
  startTime?: string | null; // e.g., "7:30 AM (UTC)"
  endDate?: Date | null;
  eventType?: string | null;
  organizer?: string | null; // Store/shop name
  playerCount?: number | null; // Registered players
  capacity?: number | null; // Max players
  price?: string | null; // e.g., "A$15.00", "Free Event"
  url?: string | null;
  imageUrl?: string | null;
}

// SQLite implementation
let sqliteDb: Database.Database | null = null;

function getSqliteDb(): Database.Database {
  if (!sqliteDb) {
    const dbPath = env.SQLITE_PATH || './riftfound.db';
    sqliteDb = new Database(dbPath);
    sqliteDb.pragma('journal_mode = WAL');
    initSqliteSchema(sqliteDb);
  }
  return sqliteDb;
}

function initSqliteSchema(db: Database.Database) {
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
    CREATE INDEX IF NOT EXISTS idx_shops_geocode_status ON shops(geocode_status);
    CREATE INDEX IF NOT EXISTS idx_shops_lat_lng ON shops(latitude, longitude);

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
    CREATE INDEX IF NOT EXISTS idx_events_city ON events(city);
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

    CREATE TABLE IF NOT EXISTS photon_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      osm_id INTEGER NOT NULL UNIQUE,
      photon_data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_photon_queue_created_at ON photon_queue(created_at);
  `);

  // Add new columns if they don't exist (migrations for existing DBs)
  try {
    db.exec(`ALTER TABLE events ADD COLUMN start_time TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE events ADD COLUMN player_count INTEGER`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE events ADD COLUMN capacity INTEGER`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE events ADD COLUMN price TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE events ADD COLUMN shop_id INTEGER REFERENCES shops(id)`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE shops ADD COLUMN display_city TEXT`);
  } catch { /* column exists */ }

  // Migration: Add external_id to shops table if it doesn't exist
  // Check if external_id column exists
  const shopColumns = db.prepare(`PRAGMA table_info(shops)`).all() as Array<{ name: string }>;
  const hasExternalId = shopColumns.some(col => col.name === 'external_id');

  if (!hasExternalId) {
    console.log('Migrating shops table: adding external_id column...');
    // Old shops don't have external_id, so we need to rebuild the table
    // Clear shop_id references from events first, then clear shops
    // The next scrape will repopulate with correct external_ids
    db.exec(`
      UPDATE events SET shop_id = NULL;
      DELETE FROM shops;
    `);
    // Now recreate the table with external_id
    db.exec(`
      DROP TABLE shops;
      CREATE TABLE shops (
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
      CREATE INDEX idx_shops_external_id ON shops(external_id);
      CREATE INDEX idx_shops_name ON shops(name);
      CREATE INDEX idx_shops_geocode_status ON shops(geocode_status);
      CREATE INDEX idx_shops_lat_lng ON shops(latitude, longitude);
    `);
    console.log('Shops table migrated. Shops will be repopulated on next scrape.');
  }
}

// PostgreSQL implementation
let pgPool: Pool | null = null;

function getPgPool(): Pool {
  if (!pgPool) {
    pgPool = new Pool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      database: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      max: 5,
    });
  }
  return pgPool;
}

// Check which DB to use
function useSqlite(): boolean {
  return env.DB_TYPE === 'sqlite';
}

function useDynamoDB(): boolean {
  return env.DB_TYPE === 'dynamodb';
}

// Public API
export async function startScrapeRun(): Promise<string> {
  if (useDynamoDB()) {
    return startScrapeRunDynamoDB();
  } else if (useSqlite()) {
    const db = getSqliteDb();
    const result = db.prepare(
      `INSERT INTO scrape_runs (started_at, status) VALUES (datetime('now'), 'running')`
    ).run();
    return String(result.lastInsertRowid);
  } else {
    const result = await getPgPool().query(
      `INSERT INTO scrape_runs (started_at, status) VALUES (NOW(), 'running') RETURNING id`
    );
    return result.rows[0].id;
  }
}

export async function completeScrapeRun(
  runId: string,
  stats: { eventsFound: number; eventsCreated: number; eventsUpdated: number }
): Promise<void> {
  if (useDynamoDB()) {
    return completeScrapeRunDynamoDB(runId, stats);
  } else if (useSqlite()) {
    const db = getSqliteDb();
    db.prepare(`
      UPDATE scrape_runs SET
        completed_at = datetime('now'),
        status = 'completed',
        events_found = ?,
        events_created = ?,
        events_updated = ?
      WHERE id = ?
    `).run(stats.eventsFound, stats.eventsCreated, stats.eventsUpdated, runId);
  } else {
    await getPgPool().query(
      `UPDATE scrape_runs SET
        completed_at = NOW(),
        status = 'completed',
        events_found = $2,
        events_created = $3,
        events_updated = $4
      WHERE id = $1`,
      [runId, stats.eventsFound, stats.eventsCreated, stats.eventsUpdated]
    );
  }
}

export async function failScrapeRun(runId: string, errorMessage: string): Promise<void> {
  if (useDynamoDB()) {
    return failScrapeRunDynamoDB(runId, errorMessage);
  } else if (useSqlite()) {
    const db = getSqliteDb();
    db.prepare(`
      UPDATE scrape_runs SET
        completed_at = datetime('now'),
        status = 'failed',
        error_message = ?
      WHERE id = ?
    `).run(errorMessage, runId);
  } else {
    await getPgPool().query(
      `UPDATE scrape_runs SET
        completed_at = NOW(),
        status = 'failed',
        error_message = $2
      WHERE id = $1`,
      [runId, errorMessage]
    );
  }
}

// Shop interface for geocoding queue
export interface Shop {
  id: number;
  externalId: number;
  name: string;
  locationText: string | null;
  latitude: number | null;
  longitude: number | null;
  geocodeStatus: string;
  geocodeError: string | null;
}

// Store info from API (with coordinates)
export interface StoreInfo {
  id: number;
  name: string;
  full_address: string;
  city: string;
  state: string;
  country: string;
  latitude: number;
  longitude: number;
  website: string | null;
  email: string | null;
}


// Result from upserting a shop
export interface UpsertShopResult {
  shopId: number;
  isNew: boolean;
  needsCityGeocode: boolean;
  latitude: number;
  longitude: number;
}

// Upsert a shop with full info from API (includes coordinates)
// Uses external_id (API store ID) as unique identifier to handle stores with same name in different locations
export async function upsertShopFromApi(store: StoreInfo): Promise<UpsertShopResult> {
  if (useDynamoDB()) {
    return upsertShopFromApiDynamoDB(store);
  } else if (useSqlite()) {
    const db = getSqliteDb();

    // Check if exists by external_id (API store ID)
    const existing = db.prepare('SELECT id, display_city FROM shops WHERE external_id = ?').get(store.id) as { id: number; display_city: string | null } | undefined;

    if (existing) {
      // Update with API data (always has better info)
      db.prepare(`
        UPDATE shops SET
          name = ?,
          location_text = ?,
          latitude = ?,
          longitude = ?,
          geocode_status = 'completed',
          updated_at = datetime('now')
        WHERE id = ?
      `).run(store.name, store.full_address, store.latitude, store.longitude, existing.id);
      return {
        shopId: existing.id,
        isNew: false,
        needsCityGeocode: !existing.display_city,
        latitude: store.latitude,
        longitude: store.longitude,
      };
    } else {
      const result = db.prepare(`
        INSERT INTO shops (external_id, name, location_text, latitude, longitude, geocode_status)
        VALUES (?, ?, ?, ?, ?, 'completed')
      `).run(store.id, store.name, store.full_address, store.latitude, store.longitude);
      return {
        shopId: result.lastInsertRowid as number,
        isNew: true,
        needsCityGeocode: true,
        latitude: store.latitude,
        longitude: store.longitude,
      };
    }
  } else {
    const pool = getPgPool();
    const result = await pool.query(
      `INSERT INTO shops (external_id, name, location_text, latitude, longitude, geocode_status)
       VALUES ($1, $2, $3, $4, $5, 'completed')
       ON CONFLICT (external_id) DO UPDATE SET
         name = EXCLUDED.name,
         location_text = EXCLUDED.location_text,
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         geocode_status = 'completed',
         updated_at = NOW()
       RETURNING id, (xmax = 0) as is_new, display_city`,
      [store.id, store.name, store.full_address, store.latitude, store.longitude]
    );
    return {
      shopId: result.rows[0].id,
      isNew: result.rows[0].is_new,
      needsCityGeocode: !result.rows[0].display_city,
      latitude: store.latitude,
      longitude: store.longitude,
    };
  }
}

// Update a shop's display city after reverse geocoding
export function updateShopDisplayCity(shopId: number, displayCity: string): void {
  if (useDynamoDB()) {
    // For DynamoDB, shopId is the external_id
    updateShopDisplayCityDynamoDB(shopId, displayCity);
  } else if (useSqlite()) {
    const db = getSqliteDb();
    db.prepare(`
      UPDATE shops SET display_city = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(displayCity, shopId);
  } else {
    // PostgreSQL - async version would be needed
    throw new Error('updateShopDisplayCity not implemented for PostgreSQL yet');
  }
}

// Result from upserting an event
export interface UpsertEventResult {
  created: boolean;
  skipped?: boolean;  // True if write was skipped due to no changes (DynamoDB only)
  shopResult?: UpsertShopResult;
}

// Upsert event with store info from API (no geocoding needed)
export async function upsertEventWithStore(
  event: ScrapedEvent,
  storeInfo: StoreInfo | null
): Promise<UpsertEventResult> {
  if (useDynamoDB()) {
    return upsertEventWithStoreDynamoDB(event, storeInfo);
  }

  // First, upsert the shop with full coordinates from API
  let shopId: number | null = null;
  let shopResult: UpsertShopResult | undefined;

  if (storeInfo) {
    shopResult = await upsertShopFromApi(storeInfo);
    shopId = shopResult.shopId;
  }

  // Then upsert the event with the shop reference
  const eventResult = await upsertEventInternal(event, shopId);

  return {
    created: eventResult.created,
    shopResult,
  };
}

async function upsertEventInternal(event: ScrapedEvent, shopId: number | null): Promise<{ created: boolean }> {

  if (useSqlite()) {
    const db = getSqliteDb();

    // Check if exists
    const existing = db.prepare('SELECT id FROM events WHERE external_id = ?').get(event.externalId);

    if (existing) {
      db.prepare(`
        UPDATE events SET
          name = ?, description = ?, location = ?, address = ?, city = ?, state = ?,
          country = ?, latitude = ?, longitude = ?, start_date = ?, start_time = ?,
          end_date = ?, event_type = ?, organizer = ?, player_count = ?, capacity = ?,
          price = ?, url = ?, image_url = ?, shop_id = ?, scraped_at = datetime('now'), updated_at = datetime('now')
        WHERE external_id = ?
      `).run(
        event.name, event.description ?? null, event.location ?? null,
        event.address ?? null, event.city ?? null, event.state ?? null,
        event.country ?? null, event.latitude ?? null, event.longitude ?? null,
        event.startDate.toISOString(), event.startTime ?? null,
        event.endDate?.toISOString() ?? null, event.eventType ?? null,
        event.organizer ?? null, event.playerCount ?? null, event.capacity ?? null,
        event.price ?? null, event.url ?? null, event.imageUrl ?? null, shopId, event.externalId
      );
      return { created: false };
    } else {
      db.prepare(`
        INSERT INTO events (
          external_id, name, description, location, address, city, state, country,
          latitude, longitude, start_date, start_time, end_date, event_type, organizer,
          player_count, capacity, price, url, image_url, shop_id, scraped_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        event.externalId, event.name, event.description ?? null, event.location ?? null,
        event.address ?? null, event.city ?? null, event.state ?? null,
        event.country ?? null, event.latitude ?? null, event.longitude ?? null,
        event.startDate.toISOString(), event.startTime ?? null,
        event.endDate?.toISOString() ?? null, event.eventType ?? null,
        event.organizer ?? null, event.playerCount ?? null, event.capacity ?? null,
        event.price ?? null, event.url ?? null, event.imageUrl ?? null, shopId
      );
      return { created: true };
    }
  } else {
    const pool = getPgPool();
    const result = await pool.query(
      `INSERT INTO events (
        external_id, name, description, location, address, city, state, country,
        latitude, longitude, start_date, start_time, end_date, event_type, organizer,
        player_count, capacity, price, url, image_url, shop_id, scraped_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW())
      ON CONFLICT (external_id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        location = EXCLUDED.location, address = EXCLUDED.address,
        city = EXCLUDED.city, state = EXCLUDED.state, country = EXCLUDED.country,
        latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
        start_date = EXCLUDED.start_date, start_time = EXCLUDED.start_time,
        end_date = EXCLUDED.end_date, event_type = EXCLUDED.event_type,
        organizer = EXCLUDED.organizer, player_count = EXCLUDED.player_count,
        capacity = EXCLUDED.capacity, price = EXCLUDED.price,
        url = EXCLUDED.url, image_url = EXCLUDED.image_url,
        shop_id = EXCLUDED.shop_id, scraped_at = NOW(), updated_at = NOW()
      RETURNING (xmax = 0) as created`,
      [
        event.externalId, event.name, event.description ?? null, event.location ?? null,
        event.address ?? null, event.city ?? null, event.state ?? null,
        event.country ?? null, event.latitude ?? null, event.longitude ?? null,
        event.startDate, event.startTime ?? null, event.endDate ?? null,
        event.eventType ?? null, event.organizer ?? null, event.playerCount ?? null,
        event.capacity ?? null, event.price ?? null, event.url ?? null, event.imageUrl ?? null, shopId,
      ]
    );
    return { created: result.rows[0].created };
  }
}

// Get all shops that need geocoding
export function getShopsToGeocode(): Shop[] {
  if (useSqlite()) {
    const db = getSqliteDb();
    const rows = db.prepare(`
      SELECT id, external_id, name, location_text, latitude, longitude, geocode_status, geocode_error
      FROM shops
      WHERE geocode_status = 'pending' AND location_text IS NOT NULL AND location_text != ''
    `).all() as Array<{
      id: number;
      external_id: number;
      name: string;
      location_text: string | null;
      latitude: number | null;
      longitude: number | null;
      geocode_status: string;
      geocode_error: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      externalId: row.external_id,
      name: row.name,
      locationText: row.location_text,
      latitude: row.latitude,
      longitude: row.longitude,
      geocodeStatus: row.geocode_status,
      geocodeError: row.geocode_error,
    }));
  } else {
    // PostgreSQL - this is sync for simplicity but could be async
    throw new Error('getShopsToGeocode not implemented for PostgreSQL yet');
  }
}

// Update shop with geocoding results
export function updateShopGeocode(
  shopId: number,
  result: { latitude: number; longitude: number } | { error: string }
): void {
  if (useSqlite()) {
    const db = getSqliteDb();

    if ('error' in result) {
      db.prepare(`
        UPDATE shops SET
          geocode_status = 'failed',
          geocode_error = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(result.error, shopId);
    } else {
      db.prepare(`
        UPDATE shops SET
          latitude = ?,
          longitude = ?,
          geocode_status = 'completed',
          geocode_error = NULL,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(result.latitude, result.longitude, shopId);
    }
  } else {
    throw new Error('updateShopGeocode not implemented for PostgreSQL yet');
  }
}

// Delete events older than specified days
export async function deleteOldEvents(daysOld = 60): Promise<number> {
  if (useDynamoDB()) {
    return deleteOldEventsDynamoDB(daysOld);
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  const cutoffIso = cutoffDate.toISOString();

  if (useSqlite()) {
    const db = getSqliteDb();
    const result = db.prepare(`
      DELETE FROM events WHERE start_date < ?
    `).run(cutoffIso);
    return result.changes;
  } else {
    const pool = getPgPool();
    const result = await pool.query(
      `DELETE FROM events WHERE start_date < $1`,
      [cutoffIso]
    );
    return result.rowCount || 0;
  }
}

// Photon queue management
export interface PhotonQueueItem {
  id: number;
  osmId: number;
  photonData: string;
  createdAt: string;
}

// Add a city to the Photon import queue
// Uses IGNORE to skip duplicates (same osm_id)
export function addToPhotonQueue(osmId: number, photonData: object): void {
  if (useSqlite()) {
    const db = getSqliteDb();
    db.prepare(`
      INSERT OR IGNORE INTO photon_queue (osm_id, photon_data)
      VALUES (?, ?)
    `).run(osmId, JSON.stringify(photonData));
  } else {
    throw new Error('addToPhotonQueue not implemented for PostgreSQL yet');
  }
}

// Get all pending items from the Photon queue
export function getPhotonQueue(): PhotonQueueItem[] {
  if (useSqlite()) {
    const db = getSqliteDb();
    const rows = db.prepare(`
      SELECT id, osm_id, photon_data, created_at
      FROM photon_queue
      ORDER BY created_at ASC
    `).all() as Array<{
      id: number;
      osm_id: number;
      photon_data: string;
      created_at: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      osmId: row.osm_id,
      photonData: row.photon_data,
      createdAt: row.created_at,
    }));
  } else {
    throw new Error('getPhotonQueue not implemented for PostgreSQL yet');
  }
}

// Clear the Photon queue after successful import
export function clearPhotonQueue(itemIds: number[]): void {
  if (useSqlite()) {
    if (itemIds.length === 0) return;

    const db = getSqliteDb();
    const placeholders = itemIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM photon_queue WHERE id IN (${placeholders})`).run(...itemIds);
  } else {
    throw new Error('clearPhotonQueue not implemented for PostgreSQL yet');
  }
}

export async function closePool(): Promise<void> {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
}
