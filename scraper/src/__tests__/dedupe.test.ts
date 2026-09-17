import { describe, it, expect } from 'vitest';
import {
  addToDedupeIndex,
  buildDedupeIndex,
  dedupeKeyCandidates,
  eventDedupeKey,
  findDuplicate,
  looksLikeDifferentEvent,
  markEventSeen,
  splitDuplicates,
  type DedupeableEvent,
} from '../dedupe.js';

describe('eventDedupeKey', () => {
  it('builds a lat|lon|minute key', () => {
    expect(
      eventDedupeKey({
        latitude: 37.020373,
        longitude: -121.56048120000001,
        startDate: new Date('2026-10-02T01:00:00Z'),
      })
    ).toBe('37.020|-121.560|2026-10-02T01:00Z');
  });

  it('matches the same event reported by two sources with slightly different coords', () => {
    // Same store, geocoded independently by UVS and by Riot (~20m apart)
    const uvs = eventDedupeKey({
      latitude: 38.0162814,
      longitude: -121.816311,
      startDate: new Date('2026-10-02T01:00:00.000Z'),
    });
    const riot = eventDedupeKey({
      latitude: 38.0162901,
      longitude: -121.8163045,
      startDate: new Date('2026-10-02T01:00:00Z'),
    });
    expect(riot).toBe(uvs);
  });

  it('ignores sub-minute differences in start time', () => {
    const a = eventDedupeKey({ latitude: 1, longitude: 2, startDate: new Date('2026-10-02T01:00:00Z') });
    const b = eventDedupeKey({ latitude: 1, longitude: 2, startDate: new Date('2026-10-02T01:00:59Z') });
    expect(b).toBe(a);
  });

  it('separates events at the same place at different times', () => {
    const a = eventDedupeKey({ latitude: 1, longitude: 2, startDate: new Date('2026-10-02T01:00:00Z') });
    const b = eventDedupeKey({ latitude: 1, longitude: 2, startDate: new Date('2026-10-02T02:00:00Z') });
    expect(b).not.toBe(a);
  });

  it('separates events at the same time in different places', () => {
    const a = eventDedupeKey({ latitude: 37.7749, longitude: -122.4194, startDate: new Date('2026-10-02T01:00:00Z') });
    const b = eventDedupeKey({ latitude: 40.7128, longitude: -74.006, startDate: new Date('2026-10-02T01:00:00Z') });
    expect(b).not.toBe(a);
  });

  it('separates stores more than ~110m apart', () => {
    const a = eventDedupeKey({ latitude: 37.0203, longitude: -121.5604, startDate: new Date('2026-10-02T01:00:00Z') });
    const b = eventDedupeKey({ latitude: 37.0225, longitude: -121.5604, startDate: new Date('2026-10-02T01:00:00Z') });
    expect(b).not.toBe(a);
  });

  it('normalises -0 and handles missing coordinates', () => {
    expect(eventDedupeKey({ latitude: -0.0001, longitude: 0, startDate: new Date('2026-10-02T01:00:00Z') })).toBe(
      '0.000|0.000|2026-10-02T01:00Z'
    );
    expect(eventDedupeKey({ latitude: null, longitude: undefined, startDate: new Date('2026-10-02T01:00:00Z') })).toBe(
      'na|na|2026-10-02T01:00Z'
    );
  });

  it('does not throw on an invalid date', () => {
    expect(eventDedupeKey({ latitude: 1, longitude: 2, startDate: new Date('nope') })).toBe('1.000|2.000|na');
  });
});

describe('splitDuplicates', () => {
  const uvsEvent = { latitude: 37.020373, longitude: -121.56048, startDate: new Date('2026-10-02T00:00:00Z') };

  // Riot event at the same store, same minute, from the second source
  const riotSameEvent = { id: 'a', latitude: 37.0203, longitude: -121.5605, startDate: new Date('2026-10-02T00:00:00Z') };
  const riotOtherEvent = { id: 'b', latitude: 40.7128, longitude: -74.006, startDate: new Date('2026-10-05T23:00:00Z') };

  it('pairs second-source events with the first-source event they duplicate', () => {
    const index = buildDedupeIndex([uvsEvent]);
    const { unique, matched } = splitDuplicates([riotSameEvent, riotOtherEvent], index);
    expect(unique.map(e => e.id)).toEqual(['b']);
    expect(matched.map(m => m.secondary.id)).toEqual(['a']);
    // The pair carries the primary record, so the two can be field-merged.
    expect(matched[0].primary).toBe(uvsEvent);
  });

  it('keeps everything when the first source found nothing there', () => {
    const { unique, matched } = splitDuplicates([riotSameEvent, riotOtherEvent], buildDedupeIndex<DedupeableEvent>([]));
    expect(unique).toHaveLength(2);
    expect(matched).toHaveLength(0);
  });

  it('keeps two different tournaments at the same store and minute', () => {
    // Real case: "Games of Brentwood" runs two Pre-Rift events at 2026-10-19T01:00Z.
    // Only overlap with the *other* source counts as a duplicate, so both survive.
    const first = { id: 'prb-117096731805661097', latitude: 37.9419, longitude: -121.7367, startDate: new Date('2026-10-19T01:00:00Z') };
    const second = { id: 'prb-117124556273536574', latitude: 37.9419, longitude: -121.7367, startDate: new Date('2026-10-19T01:00:00Z') };
    expect(eventDedupeKey(first)).toBe(eventDedupeKey(second));

    const { unique, matched } = splitDuplicates([first, second], buildDedupeIndex<DedupeableEvent>([]));
    expect(unique).toHaveLength(2);
    expect(matched).toHaveLength(0);
  });
});

describe('dedupeKeyCandidates', () => {
  it('returns the event cell plus its eight neighbours', () => {
    const event = { latitude: 37.0205, longitude: -121.5605, startDate: new Date('2026-10-02T01:00:00Z') };
    const keys = dedupeKeyCandidates(event);
    expect(keys).toHaveLength(9);
    expect(new Set(keys).size).toBe(9);
    expect(keys).toContain(eventDedupeKey(event));
    // Base cell is 37.021|-121.560; neighbours step +/-0.001 on each axis
    expect(eventDedupeKey(event)).toBe('37.021|-121.560|2026-10-02T01:00Z');
    expect(keys).toContain('37.020|-121.561|2026-10-02T01:00Z');
    expect(keys).toContain('37.022|-121.559|2026-10-02T01:00Z');
  });

  it('wraps longitudes across the antimeridian', () => {
    const keys = dedupeKeyCandidates({ latitude: 0, longitude: 180, startDate: new Date('2026-10-02T01:00:00Z') });
    expect(keys).toContain('0.000|-179.999|2026-10-02T01:00Z');
  });

  it('keeps missing coordinates unmatched', () => {
    const keys = dedupeKeyCandidates({ latitude: null, longitude: null, startDate: new Date('2026-10-02T01:00:00Z') });
    expect(new Set(keys)).toEqual(new Set(['na|na|2026-10-02T01:00Z']));
  });

  it('matches a store the two APIs geocoded either side of a rounding boundary', () => {
    // Real shape of the near-misses: ~20m apart, but 37.0205 rounds to 37.021
    // and 37.02049 rounds to 37.020.
    const uvs = { latitude: 37.02049, longitude: -121.56049, startDate: new Date('2026-10-02T01:00:00Z') };
    const riot = { latitude: 37.02051, longitude: -121.56051, startDate: new Date('2026-10-02T01:00:00Z') };
    expect(eventDedupeKey(riot)).not.toBe(eventDedupeKey(uvs));

    const { matched } = splitDuplicates([riot], buildDedupeIndex([uvs]));
    expect(matched).toHaveLength(1);
  });

  it('still separates stores more than ~250m apart', () => {
    const a = { latitude: 37.0203, longitude: -121.5604, startDate: new Date('2026-10-02T01:00:00Z') };
    const b = { latitude: 37.0253, longitude: -121.5604, startDate: new Date('2026-10-02T01:00:00Z') };
    const { unique, matched } = splitDuplicates([b], buildDedupeIndex([a]));
    expect(unique).toHaveLength(1);
    expect(matched).toHaveLength(0);
  });
});

describe('price + category guard (looksLikeDifferentEvent)', () => {
  // Real case from the audit: Games of Martinez, 2026-10-16T01:00Z. The store's
  // stale recurring UVS series and its Riot prerelease start at the same minute
  // at the same address, but they are two different events.
  const gamesOfMartinezUvs = {
    id: '778899',
    latitude: 38.0194,
    longitude: -122.1341,
    startDate: new Date('2026-10-16T01:00:00Z'),
    eventType: 'Nexus Night',
    price: '$15.00',
  };
  const gamesOfMartinezRiot = {
    id: 'prb-117096731805661097',
    latitude: 38.0194,
    longitude: -122.1341,
    startDate: new Date('2026-10-16T01:00:00Z'),
    eventType: 'Pre-Rift',
    price: '$40.00',
  };

  it('rejects a match when price and category both differ', () => {
    expect(eventDedupeKey(gamesOfMartinezRiot)).toBe(eventDedupeKey(gamesOfMartinezUvs));
    expect(looksLikeDifferentEvent(gamesOfMartinezRiot, gamesOfMartinezUvs)).toBe(true);

    const { unique, matched } = splitDuplicates([gamesOfMartinezRiot], buildDedupeIndex([gamesOfMartinezUvs]));
    expect(matched).toHaveLength(0);
    expect(unique.map(e => e.id)).toEqual(['prb-117096731805661097']);
  });

  it('still matches a true duplicate that agrees on price and category', () => {
    const uvs = {
      id: '112233',
      latitude: 37.9419,
      longitude: -121.7367,
      startDate: new Date('2026-10-19T01:00:00Z'),
      eventType: 'Pre-Rift',
      price: '$40.00',
    };
    const riot = {
      id: 'prb-117124556273536574',
      latitude: 37.9419,
      longitude: -121.7367,
      startDate: new Date('2026-10-19T01:00:00Z'),
      eventType: 'Pre-Rift',
      price: '$40.00',
    };
    expect(looksLikeDifferentEvent(riot, uvs)).toBe(false);

    const { unique, matched } = splitDuplicates([riot], buildDedupeIndex([uvs]));
    expect(unique).toHaveLength(0);
    expect(matched).toHaveLength(1);
    expect(matched[0].primary.id).toBe('112233');
  });

  it('treats a differing price alone as the same event', () => {
    const uvs = { ...gamesOfMartinezUvs, eventType: 'Pre-Rift' };
    expect(looksLikeDifferentEvent(gamesOfMartinezRiot, uvs)).toBe(false);
    expect(splitDuplicates([gamesOfMartinezRiot], buildDedupeIndex([uvs])).matched).toHaveLength(1);
  });

  it('treats a differing category alone as the same event', () => {
    const uvs = { ...gamesOfMartinezUvs, price: '$40.00' };
    expect(looksLikeDifferentEvent(gamesOfMartinezRiot, uvs)).toBe(false);
    expect(splitDuplicates([gamesOfMartinezRiot], buildDedupeIndex([uvs])).matched).toHaveLength(1);
  });

  it('does not treat a null price or category as a difference', () => {
    const riotNoPrice = { ...gamesOfMartinezRiot, price: null };
    expect(looksLikeDifferentEvent(riotNoPrice, gamesOfMartinezUvs)).toBe(false);

    const riotNoCategory = { ...gamesOfMartinezRiot, eventType: null };
    expect(looksLikeDifferentEvent(riotNoCategory, gamesOfMartinezUvs)).toBe(false);

    const uvsNothing = { ...gamesOfMartinezUvs, price: undefined, eventType: undefined };
    expect(looksLikeDifferentEvent(gamesOfMartinezRiot, uvsNothing)).toBe(false);
  });

  it('treats equivalent spellings of free as the same price', () => {
    const uvs = { ...gamesOfMartinezUvs, price: 'Free' };
    const riot = { ...gamesOfMartinezRiot, price: 'Free Event' };
    expect(looksLikeDifferentEvent(riot, uvs)).toBe(false);
    expect(looksLikeDifferentEvent({ ...riot, price: '$0.00' }, uvs)).toBe(false);
  });

  it('picks the co-located UVS event that is actually the same event', () => {
    // The store runs both at the same minute: the stale recurring series and the
    // prerelease. Riot's Pre-Rift must merge into the UVS Pre-Rift, not the
    // Nexus Night sitting in the same cell.
    const index = buildDedupeIndex([gamesOfMartinezUvs]);
    const uvsPreRift = { ...gamesOfMartinezUvs, id: '778900', eventType: 'Pre-Rift', price: '$40.00' };
    addToDedupeIndex(index, uvsPreRift);

    expect(findDuplicate(gamesOfMartinezRiot, index)?.id).toBe('778900');
  });
});

describe('markEventSeen', () => {
  // UVS offset pagination is unstable: the audit counted 607 repeated event ids
  // across 40,433 rows in one run (1.5%), which used to be upserted twice.
  it('reports the first sighting and skips repeats within a run', () => {
    const seen = new Set<string>();
    expect(markEventSeen(seen, '1039321')).toBe(true);
    expect(markEventSeen(seen, '1039321')).toBe(false);
    expect(markEventSeen(seen, '1039322')).toBe(true);
    expect(seen.size).toBe(2);
  });

  it('counts how many upserts a run avoids', () => {
    const seen = new Set<string>();
    const pages = [['1', '2', '3'], ['3', '4', '1'], ['5']];
    let processed = 0;
    let duplicateIds = 0;

    for (const page of pages) {
      for (const id of page) {
        if (!markEventSeen(seen, id)) {
          duplicateIds++;
          continue;
        }
        processed++;
      }
    }

    expect(processed).toBe(5);
    expect(duplicateIds).toBe(2);
  });
});

describe('one primary per secondary', () => {
  // A store can run two Riot tournaments at the same minute. They must not both
  // collapse onto the same UVS row - the second one is a separate event.
  const uvs = {
    id: '990011',
    latitude: 37.9419,
    longitude: -121.7367,
    startDate: new Date('2026-10-19T01:00:00Z'),
    eventType: 'Pre-Rift',
    price: '$40.00',
  };
  const riotA = { ...uvs, id: 'prb-117096731805661097' };
  const riotB = { ...uvs, id: 'prb-117124556273536574' };

  it('merges the first and inserts the second', () => {
    const { unique, matched } = splitDuplicates([riotA, riotB], buildDedupeIndex([uvs]));
    expect(matched.map(m => m.secondary.id)).toEqual(['prb-117096731805661097']);
    expect(unique.map(e => e.id)).toEqual(['prb-117124556273536574']);
  });

  it('matches each Riot event to its own UVS event when the store has two', () => {
    const secondUvs = { ...uvs, id: '990012' };
    const { unique, matched } = splitDuplicates([riotA, riotB], buildDedupeIndex([uvs, secondUvs]));
    expect(unique).toHaveLength(0);
    expect(matched.map(m => m.primary.id)).toEqual(['990011', '990012']);
  });
});
