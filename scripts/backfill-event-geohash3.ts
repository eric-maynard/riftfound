/**
 * Backfill script to add geohash3 attribute to existing events in DynamoDB.
 * Computes geohash3 from shopLatitude/shopLongitude for the GeohashEventIndex.
 *
 * Usage: npx tsx scripts/backfill-event-geohash3.ts
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import geohash from 'ngeohash';

const REGION = process.env.AWS_REGION || 'us-west-2';
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'riftfound-prod';

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

async function backfillEventGeohash3() {
  console.log(`Backfilling geohash3 for events in ${TABLE_NAME}...`);

  let lastEvaluatedKey: Record<string, any> | undefined;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  do {
    const response = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :type',
      ExpressionAttributeValues: {
        ':type': 'EVENT',
      },
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    const items = response.Items || [];
    scanned += items.length;

    for (const item of items) {
      // Skip if already has geohash3 or no shop coordinates
      if (item.geohash3) {
        skipped++;
        continue;
      }

      if (!item.shopLatitude || !item.shopLongitude) {
        skipped++;
        continue;
      }

      const geohash3Value = geohash.encode(item.shopLatitude, item.shopLongitude, 3);

      await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: item.PK,
          SK: item.SK,
        },
        UpdateExpression: 'SET geohash3 = :gh3',
        ExpressionAttributeValues: {
          ':gh3': geohash3Value,
        },
      }));

      updated++;

      if (updated % 1000 === 0) {
        console.log(`Updated ${updated} events...`);
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;

    // Log progress
    if (scanned % 5000 === 0) {
      console.log(`Scanned ${scanned} events so far...`);
    }
  } while (lastEvaluatedKey);

  console.log(`\nBackfill complete!`);
  console.log(`  Scanned: ${scanned} events`);
  console.log(`  Updated: ${updated} events`);
  console.log(`  Skipped: ${skipped} events (already had geohash3 or no shop coordinates)`);
}

backfillEventGeohash3().catch(console.error);
