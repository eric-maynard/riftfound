import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'riftfound-prod';
const REGION = process.env.AWS_REGION || 'us-west-2';

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

async function backfillGSI2() {
  console.log(`Backfilling GSI2 attributes for events in ${TABLE_NAME}...`);

  let lastEvaluatedKey: Record<string, any> | undefined;
  let totalUpdated = 0;
  let totalScanned = 0;

  do {
    // Scan for events that don't have GSI2PK yet
    const scanResult = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :event AND attribute_not_exists(GSI2PK)',
      ExpressionAttributeValues: {
        ':event': 'EVENT',
      },
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 100,
    }));

    totalScanned += scanResult.ScannedCount || 0;
    const items = scanResult.Items || [];

    // Update each event with GSI2PK and GSI2SK
    for (const item of items) {
      const shopExternalId = item.shopExternalId;
      const startDate = item.startDate;

      if (!shopExternalId || !startDate) {
        console.log(`Skipping event ${item.externalId} - missing shopExternalId or startDate`);
        continue;
      }

      await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: 'SET GSI2PK = :gsi2pk, GSI2SK = :gsi2sk',
        ExpressionAttributeValues: {
          ':gsi2pk': `SHOP#${shopExternalId}`,
          ':gsi2sk': startDate,
        },
      }));

      totalUpdated++;
      if (totalUpdated % 100 === 0) {
        console.log(`Updated ${totalUpdated} events...`);
      }
    }

    lastEvaluatedKey = scanResult.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`\nBackfill complete!`);
  console.log(`Scanned: ${totalScanned} items`);
  console.log(`Updated: ${totalUpdated} events with GSI2 attributes`);
}

backfillGSI2().catch(console.error);
