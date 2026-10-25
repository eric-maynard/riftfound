/**
 * Point the scraper at a throwaway SQLite file.
 *
 * config.ts parses process.env once, at import time, and database.ts imports it
 * - so a test that needs the SQLite backend has to set these *before* either
 * module is evaluated. Importing this module first does that: ES modules are
 * evaluated in import order, so this runs before the `../database.js` import
 * below it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'riftfound-test-')), 'test.db');
