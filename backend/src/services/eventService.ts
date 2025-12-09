import { getPool, getSqlite, useSqlite } from '../config/database.js';
import type { Event, EventQuery } from '../models/event.js';

export async function getEvents(query: EventQuery): Promise<{ events: Event[]; total: number }> {
  const offset = (query.page - 1) * query.limit;

  if (useSqlite()) {
    return getEventsSqlite(query, offset);
  } else {
    return getEventsPostgres(query, offset);
  }
}

function getEventsSqlite(query: EventQuery, offset: number): { events: Event[]; total: number } {
  const db = getSqlite();
  let where = '1=1';
  const params: unknown[] = [];

  if (query.city) {
    where += ` AND city LIKE ?`;
    params.push(`%${query.city}%`);
  }
  if (query.state) {
    where += ` AND state LIKE ?`;
    params.push(`%${query.state}%`);
  }
  if (query.country) {
    where += ` AND country LIKE ?`;
    params.push(`%${query.country}%`);
  }
  if (query.startDateFrom) {
    where += ` AND start_date >= ?`;
    params.push(query.startDateFrom);
  }
  if (query.startDateTo) {
    where += ` AND start_date <= ?`;
    params.push(query.startDateTo);
  }
  if (query.search) {
    where += ` AND (name LIKE ? OR description LIKE ? OR location LIKE ?)`;
    const searchTerm = `%${query.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  const countRow = db.prepare(`SELECT COUNT(*) as count FROM events WHERE ${where}`).get(...params) as { count: number };
  const total = countRow.count;

  const rows = db.prepare(
    `SELECT * FROM events WHERE ${where} ORDER BY start_date ASC LIMIT ? OFFSET ?`
  ).all(...params, query.limit, offset) as Record<string, unknown>[];

  return {
    events: rows.map(mapRowToEvent),
    total,
  };
}

async function getEventsPostgres(query: EventQuery, offset: number): Promise<{ events: Event[]; total: number }> {
  const pool = getPool();
  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];
  let paramIndex = 1;

  if (query.city) {
    whereClause += ` AND city ILIKE $${paramIndex}`;
    params.push(`%${query.city}%`);
    paramIndex++;
  }
  if (query.state) {
    whereClause += ` AND state ILIKE $${paramIndex}`;
    params.push(`%${query.state}%`);
    paramIndex++;
  }
  if (query.country) {
    whereClause += ` AND country ILIKE $${paramIndex}`;
    params.push(`%${query.country}%`);
    paramIndex++;
  }
  if (query.startDateFrom) {
    whereClause += ` AND start_date >= $${paramIndex}`;
    params.push(query.startDateFrom);
    paramIndex++;
  }
  if (query.startDateTo) {
    whereClause += ` AND start_date <= $${paramIndex}`;
    params.push(query.startDateTo);
    paramIndex++;
  }
  if (query.search) {
    whereClause += ` AND (name ILIKE $${paramIndex} OR description ILIKE $${paramIndex} OR location ILIKE $${paramIndex})`;
    params.push(`%${query.search}%`);
    paramIndex++;
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM events ${whereClause}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const eventsResult = await pool.query(
    `SELECT * FROM events ${whereClause} ORDER BY start_date ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, query.limit, offset]
  );

  return {
    events: eventsResult.rows.map(mapRowToEvent),
    total,
  };
}

export async function getEventById(id: string): Promise<Event | null> {
  if (useSqlite()) {
    const db = getSqlite();
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? mapRowToEvent(row) : null;
  } else {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
    return result.rows.length > 0 ? mapRowToEvent(result.rows[0]) : null;
  }
}

function mapRowToEvent(row: Record<string, unknown>): Event {
  return {
    id: String(row.id),
    externalId: row.external_id as string,
    name: row.name as string,
    description: row.description as string | null,
    location: row.location as string | null,
    address: row.address as string | null,
    city: row.city as string | null,
    state: row.state as string | null,
    country: row.country as string | null,
    latitude: row.latitude as number | null,
    longitude: row.longitude as number | null,
    startDate: new Date(row.start_date as string),
    endDate: row.end_date ? new Date(row.end_date as string) : null,
    eventType: row.event_type as string | null,
    organizer: row.organizer as string | null,
    url: row.url as string | null,
    imageUrl: row.image_url as string | null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    scrapedAt: new Date(row.scraped_at as string),
  };
}
