import { getPool, getSqlite, useSqlite } from '../config/database.js';
import type { Event, EventQuery } from '../models/event.js';

// Calculate date range for calendar mode (3 months forward/backward)
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

export async function getEvents(query: EventQuery): Promise<{ events: Event[]; total: number }> {
  // In calendar mode, ignore pagination and use 3-month range
  const limit = query.calendarMode ? 10000 : query.limit;
  const offset = query.calendarMode ? 0 : (query.page - 1) * query.limit;

  if (useSqlite()) {
    return getEventsSqlite(query, offset, limit);
  } else {
    return getEventsPostgres(query, offset, limit);
  }
}

function getEventsSqlite(query: EventQuery, offset: number, limit: number): { events: Event[]; total: number } {
  const db = getSqlite();
  let where = '1=1';
  const params: unknown[] = [];
  const hasLocationFilter = query.lat !== undefined && query.lng !== undefined;

  // In calendar mode, use 3-month date range
  if (query.calendarMode) {
    const { startDate, endDate } = getCalendarDateRange();
    where += ` AND e.start_date >= ? AND e.start_date <= ?`;
    params.push(startDate, endDate);
  }

  if (query.city) {
    where += ` AND e.city LIKE ?`;
    params.push(`%${query.city}%`);
  }
  if (query.state) {
    where += ` AND e.state LIKE ?`;
    params.push(`%${query.state}%`);
  }
  if (query.country) {
    where += ` AND e.country LIKE ?`;
    params.push(`%${query.country}%`);
  }
  if (query.startDateFrom && !query.calendarMode) {
    where += ` AND e.start_date >= ?`;
    params.push(query.startDateFrom);
  }
  if (query.startDateTo && !query.calendarMode) {
    where += ` AND e.start_date <= ?`;
    params.push(query.startDateTo);
  }
  if (query.search) {
    where += ` AND (e.name LIKE ? OR e.description LIKE ? OR e.location LIKE ?)`;
    const searchTerm = `%${query.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }
  if (query.eventType) {
    where += ` AND e.event_type = ?`;
    params.push(query.eventType);
  }

  // Haversine distance filter
  let distanceFilter = '';
  let distanceSelect = '';
  if (hasLocationFilter) {
    // SQLite doesn't have built-in radians/acos, so we use a simplified formula
    // Haversine: 6371 * 2 * asin(sqrt(sin((lat2-lat1)/2)^2 + cos(lat1)*cos(lat2)*sin((lng2-lng1)/2)^2))
    // For SQLite, we'll filter in JavaScript after fetching (simpler and SQLite lacks trig functions)
    distanceSelect = `, s.latitude as shop_latitude, s.longitude as shop_longitude`;
  }

  const baseQuery = `
    SELECT e.*${distanceSelect}
    FROM events e
    LEFT JOIN shops s ON e.shop_id = s.id
    WHERE ${where}
  `;

  // For location filtering without SQLite trig functions, we fetch more and filter in JS
  if (hasLocationFilter) {
    const rows = db.prepare(
      `${baseQuery} ORDER BY e.start_date ASC`
    ).all(...params) as Record<string, unknown>[];

    // Filter by distance in JavaScript
    const filteredRows = rows.filter(row => {
      const shopLat = row.shop_latitude as number | null;
      const shopLng = row.shop_longitude as number | null;
      if (shopLat === null || shopLng === null) return false;

      const distance = haversineDistance(query.lat!, query.lng!, shopLat, shopLng);
      return distance <= query.radiusKm;
    });

    const total = filteredRows.length;
    const paginatedRows = filteredRows.slice(offset, offset + limit);

    return {
      events: paginatedRows.map(mapRowToEvent),
      total,
    };
  }

  // No location filter - use standard SQL pagination
  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM events e LEFT JOIN shops s ON e.shop_id = s.id WHERE ${where}`
  ).get(...params) as { count: number };
  const total = countRow.count;

  const rows = db.prepare(
    `${baseQuery} ORDER BY e.start_date ASC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return {
    events: rows.map(mapRowToEvent),
    total,
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

async function getEventsPostgres(query: EventQuery, offset: number, limit: number): Promise<{ events: Event[]; total: number }> {
  const pool = getPool();
  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];
  let paramIndex = 1;
  const hasLocationFilter = query.lat !== undefined && query.lng !== undefined;

  // In calendar mode, use 3-month date range
  if (query.calendarMode) {
    const { startDate, endDate } = getCalendarDateRange();
    whereClause += ` AND e.start_date >= $${paramIndex} AND e.start_date <= $${paramIndex + 1}`;
    params.push(startDate, endDate);
    paramIndex += 2;
  }

  if (query.city) {
    whereClause += ` AND e.city ILIKE $${paramIndex}`;
    params.push(`%${query.city}%`);
    paramIndex++;
  }
  if (query.state) {
    whereClause += ` AND e.state ILIKE $${paramIndex}`;
    params.push(`%${query.state}%`);
    paramIndex++;
  }
  if (query.country) {
    whereClause += ` AND e.country ILIKE $${paramIndex}`;
    params.push(`%${query.country}%`);
    paramIndex++;
  }
  if (query.startDateFrom && !query.calendarMode) {
    whereClause += ` AND e.start_date >= $${paramIndex}`;
    params.push(query.startDateFrom);
    paramIndex++;
  }
  if (query.startDateTo && !query.calendarMode) {
    whereClause += ` AND e.start_date <= $${paramIndex}`;
    params.push(query.startDateTo);
    paramIndex++;
  }
  if (query.search) {
    whereClause += ` AND (e.name ILIKE $${paramIndex} OR e.description ILIKE $${paramIndex} OR e.location ILIKE $${paramIndex})`;
    params.push(`%${query.search}%`);
    paramIndex++;
  }
  if (query.eventType) {
    whereClause += ` AND e.event_type = $${paramIndex}`;
    params.push(query.eventType);
    paramIndex++;
  }

  // Location filtering using PostgreSQL's built-in math functions
  if (hasLocationFilter) {
    whereClause += ` AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL`;
    whereClause += ` AND (
      6371 * acos(
        cos(radians($${paramIndex})) * cos(radians(s.latitude)) *
        cos(radians(s.longitude) - radians($${paramIndex + 1})) +
        sin(radians($${paramIndex})) * sin(radians(s.latitude))
      )
    ) <= $${paramIndex + 2}`;
    params.push(query.lat, query.lng, query.radiusKm);
    paramIndex += 3;
  }

  const baseQuery = `
    SELECT e.*, s.latitude as shop_latitude, s.longitude as shop_longitude
    FROM events e
    LEFT JOIN shops s ON e.shop_id = s.id
    ${whereClause}
  `;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM events e LEFT JOIN shops s ON e.shop_id = s.id ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const eventsResult = await pool.query(
    `${baseQuery} ORDER BY e.start_date ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
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
    startTime: row.start_time as string | null,
    endDate: row.end_date ? new Date(row.end_date as string) : null,
    eventType: row.event_type as string | null,
    organizer: row.organizer as string | null,
    playerCount: row.player_count as number | null,
    price: row.price as string | null,
    url: row.url as string | null,
    imageUrl: row.image_url as string | null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    scrapedAt: new Date(row.scraped_at as string),
    // Shop coordinates (from joined shops table)
    shopLatitude: row.shop_latitude as number | null ?? null,
    shopLongitude: row.shop_longitude as number | null ?? null,
  };
}

export interface ScrapeInfo {
  lastScrapeAt: Date | null;
  totalEvents: number;
}

export async function getScrapeInfo(): Promise<ScrapeInfo> {
  if (useSqlite()) {
    const db = getSqlite();

    // Get the most recent scrape run that completed
    const scrapeRow = db.prepare(
      `SELECT completed_at FROM scrape_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1`
    ).get() as { completed_at: string } | undefined;

    const countRow = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };

    return {
      lastScrapeAt: scrapeRow ? new Date(scrapeRow.completed_at) : null,
      totalEvents: countRow.count,
    };
  } else {
    const pool = getPool();

    const scrapeResult = await pool.query(
      `SELECT completed_at FROM scrape_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1`
    );

    const countResult = await pool.query('SELECT COUNT(*) FROM events');

    return {
      lastScrapeAt: scrapeResult.rows.length > 0 ? new Date(scrapeResult.rows[0].completed_at) : null,
      totalEvents: parseInt(countResult.rows[0].count, 10),
    };
  }
}
