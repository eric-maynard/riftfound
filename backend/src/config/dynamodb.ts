import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
  BatchGetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { env } from './env.js';

// DynamoDB client singleton
let docClient: DynamoDBDocumentClient | null = null;

export function getDynamoClient(): DynamoDBDocumentClient {
  if (!docClient) {
    const clientConfig: ConstructorParameters<typeof DynamoDBClient>[0] = {
      region: env.AWS_REGION,
    };

    // Use local endpoint for development (DynamoDB Local)
    if (env.DYNAMODB_ENDPOINT) {
      clientConfig.endpoint = env.DYNAMODB_ENDPOINT;
      clientConfig.credentials = {
        accessKeyId: 'local',
        secretAccessKey: 'local',
      };
    }

    const client = new DynamoDBClient(clientConfig);
    docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertClassInstanceToMap: true,
      },
    });
  }
  return docClient;
}

export function getTableName(): string {
  return env.DYNAMODB_TABLE_NAME;
}

// Entity key prefixes
export const EntityPrefix = {
  EVENT: 'EVENT#',
  SHOP: 'SHOP#',
  GEOCACHE: 'GEOCACHE#',
  SCRAPE_RUN: 'SCRAPE_RUN',
  ZIPCODE: 'ZIPCODE#',
  PLAYER: 'PLAYER#',
  RANKING: 'RANKING#',
  EVENT_RESULTS: 'RESULTS#',
  EVENT_ROSTER: 'ROSTER#',
} as const;

// Helper to create event keys
export function eventKeys(externalId: string) {
  return {
    PK: `${EntityPrefix.EVENT}${externalId}`,
    SK: `${EntityPrefix.EVENT}${externalId}`,
  };
}

// Helper to create event GSI1 keys (for date-based queries)
export function eventGSI1Keys(startDate: Date, externalId: string) {
  const dateStr = startDate.toISOString().split('T')[0]; // YYYY-MM-DD
  return {
    GSI1PK: `DATE#${dateStr}`,
    GSI1SK: `${EntityPrefix.EVENT}${externalId}`,
  };
}

// Helper to create event GSI2 keys (for shop-based queries)
export function eventGSI2Keys(shopExternalId: number, startDate: string) {
  return {
    GSI2PK: `${EntityPrefix.SHOP}${shopExternalId}`,
    GSI2SK: startDate,
  };
}

// Helper to create shop keys
export function shopKeys(externalId: number) {
  return {
    PK: `${EntityPrefix.SHOP}${externalId}`,
    SK: `${EntityPrefix.SHOP}${externalId}`,
  };
}

// Helper to create geocache keys
export function geocacheKeys(normalizedQuery: string) {
  return {
    PK: `${EntityPrefix.GEOCACHE}${normalizedQuery}`,
    SK: 'GEOCACHE',
  };
}

// Helper to create geocache GSI3 keys (for LRU eviction)
// All geocache items share the same GSI3PK, sorted by lastAccessedAt
export function geocacheGSI3Keys(lastAccessedAt: string) {
  return {
    GSI3PK: 'GEOCACHE_LRU',
    GSI3SK: lastAccessedAt,
  };
}

// Helper to create scrape run keys
export function scrapeRunKeys(timestamp: string) {
  return {
    PK: EntityPrefix.SCRAPE_RUN,
    SK: timestamp,
  };
}

// --- Ranking / rating items (written by the scraper's rating engine) ---
// PLAYER#<uuid> / PROFILE
// PLAYER#<uuid> / RATING#<scope>#<iso-date>
// PLAYER#<uuid> / MATCH#<iso-timestamp>#<matchId>
// RANKING#<scope>

export const PLAYER_PROFILE_SK = 'PROFILE';
export const PLAYER_RATING_SK_PREFIX = 'RATING#';
export const PLAYER_MATCH_SK_PREFIX = 'MATCH#';

// Helper to create player profile keys
export function playerProfileKeys(playerId: string) {
  return {
    PK: `${EntityPrefix.PLAYER}${playerId}`,
    SK: PLAYER_PROFILE_SK,
  };
}

// Partition key shared by every item of one player
export function playerPK(playerId: string) {
  return `${EntityPrefix.PLAYER}${playerId}`;
}

// Sort-key prefix for one scope's rating history
export function playerRatingSKPrefix(scope: string) {
  return `${PLAYER_RATING_SK_PREFIX}${scope}#`;
}

// Partition key for one leaderboard scope
export function rankingPK(scope: string) {
  return `${EntityPrefix.RANKING}${scope}`;
}

/**
 * GSI1 partitions the engine's catalogue items are enumerable in.
 *
 * `SET#<id>`, `COMPONENT#<id>`, `VENUE#<id>` and `SCENE#<id>` each carry
 * `GSI1PK: '<PARTITION>'` so a whole catalogue is **one Query** with no scan
 * and no new index - the access pattern those keys were added for. Without
 * them an item can only be fetched by an id the reader already has, which is
 * not a list: that is how `/api/sets` ended up inferring set ids from player
 * profiles and serving them with no name.
 *
 * The scraper writes these (`scraper/src/dynamodb.ts`), and the spellings have
 * to match it exactly, so they are named here rather than inlined at the call
 * site. `'COMPONENT'` is the scene map's whole read.
 */
export const SET_CATALOGUE_PARTITION = 'SET';
export const COMPONENT_CATALOGUE_PARTITION = 'COMPONENT';
export const VENUE_CATALOGUE_PARTITION = 'VENUE';
export const SCENE_CATALOGUE_PARTITION = 'SCENE';

/**
 * One component's own catalogue item, by id.
 *
 * The GSI1 partition above is for *listing* the catalogue; this is the other
 * access pattern, and it is the cheap one: a reader who already holds a
 * component id - an event page that has just worked out which scene its
 * players are in, say - wants that one item, not 1,235 of them. A GetItem is
 * ~1 read unit against the Query's ~46, which is the difference between the
 * scene line on an event page being free and it being the most expensive
 * thing on the response.
 *
 * `'PROFILE'` is `PLAYER_PROFILE_SK`'s spelling and the scraper writes the
 * same word (`scraper/src/dynamodb.ts`, `componentKeys`); it is repeated here
 * rather than borrowed from the player helper because the two are different
 * contracts that happen to agree.
 */
export function componentProfileKeys(componentId: string) {
  return {
    PK: `${COMPONENT_CATALOGUE_PARTITION}#${componentId}`,
    SK: 'PROFILE',
  };
}

// --- Tournament facts (written by the scraper's playriftboundResults pass) ---
// RESULTS#<externalId> / RESULTS#<externalId>  - standings, pairings, per-game
// ROSTER#<externalId>  / ROSTER#<externalId>   - dated registrations
//
// One item per event per fact, so "the results for this event" is a single
// GetItem and "do these 50 events have anything" is a single BatchGet. Both
// keys repeat the prefix in the sort key: that is the scraper's shape, not a
// typo.

export function eventResultsKeys(externalId: string) {
  return {
    PK: `${EntityPrefix.EVENT_RESULTS}${externalId}`,
    SK: `${EntityPrefix.EVENT_RESULTS}${externalId}`,
  };
}

export function eventRosterKeys(externalId: string) {
  return {
    PK: `${EntityPrefix.EVENT_ROSTER}${externalId}`,
    SK: `${EntityPrefix.EVENT_ROSTER}${externalId}`,
  };
}

// Helper to create zipcode keys
export function zipcodeKeys(zipcode: string) {
  return {
    PK: `${EntityPrefix.ZIPCODE}${zipcode}`,
    SK: 'ZIPCODE',
  };
}

// Re-export commands for convenience
export {
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
  BatchGetCommand,
  ScanCommand,
};
