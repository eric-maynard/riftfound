import { describe, it, expect } from 'vitest';
import {
  haversineMeters,
  matchOrganizerToShop,
  resolveOrganizerShops,
  shopNameSimilarity,
  type ShopCandidate,
} from '../shopMatch.js';

// ~0.001 deg latitude = ~111m
const martinez: ShopCandidate = { externalId: 4821, name: 'Games of Martinez', latitude: 38.0194, longitude: -122.1341 };
const cafe: ShopCandidate = { externalId: 5120, name: 'Dragon Cafe & Cards', latitude: 38.0205, longitude: -122.1341 };

describe('shopNameSimilarity', () => {
  it('treats spacing, punctuation, case and legal suffixes as irrelevant', () => {
    expect(shopNameSimilarity('Games of Martinez, LLC', 'games-of-martinez')).toBe(1);
    expect(shopNameSimilarity('GameKastle', 'Game Kastle Inc.')).toBe(1);
  });

  it('scores containment highly', () => {
    expect(shopNameSimilarity('Games of Martinez', 'Games of Martinez Card Shop')).toBe(0.9);
  });

  it('does not match stores that only share a generic word', () => {
    expect(shopNameSimilarity('Cards & Games', 'Dragon Games')).toBeLessThan(0.5);
  });

  // The two systematic ways the sources spell the same store differently. Both
  // scored 0 before - indistinguishable from two unrelated stores - and both
  // were leaving a duplicate shop row in production. See shopMatch.ts for the
  // corpus measurement behind each row.
  it('reads a run-together name as the spaced one', () => {
    expect(shopNameSimilarity('GameAndTrade', 'Game and Trade')).toBe(1);
    expect(shopNameSimilarity('WorldofBoardGames', 'World of Board Games')).toBe(1);
  });

  it('reads an initialism as the words it stands for', () => {
    // The reported case: one venue split across two shop rows 1m apart.
    expect(shopNameSimilarity('Gamescape San Francisco', 'GamescapeSF')).toBe(1);
    expect(shopNameSimilarity('Chaos Hobby Store', 'CHS')).toBe(1);
    expect(shopNameSimilarity('Top Deck Games - Egg Harbor Township', 'Top Deck Games EHT')).toBe(1);
  });

  it('gives partial credit when only part of the name abbreviates', () => {
    // "CP" is Combat Power; the rest of the two names genuinely differs.
    expect(shopNameSimilarity('Combat Power Gaming and Collectibles', 'CP Collectibles')).toBeGreaterThanOrEqual(0.5);
    // "TCG" is Trading Card Games, across two languages.
    expect(shopNameSimilarity('ArlyToys Trading Card Games', 'ArlyToys Speelgoed en TCG')).toBeGreaterThanOrEqual(0.5);
  });

  it('never scores a pair lower than the plain token overlap', () => {
    // The regression a camel-case tokeniser caused: splitting "CardPro" into
    // two tokens destroys the one token the two names share, and splits every
    // `GmbH` past the stopword list that was meant to drop it. Every rule here
    // is folded in with max() precisely so a *resolved* organizer cannot become
    // unresolved, which would silently resurrect a duplicate shop row.
    expect(shopNameSimilarity('Cardpro Hobbies & Collectibles Toy Shop', 'CardPro Hobbes and Collectibles'))
      .toBeGreaterThanOrEqual(1 / 3);
    expect(shopNameSimilarity('FUNtainment München', 'FUNtainment Einzelhandel GmbH & Co. KG'))
      .toBeGreaterThanOrEqual(0.25);
  });

  it('still refuses two different stores whose names merely overlap', () => {
    // 200m apart in the live corpus; the acronym rule lifts this off zero and
    // must not lift it near the 0.5 threshold.
    expect(shopNameSimilarity('ARCANA LIFE IS A GAME', 'In bocca al gioco')).toBeLessThan(0.5);
    expect(shopNameSimilarity('RedMoon Games', 'Glitch City Games')).toBeLessThan(0.5);
    expect(shopNameSimilarity('Rice Cards', 'Just for fun')).toBeLessThan(0.5);
  });

  it('is symmetric', () => {
    for (const [a, b] of [
      ['Gamescape San Francisco', 'GamescapeSF'],
      ['Combat Power Gaming and Collectibles', 'CP Collectibles'],
      ['GameAndTrade', 'Game and Trade'],
      ['Cards & Games', 'Dragon Games'],
    ]) {
      expect(shopNameSimilarity(a, b)).toBe(shopNameSimilarity(b, a));
    }
  });
});

describe('matchOrganizerToShop', () => {
  it('matches a similarly named store within 250m', () => {
    const organizer = { name: 'Games Of Martinez LLC', latitude: 38.0209, longitude: -122.1341 }; // ~170m
    expect(matchOrganizerToShop(organizer, [martinez, cafe])?.shop.externalId).toBe(4821);
  });

  it('ignores stores beyond 250m even with the same name', () => {
    const organizer = { name: 'Games of Martinez', latitude: 38.0230, longitude: -122.1341 }; // ~400m
    expect(matchOrganizerToShop(organizer, [martinez])).toBeNull();
  });

  it('accepts a loosely named store only when it is the sole store within 50m', () => {
    const organizer = { name: 'Martinez Nexus Nights', latitude: 38.01955, longitude: -122.1341 }; // ~17m
    expect(matchOrganizerToShop(organizer, [martinez])?.shop.externalId).toBe(4821);
    const crowded = { ...cafe, latitude: 38.0196 };
    expect(matchOrganizerToShop(organizer, [martinez, crowded])).toBeNull();
    // Next door but nothing in common: a different store.
    expect(matchOrganizerToShop({ ...organizer, name: 'Pixel Palace' }, [martinez])).toBeNull();
  });

  it('resolves the Gamescape duplicate, at its real coordinates', () => {
    // Both rows are live in production: UVS 1979 "GamescapeSF" and the
    // synthesised Riot organizer 2230608066 "Gamescape San Francisco", 1m
    // apart at 333 Divisadero St. Token Jaccard scored them 0.00, so the
    // organizer never resolved and one venue's history was split across two
    // shop rows - and therefore across two scenes and two venue profiles.
    const gamescapeSF: ShopCandidate = {
      externalId: 1979,
      name: 'GamescapeSF',
      latitude: 37.772684,
      longitude: -122.437613,
    };
    const organizer = { name: 'Gamescape San Francisco', latitude: 37.7726848, longitude: -122.4376298 };
    const match = matchOrganizerToShop(organizer, [gamescapeSF]);
    expect(match?.shop.externalId).toBe(1979);
    expect(match?.distanceMeters).toBeLessThan(5);
  });
});

describe('resolveOrganizerShops', () => {
  it('prefers event evidence over proximity matching', () => {
    const organizers = new Map([[2_000_000_001, { name: 'Dragon Cafe', latitude: 38.0196, longitude: -122.1341 }]]);
    const resolved = resolveOrganizerShops(
      organizers,
      [
        { organizerShopId: 2_000_000_001, uvsShop: martinez },
        { organizerShopId: 2_000_000_001, uvsShop: martinez },
        { organizerShopId: 2_000_000_001, uvsShop: cafe },
      ],
      [martinez, cafe]
    );
    expect(resolved.get(2_000_000_001)?.externalId).toBe(4821);
  });

  it('needs two matched events or a similar name before trusting event evidence', () => {
    const organizers = new Map([[2_000_000_001, { name: 'Pixel Palace', latitude: 38.0196, longitude: -122.1341 }]]);
    expect(resolveOrganizerShops(organizers, [{ organizerShopId: 2_000_000_001, uvsShop: martinez }], []).size).toBe(0);
  });

  it('discards evidence pointing at a shop more than 1km away', () => {
    const far = { ...martinez, latitude: 38.05 };
    const organizers = new Map([[2_000_000_001, { name: 'Unrelated', latitude: 38.0194, longitude: -122.1341 }]]);
    expect(resolveOrganizerShops(organizers, [{ organizerShopId: 2_000_000_001, uvsShop: far }], []).size).toBe(0);
  });

  it('falls back to proximity for organizers without evidence', () => {
    const organizers = new Map([[2_000_000_002, { name: 'Games of Martinez', latitude: 38.0195, longitude: -122.1341 }]]);
    expect(resolveOrganizerShops(organizers, [], [martinez]).get(2_000_000_002)?.externalId).toBe(4821);
  });
});

describe('haversineMeters', () => {
  it('is about 111km per degree of latitude', () => {
    expect(haversineMeters(0, 0, 1, 0)).toBeGreaterThan(111_000);
    expect(haversineMeters(0, 0, 1, 0)).toBeLessThan(111_400);
  });
});
