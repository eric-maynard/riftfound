import { z } from 'zod';
import dotenv from 'dotenv';

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

  // Geocoding - Google Maps API (optional, takes precedence over Photon)
  GOOGLE_MAPS_API_KEY: z.string().optional(),
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
