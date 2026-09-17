import { describe, it, expect } from 'vitest';
import type { ScrapedEvent } from '../database.js';
import { mergeEventRecords, mergeEventType, mergeSources, SOURCE_PLAYRIFTBOUND, SOURCE_UVS } from '../merge.js';

/** A UVS row as the scraper builds it: rich text, no URL, often a stale category. */
function uvsEvent(overrides: Partial<ScrapedEvent> = {}): ScrapedEvent {
  return {
    externalId: '1039321',
    name: 'Thursday Nexus Nights',
    description: 'Weekly Riftbound night. Prizes for everyone.',
    location: 'Games of Martinez',
    address: '123 Main St, Martinez, CA, 94553, US',
    city: 'Martinez',
    state: 'CA',
    country: 'US',
    latitude: 38.0194,
    longitude: -122.1341,
    startDate: new Date('2026-10-16T01:00:00Z'),
    startTime: null,
    endDate: new Date('2026-10-16T04:00:00Z'),
    eventType: 'Nexus Night',
    organizer: 'Games of Martinez',
    playerCount: 12,
    capacity: 32,
    price: '$15.00',
    url: null,
    imageUrl: 'https://cdn.uvsgames.test/header.png',
    sources: [SOURCE_UVS],
    ...overrides,
  };
}

/** The same event as Riot reports it: authoritative type + URL, little else. */
function playriftboundEvent(overrides: Partial<ScrapedEvent> = {}): ScrapedEvent {
  return {
    externalId: 'prb-117096731805661097',
    name: 'Riftbound: Origins Pre-Rift Event',
    description: null,
    location: 'Games of Martinez',
    address: '123 Main St, Martinez, CA 94553, USA',
    city: 'Martinez',
    state: 'CA',
    country: 'US',
    latitude: 38.01941,
    longitude: -122.13412,
    startDate: new Date('2026-10-16T01:00:00Z'),
    startTime: null,
    endDate: null,
    eventType: 'Pre-Rift',
    organizer: 'Games of Martinez',
    playerCount: null,
    capacity: 24,
    price: '$15.00',
    url: 'https://playriftbound.com/en-us/events/117096731805661097',
    imageUrl: null,
    sources: [SOURCE_PLAYRIFTBOUND],
    ...overrides,
  };
}

describe('mergeEventRecords', () => {
  it('keeps the UVS identity so the merged record upserts over the same row', () => {
    const merged = mergeEventRecords(uvsEvent(), playriftboundEvent());
    expect(merged.externalId).toBe('1039321');
    expect(merged.name).toBe('Thursday Nexus Nights');
    expect(merged.organizer).toBe('Games of Martinez');
    expect(merged.address).toBe('123 Main St, Martinez, CA, 94553, US');
    expect(merged.latitude).toBe(38.0194);
    expect(merged.longitude).toBe(-122.1341);
  });

  it('takes the authoritative event type and registration URL from Riot', () => {
    const merged = mergeEventRecords(uvsEvent(), playriftboundEvent());
    expect(merged.eventType).toBe('Pre-Rift');
    expect(merged.url).toBe('https://playriftbound.com/en-us/events/117096731805661097');
  });

  it('keeps the UVS description, image and end date that Riot does not have', () => {
    const merged = mergeEventRecords(uvsEvent(), playriftboundEvent());
    expect(merged.description).toBe('Weekly Riftbound night. Prizes for everyone.');
    expect(merged.imageUrl).toBe('https://cdn.uvsgames.test/header.png');
    expect(merged.endDate?.toISOString()).toBe('2026-10-16T04:00:00.000Z');
  });

  it('prefers the UVS player count, because Riot reports none for ~72% of events', () => {
    expect(mergeEventRecords(uvsEvent(), playriftboundEvent()).playerCount).toBe(12);
    // Zero registrations is a real answer, not a missing one.
    expect(mergeEventRecords(uvsEvent({ playerCount: 0 }), playriftboundEvent({ playerCount: 9 })).playerCount).toBe(0);
    // Riot only fills the gap.
    expect(
      mergeEventRecords(uvsEvent({ playerCount: null }), playriftboundEvent({ playerCount: 9 })).playerCount
    ).toBe(9);
  });

  it('prefers the incumbent UVS capacity and price unless they are missing', () => {
    const merged = mergeEventRecords(uvsEvent(), playriftboundEvent({ capacity: 24, price: '$40.00' }));
    expect(merged.capacity).toBe(32);
    expect(merged.price).toBe('$15.00');

    const gapFilled = mergeEventRecords(
      uvsEvent({ capacity: null, price: null }),
      playriftboundEvent({ capacity: 24, price: '$40.00' })
    );
    expect(gapFilled.capacity).toBe(24);
    expect(gapFilled.price).toBe('$40.00');
  });

  it('records both contributing sources', () => {
    expect(mergeEventRecords(uvsEvent(), playriftboundEvent()).sources).toEqual(['uvs', 'playriftbound']);
  });

  it('does not lose Riot fields when the UVS record has no source tag', () => {
    const merged = mergeEventRecords(uvsEvent({ sources: undefined }), playriftboundEvent({ sources: undefined }));
    expect(merged.sources).toEqual(['uvs', 'playriftbound']);
  });
});

describe('mergeEventType', () => {
  it("prefers Riot's enum over the UVS name inference", () => {
    expect(mergeEventType('Nexus Night', 'Pre-Rift')).toBe('Pre-Rift');
    expect(mergeEventType('Other', 'Summoner Skirmish')).toBe('Summoner Skirmish');
  });

  it("does not let Riot's unclassified fallback overwrite a specific UVS category", () => {
    expect(mergeEventType('Nexus Night', 'Other')).toBe('Nexus Night');
    expect(mergeEventType('Nexus Night', null)).toBe('Nexus Night');
  });

  it('falls back to whatever exists', () => {
    expect(mergeEventType(null, 'Other')).toBe('Other');
    expect(mergeEventType(null, null)).toBeNull();
  });
});

describe('mergeSources', () => {
  it('unions the labels without duplicates', () => {
    expect(mergeSources(['uvs'], ['playriftbound'])).toEqual(['uvs', 'playriftbound']);
    expect(mergeSources(['uvs', 'playriftbound'], ['playriftbound'])).toEqual(['uvs', 'playriftbound']);
    expect(mergeSources(null, undefined, ['uvs'])).toEqual(['uvs']);
  });
});
