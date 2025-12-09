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
  endDate?: Date | null;
  eventType?: string | null;
  organizer?: string | null;
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
      end_date TEXT,
      event_type TEXT,
      organizer TEXT,
      url TEXT,
      image_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      scraped_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_external_id ON events(external_id);
    CREATE INDEX IF NOT EXISTS idx_events_start_date ON events(start_date);
    CREATE INDEX IF NOT EXISTS idx_events_city ON events(city);

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

export async function upsertEvent(event: ScrapedEvent): Promise<{ created: boolean }> {
  if (useSqlite()) {
    const db = getSqliteDb();

    // Check if exists
    const existing = db.prepare('SELECT id FROM events WHERE external_id = ?').get(event.externalId);

    if (existing) {
      db.prepare(`
        UPDATE events SET
          name = ?, description = ?, location = ?, address = ?, city = ?, state = ?,
          country = ?, latitude = ?, longitude = ?, start_date = ?, end_date = ?,
          event_type = ?, organizer = ?, url = ?, image_url = ?,
          scraped_at = datetime('now'), updated_at = datetime('now')
        WHERE external_id = ?
      `).run(
        event.name, event.description ?? null, event.location ?? null,
        event.address ?? null, event.city ?? null, event.state ?? null,
        event.country ?? null, event.latitude ?? null, event.longitude ?? null,
        event.startDate.toISOString(), event.endDate?.toISOString() ?? null,
        event.eventType ?? null, event.organizer ?? null, event.url ?? null,
        event.imageUrl ?? null, event.externalId
      );
      return { created: false };
    } else {
      db.prepare(`
        INSERT INTO events (
          external_id, name, description, location, address, city, state, country,
          latitude, longitude, start_date, end_date, event_type, organizer, url,
          image_url, scraped_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        event.externalId, event.name, event.description ?? null, event.location ?? null,
        event.address ?? null, event.city ?? null, event.state ?? null,
        event.country ?? null, event.latitude ?? null, event.longitude ?? null,
        event.startDate.toISOString(), event.endDate?.toISOString() ?? null,
        event.eventType ?? null, event.organizer ?? null, event.url ?? null,
        event.imageUrl ?? null
      );
      return { created: true };
    }
  } else {
    const result = await getPgPool().query(
      `INSERT INTO events (
        external_id, name, description, location, address, city, state, country,
        latitude, longitude, start_date, end_date, event_type, organizer, url,
        image_url, scraped_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
      ON CONFLICT (external_id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        location = EXCLUDED.location, address = EXCLUDED.address,
        city = EXCLUDED.city, state = EXCLUDED.state, country = EXCLUDED.country,
        latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
        start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
        event_type = EXCLUDED.event_type, organizer = EXCLUDED.organizer,
        url = EXCLUDED.url, image_url = EXCLUDED.image_url,
        scraped_at = NOW(), updated_at = NOW()
      RETURNING (xmax = 0) as created`,
      [
        event.externalId, event.name, event.description ?? null, event.location ?? null,
        event.address ?? null, event.city ?? null, event.state ?? null,
        event.country ?? null, event.latitude ?? null, event.longitude ?? null,
        event.startDate, event.endDate ?? null, event.eventType ?? null,
        event.organizer ?? null, event.url ?? null, event.imageUrl ?? null,
      ]
    );
    return { created: result.rows[0].created };
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
