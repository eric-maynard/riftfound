import { Pool } from 'pg';
import Database from 'better-sqlite3';
import { env } from './config.js';

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
      name TEXT UNIQUE NOT NULL,
      location_text TEXT,
      latitude REAL,
      longitude REAL,
      geocode_status TEXT DEFAULT 'pending',
      geocode_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_shops_name ON shops(name);
    CREATE INDEX IF NOT EXISTS idx_shops_geocode_status ON shops(geocode_status);

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
  `);

  // Add new columns if they don't exist (migrations for existing DBs)
  try {
    db.exec(`ALTER TABLE events ADD COLUMN start_time TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE events ADD COLUMN player_count INTEGER`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE events ADD COLUMN price TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE events ADD COLUMN shop_id INTEGER REFERENCES shops(id)`);
  } catch { /* column exists */ }
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

// Public API
export async function startScrapeRun(): Promise<string> {
  if (useSqlite()) {
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
  if (useSqlite()) {
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
  if (useSqlite()) {
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

// Upsert a shop and return its id
async function upsertShop(name: string, locationText: string | null): Promise<number> {
  if (useSqlite()) {
    const db = getSqliteDb();

    // Check if exists
    const existing = db.prepare('SELECT id FROM shops WHERE name = ?').get(name) as { id: number } | undefined;

    if (existing) {
      // Update location_text if we have a better one
      if (locationText) {
        db.prepare(`
          UPDATE shops SET location_text = ?, updated_at = datetime('now')
          WHERE name = ? AND (location_text IS NULL OR location_text = '')
        `).run(locationText, name);
      }
      return existing.id;
    } else {
      const result = db.prepare(`
        INSERT INTO shops (name, location_text) VALUES (?, ?)
      `).run(name, locationText);
      return result.lastInsertRowid as number;
    }
  } else {
    const pool = getPgPool();
    const result = await pool.query(
      `INSERT INTO shops (name, location_text)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET
         location_text = COALESCE(NULLIF(shops.location_text, ''), EXCLUDED.location_text),
         updated_at = NOW()
       RETURNING id`,
      [name, locationText]
    );
    return result.rows[0].id;
  }
}

// Upsert a shop with full info from API (includes coordinates)
export async function upsertShopFromApi(store: StoreInfo): Promise<number> {
  if (useSqlite()) {
    const db = getSqliteDb();

    // Check if exists
    const existing = db.prepare('SELECT id FROM shops WHERE name = ?').get(store.name) as { id: number } | undefined;

    if (existing) {
      // Update with API data (always has better info)
      db.prepare(`
        UPDATE shops SET
          location_text = ?,
          latitude = ?,
          longitude = ?,
          geocode_status = 'completed',
          updated_at = datetime('now')
        WHERE id = ?
      `).run(store.full_address, store.latitude, store.longitude, existing.id);
      return existing.id;
    } else {
      const result = db.prepare(`
        INSERT INTO shops (name, location_text, latitude, longitude, geocode_status)
        VALUES (?, ?, ?, ?, 'completed')
      `).run(store.name, store.full_address, store.latitude, store.longitude);
      return result.lastInsertRowid as number;
    }
  } else {
    const pool = getPgPool();
    const result = await pool.query(
      `INSERT INTO shops (name, location_text, latitude, longitude, geocode_status)
       VALUES ($1, $2, $3, $4, 'completed')
       ON CONFLICT (name) DO UPDATE SET
         location_text = EXCLUDED.location_text,
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         geocode_status = 'completed',
         updated_at = NOW()
       RETURNING id`,
      [store.name, store.full_address, store.latitude, store.longitude]
    );
    return result.rows[0].id;
  }
}

// Upsert event with store info from API (no geocoding needed)
export async function upsertEventWithStore(
  event: ScrapedEvent,
  storeInfo: StoreInfo | null
): Promise<{ created: boolean }> {
  // First, upsert the shop with full coordinates from API
  let shopId: number | null = null;
  if (storeInfo) {
    shopId = await upsertShopFromApi(storeInfo);
  }

  // Then upsert the event with the shop reference
  return upsertEventInternal(event, shopId);
}

export async function upsertEvent(event: ScrapedEvent): Promise<{ created: boolean }> {
  // First, upsert the shop if we have an organizer
  let shopId: number | null = null;
  if (event.organizer) {
    shopId = await upsertShop(event.organizer, event.location ?? null);
  }
  return upsertEventInternal(event, shopId);
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
          end_date = ?, event_type = ?, organizer = ?, player_count = ?, price = ?,
          url = ?, image_url = ?, shop_id = ?, scraped_at = datetime('now'), updated_at = datetime('now')
        WHERE external_id = ?
      `).run(
        event.name, event.description ?? null, event.location ?? null,
        event.address ?? null, event.city ?? null, event.state ?? null,
        event.country ?? null, event.latitude ?? null, event.longitude ?? null,
        event.startDate.toISOString(), event.startTime ?? null,
        event.endDate?.toISOString() ?? null, event.eventType ?? null,
        event.organizer ?? null, event.playerCount ?? null, event.price ?? null,
        event.url ?? null, event.imageUrl ?? null, shopId, event.externalId
      );
      return { created: false };
    } else {
      db.prepare(`
        INSERT INTO events (
          external_id, name, description, location, address, city, state, country,
          latitude, longitude, start_date, start_time, end_date, event_type, organizer,
          player_count, price, url, image_url, shop_id, scraped_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        event.externalId, event.name, event.description ?? null, event.location ?? null,
        event.address ?? null, event.city ?? null, event.state ?? null,
        event.country ?? null, event.latitude ?? null, event.longitude ?? null,
        event.startDate.toISOString(), event.startTime ?? null,
        event.endDate?.toISOString() ?? null, event.eventType ?? null,
        event.organizer ?? null, event.playerCount ?? null, event.price ?? null,
        event.url ?? null, event.imageUrl ?? null, shopId
      );
      return { created: true };
    }
  } else {
    const pool = getPgPool();
    const result = await pool.query(
      `INSERT INTO events (
        external_id, name, description, location, address, city, state, country,
        latitude, longitude, start_date, start_time, end_date, event_type, organizer,
        player_count, price, url, image_url, shop_id, scraped_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW())
      ON CONFLICT (external_id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        location = EXCLUDED.location, address = EXCLUDED.address,
        city = EXCLUDED.city, state = EXCLUDED.state, country = EXCLUDED.country,
        latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
        start_date = EXCLUDED.start_date, start_time = EXCLUDED.start_time,
        end_date = EXCLUDED.end_date, event_type = EXCLUDED.event_type,
        organizer = EXCLUDED.organizer, player_count = EXCLUDED.player_count,
        price = EXCLUDED.price, url = EXCLUDED.url, image_url = EXCLUDED.image_url,
        shop_id = EXCLUDED.shop_id, scraped_at = NOW(), updated_at = NOW()
      RETURNING (xmax = 0) as created`,
      [
        event.externalId, event.name, event.description ?? null, event.location ?? null,
        event.address ?? null, event.city ?? null, event.state ?? null,
        event.country ?? null, event.latitude ?? null, event.longitude ?? null,
        event.startDate, event.startTime ?? null, event.endDate ?? null,
        event.eventType ?? null, event.organizer ?? null, event.playerCount ?? null,
        event.price ?? null, event.url ?? null, event.imageUrl ?? null, shopId,
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
      SELECT id, name, location_text, latitude, longitude, geocode_status, geocode_error
      FROM shops
      WHERE geocode_status = 'pending' AND location_text IS NOT NULL AND location_text != ''
    `).all() as Array<{
      id: number;
      name: string;
      location_text: string | null;
      latitude: number | null;
      longitude: number | null;
      geocode_status: string;
      geocode_error: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
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
