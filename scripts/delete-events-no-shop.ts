import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'riftfound-prod';
const REGION = process.env.AWS_REGION || 'us-west-2';

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

async function deleteEventsWithoutShop() {
  console.log(`Deleting events without shopExternalId from ${TABLE_NAME}...`);

  let lastEvaluatedKey: Record<string, any> | undefined;
  let totalDeleted = 0;

  do {
    const scanResult = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :event AND (attribute_not_exists(shopExternalId) OR shopExternalId = :null)',
      ExpressionAttributeValues: {
        ':event': 'EVENT',
        ':null': null,
      },
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 100,
      ProjectionExpression: 'PK, SK',
    }));

    const items = scanResult.Items || [];

    if (items.length > 0) {
      // BatchWrite can handle up to 25 items at a time
      const batchSize = 25;
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const deleteRequests = batch.map(item => ({
          DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
        }));

        await docClient.send(new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: deleteRequests,
          },
        }));

        totalDeleted += batch.length;
        console.log(`Deleted ${totalDeleted} events...`);
      }
    }

    lastEvaluatedKey = scanResult.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`\nDeletion complete! Removed ${totalDeleted} events without shop data.`);
}

deleteEventsWithoutShop().catch(console.error);
