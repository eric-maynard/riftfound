/**
 * An in-memory stand-in for the DynamoDB document client.
 *
 * Enough of the real thing to exercise a writer *and then read it back the way
 * a reader would*: single-item Get/Put/Delete, BatchGet, BatchWrite, Scan, and
 * Query on either the main table keys or GSI1. Assertions about what a reader
 * can retrieve are the point - a call-by-call mock can show that a key was
 * written but not that it indexes anything.
 *
 * It lives in its own module because a `vi.mock` factory runs before the test
 * file's own declarations are evaluated, so the fakes cannot be defined there.
 * A test wires it up with:
 *
 *   vi.mock('@aws-sdk/lib-dynamodb', async () => {
 *     const { fakeSend, FAKE_COMMANDS } = await import('./helpers/fakeDynamo.js');
 *     return { DynamoDBDocumentClient: { from: () => ({ send: fakeSend }) }, ...FAKE_COMMANDS };
 *   });
 */
import { vi } from 'vitest';

export interface FakeItem extends Record<string, unknown> {
  PK: string;
  SK: string;
}

type CommandInput = Record<string, unknown>;

export class FakeCommand {
  constructor(public readonly input: CommandInput) {}
}
export class FakeGetCommand extends FakeCommand {}
export class FakePutCommand extends FakeCommand {}
export class FakeQueryCommand extends FakeCommand {}
export class FakeDeleteCommand extends FakeCommand {}
export class FakeBatchWriteCommand extends FakeCommand {}
export class FakeBatchGetCommand extends FakeCommand {}
export class FakeScanCommand extends FakeCommand {}
export class FakeUpdateCommand extends FakeCommand {}

/** Drop-in replacements for the lib-dynamodb command classes. */
export const FAKE_COMMANDS = {
  GetCommand: FakeGetCommand,
  PutCommand: FakePutCommand,
  QueryCommand: FakeQueryCommand,
  DeleteCommand: FakeDeleteCommand,
  BatchWriteCommand: FakeBatchWriteCommand,
  BatchGetCommand: FakeBatchGetCommand,
  ScanCommand: FakeScanCommand,
  UpdateCommand: FakeUpdateCommand,
};

/** The table itself. Clear it between tests. */
export const fakeTable = new Map<string, FakeItem>();

const itemKey = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;

function put(item: FakeItem): void {
  fakeTable.set(itemKey(item.PK, item.SK), item);
}

/** `PK = :pk` (or `GSI1PK = :pk`), optionally `AND begins_with(SK, :sk)`. */
function matchesKeyCondition(item: FakeItem, input: CommandInput): boolean {
  const expression = String(input.KeyConditionExpression ?? '');
  const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
  const onIndex = input.IndexName === 'GSI1';
  const partitionAttr = onIndex ? 'GSI1PK' : 'PK';
  const sortAttr = onIndex ? 'GSI1SK' : 'SK';

  if (item[partitionAttr] !== values[':pk']) return false;
  if (expression.includes('begins_with')) {
    const sortValue = item[sortAttr];
    if (typeof sortValue !== 'string' || !sortValue.startsWith(String(values[':sk']))) return false;
  }
  return true;
}

export const fakeSend = vi.fn(async (command: FakeCommand): Promise<Record<string, unknown>> => {
  const input = command.input;

  if (command instanceof FakeGetCommand) {
    const key = input.Key as FakeItem;
    return { Item: fakeTable.get(itemKey(key.PK, key.SK)) };
  }

  if (command instanceof FakePutCommand) {
    put(input.Item as FakeItem);
    return {};
  }

  if (command instanceof FakeDeleteCommand) {
    const key = input.Key as FakeItem;
    fakeTable.delete(itemKey(key.PK, key.SK));
    return {};
  }

  if (command instanceof FakeQueryCommand) {
    const sortAttr = input.IndexName === 'GSI1' ? 'GSI1SK' : 'SK';
    const items = [...fakeTable.values()]
      .filter(item => matchesKeyCondition(item, input))
      .sort((a, b) => String(a[sortAttr]).localeCompare(String(b[sortAttr])));
    return { Items: items };
  }

  if (command instanceof FakeBatchWriteCommand) {
    const requestItems = input.RequestItems as Record<string, Record<string, unknown>[]>;
    for (const requests of Object.values(requestItems)) {
      for (const request of requests) {
        const putRequest = request.PutRequest as { Item: FakeItem } | undefined;
        const deleteRequest = request.DeleteRequest as { Key: FakeItem } | undefined;
        if (putRequest) put(putRequest.Item);
        else if (deleteRequest) fakeTable.delete(itemKey(deleteRequest.Key.PK, deleteRequest.Key.SK));
      }
    }
    return { UnprocessedItems: {} };
  }

  if (command instanceof FakeBatchGetCommand) {
    const requestItems = input.RequestItems as Record<string, { Keys: FakeItem[] }>;
    const responses: Record<string, FakeItem[]> = {};
    for (const [table, spec] of Object.entries(requestItems)) {
      responses[table] = spec.Keys
        .map(key => fakeTable.get(itemKey(key.PK, key.SK)))
        .filter((item): item is FakeItem => item !== undefined);
    }
    return { Responses: responses, UnprocessedKeys: {} };
  }

  if (command instanceof FakeScanCommand) {
    return { Items: [...fakeTable.values()] };
  }

  return {};
});

/** Everything in one GSI1 partition, in sort-key order - what a reader sees. */
export function queryGsi1(partition: string): FakeItem[] {
  return [...fakeTable.values()]
    .filter(item => item.GSI1PK === partition)
    .sort((a, b) => String(a.GSI1SK).localeCompare(String(b.GSI1SK)));
}
