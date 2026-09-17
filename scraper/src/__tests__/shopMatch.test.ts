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
