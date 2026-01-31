import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
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
  PRICE: 'PRICE#',
  ORDER: 'ORDER#',
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

// Helper to create zipcode keys
export function zipcodeKeys(zipcode: string) {
  return {
    PK: `${EntityPrefix.ZIPCODE}${zipcode}`,
    SK: 'ZIPCODE',
  };
}

// Helper to create price keys (normalized card name as key)
export function priceKeys(cardName: string) {
  const normalized = cardName.toLowerCase().trim();
  return {
    PK: `${EntityPrefix.PRICE}${normalized}`,
    SK: 'PRICE',
  };
}

// Helper to create order keys
export function orderKeys(orderId: string) {
  return {
    PK: `${EntityPrefix.ORDER}${orderId}`,
    SK: `${EntityPrefix.ORDER}${orderId}`,
  };
}

// Helper to create order GSI1 keys (for listing orders by date)
export function orderGSI1Keys(createdAt: string, orderId: string) {
  return {
    GSI1PK: 'ORDERS',
    GSI1SK: `${createdAt}#${orderId}`,
  };
}

// Re-export commands for convenience
export {
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
  ScanCommand,
};
