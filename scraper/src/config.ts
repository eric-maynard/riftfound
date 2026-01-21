import { z } from 'zod';
import dotenv from 'dotenv';

// Load .env file
dotenv.config({ path: '../.env' });
dotenv.config(); // Also check current directory

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database type: sqlite (default for dev), postgres, or dynamodb
  DB_TYPE: z.enum(['sqlite', 'postgres', 'dynamodb']).default('sqlite'),

  // SQLite config - relative to project root
  SQLITE_PATH: z.string().default('../riftfound.db'),

  // PostgreSQL config (only required if DB_TYPE=postgres)
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().transform(Number).default('5432'),
  DB_NAME: z.string().default('riftfound'),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),

  // DynamoDB config (only required if DB_TYPE=dynamodb)
  DYNAMODB_TABLE_NAME: z.string().default('riftfound'),
  AWS_REGION: z.string().default('us-west-2'),
  DYNAMODB_ENDPOINT: z.string().optional(), // For local development with DynamoDB Local

  // Scraper
  SCRAPE_INTERVAL_MINUTES: z.string().transform(Number).default('60'),

  // Geocoding - Photon (self-hosted)
  PHOTON_URL: z.string().default('http://localhost:2322'),
  PHOTON_ENABLED: z.string().transform(v => v !== 'false').default('true'),

  // Geocoding - Mapbox API (optional, takes precedence over Photon)
  MAPBOX_ACCESS_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  // Validate postgres credentials if using postgres
  if (result.data.DB_TYPE === 'postgres') {
    if (!result.data.DB_USER || !result.data.DB_PASSWORD) {
      console.error('DB_USER and DB_PASSWORD required when DB_TYPE=postgres');
      process.exit(1);
    }
  }

  return result.data;
}

export const env = loadEnv();
