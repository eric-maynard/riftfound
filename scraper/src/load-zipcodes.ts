#!/usr/bin/env node
/**
 * Load US ZIP codes from CSV into the database.
 *
 * Usage: npx tsx src/load-zipcodes.ts <path-to-csv>
 *
 * Expected CSV format (from geonames.org):
 * country code,postal code,place name,admin name1,admin code1,admin name2,admin code2,latitude,longitude
 * US,99547,Atka,Alaska,AK,Aleutians West (CA),16,52.1961,-174.2006
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import Database from 'better-sqlite3';
import { env } from './config.js';

async function loadZipcodes(csvPath: string): Promise<void> {
  const dbPath = env.SQLITE_PATH || './riftfound.db';
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Create table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS us_zipcodes (
      zipcode TEXT PRIMARY KEY,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      state_code TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL
    )
  `);

  // Clear existing data
  const deleteResult = db.prepare('DELETE FROM us_zipcodes').run();
  console.log(`Cleared ${deleteResult.changes} existing ZIP codes`);

  // Prepare insert statement
  const insert = db.prepare(`
    INSERT OR REPLACE INTO us_zipcodes (zipcode, city, state, state_code, latitude, longitude)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Process CSV
  const fileStream = createReadStream(csvPath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  let inserted = 0;
  let skipped = 0;

  // Use a transaction for better performance
  const insertMany = db.transaction((rows: Array<[string, string, string, string, number, number]>) => {
    for (const row of rows) {
      insert.run(...row);
    }
  });

  const batch: Array<[string, string, string, string, number, number]> = [];
  const BATCH_SIZE = 1000;

  for await (const line of rl) {
    lineNum++;

    // Skip header
    if (lineNum === 1) continue;

    // Parse CSV line (simple parsing, assumes no commas in values)
    const parts = line.split(',');
    if (parts.length < 9) {
      skipped++;
      continue;
    }

    const [countryCode, postalCode, placeName, adminName1, adminCode1, , , latStr, lonStr] = parts;

    // Only US ZIP codes
    if (countryCode !== 'US') {
      skipped++;
      continue;
    }

    // Validate 5-digit ZIP
    if (!/^\d{5}$/.test(postalCode)) {
      skipped++;
      continue;
    }

    const latitude = parseFloat(latStr);
    const longitude = parseFloat(lonStr);

    if (isNaN(latitude) || isNaN(longitude)) {
      skipped++;
      continue;
    }

    batch.push([postalCode, placeName, adminName1, adminCode1, latitude, longitude]);
    inserted++;

    // Insert in batches
    if (batch.length >= BATCH_SIZE) {
      insertMany(batch);
      batch.length = 0;
      process.stdout.write(`\rInserted ${inserted} ZIP codes...`);
    }
  }

  // Insert remaining
  if (batch.length > 0) {
    insertMany(batch);
  }

  console.log(`\nDone! Inserted ${inserted} ZIP codes, skipped ${skipped} rows`);

  // Verify
  const count = db.prepare('SELECT COUNT(*) as count FROM us_zipcodes').get() as { count: number };
  console.log(`Total ZIP codes in database: ${count.count}`);

  db.close();
}

// Main
const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: npx tsx src/load-zipcodes.ts <path-to-csv>');
  process.exit(1);
}

loadZipcodes(csvPath).catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
