/**
 * Import card prices into DynamoDB.
 *
 * Usage:
 *   npx ts-node import-prices.ts prices.json
 *   npx ts-node import-prices.ts prices.csv
 *
 * JSON format:
 *   [
 *     { "cardName": "Card Name", "price": 1.99 },
 *     ...
 *   ]
 *
 * CSV format (with header):
 *   cardName,price
 *   Card Name,1.99
 *   ...
 *
 * Environment:
 *   DB_TYPE=dynamodb
 *   DYNAMODB_TABLE_NAME=riftfound-prod
 *   AWS_REGION=us-west-2
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import {
  DynamoDBClient,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

interface PriceEntry {
  cardName: string;
  price: number;
}

function loadJsonPrices(filePath: string): PriceEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content);

  if (!Array.isArray(data)) {
    throw new Error('JSON file must contain an array of price entries');
  }

  return data.map((entry, i) => {
    if (typeof entry.cardName !== 'string' || entry.cardName.trim() === '') {
      throw new Error(`Entry ${i}: missing or invalid cardName`);
    }
    if (typeof entry.price !== 'number' || entry.price < 0) {
      throw new Error(`Entry ${i}: missing or invalid price`);
    }
    return {
      cardName: entry.cardName.trim(),
      price: entry.price,
    };
  });
}

function loadCsvPrices(filePath: string): PriceEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  return records.map((record: Record<string, string>, i: number) => {
    const cardName = record.cardName || record.card_name || record.name;
    const priceStr = record.price || record.Price;

    if (!cardName || cardName.trim() === '') {
      throw new Error(`Row ${i + 2}: missing cardName`);
    }

    const price = parseFloat(priceStr);
    if (isNaN(price) || price < 0) {
      throw new Error(`Row ${i + 2}: invalid price "${priceStr}"`);
    }

    return {
      cardName: cardName.trim(),
      price,
    };
  });
}

function priceKeys(cardName: string) {
  const normalized = cardName.toLowerCase().trim();
  return {
    PK: `PRICE#${normalized}`,
    SK: 'PRICE',
  };
}

async function importPrices(prices: PriceEntry[]): Promise<void> {
  const tableName = process.env.DYNAMODB_TABLE_NAME || 'riftfound-prod';
  const region = process.env.AWS_REGION || 'us-west-2';

  const client = new DynamoDBClient({ region });

  console.log(`Importing ${prices.length} prices to ${tableName}...`);

  // DynamoDB batch write supports up to 25 items per request
  const batchSize = 25;
  let imported = 0;
  let failed = 0;

  for (let i = 0; i < prices.length; i += batchSize) {
    const batch = prices.slice(i, i + batchSize);

    const putRequests = batch.map(({ cardName, price }) => {
      const keys = priceKeys(cardName);
      const item = {
        ...keys,
        cardName: cardName,
        cardNameNormalized: cardName.toLowerCase().trim(),
        price: price,
        updatedAt: new Date().toISOString(),
      };

      return {
        PutRequest: {
          Item: marshall(item),
        },
      };
    });

    try {
      await client.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [tableName]: putRequests,
          },
        })
      );
      imported += batch.length;
      process.stdout.write(`\rImported ${imported}/${prices.length}...`);
    } catch (error) {
      console.error(`\nBatch starting at ${i} failed:`, error);
      failed += batch.length;
    }
  }

  console.log(`\nDone! Imported: ${imported}, Failed: ${failed}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: npx ts-node import-prices.ts <prices.json|prices.csv>');
    console.log('\nExamples:');
    console.log('  npx ts-node import-prices.ts prices.json');
    console.log('  npx ts-node import-prices.ts prices.csv');
    console.log('\nEnvironment variables:');
    console.log('  DYNAMODB_TABLE_NAME - DynamoDB table (default: riftfound-prod)');
    console.log('  AWS_REGION - AWS region (default: us-west-2)');
    process.exit(1);
  }

  const filePath = args[0];

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const ext = path.extname(filePath).toLowerCase();
  let prices: PriceEntry[];

  try {
    if (ext === '.json') {
      prices = loadJsonPrices(filePath);
    } else if (ext === '.csv') {
      prices = loadCsvPrices(filePath);
    } else {
      console.error(`Unsupported file format: ${ext}. Use .json or .csv`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Failed to load prices:', error);
    process.exit(1);
  }

  console.log(`Loaded ${prices.length} prices from ${filePath}`);

  // Show a sample
  if (prices.length > 0) {
    console.log('\nSample entries:');
    prices.slice(0, 3).forEach((p) => {
      console.log(`  ${p.cardName}: $${p.price.toFixed(2)}`);
    });
    if (prices.length > 3) {
      console.log(`  ... and ${prices.length - 3} more`);
    }
  }

  await importPrices(prices);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
