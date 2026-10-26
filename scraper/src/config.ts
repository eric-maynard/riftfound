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

  // Second event source: Riot's official playriftbound API
  PLAYRIFTBOUND_ENABLED: z.string().transform(v => v !== 'false').default('true'),
  // Delay between playriftbound requests (polite rate limit, ~1 req/sec)
  PLAYRIFTBOUND_REQUEST_DELAY_MS: z.string().transform(Number).default('1000'),
  // Anchors swept per run; the rest roll over to later runs (see sources/playriftbound.ts)
  PLAYRIFTBOUND_MAX_ANCHORS_PER_RUN: z.string().transform(Number).default('150'),
  // Optional override for the persisted GraphQL query hash (normally self-healing)
  PLAYRIFTBOUND_QUERY_HASH: z.string().optional(),

  // Third pass: tournament rosters and results (see sources/playriftboundResults.ts).
  // Shares PLAYRIFTBOUND_REQUEST_DELAY_MS for its rate limit.
  PLAYRIFTBOUND_RESULTS_ENABLED: z.string().transform(v => v !== 'false').default('true'),
  // Event pages fetched per run; the rest roll over to the next run
  PLAYRIFTBOUND_RESULTS_MAX_EVENTS_PER_RUN: z.string().transform(Number).default('250'),
  // How far back to look for finished events still awaiting a results capture
  PLAYRIFTBOUND_RESULTS_LOOKBACK_DAYS: z.string().transform(Number).default('21'),

  // Fourth pass: player ratings (see ranking/). A batch refit of the whole
  // history, not an incremental update - so it runs on its own slow cadence
  // rather than every scrape cycle.
  RANKING_ENABLED: z.string().transform(v => v !== 'false').default('true'),
  // How far back the replay reads fact rows. Covers more than the facts go back
  // today; the cost is one empty Query per empty day.
  RANKING_HISTORY_DAYS: z.string().transform(Number).default('400'),
  // Minimum gap between refits. The coordinator runs every 2 hours; a refit
  // rewrites every profile and every rating point, so it is deliberately slower.
  RANKING_REFIT_INTERVAL_HOURS: z.string().transform(Number).default('24'),
  // Lambda time held back from the pass for the writes and the summary.
  RANKING_RESERVED_MS: z.string().transform(Number).default('120000'),

  // --- the model (ranking/whr.ts) ---
  // Prior SD of a player's rating, in Elo points. The one knob that decides how
  // fast a newcomer leaves the anchor and how hard a disconnected cluster is
  // pinned to it. See scraper/CLAUDE.md for how the default was chosen.
  RANKING_PRIOR_SIGMA_ELO: z.string().transform(Number).default('150'),
  // Where the published scale is anchored: the rating of a player with no
  // evidence. A pure display offset - the fit is invariant under changing it,
  // so no prediction moves - but stored absolute numbers only pick up a new
  // anchor on the next refit.
  RANKING_ELO_ORIGIN: z.string().transform(Number).default('1200'),
  // Rating drift allowed by the Wiener prior, in Elo per sqrt(day).
  RANKING_DRIFT_ELO_PER_SQRT_DAY: z.string().transform(Number).default('4'),
  // What one observation is: 'game-shared' splits a match's weight across its
  // recorded games (margin-aware, one unit of evidence per match), 'game'
  // counts every game independently, 'match' ignores margin. All three measure
  // the same on held-out data; see ranking/whr.ts for why 'game-shared' wins.
  RANKING_OBSERVATION_LEVEL: z.enum(['game-shared', 'game', 'match']).default('game-shared'),
  // Total weight of one match. Swept against held-out log loss; 1 is the default.
  RANKING_WEIGHT_SCALE: z.string().transform(Number).default('1'),
  RANKING_MAX_ITERATIONS: z.string().transform(Number).default('60'),
  // Safety cap on the replay, so an unexpectedly large history cannot OOM the Lambda.
  RANKING_MAX_MATCHES: z.string().transform(Number).default('2000000'),

  // --- the publishing bar (ranking/snapshot.ts) ---
  // No public rating below this many game observations...
  RANKING_MIN_GAMES: z.string().transform(Number).default('8'),
  // ...or above this posterior SD, in Elo points.
  RANKING_MAX_UNCERTAINTY_ELO: z.string().transform(Number).default('120'),
  // Component size below which a rank is published but not presented as a
  // position - a "2nd of 3" in an isolated scene is not a placement.
  RANKING_MIN_COMPONENT_SIZE: z.string().transform(Number).default('8'),
  // Per-component ladders are published for the largest N components only.
  RANKING_MAX_COMPONENT_LADDERS: z.string().transform(Number).default('50'),
  // A set era with fewer matches than this is not fitted at all.
  RANKING_MIN_SET_MATCHES: z.string().transform(Number).default('50'),
  // JSON override for the curated set table (ranking/sets.ts).
  RANKING_SET_TABLE: z.string().optional(),
  // Prerelease attribution: a prerelease is played *with* the new set, so these
  // tournament types, within RANKING_PRERELEASE_LEAD_DAYS of a release date,
  // count toward the set they preview rather than the outgoing one.
  RANKING_PRERELEASE_TYPES: z.string().default('Pre-Rift'),
  RANKING_PRERELEASE_LEAD_DAYS: z.string().transform(Number).default('14'),

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
