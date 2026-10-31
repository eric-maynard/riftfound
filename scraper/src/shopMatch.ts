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

/** Lowercased, accent-free, `&` spelled out, apostrophes dropped. */
function foldName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '');
}

/** Lowercased, accent-free, punctuation-free tokens with legal suffixes and fillers removed. */
export function shopNameTokens(name: string): string[] {
  return foldName(name)
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 0 && !STOPWORDS.has(token));
}

/**
 * The name with everything but letters and digits removed - **stopwords kept**.
 *
 * This is the form that makes "GameAndTrade" and "Game and Trade" the same
 * name. The token path drops `and` as a filler on one side and cannot drop it
 * from the middle of a run-together word on the other, so the two token sets
 * share nothing at all; squashed, the two names are character-identical.
 */
function squashName(name: string): string {
  return foldName(name).replace(/[^a-z0-9]+/g, '');
}

/**
 * Length bounds on a run of words we are willing to read as an acronym.
 *
 * Two letters is the shortest initialism a store actually uses ("SF", "CP"),
 * and five words is past anything observed ("Egg Harbor Township" is three).
 * The upper bound also keeps `abbreviatedJoins` linear in the name's length.
 */
const MIN_ACRONYM_WORDS = 2;
const MAX_ACRONYM_WORDS = 5;

/**
 * Every join of `tokens` with one run of adjacent tokens replaced by that run's
 * initials: `["gamescape","san","francisco"]` yields `"gamescapesf"` (among
 * others), which is exactly what the other side of the Gamescape pair spells.
 */
function abbreviatedJoins(tokens: string[]): Set<string> {
  const joins = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens.slice(0, i).join('');
    for (let n = MIN_ACRONYM_WORDS; n <= MAX_ACRONYM_WORDS && i + n <= tokens.length; n++) {
      const initials = tokens.slice(i, i + n).map(token => token[0]).join('');
      joins.add(head + initials + tokens.slice(i + n).join(''));
    }
  }
  return joins;
}

/**
 * `tokens` with every run of adjacent tokens whose initials spell a token of
 * `against` replaced by that initialism, longest run first.
 *
 * This is the partial form of the rule above, for names that abbreviate *part*
 * of themselves and differ elsewhere: "Combat Power Gaming and Collectibles"
 * against "CP Collectibles" becomes `["cp","gaming","collectibles"]`, which
 * shares two tokens with `["cp","collectibles"]` instead of none.
 */
function collapseAcronyms(tokens: string[], against: string[]): string[] {
  const target = new Set(against);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let taken = 0;
    const longest = Math.min(tokens.length - i, MAX_ACRONYM_WORDS);
    for (let n = longest; n >= MIN_ACRONYM_WORDS; n--) {
      const initials = tokens.slice(i, i + n).map(token => token[0]).join('');
      if (target.has(initials)) {
        out.push(initials);
        taken = n;
        break;
      }
    }
    if (taken === 0) {
      out.push(tokens[i]);
      taken = 1;
    }
    i += taken;
  }
  return out;
}

function tokenJaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/** One joined name contains the other, with enough of it to mean something. */
function oneContainsTheOther(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 6 && longer.includes(shorter);
}

/**
 * 0..1 similarity between two store names. 1 when they're the same ignoring
 * spacing/punctuation or when one abbreviates the other, 0.9 when one contains
 * the other ("Games of Martinez" vs "Games of Martinez Card Shop"), otherwise
 * token Jaccard with acronyms expanded.
 *
 * The two sources name the same store differently in two systematic ways, and
 * plain token Jaccard scores both at **zero** - the worst available answer,
 * because a zero is indistinguishable from two unrelated stores:
 *
 * 1. **One side runs the words together.** "GameAndTrade" is one token and
 *    "Game and Trade" is two, with the word between them dropped as a filler,
 *    so the sets are disjoint. `squashName` compares them with the spacing and
 *    the fillers put back.
 * 2. **One side abbreviates part of the name.** "GamescapeSF" against
 *    "Gamescape San Francisco", "Top Deck Games EHT" against "... Egg Harbor
 *    Township", "CHS" against "Chaos Hobby Store". `abbreviatedJoins` and
 *    `collapseAcronyms` read an initialism as the words it stands for.
 *
 * **Every rule here is additive** - folded in with `max`, never replacing the
 * token overlap - so no pair's similarity can fall. That property matters more
 * than the new matches do, because this function also *gates*
 * `matchOrganizerToShop`: a lowered score would orphan an organizer that
 * resolves today, and the symptom would be a shop row reappearing rather than
 * an obvious failure. A tokeniser change was tried first and rejected for
 * exactly this - splitting on a lower-to-upper transition fixes Gamescape and
 * breaks "CardPro Hobbies" against "Cardpro Hobbes" (0.33 -> 0.12, the shared
 * token destroyed) along with every `GmbH` in the corpus, which the stopword
 * list can no longer see once it is spelled `gmb h`.
 *
 * Measured against the live shop corpus (9,536 rows, 1,015 of them synthesised
 * Riot organizers still awaiting a UVS match) on 2026-10-31. Of the 206
 * synthesised-vs-UVS pairs inside the 250m search radius, 10 change score,
 * **0 fall**, and the change resolves **9** organizers that resolve to nothing
 * today - every one of them the same store, by inspection:
 *
 * | organizer | UVS shop | apart | before | after |
 * |---|---|---|---|---|
 * | Gamescape San Francisco | GamescapeSF | 1m | 0.00 | **1.00** |
 * | GameAndTrade | Game and Trade | 6m | 0.00 | **1.00** |
 * | WorldofBoardGames | World of Board Games | 1m | 0.00 | **1.00** |
 * | Chaos Hobby Store | CHS | 22m | 0.00 | **1.00** |
 * | Top Deck Games - Egg Harbor Township | Top Deck Games EHT | 174m | 0.43 | **1.00** |
 * | Combat Power Gaming and Collectibles | CP Collectibles | 142m | 0.20 | **0.67** |
 * | ArlyToys Trading Card Games | ArlyToys Speelgoed en TCG | 0m | 0.14 | **0.50** |
 * | Bulle de Jeux Melun | BDJ LOISIRS | 0m | 0.00 | 0.33 |
 * | BNW Unlimited LLC | Brave New Worlds - Willow Grove | 1m | 0.00 | 0.25 |
 *
 * The last two clear the sole-candidate rule rather than the 0.5 name
 * threshold, which is the case that rule exists for: a lone UVS shop metres
 * away whose name is only loosely similar.
 *
 * The tenth change is the one that is **not** a match, and it is the useful
 * one to record: "ARCANA LIFE IS A GAME" against "In bocca al gioco" 200m away
 * rises 0.00 -> 0.14, because `collapseAcronyms` reads `al` as initials of
 * "A GAME" somewhere in the middle. It stays far below the 0.5 threshold and
 * is not a sole candidate (another UVS shop sits 16m from that organizer), so
 * it resolves to nothing - which is why the two thresholds carry the decision
 * and this function only ever supplies evidence to them.
 *
 * A two-letter initialism is weak evidence on its own, and it is never used on
 * its own - nothing here is consulted until `matchOrganizerToShop` has found a
 * candidate within 250m. Two *different* stores that close, whose names differ
 * only by an acronym standing in for its own expansion, is not a case this
 * corpus contains.
 */
export function shopNameSimilarity(a: string, b: string): number {
  const ta = shopNameTokens(a);
  const tb = shopNameTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const ca = ta.join('');
  const cb = tb.join('');
  const sa = squashName(a);
  const sb = squashName(b);
  // The same name once spacing and punctuation go - with the fillers dropped,
  // or with them kept ("GameAndTrade" vs "Game and Trade").
  if (ca === cb || sa === sb) return 1;
  // One name abbreviates a run of words in the other.
  if (abbreviatedJoins(tb).has(ca) || abbreviatedJoins(ta).has(cb)) return 1;
  if (oneContainsTheOther(ca, cb) || oneContainsTheOther(sa, sb)) return 0.9;

  // Token overlap, with each side's acronyms also read as the words they stand
  // for. Never below the plain overlap: expansion only adds ways to agree.
  const ea = collapseAcronyms(ta, tb);
  const eb = collapseAcronyms(tb, ta);
  return Math.max(
    tokenJaccard(ta, tb),
    tokenJaccard(ea, tb),
    tokenJaccard(ta, eb),
    tokenJaccard(ea, eb)
  );
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
