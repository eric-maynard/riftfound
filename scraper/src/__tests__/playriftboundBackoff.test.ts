import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPlayriftboundEvents, SEED_ANCHORS } from '../sources/playriftbound.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPlayriftboundEvents backoff', () => {
  const options = { anchors: SEED_ANCHORS.slice(0, 5), maxAnchorsPerRun: 5, requestDelayMs: 0, anchorDelayMs: 0, rotation: 0 };

  it('stops the whole source on the first 429 instead of trying every anchor', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPlayriftboundEvents(options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(true);
    expect(result.events).toEqual([]);
  });

  it('gives up after repeated anchor failures', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPlayriftboundEvents(options);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.failed).toBe(true);
    expect(result.anchorsFailed).toBe(3);
  });

  it('identifies itself as Riftfound, never as Riot\'s own client', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchPlayriftboundEvents(options);

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['apollographql-client-name']).toBe('Riftfound');
    expect(headers['User-Agent']).toContain('Riftfound');
  });
});
