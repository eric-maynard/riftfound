/**
 * Matching Riot playriftbound organizers to existing UVS shops.
 *
 * Both sources describe the same physical stores, but Riot identifies organizers
 * by UUID and UVS by integer store id, so without this every store listed on both
 * would get two shop rows (the UVS one and a synthesised `2e9+` one) and its
 * Riot-only events would hang off the duplicate.
 *
 * Two kinds of evidence, strongest first:
 *
 * 1. Event evidence: a Riot event that de-duplicated against a UVS event (same
 *    place, same minute) tells us the organizer *is* that UVS event's shop.
 * 2. Proximity + name: a UVS shop within ~250m whose name is similar, or the
 *    only UVS shop within ~50m sharing at least a word of its name.
 */

export interface ShopCandidate {
  externalId: number;
  name: string;
  latitude: number;
  longitude: number;
}

export interface OrganizerLocation {
  name: string;
  latitude: number;
  longitude: number;
}

/** Search radius for proximity matching. The two APIs geocode stores up to ~200m apart. */
export const SHOP_MATCH_RADIUS_METERS = 250;
/** A lone UVS shop this close only needs a loosely similar name (one shared word). */
export const SHOP_MATCH_SOLE_CANDIDATE_METERS = 50;
const SOLE_CANDIDATE_SIMILARITY = 0.2;
/** Minimum name similarity for a proximity match. */
export const SHOP_NAME_SIMILARITY_THRESHOLD = 0.5;
/** Event evidence is ignored if the two shops are further apart than this. */
export const SHOP_EVIDENCE_MAX_METERS = 1000;

const EARTH_RADIUS_METERS = 6_371_000;

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

const STOPWORDS = new Set([
  'the', 'and', 'of', 'at', 'inc', 'llc', 'ltd', 'limited', 'co', 'corp', 'company', 'llp', 'gmbh', 'pty', 'srl',
]);

/** Lowercased, accent-free, punctuation-free tokens with legal suffixes and fillers removed. */
export function shopNameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 0 && !STOPWORDS.has(token));
}

/**
 * 0..1 similarity between two store names. 1 when they're the same ignoring
 * spacing/punctuation, 0.9 when one contains the other ("Games of Martinez" vs
 * "Games of Martinez Card Shop"), otherwise token Jaccard.
 */
export function shopNameSimilarity(a: string, b: string): number {
  const ta = shopNameTokens(a);
  const tb = shopNameTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const ca = ta.join('');
  const cb = tb.join('');
  if (ca === cb) return 1;
  const [shorter, longer] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (shorter.length >= 6 && longer.includes(shorter)) return 0.9;

  const setA = new Set(ta);
  const setB = new Set(tb);
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

export interface ShopMatch {
  shop: ShopCandidate;
  distanceMeters: number;
  similarity: number;
}

/** Best proximity + name match for an organizer among UVS shop candidates, or null. */
export function matchOrganizerToShop(organizer: OrganizerLocation, candidates: ShopCandidate[]): ShopMatch | null {
  const nearby: ShopMatch[] = [];
  for (const shop of candidates) {
    const distanceMeters = haversineMeters(organizer.latitude, organizer.longitude, shop.latitude, shop.longitude);
    if (distanceMeters > SHOP_MATCH_RADIUS_METERS) continue;
    nearby.push({ shop, distanceMeters, similarity: shopNameSimilarity(organizer.name, shop.name) });
  }
  if (nearby.length === 0) return null;

  const similar = nearby
    .filter(m => m.similarity >= SHOP_NAME_SIMILARITY_THRESHOLD)
    .sort((x, y) => y.similarity - x.similarity || x.distanceMeters - y.distanceMeters);
  if (similar.length > 0) return similar[0];

  if (
    nearby.length === 1 &&
    nearby[0].distanceMeters <= SHOP_MATCH_SOLE_CANDIDATE_METERS &&
    nearby[0].similarity >= SOLE_CANDIDATE_SIMILARITY
  ) {
    return nearby[0];
  }
  return null;
}

/**
 * Resolve Riot organizer shops (keyed by synthesised id) to UVS shops.
 *
 * `evidence` is one entry per Riot event that de-duplicated against a UVS event
 * with a known shop; the most common UVS shop per organizer wins, provided it
 * has two or more matched events or a similar name (one accidental same-minute
 * match at a neighbouring store isn't enough). Everything else falls back to
 * proximity + name matching against `candidates`.
 */
export function resolveOrganizerShops(
  organizers: Map<number, OrganizerLocation>,
  evidence: { organizerShopId: number; uvsShop: ShopCandidate }[],
  candidates: ShopCandidate[]
): Map<number, ShopCandidate> {
  const resolved = new Map<number, ShopCandidate>();

  const votes = new Map<number, Map<number, { shop: ShopCandidate; count: number }>>();
  for (const { organizerShopId, uvsShop } of evidence) {
    const organizer = organizers.get(organizerShopId);
    if (!organizer) continue;
    const distance = haversineMeters(organizer.latitude, organizer.longitude, uvsShop.latitude, uvsShop.longitude);
    if (distance > SHOP_EVIDENCE_MAX_METERS) continue;
    const byShop = votes.get(organizerShopId) ?? new Map();
    const entry = byShop.get(uvsShop.externalId) ?? { shop: uvsShop, count: 0 };
    entry.count++;
    byShop.set(uvsShop.externalId, entry);
    votes.set(organizerShopId, byShop);
  }
  for (const [organizerShopId, byShop] of votes) {
    const best = [...byShop.values()].sort((a, b) => b.count - a.count)[0];
    const organizer = organizers.get(organizerShopId) as OrganizerLocation;
    if (best.count >= 2 || shopNameSimilarity(organizer.name, best.shop.name) >= SHOP_NAME_SIMILARITY_THRESHOLD) {
      resolved.set(organizerShopId, best.shop);
    }
  }

  for (const [organizerShopId, organizer] of organizers) {
    if (resolved.has(organizerShopId)) continue;
    const match = matchOrganizerToShop(organizer, candidates);
    if (match) resolved.set(organizerShopId, match.shop);
  }

  return resolved;
}
