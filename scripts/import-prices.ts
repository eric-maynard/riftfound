/**
 * Import card prices into DynamoDB.
 *
 * Usage:
 *   npx ts-node import-prices.ts prices.json
 *   npx ts-node import-prices.ts prices.csv
 *
 * JSON format:
 *   [
 *     {
 *       "cardName": "Card Name",
 *       "cardNumber": "001",
 *       "set": "Core Set",
 *       "priceUsd": 1.99,
 *       "priceCny": 14.00
 *     },
 *     ...
 *   ]
 *
 * CSV format (with header):
 *   cardName,cardNumber,set,priceUsd,priceCny
 *   Card Name,001,Core Set,1.99,14.00
 *   ...
 *
 * Notes:
 *   - At least one of priceUsd or priceCny is required
 *   - cardNumber and set are optional but recommended
 *   - Legacy format with just "price" is still supported (treated as priceUsd)
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
  cardNumber: string | null;
  set: string | null;
  priceUsd: number | null;
  priceCny: number | null;
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

    // Support legacy "price" field as priceUsd
    const priceUsd = entry.priceUsd ?? entry.price ?? null;
    const priceCny = entry.priceCny ?? null;

    if (priceUsd === null && priceCny === null) {
      throw new Error(`Entry ${i}: at least one of priceUsd or priceCny is required`);
    }

    if (priceUsd !== null && (typeof priceUsd !== 'number' || priceUsd < 0)) {
      throw new Error(`Entry ${i}: invalid priceUsd`);
    }

    if (priceCny !== null && (typeof priceCny !== 'number' || priceCny < 0)) {
      throw new Error(`Entry ${i}: invalid priceCny`);
    }

    return {
      cardName: entry.cardName.trim(),
      cardNumber: entry.cardNumber?.toString().trim() || null,
      set: entry.set?.trim() || null,
      priceUsd,
      priceCny,
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

    if (!cardName || cardName.trim() === '') {
      throw new Error(`Row ${i + 2}: missing cardName`);
    }

    // Support legacy "price" field as priceUsd
    const priceUsdStr = record.priceUsd || record.price_usd || record.price || record.Price;
    const priceCnyStr = record.priceCny || record.price_cny;

    const priceUsd = priceUsdStr ? parseFloat(priceUsdStr) : null;
    const priceCny = priceCnyStr ? parseFloat(priceCnyStr) : null;

    if (priceUsd === null && priceCny === null) {
      throw new Error(`Row ${i + 2}: at least one of priceUsd or priceCny is required`);
    }

    if (priceUsd !== null && (isNaN(priceUsd) || priceUsd < 0)) {
      throw new Error(`Row ${i + 2}: invalid priceUsd "${priceUsdStr}"`);
    }

    if (priceCny !== null && (isNaN(priceCny) || priceCny < 0)) {
      throw new Error(`Row ${i + 2}: invalid priceCny "${priceCnyStr}"`);
    }

    const cardNumber = record.cardNumber || record.card_number || record.number || null;
    const set = record.set || record.setName || record.set_name || null;

    return {
      cardName: cardName.trim(),
      cardNumber: cardNumber?.trim() || null,
      set: set?.trim() || null,
      priceUsd: priceUsd !== null && !isNaN(priceUsd) ? priceUsd : null,
      priceCny: priceCny !== null && !isNaN(priceCny) ? priceCny : null,
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

    const putRequests = batch.map(({ cardName, cardNumber, set, priceUsd, priceCny }) => {
      const keys = priceKeys(cardName);
      const item: Record<string, unknown> = {
        ...keys,
        cardName: cardName,
        cardNameNormalized: cardName.toLowerCase().trim(),
        updatedAt: new Date().toISOString(),
      };

      // Only include non-null fields
      if (cardNumber !== null) item.cardNumber = cardNumber;
      if (set !== null) item.set = set;
      if (priceUsd !== null) item.priceUsd = priceUsd;
      if (priceCny !== null) item.priceCny = priceCny;

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
      const setInfo = p.set && p.cardNumber ? ` [${p.set} #${p.cardNumber}]` : '';
      const usdStr = p.priceUsd !== null ? `$${p.priceUsd.toFixed(2)}` : '-';
      const cnyStr = p.priceCny !== null ? `¥${p.priceCny.toFixed(2)}` : '-';
      console.log(`  ${p.cardName}${setInfo}: ${usdStr} USD / ${cnyStr} CNY`);
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
