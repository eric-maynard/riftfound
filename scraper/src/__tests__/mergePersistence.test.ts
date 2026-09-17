import { describe, it, expect } from 'vitest';
import { mergedFieldChanges, preserveMergedFields } from '../merge.js';

const START = '2026-10-16T01:00:00.000Z';

/** A row after a playriftbound field-merge. */
const mergedRow = {
  startDate: START,
  eventType: 'Pre-Rift',
  url: 'https://playriftbound.com/en-us/events/abc',
  playerCount: 12,
  capacity: 16,
  price: '$40.00',
  sources: ['uvs', 'playriftbound'],
};

/** The bare UVS record a worker writes for the same event. */
const uvsWrite = {
  startDate: START,
  eventType: 'Nexus Night',
  url: null,
  playerCount: 12,
  capacity: 16,
  price: '$40.00',
  sources: ['uvs'],
};

describe('preserveMergedFields', () => {
  it('keeps the merged type, url and sources when the UVS pass re-writes a merged row', () => {
    const result = preserveMergedFields(uvsWrite, mergedRow, START);
    expect(result.eventType).toBe('Pre-Rift');
    expect(result.url).toBe(mergedRow.url);
    expect(result.sources).toEqual(['uvs', 'playriftbound']);
    expect(mergedFieldChanges(mergedRow, result)).toBeNull();
  });

  it('lets UVS values win where they are present', () => {
    const result = preserveMergedFields({ ...uvsWrite, price: '$45.00', playerCount: 14 }, mergedRow, START);
    expect(result.price).toBe('$45.00');
    expect(result.playerCount).toBe(14);
  });

  it('drops the merge when the UVS event was retimed', () => {
    const result = preserveMergedFields(uvsWrite, mergedRow, '2026-10-17T01:00:00.000Z');
    expect(result).toBe(uvsWrite);
  });

  it('does nothing for rows that were never merged, or for playriftbound writes', () => {
    expect(preserveMergedFields(uvsWrite, { ...mergedRow, sources: ['uvs'] }, START)).toBe(uvsWrite);
    const prbWrite = { ...uvsWrite, sources: ['playriftbound'] };
    expect(preserveMergedFields(prbWrite, mergedRow, START)).toBe(prbWrite);
  });
});

describe('mergedFieldChanges', () => {
  it('returns only the merge-owned attributes that differ', () => {
    expect(mergedFieldChanges(uvsWrite, mergedRow)).toEqual({
      eventType: 'Pre-Rift',
      url: mergedRow.url,
      sources: ['uvs', 'playriftbound'],
    });
  });

  it('treats undefined and null as equal', () => {
    expect(mergedFieldChanges({ url: undefined, sources: null }, { url: null, sources: [] })).toBeNull();
  });
});
