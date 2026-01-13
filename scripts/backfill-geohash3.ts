/**
 * Backfill script to add geohash3 attribute to existing shops in DynamoDB.
 * Run this after creating the GeohashIndex3 GSI.
 *
 * Usage: npx tsx scripts/backfill-geohash3.ts
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import geohash from 'ngeohash';

const REGION = process.env.AWS_REGION || 'us-west-2';
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'riftfound-prod';

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

async function backfillGeohash3() {
  console.log(`Backfilling geohash3 for shops in ${TABLE_NAME}...`);

  let lastEvaluatedKey: Record<string, any> | undefined;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  do {
    const response = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :type',
      ExpressionAttributeValues: {
        ':type': 'SHOP',
      },
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    const items = response.Items || [];
    scanned += items.length;

    for (const item of items) {
      // Skip if already has geohash3 or no coordinates
      if (item.geohash3) {
        skipped++;
        continue;
      }

      if (!item.latitude || !item.longitude) {
        skipped++;
        continue;
      }

      const geohash3 = geohash.encode(item.latitude, item.longitude, 3);

      await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: item.PK,
          SK: item.SK,
        },
        UpdateExpression: 'SET geohash3 = :gh3',
        ExpressionAttributeValues: {
          ':gh3': geohash3,
        },
      }));

      updated++;

      if (updated % 100 === 0) {
        console.log(`Updated ${updated} shops...`);
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`\nBackfill complete!`);
  console.log(`  Scanned: ${scanned} shops`);
  console.log(`  Updated: ${updated} shops`);
  console.log(`  Skipped: ${skipped} shops (already had geohash3 or no coordinates)`);
}

backfillGeohash3().catch(console.error);
