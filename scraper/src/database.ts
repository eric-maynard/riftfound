import { Pool } from 'pg';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { env } from './config.js';
import {
  sanitizeEventResults,
  sanitizeEventRoster,
  sanitizeRankingSnapshot,
  sanitizeScrapedEvent,
  sanitizeStoreInfo,
} from './sanitize.js';
// Value import, but the chain back here is type-only, so there is no cycle.
import { PLAYRIFTBOUND_ID_PREFIX } from './sources/playriftbound.js';
import {
  startScrapeRunDynamoDB,
  completeScrapeRunDynamoDB,
  failScrapeRunDynamoDB,
  upsertShopFromApiDynamoDB,
  updateShopDisplayCityDynamoDB,
  upsertEventWithStoreDynamoDB,
  deleteOldEventsDynamoDB,
  getLastStaleCleanupTimeDynamoDB,
  setLastStaleCleanupTimeDynamoDB,
  cleanupStaleEventsDynamoDB,
  loadUpcomingEventsDynamoDB,
  applyMergedEventFieldsDynamoDB,
  deleteEventsDynamoDB,
  recordScrapeCycleDynamoDB,
  recordShardSeenIdsDynamoDB,
  loadScrapeCyclesDynamoDB,
  loadShopsByGeohash4DynamoDB,
  repointEventsToShopDynamoDB,
  deleteShopsDynamoDB,
  loadEventFactCandidatesDynamoDB,
  putEventResultsDynamoDB,
  putEventRosterDynamoDB,
  getEventResultsDynamoDB,
  loadEventFactsByDateDynamoDB,
  loadEventNamesDynamoDB,
  loadMatchLogMarkersDynamoDB,
  loadShopLabelsDynamoDB,
  saveRankingSnapshotDynamoDB,
  getLastRankingRefitDynamoDB,
  setLastRankingRefitDynamoDB,
  getPlayerProfileDynamoDB,
  getRankingRowsDynamoDB,
  type RankingWriteSummary,
  type StoredEventSummary,
} from './dynamodb.js';
import type {
  PlayerMatchLogEntry,
  PlayerProfile,
  PlayerRatingPoint,
  RankingRow,
  RankingSnapshot,
} from './ranking/items.js';
import type { MergeOwnedFields } from './merge.js';
import type { ScrapeCycle } from './cancellations.js';
import type { ShopCandidate } from './shopMatch.js';

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
  /**
   * Which upstream source(s) this record came from ('uvs', 'playriftbound').
   * Two entries means the two sources' records were field-merged (see merge.ts),
   * and is stored so the origin of a row stays inspectable.
   */
  sources?: string[] | null;
  /**
   * Riot's `RiftboundTournamentConfig.format` enum, verbatim (`CONSTRUCTED`,
   * `SEALED`, …). SQL column `play_format`.
   *
   * **Not called `format`, deliberately.** The frontend already ships a
   * user-facing "Format" filter that actually filters `eventType` (All /
   * Constructed / Sealed / Draft / Multiplayer), so a bare `format` in this
   * schema would collide with an established label that means something else
   * and invite a real bug. `playFormat` is Riot's field and nothing else.
   *
   * Stored raw rather than normalised to title case: it is an enum, and Riot's
   * enums in this feed demonstrably change (see the `tournamentType`
   * correction in scraper/CLAUDE.md), so readers map it, we do not.
   *
   * **Prospective only, and permanently so.** The playriftbound search API is
   * the only surface that exposes it and that API is upcoming-only; the event
   * detail page the results pass reads has no format field at all. So every
   * event that was already stored without it - and every event that happens
   * before this field shipped - will never have one. Null is normal, forever.
   *
   * Only the playriftbound source sets it. No UVS record carries one: the UVS
   * response does have an unused `event_format` string (see ApiEvent in
   * api.ts), but nothing reads it and nothing here is derived from it.
   */
  playFormat?: string | null;
}

// ---------------------------------------------------------------------------
// Tournament facts: who registered for an event, and what happened in it
// (sources/playriftboundResults.ts)
// ---------------------------------------------------------------------------

/**
 * How finished a stored results capture is.
 *
 * `final` - every round FINALIZED. Immutable, never fetched again.
 * `partial` - a round was still live when we looked. Gets one re-check, then is
 *           accepted as-is. (Match status is deliberately not part of this:
 *           Riot leaves matches IN_PROGRESS inside FINALIZED rounds.)
 * `none`  - the event happened but no pairings were ever run through Riot's
 *           software. ~29% of finished events; a fact, not an error.
 */
export type EventResultsStatus = 'final' | 'partial' | 'none';

/** Where a roster came from: dated signups, or who actually played. */
export type RosterSource = 'registrants' | 'participants';

/**
 * Event context copied onto every fact.
 *
 * Deliberately denormalised: a rating pass replaying the whole history needs
 * each match's date, event type and venue, and the event rows themselves are
 * aged out (deleteOldEvents, plus a TTL) long before the facts are.
 */
export interface EventFactContext {
  /** Our event id, e.g. `prb-117209411862156256`. */
  externalId: string;
  /** Riot's tournament id (the external id without the `prb-` prefix). */
  tournamentId: string;
  eventStartDate: Date;
  eventType: string | null;
  /**
   * Riot's event `format` enum as stored on the event row (see
   * `ScrapedEvent.playFormat`). Carried onto every fact because the facts
   * outlive the event rows, and because this is the *only* route by which a
   * rating pass could ever see format: facts are written from the detail page,
   * which has no format field of its own.
   *
   * Null on every fact captured for an event discovered before this field
   * shipped, and on every UVS-only event. That is permanent and normal.
   */
  playFormat: string | null;
  shopExternalId: number | null;
  latitude: number | null;
  longitude: number | null;
}

/** One player in an event's field. `playerId` is Riot's stable account UUID. */
export interface RosterEntry {
  /** Stable Riot UUID - the identity key for everything downstream. */
  playerId: string;
  /** Mutable presentation data: display names are user-editable and churn. */
  name: string | null;
  tagLine: string | null;
  /** `esportsTeamId`, when known - the join key into standings and pairings. */
  teamId: string | null;
  status: string | null;
  checkedIn: boolean | null;
  waitlistPosition: number | null;
  /** When this player signed up (Riot's `acceptedTermsAt`). */
  registeredAt: string | null;
}

export interface EventRoster extends EventFactContext {
  source: RosterSource;
  playerCount: number;
  entries: RosterEntry[];
  capturedAt: string;
}

/** `esportsTeamId` -> the player behind it. In 1v1 Constructed a team is one player. */
export interface ResultPlayer {
  teamId: string;
  playerId: string | null;
  name: string | null;
  tagLine: string | null;
}

export interface ResultStanding {
  rank: number;
  teamId: string;
  matchPoints: number | null;
  matchWins: number | null;
  matchLosses: number | null;
  matchDraws: number | null;
  /** Riot's Swiss tiebreakers, as fractions rounded to 4 places. */
  opponentMatchWinPct: number | null;
  gameWinPct: number | null;
  opponentGameWinPct: number | null;
}

export interface ResultMatchSide {
  teamId: string;
  outcome: string | null;
  gameWins: number;
}

export interface ResultGame {
  number: number;
  winnerTeamId: string | null;
}

export interface ResultMatch {
  matchId: string;
  tableNumber: number | null;
  status: string | null;
  /** A bye, not a played match: it must never count towards a rating. */
  bye: boolean;
  sides: ResultMatchSide[];
  games: ResultGame[];
}

export interface ResultRound {
  /** Index of the stage section this round belongs to (swiss, top cut, …). */
  section: number;
  roundNumber: number;
  status: string | null;
  byeTeamIds: string[];
  matches: ResultMatch[];
}

export interface EventResults extends EventFactContext {
  status: EventResultsStatus;
  roundCount: number;
  playerCount: number;
  /** Matches not yet COMPLETED - why a capture can be `partial`. */
  openMatches: number;
  players: ResultPlayer[];
  /** Final standings only; the per-round tables are reconstructible. */
  standings: ResultStanding[];
  rounds: ResultRound[];
  /** Riot's own `updatedAt` on the tournament. */
  sourceUpdatedAt: string | null;
  capturedAt: string;
  /** True when the pairings were dropped to keep the row inside DynamoDB's item limit. */
  trimmed?: boolean;
}

/** Stored bookkeeping for one event's results capture. */
export interface StoredResultsMeta {
  status: EventResultsStatus;
  /** Successful fetches so far. Capped at MAX_ATTEMPTS. */
  attempts: number;
  lastCheckedAt: Date | null;
}

/** A stored `prb-` event, with what we have already captured for it. */
export interface EventFactCandidate extends EventFactContext {
  results: StoredResultsMeta | null;
  hasRoster: boolean;
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
      sources TEXT,
      -- Riot's RiftboundTournamentConfig.format, verbatim. Named play_format
      -- rather than format because the UI's "Format" filter means event_type;
      -- see ScrapedEvent.playFormat.
      play_format TEXT,
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

    -- Tournament facts (sources/playriftboundResults.ts). One row per event:
    -- the common read is "the results for this event", and a capture is written
    -- once rather than row by row, so there is nothing to gain from splitting
    -- matches or standings out into their own tables.
    CREATE TABLE IF NOT EXISTS event_results (
      external_id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL,
      event_start_date TEXT NOT NULL,
      event_type TEXT,
      play_format TEXT,
      shop_external_id INTEGER,
      latitude REAL,
      longitude REAL,
      status TEXT NOT NULL,
      round_count INTEGER NOT NULL DEFAULT 0,
      player_count INTEGER NOT NULL DEFAULT 0,
      open_matches INTEGER NOT NULL DEFAULT 0,
      trimmed INTEGER NOT NULL DEFAULT 0,
      source_updated_at TEXT,
      digest TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_captured_at TEXT NOT NULL,
      last_checked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_event_results_start ON event_results(event_start_date);

    CREATE TABLE IF NOT EXISTS event_rosters (
      external_id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL,
      event_start_date TEXT NOT NULL,
      event_type TEXT,
      play_format TEXT,
      shop_external_id INTEGER,
      latitude REAL,
      longitude REAL,
      source TEXT NOT NULL,
      player_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_event_rosters_start ON event_rosters(event_start_date);

    -- Derived player ratings (ranking/). Mirrors the DynamoDB key shapes so the
    -- two backends answer the same questions: a player's partition is one
    -- player_id, a ladder page is one (scope, page).
    CREATE TABLE IF NOT EXISTS player_profiles (
      player_id TEXT PRIMARY KEY,
      display_name TEXT,
      rating REAL,
      rated INTEGER NOT NULL DEFAULT 0,
      component_id TEXT,
      payload TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS player_rating_history (
      player_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      date TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (player_id, scope, date)
    );

    CREATE TABLE IF NOT EXISTS player_matches (
      player_id TEXT NOT NULL,
      played_at TEXT NOT NULL,
      match_id TEXT NOT NULL,
      event_external_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (player_id, played_at, match_id)
    );

    -- One row per player per leaderboard, keyed by rank: the SQLite mirror of
    -- the RANKING#<scope> / RANK#<nnnnnn>#<playerId> items.
    CREATE TABLE IF NOT EXISTS ranking_rows (
      scope TEXT NOT NULL,
      rank INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (scope, player_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ranking_rows_rank ON ranking_rows(scope, rank);

    CREATE TABLE IF NOT EXISTS ranking_meta (
      scope TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ranking_components (
      component_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ranking_sets (
      set_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );

    -- Write-once bookkeeping for the per-player match log, so a refit does not
    -- re-emit entries it already wrote.
    CREATE TABLE IF NOT EXISTS ranking_log_markers (
      event_external_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      written_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ranking_state (
      key TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
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
    db.exec(`ALTER TABLE events ADD COLUMN capacity INTEGER`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE events ADD COLUMN price TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE events ADD COLUMN sources TEXT`);
  } catch { /* column exists */ }
  // Riot's event format (see ScrapedEvent.playFormat). Additive: existing rows
  // keep NULL, which is the permanent and correct value for them - the field
  // cannot be backfilled.
  try {
    db.exec(`ALTER TABLE events ADD COLUMN play_format TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE event_results ADD COLUMN play_format TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE event_rosters ADD COLUMN play_format TEXT`);
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
export async function upsertShopFromApi(rawStore: StoreInfo): Promise<UpsertShopResult> {
  // Store names are free text typed by store owners and reach the DB verbatim,
  // so they are cleaned here as well as at the event boundary (see sanitize.ts).
  const store = sanitizeStoreInfo(rawStore);

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
  rawEvent: ScrapedEvent,
  rawStoreInfo: StoreInfo | null,
  options: { existingShop?: boolean } = {}
): Promise<UpsertEventResult> {
  // Single choke point for both sources and all three backends: nothing reaches
  // a table without having its free text stripped of markup first (sanitize.ts).
  const event = sanitizeScrapedEvent(rawEvent);
  const storeInfo = rawStoreInfo ? sanitizeStoreInfo(rawStoreInfo) : null;

  if (useDynamoDB()) {
    return upsertEventWithStoreDynamoDB(event, storeInfo, options);
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

/**
 * Sources are stored as a comma separated list ('uvs', 'uvs,playriftbound') so a
 * merged row's origin can be read straight out of the table.
 */
function serializeSources(sources: string[] | null | undefined): string | null {
  return sources && sources.length > 0 ? sources.join(',') : null;
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
          price = ?, url = ?, image_url = ?, sources = ?, play_format = ?, shop_id = ?,
          scraped_at = datetime('now'), updated_at = datetime('now')
        WHERE external_id = ?
      `).run(
        event.name, event.description ?? null, event.location ?? null,
        event.address ?? null, event.city ?? null, event.state ?? null,
        event.country ?? null, event.latitude ?? null, event.longitude ?? null,
        event.startDate.toISOString(), event.startTime ?? null,
        event.endDate?.toISOString() ?? null, event.eventType ?? null,
        event.organizer ?? null, event.playerCount ?? null, event.capacity ?? null,
        event.price ?? null, event.url ?? null, event.imageUrl ?? null,
        serializeSources(event.sources), event.playFormat ?? null, shopId, event.externalId
      );
      return { created: false };
    } else {
      db.prepare(`
        INSERT INTO events (
          external_id, name, description, location, address, city, state, country,
          latitude, longitude, start_date, start_time, end_date, event_type, organizer,
          player_count, capacity, price, url, image_url, sources, play_format, shop_id, scraped_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        event.externalId, event.name, event.description ?? null, event.location ?? null,
        event.address ?? null, event.city ?? null, event.state ?? null,
        event.country ?? null, event.latitude ?? null, event.longitude ?? null,
        event.startDate.toISOString(), event.startTime ?? null,
        event.endDate?.toISOString() ?? null, event.eventType ?? null,
        event.organizer ?? null, event.playerCount ?? null, event.capacity ?? null,
        event.price ?? null, event.url ?? null, event.imageUrl ?? null,
        serializeSources(event.sources), event.playFormat ?? null, shopId
      );
      return { created: true };
    }
  } else {
    // Note: the PostgreSQL dev schema (infrastructure/init.sql) has neither a
    // `sources` nor a `play_format` column, so origin tracking and Riot's event
    // format are persisted on SQLite and DynamoDB only.
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

// Check if stale event cleanup should run (once per day)
export async function shouldRunStaleCleanup(): Promise<boolean> {
  if (!useDynamoDB()) return false;

  const lastRun = await getLastStaleCleanupTimeDynamoDB();
  if (!lastRun) return true;

  const hoursSinceLastRun = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60);
  return hoursSinceLastRun >= 24;
}

// Remove upcoming events that no longer appear in the upstream API
/**
 * Remove upcoming events that no longer appear in any source.
 *
 * `protectedExternalIdPrefixes` shields events belonging to a source that did not
 * run this cycle (disabled or failed), so a temporary source outage cannot delete
 * that source's events.
 */
export async function cleanupStaleEvents(
  seenExternalIds: Set<string>,
  protectedExternalIdPrefixes: string[] = []
): Promise<number> {
  if (!useDynamoDB()) return 0;

  const deleted = await cleanupStaleEventsDynamoDB(seenExternalIds, protectedExternalIdPrefixes);
  await setLastStaleCleanupTimeDynamoDB(new Date().toISOString());
  return deleted;
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

// ---------------------------------------------------------------------------
// Sharded Lambda support (DynamoDB only)
// ---------------------------------------------------------------------------

export type { StoredEventSummary } from './dynamodb.js';
export type { RankingWriteSummary } from './dynamodb.js';

/** Whether the table-backed playriftbound pass (lambda.ts) can run on this backend. */
export function supportsStoredEventReads(): boolean {
  return useDynamoDB();
}

/** Upcoming stored events (UVS and playriftbound rows) for the next `daysForward` days. */
export async function loadUpcomingEvents(daysForward = 90): Promise<StoredEventSummary[]> {
  if (!useDynamoDB()) throw new Error('loadUpcomingEvents is only implemented for DynamoDB');
  return loadUpcomingEventsDynamoDB(daysForward);
}

/** Write field-merge results onto an existing event row. */
export async function applyMergedEventFields(
  externalId: string,
  changes: Partial<MergeOwnedFields>
): Promise<boolean> {
  if (!useDynamoDB()) throw new Error('applyMergedEventFields is only implemented for DynamoDB');
  return applyMergedEventFieldsDynamoDB(externalId, changes);
}

/** Delete event rows by external id. */
export async function deleteEventsByExternalId(externalIds: string[]): Promise<number> {
  if (!useDynamoDB()) throw new Error('deleteEventsByExternalId is only implemented for DynamoDB');
  return deleteEventsDynamoDB(externalIds);
}

/** Record a sharded scrape cycle (coordinator). */
export async function recordScrapeCycle(cycle: { cycleId: string; shardCount: number; totalExpected: number }): Promise<void> {
  if (!useDynamoDB()) return;
  return recordScrapeCycleDynamoDB(cycle);
}

/** Record the UVS event ids one shard saw (worker). */
export async function recordShardSeenIds(
  cycleId: string,
  shardIndex: number,
  ids: Iterable<string>,
  complete: boolean
): Promise<void> {
  if (!useDynamoDB()) return;
  return recordShardSeenIdsDynamoDB(cycleId, shardIndex, ids, complete);
}

/** Scrape cycles started within [since, until], newest first. */
export async function loadScrapeCycles(since: Date, until: Date): Promise<ScrapeCycle[]> {
  if (!useDynamoDB()) return [];
  return loadScrapeCyclesDynamoDB(since, until);
}

/** Shop rows in the given precision-4 geohash cells. */
export async function loadShopsByGeohash4(cells: string[]): Promise<ShopCandidate[]> {
  if (!useDynamoDB()) throw new Error('loadShopsByGeohash4 is only implemented for DynamoDB');
  return loadShopsByGeohash4DynamoDB(cells);
}

/** Point stored events at another shop row. */
export async function repointEventsToShop(
  events: { externalId: string; startDate: Date }[],
  shop: ShopCandidate
): Promise<number> {
  if (!useDynamoDB()) throw new Error('repointEventsToShop is only implemented for DynamoDB');
  return repointEventsToShopDynamoDB(events, shop);
}

/** Delete shop rows by external id. */
export async function deleteShopsByExternalId(externalIds: number[]): Promise<number> {
  if (!useDynamoDB()) throw new Error('deleteShopsByExternalId is only implemented for DynamoDB');
  return deleteShopsDynamoDB(externalIds);
}

// ---------------------------------------------------------------------------
// Tournament facts (sources/playriftboundResults.ts)
// ---------------------------------------------------------------------------

/**
 * Whether this backend can store tournament facts.
 *
 * PostgreSQL is the dev-only backend and its schema (infrastructure/init.sql) is
 * not managed from here, so it is left out rather than half-supported.
 */
export function supportsEventFacts(): boolean {
  return useDynamoDB() || useSqlite();
}

/**
 * Fingerprint of a capture's actual content, metadata excluded.
 *
 * Results are immutable once an organizer finalises them, so a re-check almost
 * always reads back exactly what we already stored. Comparing digests lets the
 * re-check write only its bookkeeping (attempt counter, timestamp) instead of
 * rewriting the whole row - the same skip-unchanged discipline the event upsert
 * uses, and the reason a re-check costs almost nothing.
 */
export function eventResultsDigest(results: EventResults): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        results.status,
        results.openMatches,
        results.sourceUpdatedAt,
        results.trimmed ?? false,
        results.players,
        results.standings,
        results.rounds,
      ])
    )
    .digest('hex');
}

/** The content half of a results row, stored as one JSON blob on SQLite. */
function resultsPayload(results: EventResults): string {
  return JSON.stringify({
    players: results.players,
    standings: results.standings,
    rounds: results.rounds,
  });
}

/**
 * Stored `prb-` events in the window, with whatever we have already captured.
 *
 * `daysBack` covers finished events awaiting a results capture, `daysForward`
 * the ones close enough to their start to be worth a roster snapshot.
 */
export async function loadEventFactCandidates(
  window: { daysBack: number; daysForward: number }
): Promise<EventFactCandidate[]> {
  if (useDynamoDB()) return loadEventFactCandidatesDynamoDB(window);
  if (!useSqlite()) throw new Error('loadEventFactCandidates is not implemented for PostgreSQL');

  const db = getSqliteDb();
  const since = new Date(Date.now() - window.daysBack * 86_400_000).toISOString();
  const until = new Date(Date.now() + window.daysForward * 86_400_000).toISOString();

  const rows = db.prepare(`
    SELECT
      e.external_id, e.start_date, e.event_type, e.play_format, e.latitude, e.longitude,
      s.external_id AS shop_external_id,
      r.status AS results_status, r.attempts AS results_attempts, r.last_checked_at,
      ro.external_id AS roster_external_id
    FROM events e
    LEFT JOIN shops s ON s.id = e.shop_id
    LEFT JOIN event_results r ON r.external_id = e.external_id
    LEFT JOIN event_rosters ro ON ro.external_id = e.external_id
    WHERE e.external_id LIKE ? AND e.start_date >= ? AND e.start_date <= ?
  `).all(`${PLAYRIFTBOUND_ID_PREFIX}%`, since, until) as Array<{
    external_id: string;
    start_date: string;
    event_type: string | null;
    play_format: string | null;
    latitude: number | null;
    longitude: number | null;
    shop_external_id: number | null;
    results_status: EventResultsStatus | null;
    results_attempts: number | null;
    last_checked_at: string | null;
    roster_external_id: string | null;
  }>;

  return rows.map(row => ({
    externalId: row.external_id,
    tournamentId: row.external_id.slice(PLAYRIFTBOUND_ID_PREFIX.length),
    eventStartDate: new Date(row.start_date),
    eventType: row.event_type,
    // Null for every event stored before this column existed - permanent, and
    // never an error (see EventFactContext.playFormat).
    playFormat: row.play_format ?? null,
    shopExternalId: row.shop_external_id,
    latitude: row.latitude,
    longitude: row.longitude,
    results: row.results_status
      ? {
          status: row.results_status,
          attempts: row.results_attempts ?? 0,
          lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at) : null,
        }
      : null,
    hasRoster: row.roster_external_id !== null,
  }));
}

/**
 * Store one event's results capture.
 *
 * Player display names and tag lines are cleaned here as well as at the
 * converter, so no code path can write raw text to a table (see sanitize.ts).
 */
export async function saveEventResults(rawResults: EventResults): Promise<{ skipped: boolean }> {
  const results = sanitizeEventResults(rawResults);
  const digest = eventResultsDigest(results);

  if (useDynamoDB()) return putEventResultsDynamoDB(results, digest);
  if (!useSqlite()) throw new Error('saveEventResults is not implemented for PostgreSQL');

  const db = getSqliteDb();
  const now = new Date().toISOString();
  const existing = db.prepare(
    'SELECT digest, attempts, first_captured_at FROM event_results WHERE external_id = ?'
  ).get(results.externalId) as { digest: string; attempts: number; first_captured_at: string } | undefined;

  const attempts = (existing?.attempts ?? 0) + 1;

  if (existing && existing.digest === digest) {
    // Nothing new on the page: only the bookkeeping moves.
    db.prepare(
      'UPDATE event_results SET attempts = ?, last_checked_at = ? WHERE external_id = ?'
    ).run(attempts, now, results.externalId);
    return { skipped: true };
  }

  db.prepare(`
    INSERT INTO event_results (
      external_id, tournament_id, event_start_date, event_type, play_format, shop_external_id,
      latitude, longitude, status, round_count, player_count, open_matches, trimmed,
      source_updated_at, digest, payload, attempts, first_captured_at, last_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      status = excluded.status, round_count = excluded.round_count,
      player_count = excluded.player_count, open_matches = excluded.open_matches,
      trimmed = excluded.trimmed, source_updated_at = excluded.source_updated_at,
      digest = excluded.digest, payload = excluded.payload,
      attempts = excluded.attempts, last_checked_at = excluded.last_checked_at
  `).run(
    results.externalId, results.tournamentId, results.eventStartDate.toISOString(),
    results.eventType, results.playFormat ?? null, results.shopExternalId,
    results.latitude, results.longitude,
    results.status, results.roundCount, results.playerCount, results.openMatches,
    results.trimmed ? 1 : 0, results.sourceUpdatedAt, digest, resultsPayload(results),
    attempts, existing?.first_captured_at ?? results.capturedAt, now
  );
  return { skipped: false };
}

/**
 * Store one event's roster.
 *
 * Rosters are write-once facts: a dated registrant list cannot be reconstructed
 * later, so an existing row is never replaced by a thinner one.
 */
export async function saveEventRoster(rawRoster: EventRoster): Promise<{ skipped: boolean }> {
  const roster = sanitizeEventRoster(rawRoster);

  if (useDynamoDB()) return putEventRosterDynamoDB(roster);
  if (!useSqlite()) throw new Error('saveEventRoster is not implemented for PostgreSQL');

  const db = getSqliteDb();
  const result = db.prepare(`
    INSERT INTO event_rosters (
      external_id, tournament_id, event_start_date, event_type, play_format, shop_external_id,
      latitude, longitude, source, player_count, payload, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO NOTHING
  `).run(
    roster.externalId, roster.tournamentId, roster.eventStartDate.toISOString(),
    roster.eventType, roster.playFormat ?? null, roster.shopExternalId,
    roster.latitude, roster.longitude,
    roster.source, roster.playerCount, JSON.stringify({ entries: roster.entries }),
    roster.capturedAt
  );
  return { skipped: result.changes === 0 };
}

/**
 * The results for one event, in a single lookup.
 *
 * This is the read everything downstream does, and the reason a capture is one
 * row rather than a row per match or per standing.
 */
export async function getEventResults(externalId: string): Promise<EventResults | null> {
  if (useDynamoDB()) return getEventResultsDynamoDB(externalId);
  if (!useSqlite()) throw new Error('getEventResults is not implemented for PostgreSQL');

  const row = getSqliteDb()
    .prepare('SELECT * FROM event_results WHERE external_id = ?')
    .get(externalId) as SqliteResultsRow | undefined;
  return row ? resultsFromSqliteRow(row) : null;
}

/**
 * Every fact recorded for events that started on one UTC day.
 *
 * A rating pass replays history by walking these day by day: on DynamoDB each
 * call is two Queries against GSI1's `RESULTS#<date>` / `ROSTER#<date>`
 * partitions, so the whole history is readable in order without ever scanning
 * the table.
 */
export async function loadEventFactsByDate(
  date: string
): Promise<{ results: EventResults[]; rosters: EventRoster[] }> {
  if (useDynamoDB()) return loadEventFactsByDateDynamoDB(date);
  if (!useSqlite()) throw new Error('loadEventFactsByDate is not implemented for PostgreSQL');

  const db = getSqliteDb();
  const from = `${date}T00:00:00.000Z`;
  const to = `${date}T23:59:59.999Z`;
  const results = (db.prepare(
    'SELECT * FROM event_results WHERE event_start_date BETWEEN ? AND ? ORDER BY event_start_date'
  ).all(from, to) as SqliteResultsRow[]).map(resultsFromSqliteRow);
  const rosters = (db.prepare(
    'SELECT * FROM event_rosters WHERE event_start_date BETWEEN ? AND ? ORDER BY event_start_date'
  ).all(from, to) as SqliteRosterRow[]).map(rosterFromSqliteRow);
  return { results, rosters };
}

interface SqliteResultsRow {
  external_id: string;
  tournament_id: string;
  event_start_date: string;
  event_type: string | null;
  play_format: string | null;
  shop_external_id: number | null;
  latitude: number | null;
  longitude: number | null;
  status: EventResultsStatus;
  round_count: number;
  player_count: number;
  open_matches: number;
  trimmed: number;
  source_updated_at: string | null;
  payload: string;
  first_captured_at: string;
  last_checked_at: string;
}

interface SqliteRosterRow {
  external_id: string;
  tournament_id: string;
  event_start_date: string;
  event_type: string | null;
  play_format: string | null;
  shop_external_id: number | null;
  latitude: number | null;
  longitude: number | null;
  source: RosterSource;
  player_count: number;
  payload: string;
  captured_at: string;
}

function resultsFromSqliteRow(row: SqliteResultsRow): EventResults {
  const payload = JSON.parse(row.payload) as Pick<EventResults, 'players' | 'standings' | 'rounds'>;
  return {
    externalId: row.external_id,
    tournamentId: row.tournament_id,
    eventStartDate: new Date(row.event_start_date),
    eventType: row.event_type,
    playFormat: row.play_format ?? null,
    shopExternalId: row.shop_external_id,
    latitude: row.latitude,
    longitude: row.longitude,
    status: row.status,
    roundCount: row.round_count,
    playerCount: row.player_count,
    openMatches: row.open_matches,
    players: payload.players ?? [],
    standings: payload.standings ?? [],
    rounds: payload.rounds ?? [],
    sourceUpdatedAt: row.source_updated_at,
    capturedAt: row.first_captured_at,
    trimmed: row.trimmed === 1,
  };
}

function rosterFromSqliteRow(row: SqliteRosterRow): EventRoster {
  const payload = JSON.parse(row.payload) as { entries?: RosterEntry[] };
  return {
    externalId: row.external_id,
    tournamentId: row.tournament_id,
    eventStartDate: new Date(row.event_start_date),
    eventType: row.event_type,
    playFormat: row.play_format ?? null,
    shopExternalId: row.shop_external_id,
    latitude: row.latitude,
    longitude: row.longitude,
    source: row.source,
    playerCount: row.player_count,
    entries: payload.entries ?? [],
    capturedAt: row.captured_at,
  };
}

// ---------------------------------------------------------------------------
// Derived player ratings (ranking/)
// ---------------------------------------------------------------------------

/**
 * Whether this backend can store derived ratings.
 *
 * Same rule as supportsEventFacts: DynamoDB is production and SQLite is dev,
 * while PostgreSQL's schema (infrastructure/init.sql) is not managed from here
 * and is left out rather than half-supported. Keeping SQLite in means
 * `./dev.sh` can run a real refit, and the storage-shape tests run against a
 * real throwaway database rather than a mock.
 */
export function supportsRankingWrites(): boolean {
  return useDynamoDB() || useSqlite();
}

/** Events whose per-player match log is already written at `version`. */
export async function loadMatchLogMarkers(
  eventExternalIds: string[],
  version: number
): Promise<Set<string>> {
  if (eventExternalIds.length === 0) return new Set();
  if (useDynamoDB()) return loadMatchLogMarkersDynamoDB(eventExternalIds, version);
  if (!useSqlite()) throw new Error('loadMatchLogMarkers is not implemented for PostgreSQL');

  const db = getSqliteDb();
  const done = new Set<string>();
  const statement = db.prepare(
    'SELECT event_external_id FROM ranking_log_markers WHERE event_external_id = ? AND version = ?'
  );
  for (const externalId of eventExternalIds) {
    if (statement.get(externalId, version)) done.add(externalId);
  }
  return done;
}

/** Human-readable region labels for shop venues. */
export async function loadShopLabels(externalIds: number[]): Promise<Map<number, string>> {
  if (externalIds.length === 0) return new Map();
  if (useDynamoDB()) return loadShopLabelsDynamoDB(externalIds);
  if (!useSqlite()) throw new Error('loadShopLabels is not implemented for PostgreSQL');

  const db = getSqliteDb();
  const labels = new Map<number, string>();
  // Same preference as the DynamoDB path: the reverse-geocoded "City, ST" the
  // frontend already shows, falling back to the raw address text.
  const statement = db.prepare(
    'SELECT external_id, display_city, location_text FROM shops WHERE external_id = ?'
  );
  for (const externalId of externalIds) {
    const row = statement.get(externalId) as
      { external_id: number; display_city: string | null; location_text: string | null } | undefined;
    if (!row) continue;
    const label = row.display_city ?? row.location_text;
    if (label) labels.set(row.external_id, label);
  }
  return labels;
}

/**
 * Store one refit's derived items.
 *
 * Sanitised here as well as in the converter: see sanitizeRankingSnapshot.
 */
export async function saveRankingSnapshot(
  raw: RankingSnapshot,
  matchLogVersion: number
): Promise<RankingWriteSummary> {
  const snapshot = sanitizeRankingSnapshot(raw);
  if (useDynamoDB()) return saveRankingSnapshotDynamoDB(snapshot, matchLogVersion);
  if (!useSqlite()) throw new Error('saveRankingSnapshot is not implemented for PostgreSQL');

  const db = getSqliteDb();
  const now = new Date().toISOString();

  const upsertProfile = db.prepare(`
    INSERT INTO player_profiles (player_id, display_name, rating, rated, component_id, payload, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id) DO UPDATE SET
      display_name = excluded.display_name,
      rating = excluded.rating,
      rated = excluded.rated,
      component_id = excluded.component_id,
      payload = excluded.payload,
      generated_at = excluded.generated_at
  `);
  const upsertPoint = db.prepare(`
    INSERT INTO player_rating_history (player_id, scope, date, payload) VALUES (?, ?, ?, ?)
    ON CONFLICT(player_id, scope, date) DO UPDATE SET payload = excluded.payload
  `);
  const upsertMatch = db.prepare(`
    INSERT INTO player_matches (player_id, played_at, match_id, event_external_id, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(player_id, played_at, match_id) DO UPDATE SET payload = excluded.payload
  `);
  const upsertRow = db.prepare(`
    INSERT INTO ranking_rows (scope, rank, player_id, payload) VALUES (?, ?, ?, ?)
    ON CONFLICT(scope, player_id) DO UPDATE SET rank = excluded.rank, payload = excluded.payload
  `);
  const upsertMeta = db.prepare(`
    INSERT INTO ranking_meta (scope, payload) VALUES (?, ?)
    ON CONFLICT(scope) DO UPDATE SET payload = excluded.payload
  `);
  const upsertComponent = db.prepare(`
    INSERT INTO ranking_components (component_id, payload) VALUES (?, ?)
    ON CONFLICT(component_id) DO UPDATE SET payload = excluded.payload
  `);
  const upsertSet = db.prepare(`
    INSERT INTO ranking_sets (set_id, payload) VALUES (?, ?)
    ON CONFLICT(set_id) DO UPDATE SET payload = excluded.payload
  `);
  const upsertMarker = db.prepare(`
    INSERT INTO ranking_log_markers (event_external_id, version, written_at) VALUES (?, ?, ?)
    ON CONFLICT(event_external_id) DO UPDATE SET version = excluded.version, written_at = excluded.written_at
  `);

  const summary: RankingWriteSummary = {
    profiles: snapshot.profiles.length,
    historyPoints: snapshot.history.length,
    matchLogEntries: snapshot.matchLog.length,
    rankingRows: snapshot.rankings.length,
    metas: snapshot.metas.length,
    components: snapshot.components.length,
    sets: snapshot.sets.length,
    markers: snapshot.matchLogEvents.length,
    deletedRows: 0,
    deletedScopes: 0,
  };

  db.transaction(() => {
    // Prune exactly like the DynamoDB path: a rank lives in the key, so a
    // player who dropped off a board (or off the ladder entirely) would
    // otherwise linger, and a component that merged away would leave a scope
    // nothing points at.
    const scopes = new Set(snapshot.metas.map(meta => meta.scope));
    const keep = new Map<string, Set<string>>();
    for (const row of snapshot.rankings) {
      let members = keep.get(row.scope);
      if (!members) keep.set(row.scope, (members = new Set()));
      members.add(row.playerId);
    }
    const storedScopes = db.prepare('SELECT scope FROM ranking_meta').all() as { scope: string }[];
    const storedRowScopes = db.prepare('SELECT DISTINCT scope FROM ranking_rows').all() as { scope: string }[];
    const deleteRow = db.prepare('DELETE FROM ranking_rows WHERE scope = ? AND player_id = ?');
    const deleteScopeRows = db.prepare('DELETE FROM ranking_rows WHERE scope = ?');
    const deleteMeta = db.prepare('DELETE FROM ranking_meta WHERE scope = ?');

    for (const { scope } of [...storedScopes, ...storedRowScopes]) {
      if (!scopes.has(scope)) {
        summary.deletedRows += deleteScopeRows.run(scope).changes;
        if (deleteMeta.run(scope).changes > 0) summary.deletedScopes++;
        continue;
      }
      const members = keep.get(scope) ?? new Set<string>();
      const stored = db.prepare('SELECT player_id FROM ranking_rows WHERE scope = ?').all(scope) as
        { player_id: string }[];
      for (const row of stored) {
        if (!members.has(row.player_id)) summary.deletedRows += deleteRow.run(scope, row.player_id).changes;
      }
    }

    const componentIds = new Set(snapshot.components.map(component => component.componentId));
    for (const row of db.prepare('SELECT component_id FROM ranking_components').all() as { component_id: string }[]) {
      if (!componentIds.has(row.component_id)) {
        db.prepare('DELETE FROM ranking_components WHERE component_id = ?').run(row.component_id);
      }
    }
    const setIds = new Set(snapshot.sets.map(set => set.setId));
    for (const row of db.prepare('SELECT set_id FROM ranking_sets').all() as { set_id: string }[]) {
      if (!setIds.has(row.set_id)) db.prepare('DELETE FROM ranking_sets WHERE set_id = ?').run(row.set_id);
    }

    for (const profile of snapshot.profiles) {
      upsertProfile.run(
        profile.playerId,
        profile.displayName,
        profile.rating,
        profile.rated ? 1 : 0,
        profile.componentId,
        JSON.stringify(profile),
        profile.generatedAt
      );
    }
    for (const point of snapshot.history) {
      upsertPoint.run(point.playerId, point.scope, point.date, JSON.stringify(point));
    }
    for (const entry of snapshot.matchLog) {
      upsertMatch.run(entry.playerId, entry.playedAt, entry.matchId, entry.eventExternalId, JSON.stringify(entry));
    }
    for (const row of snapshot.rankings) {
      upsertRow.run(row.scope, row.rank, row.playerId, JSON.stringify(row));
    }
    for (const meta of snapshot.metas) {
      upsertMeta.run(meta.scope, JSON.stringify(meta));
    }
    for (const component of snapshot.components) {
      upsertComponent.run(component.componentId, JSON.stringify(component));
    }
    for (const set of snapshot.sets) {
      upsertSet.run(set.setId, JSON.stringify(set));
    }
    for (const eventExternalId of snapshot.matchLogEvents) {
      upsertMarker.run(eventExternalId, matchLogVersion, now);
    }
  })();

  return summary;
}

/** When the rating pass last completed. Gates the refit interval. */
export async function getLastRankingRefit(): Promise<string | null> {
  if (useDynamoDB()) return getLastRankingRefitDynamoDB();
  if (!useSqlite()) return null;
  const row = getSqliteDb()
    .prepare("SELECT completed_at FROM ranking_state WHERE key = 'refit'")
    .get() as { completed_at: string } | undefined;
  return row?.completed_at ?? null;
}

export async function setLastRankingRefit(timestamp: string): Promise<void> {
  if (useDynamoDB()) return setLastRankingRefitDynamoDB(timestamp);
  if (!useSqlite()) return;
  getSqliteDb()
    .prepare(`
      INSERT INTO ranking_state (key, completed_at) VALUES ('refit', ?)
      ON CONFLICT(key) DO UPDATE SET completed_at = excluded.completed_at
    `)
    .run(timestamp);
}

/** One player's stored profile. Used by tests and the metrics CLI. */
export async function getPlayerProfile(playerId: string): Promise<PlayerProfile | null> {
  if (useDynamoDB()) return getPlayerProfileDynamoDB(playerId);
  if (!useSqlite()) throw new Error('getPlayerProfile is not implemented for PostgreSQL');
  const row = getSqliteDb()
    .prepare('SELECT payload FROM player_profiles WHERE player_id = ?')
    .get(playerId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as PlayerProfile) : null;
}

/** One leaderboard, in rank order. */
export async function getRankingRows(scope: string, limit = 100): Promise<RankingRow[]> {
  if (useDynamoDB()) return getRankingRowsDynamoDB(scope, limit);
  if (!useSqlite()) throw new Error('getRankingRows is not implemented for PostgreSQL');
  return (getSqliteDb()
    .prepare('SELECT payload FROM ranking_rows WHERE scope = ? ORDER BY rank LIMIT ?')
    .all(scope, limit) as { payload: string }[]
  ).map(row => JSON.parse(row.payload) as RankingRow);
}

/** One player's rating history for a scope, oldest first. SQLite/dev and tests. */
export async function getPlayerRatingHistory(
  playerId: string,
  scope: string
): Promise<PlayerRatingPoint[]> {
  if (!useSqlite()) throw new Error('getPlayerRatingHistory is only implemented for SQLite');
  return (getSqliteDb()
    .prepare('SELECT payload FROM player_rating_history WHERE player_id = ? AND scope = ? ORDER BY date')
    .all(playerId, scope) as { payload: string }[]
  ).map(row => JSON.parse(row.payload) as PlayerRatingPoint);
}

/** One player's match log, oldest first. SQLite/dev and tests. */
export async function getPlayerMatchLog(playerId: string): Promise<PlayerMatchLogEntry[]> {
  if (!useSqlite()) throw new Error('getPlayerMatchLog is only implemented for SQLite');
  return (getSqliteDb()
    .prepare('SELECT payload FROM player_matches WHERE player_id = ? ORDER BY played_at, match_id')
    .all(playerId) as { payload: string }[]
  ).map(row => JSON.parse(row.payload) as PlayerMatchLogEntry);
}

/**
 * Event names for a date window, for the per-player match log.
 *
 * Returns an empty map rather than throwing when the backend cannot answer: an
 * unnamed match log entry is a cosmetic loss, not a reason to fail a refit.
 */
export async function loadEventNames(daysBack: number, daysForward = 2): Promise<Map<string, string>> {
  if (useDynamoDB()) return loadEventNamesDynamoDB(daysBack, daysForward);
  if (!useSqlite()) return new Map();

  const from = new Date(Date.now() - daysBack * 86_400_000).toISOString();
  const to = new Date(Date.now() + daysForward * 86_400_000).toISOString();
  const rows = getSqliteDb()
    .prepare('SELECT external_id, name FROM events WHERE start_date BETWEEN ? AND ?')
    .all(from, to) as { external_id: string; name: string | null }[];
  const names = new Map<string, string>();
  for (const row of rows) if (row.name) names.set(row.external_id, row.name);
  return names;
}
