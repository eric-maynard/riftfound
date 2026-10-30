/**
 * An in-memory stand-in for the DynamoDB document client, for the API side.
 *
 * The scraper has one of its own (`scraper/src/__tests__/helpers/fakeDynamo.ts`)
 * and this is deliberately not shared with it: that one exists to check what a
 * *writer* put in the table, and this one exists to check what a *reader* gets
 * back out when the table is large. The difference that matters is right here
 * in `ScanCommand` - this fake honours `Limit` and `ExclusiveStartKey` with
 * DynamoDB's real "items examined before the filter" semantics, which is the
 * exact behaviour the capped-scan search bug turned on. A fake that filtered
 * first and then counted would make the broken search look like it worked.
 *
 * It lives in its own module because a `vi.mock` factory runs before the test
 * file's own declarations are evaluated, so the fakes cannot be defined there.
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

/**
 * The table, in insertion order.
 *
 * Order is load-bearing here in a way it is not in the scraper's fake: scan
 * order is *why* the old search found `sealsmasher` (first page) and not
 * `tpcstld` (page 80), so a test that proves the fix has to be able to put a
 * player deep in the corpus and have them stay there.
 */
export const fakeTable = new Map<string, FakeItem>();

const itemKey = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;

export function putFakeItem(item: FakeItem): void {
  fakeTable.set(itemKey(item.PK, item.SK), item);
}

export function resetFakeTable(): void {
  fakeTable.clear();
  fakeSend.mockClear();
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

/** `SK = :sk`, which is the only filter the readers under test use on a Scan. */
function matchesScanFilter(item: FakeItem, input: CommandInput): boolean {
  const expression = String(input.FilterExpression ?? '');
  if (expression.length === 0) return true;
  const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
  if (expression.includes('SK = :sk')) return item.SK === values[':sk'];
  return true;
}

export const fakeSend = vi.fn(async (command: FakeCommand): Promise<Record<string, unknown>> => {
  const input = command.input;

  if (command instanceof FakeGetCommand) {
    const key = input.Key as FakeItem;
    return { Item: fakeTable.get(itemKey(key.PK, key.SK)) };
  }

  if (command instanceof FakePutCommand) {
    putFakeItem(input.Item as FakeItem);
    return {};
  }

  if (command instanceof FakeQueryCommand) {
    const sortAttr = input.IndexName === 'GSI1' ? 'GSI1SK' : 'SK';
    let items = [...fakeTable.values()]
      .filter((item) => matchesKeyCondition(item, input))
      .sort((a, b) => String(a[sortAttr]).localeCompare(String(b[sortAttr])));
    if (input.ScanIndexForward === false) items = items.reverse();

    const start = input.ExclusiveStartKey as FakeItem | undefined;
    if (start) {
      const at = items.findIndex((item) => item.SK === start.SK);
      items = at >= 0 ? items.slice(at + 1) : items;
    }
    const limit = Number(input.Limit ?? items.length);
    const page = items.slice(0, limit);
    const more = page.length < items.length;
    return {
      Items: page,
      ...(more && page.length > 0
        ? { LastEvaluatedKey: { PK: page[page.length - 1].PK, SK: page[page.length - 1].SK } }
        : {}),
    };
  }

  if (command instanceof FakeBatchGetCommand) {
    const requestItems = input.RequestItems as Record<string, { Keys: FakeItem[] }>;
    const responses: Record<string, FakeItem[]> = {};
    for (const [table, spec] of Object.entries(requestItems)) {
      // Returned in a *shuffled* order on purpose: BatchGet gives no ordering
      // guarantee, and a reader that relied on the request order would pass a
      // test that handed items back in it.
      responses[table] = spec.Keys.map((key) => fakeTable.get(itemKey(key.PK, key.SK)))
        .filter((item): item is FakeItem => item !== undefined)
        .reverse();
    }
    return { Responses: responses, UnprocessedKeys: {} };
  }

  if (command instanceof FakeScanCommand) {
    // DynamoDB's real semantics, and the whole point of this fake: `Limit`
    // bounds the items *examined*, and the filter is applied to that window
    // afterwards. So a 500-item Limit over a table of mostly non-PROFILE rows
    // yields a handful of profiles, which is what made the old search see
    // 0.43% of players.
    const all = [...fakeTable.values()];
    const start = input.ExclusiveStartKey as FakeItem | undefined;
    const from = start ? all.findIndex((item) => itemKey(item.PK, item.SK) === itemKey(start.PK, start.SK)) + 1 : 0;
    const limit = Number(input.Limit ?? all.length);
    const window = all.slice(from, from + limit);
    const last = window[window.length - 1];
    const more = from + window.length < all.length;
    return {
      Items: window.filter((item) => matchesScanFilter(item, input)),
      ScannedCount: window.length,
      ...(more && last ? { LastEvaluatedKey: { PK: last.PK, SK: last.SK } } : {}),
    };
  }

  if (command instanceof FakeBatchWriteCommand) {
    const requestItems = input.RequestItems as Record<string, Record<string, unknown>[]>;
    for (const requests of Object.values(requestItems)) {
      for (const request of requests) {
        const putRequest = request.PutRequest as { Item: FakeItem } | undefined;
        const deleteRequest = request.DeleteRequest as { Key: FakeItem } | undefined;
        if (putRequest) putFakeItem(putRequest.Item);
        else if (deleteRequest) fakeTable.delete(itemKey(deleteRequest.Key.PK, deleteRequest.Key.SK));
      }
    }
    return { UnprocessedItems: {} };
  }

  return {};
});
