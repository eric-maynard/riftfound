/**
 * Point the scraper at a throwaway SQLite file that already holds an `events`
 * table **created without the `sources` and `play_format` columns**, with one
 * row already in it.
 *
 * This is the state a long-lived database is in, and the only state in which
 * the additive `ALTER TABLE` migrations actually do anything: a fresh database
 * gets the columns from `CREATE TABLE` and proves nothing.
 *
 * Everything older than `sources` is present, because `initSqliteSchema`
 * creates its indexes (`idx_events_shop_id`) in the same `exec` as the tables,
 * before the ALTERs run - so a fixture missing `shop_id` would fail schema
 * initialisation rather than exercise a migration.
 *
 * Like helpers/sqliteEnv.ts, this has to run *before* config.ts and database.ts
 * are evaluated, so a test imports it first.
 */
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(mkdtempSync(join(tmpdir(), 'riftfound-legacy-')), 'legacy.db');

/** An event stored before the format column existed. It can never acquire one. */
export const LEGACY_EVENT_ID = 'prb-100000000000000001';
export const LEGACY_EVENT_START = '2026-10-20T01:00:00.000Z';

const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE events (
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
    shop_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    scraped_at TEXT NOT NULL
  );
`);
legacy
  .prepare(
    `INSERT INTO events (external_id, name, start_date, event_type, latitude, longitude, scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  )
  .run(LEGACY_EVENT_ID, 'A Nexus Night from before the column existed', LEGACY_EVENT_START, 'Nexus Night', 38.0162814, -121.816311);
legacy.close();

process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = dbPath;
