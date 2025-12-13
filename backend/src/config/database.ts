import { Pool } from 'pg';
import Database from 'better-sqlite3';
import { env } from './env.js';

// SQLite
let sqliteDb: Database.Database | null = null;

function getSqliteDb(): Database.Database {
  if (!sqliteDb) {
    sqliteDb = new Database(env.SQLITE_PATH, { readonly: false });
    sqliteDb.pragma('journal_mode = WAL');
  }
  return sqliteDb;
}

// PostgreSQL
let pgPool: Pool | null = null;

function getPgPool(): Pool {
  if (!pgPool) {
    pgPool = new Pool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      database: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    pgPool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }
  return pgPool;
}

export function useSqlite(): boolean {
  return env.DB_TYPE === 'sqlite';
}

export function getPool(): Pool {
  return getPgPool();
}

export function getSqlite(): Database.Database {
  return getSqliteDb();
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

export async function testConnection(): Promise<boolean> {
  try {
    if (useSqlite()) {
      const db = getSqliteDb();
      db.prepare('SELECT 1').get();
      console.log('SQLite connection successful');
      return true;
    } else {
      const client = await getPgPool().connect();
      await client.query('SELECT 1');
      client.release();
      console.log('PostgreSQL connection successful');
      return true;
    }
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

// Photon queue for batch import
export interface PhotonQueueItem {
  id: number;
  osmId: number;
  photonData: string;
  createdAt: string;
}

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
