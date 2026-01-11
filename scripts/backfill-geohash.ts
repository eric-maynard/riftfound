import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import geohash from 'ngeohash';

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'riftfound-prod';
const REGION = process.env.AWS_REGION || 'us-west-2';

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

async function backfillGeohash() {
  console.log(`Backfilling geohash4 for shops in ${TABLE_NAME}...`);

  let lastEvaluatedKey: Record<string, any> | undefined;
  let totalUpdated = 0;
  let totalSkipped = 0;

  do {
    const scanResult = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :shop',
      ExpressionAttributeValues: {
        ':shop': 'SHOP',
      },
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 100,
    }));

    const items = scanResult.Items || [];

    for (const item of items) {
      const lat = item.latitude;
      const lng = item.longitude;

      if (lat === null || lat === undefined || lng === null || lng === undefined) {
        totalSkipped++;
        continue;
      }

      // Calculate 4-character geohash
      const hash = geohash.encode(lat, lng, 4);

      await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: 'SET geohash4 = :gh',
        ExpressionAttributeValues: {
          ':gh': hash,
        },
      }));

      totalUpdated++;
      if (totalUpdated % 100 === 0) {
        console.log(`Updated ${totalUpdated} shops...`);
      }
    }

    lastEvaluatedKey = scanResult.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`\nBackfill complete!`);
  console.log(`Updated: ${totalUpdated} shops with geohash4`);
  console.log(`Skipped: ${totalSkipped} shops without coordinates`);
}

backfillGeohash().catch(console.error);
