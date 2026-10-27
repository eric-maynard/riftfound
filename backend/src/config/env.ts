import { z } from 'zod';
import dotenv from 'dotenv';
import { DEFAULT_MIN_GAMES_TO_PUBLISH } from '../models/ranking.js';

dotenv.config({ path: '../.env' });
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3001'),

  // Database type
  DB_TYPE: z.enum(['sqlite', 'postgres', 'dynamodb']).default('sqlite'),
  SQLITE_PATH: z.string().default('../riftfound.db'),

  // PostgreSQL (optional if using sqlite)
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().transform(Number).default('5432'),
  DB_NAME: z.string().default('riftfound'),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),

  // DynamoDB (optional if using sqlite/postgres)
  DYNAMODB_TABLE_NAME: z.string().default('riftfound'),
  AWS_REGION: z.string().default('us-west-2'),
  DYNAMODB_ENDPOINT: z.string().optional(), // For local development with DynamoDB Local

  // CORS
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  // Geocoding - Photon (self-hosted)
  PHOTON_URL: z.string().default('http://localhost:2322'),
  PHOTON_ENABLED: z.string().transform(v => v !== 'false').default('true'),

  // Geocoding - Mapbox API (optional, takes precedence over Photon)
  MAPBOX_ACCESS_TOKEN: z.string().optional(),

  // Ranking data source. 'auto' follows DB_TYPE: DynamoDB in production,
  // in-memory fixtures everywhere else (the rating engine only writes to
  // DynamoDB). Force either one for testing.
  RANKING_SOURCE: z.enum(['auto', 'dynamodb', 'fixture']).default('auto'),

  // The display floor: recorded games needed before a rating *number* is
  // published. Not the rank gate (8 games / 120 sigma / component 8), which is
  // in `CONFIDENCE` and decides positions. See DEFAULT_MIN_GAMES_TO_PUBLISH for
  // why the default is 3. 0 publishes every rating the engine fitted.
  RANKING_MIN_GAMES_TO_PUBLISH: z.coerce
    .number()
    .int()
    .min(0)
    .default(DEFAULT_MIN_GAMES_TO_PUBLISH),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();
