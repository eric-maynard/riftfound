/**
 * The co-play graph, and the measurements that decide how a rating may be
 * published.
 *
 * Why this module exists at all: in any paired-comparison model ratings are
 * identified only up to an additive constant **per connected component**. Two
 * local scenes that never meet have independently floating scales, so "1600
 * here" and "1600 there" mean nothing in common. Sequential Elo is worse than
 * silent about it - it is zero-sum inside a closed pool, so a cluster's mean
 * stays pinned at its members' seed values no matter how strong they are, and
 * it will report every isolated scene as exactly average with total confidence.
 *
 * So connectivity is measured first and published as a data-quality signal,
 * rather than assumed away. The numbers this module produces (and the ones in
 * scraper/CLAUDE.md) are what justify the default publishing scope.
 */

import { createHash } from 'node:crypto';
import type { ObservationSet } from './observations.js';

/** Union-find over player indices. */
export class DisjointSet {
  private readonly parent: Int32Array;
  private readonly rank: Int32Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    this.rank = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    // Path compression, iteratively: the graph can be deep and the recursion
    // limit is not worth risking on 100k players.
    let node = x;
    while (this.parent[node] !== root) {
      const next = this.parent[node];
      this.parent[node] = root;
      node = next;
    }
    return root;
  }

  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
    return true;
  }
}

export interface Component {
  id: string;
  /** Player indices, ascending. */
  members: number[];
  size: number;
  matchCount: number;
  venueCount: number;
}

export interface ComponentAssignment {
  /** Component id per player index. Players with no matches get null. */
  componentIds: (string | null)[];
  componentSizes: number[];
  components: Component[];
  /** Fraction of players-with-matches that sit in the largest component. */
  giantShare: number;
  playersWithMatches: number;
}

/**
 * A venue key for a match.
 *
 * `shopExternalId` is the real venue identity and is present on almost every
 * row; coordinates rounded to ~1km are the fallback for a Riot organizer that
 * never resolved to a shop. Both are stable across runs.
 */
export function venueKey(shopExternalId: number | null, latitude: number | null, longitude: number | null): string {
  if (shopExternalId !== null && shopExternalId !== undefined) return `shop:${shopExternalId}`;
  if (latitude !== null && longitude !== null) {
    return `geo:${latitude.toFixed(2)},${longitude.toFixed(2)}`;
  }
  return 'unknown';
}

/**
 * Component id.
 *
 * Derived from the smallest player UUID in the component so the same set of
 * players always gets the same id, whatever order the replay saw them in.
 * **Ids are not stable across refits when two components merge** - the merged
 * component takes the smaller of the two ids and the other disappears. That is
 * inherent: a component is defined by its membership, and membership changed.
 * The ranking pages carry the ids that exist in the snapshot they were written
 * with, so a reader never sees a dangling one.
 */
function componentId(players: string[], members: number[]): string {
  let min = players[members[0]];
  for (const member of members) {
    const id = players[member];
    if (id < min) min = id;
  }
  return `c${createHash('sha256').update(min).digest('hex').slice(0, 10)}`;
}

/**
 * Connected components of the co-play graph.
 *
 * `matchFilter` restricts which matches count as edges, which is how the
 * leave-one-type-out test below removes a whole tier of the event ladder and
 * asks what is left of the graph.
 */
export function findComponents(
  observations: ObservationSet,
  matchFilter?: (matchIndex: number) => boolean
): ComponentAssignment {
  const { players, playerA, playerB } = observations;
  const sets = new DisjointSet(players.length);
  const hasMatch = new Uint8Array(players.length);
  const matchesPerPlayer = new Int32Array(players.length);
  const venuesPerComponent = new Map<number, Set<string>>();

  for (let i = 0; i < playerA.length; i++) {
    if (matchFilter && !matchFilter(i)) continue;
    sets.union(playerA[i], playerB[i]);
    hasMatch[playerA[i]] = 1;
    hasMatch[playerB[i]] = 1;
    matchesPerPlayer[playerA[i]]++;
    matchesPerPlayer[playerB[i]]++;
  }

  const byRoot = new Map<number, number[]>();
  for (let p = 0; p < players.length; p++) {
    if (!hasMatch[p]) continue;
    const root = sets.find(p);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(p);
    else byRoot.set(root, [p]);
  }

  const matchCountByRoot = new Map<number, number>();
  for (let i = 0; i < playerA.length; i++) {
    if (matchFilter && !matchFilter(i)) continue;
    const root = sets.find(playerA[i]);
    matchCountByRoot.set(root, (matchCountByRoot.get(root) ?? 0) + 1);
    const event = observations.events[observations.event[i]];
    let venues = venuesPerComponent.get(root);
    if (!venues) venuesPerComponent.set(root, (venues = new Set()));
    venues.add(venueKey(event.shopExternalId, event.latitude, event.longitude));
  }

  const components: Component[] = [];
  for (const [root, members] of byRoot) {
    members.sort((a, b) => a - b);
    components.push({
      id: componentId(players, members),
      members,
      size: members.length,
      matchCount: matchCountByRoot.get(root) ?? 0,
      venueCount: venuesPerComponent.get(root)?.size ?? 0,
    });
  }
  components.sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));

  const componentIds: (string | null)[] = new Array(players.length).fill(null);
  const componentSizes: number[] = new Array(players.length).fill(0);
  for (const component of components) {
    for (const member of component.members) {
      componentIds[member] = component.id;
      componentSizes[member] = component.size;
    }
  }

  const playersWithMatches = components.reduce((total, component) => total + component.size, 0);
  return {
    componentIds,
    componentSizes,
    components,
    giantShare: playersWithMatches > 0 ? (components[0]?.size ?? 0) / playersWithMatches : 0,
    playersWithMatches,
  };
}

// ---------------------------------------------------------------------------
// The connectivity report
// ---------------------------------------------------------------------------

export interface VenueBridgeRow {
  tournamentType: string;
  matches: number;
  /** Matches whose two players have different home venues. */
  crossVenueMatches: number;
  /** Share of all cross-venue matches this type supplies. */
  shareOfCrossVenue: number;
  /** Cross-venue rate within this type, i.e. how bridging a typical such match is. */
  crossVenueRate: number;
  /** Venue-graph edges (venue pairs) this type is the only supplier of. */
  uniqueVenuePairs: number;
}

export interface LeaveOneTypeOutRow {
  removedType: string;
  matchesRemoved: number;
  componentCount: number;
  giantShare: number;
  /** Giant-component share lost by removing this type, in percentage points. */
  giantShareDelta: number;
}

export interface ConnectivityReport {
  generatedAt: string;
  players: number;
  playersWithMatches: number;
  matches: number;
  games: number;
  venues: number;

  componentCount: number;
  giantComponentSize: number;
  giantComponentShare: number;
  /** Component size -> how many components have it, for the small sizes. */
  componentSizeHistogram: { size: number; components: number; players: number }[];

  playersByVenueCount: { venues: number; players: number }[];
  multiVenuePlayers: number;
  multiVenueShare: number;
  medianVenuesPerPlayer: number;

  crossVenueMatches: number;
  crossVenueShare: number;
  bridgingByType: VenueBridgeRow[];
  leaveOneTypeOut: LeaveOneTypeOutRow[];

  /** Components of the *venue* graph: venues linked when a player played at both. */
  venueComponentCount: number;
  venueGiantComponentSize: number;
  venueGiantComponentShare: number;

  matchesPerPlayer: { percentile: number; matches: number }[];
  playersWithAtLeast: { matches: number; players: number }[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[index];
}

/**
 * Measure the graph.
 *
 * Everything here is descriptive: nothing is fitted, nothing is thresholded.
 * The point is to be able to answer "is a global ladder meaningful?" with a
 * number before building one.
 */
export function connectivityReport(observations: ObservationSet): ConnectivityReport {
  const { players, playerA, playerB, event, events, gameWinners } = observations;
  const matchCount = playerA.length;

  // Venues per player, and each player's home venue (where they played most).
  const venuesPerPlayer: Map<number, Map<string, number>> = new Map();
  const allVenues = new Set<string>();
  const addVenue = (player: number, venue: string) => {
    let counts = venuesPerPlayer.get(player);
    if (!counts) venuesPerPlayer.set(player, (counts = new Map()));
    counts.set(venue, (counts.get(venue) ?? 0) + 1);
  };

  const matchVenue: string[] = new Array(matchCount);
  for (let i = 0; i < matchCount; i++) {
    const meta = events[event[i]];
    const venue = venueKey(meta.shopExternalId, meta.latitude, meta.longitude);
    matchVenue[i] = venue;
    allVenues.add(venue);
    addVenue(playerA[i], venue);
    addVenue(playerB[i], venue);
  }

  const homeVenue = new Map<number, string>();
  for (const [player, counts] of venuesPerPlayer) {
    let best = '';
    let bestCount = -1;
    for (const [venue, count] of counts) {
      // Ties broken by venue key so the choice is deterministic across runs.
      if (count > bestCount || (count === bestCount && venue < best)) {
        best = venue;
        bestCount = count;
      }
    }
    homeVenue.set(player, best);
  }

  // Cross-venue attribution, by tournament type.
  const typeTotals = new Map<string, { matches: number; cross: number }>();
  const venuePairSuppliers = new Map<string, Set<string>>();
  let crossVenueMatches = 0;
  for (let i = 0; i < matchCount; i++) {
    const type = events[event[i]].tournamentType ?? 'Unknown';
    let row = typeTotals.get(type);
    if (!row) typeTotals.set(type, (row = { matches: 0, cross: 0 }));
    row.matches++;
    const ha = homeVenue.get(playerA[i]);
    const hb = homeVenue.get(playerB[i]);
    if (ha !== undefined && hb !== undefined && ha !== hb) {
      crossVenueMatches++;
      row.cross++;
      const pair = ha < hb ? `${ha}|${hb}` : `${hb}|${ha}`;
      let suppliers = venuePairSuppliers.get(pair);
      if (!suppliers) venuePairSuppliers.set(pair, (suppliers = new Set()));
      suppliers.add(type);
    }
  }

  const uniqueBy = new Map<string, number>();
  for (const suppliers of venuePairSuppliers.values()) {
    if (suppliers.size === 1) {
      const only = [...suppliers][0];
      uniqueBy.set(only, (uniqueBy.get(only) ?? 0) + 1);
    }
  }

  const bridgingByType: VenueBridgeRow[] = [...typeTotals.entries()]
    .map(([tournamentType, row]) => ({
      tournamentType,
      matches: row.matches,
      crossVenueMatches: row.cross,
      shareOfCrossVenue: crossVenueMatches > 0 ? row.cross / crossVenueMatches : 0,
      crossVenueRate: row.matches > 0 ? row.cross / row.matches : 0,
      uniqueVenuePairs: uniqueBy.get(tournamentType) ?? 0,
    }))
    .sort((a, b) => b.crossVenueMatches - a.crossVenueMatches);

  // The direct test of the bridging hypothesis: delete a whole tier of the
  // ladder and see what is left of the giant component.
  const base = findComponents(observations);
  const leaveOneTypeOut: LeaveOneTypeOutRow[] = [...typeTotals.keys()]
    .map(removedType => {
      const filtered = findComponents(
        observations,
        i => (events[event[i]].tournamentType ?? 'Unknown') !== removedType
      );
      return {
        removedType,
        matchesRemoved: typeTotals.get(removedType)?.matches ?? 0,
        componentCount: filtered.components.length,
        giantShare: filtered.giantShare,
        giantShareDelta: filtered.giantShare - base.giantShare,
      };
    })
    .sort((a, b) => a.giantShareDelta - b.giantShareDelta);

  // Venue graph: a venue pair is an edge when some player played at both.
  const venueList = [...allVenues];
  const venueIndex = new Map(venueList.map((venue, i) => [venue, i]));
  const venueSets = new DisjointSet(venueList.length);
  for (const counts of venuesPerPlayer.values()) {
    const keys = [...counts.keys()];
    for (let i = 1; i < keys.length; i++) {
      venueSets.union(venueIndex.get(keys[0])!, venueIndex.get(keys[i])!);
    }
  }
  const venueRootSizes = new Map<number, number>();
  for (let i = 0; i < venueList.length; i++) {
    const root = venueSets.find(i);
    venueRootSizes.set(root, (venueRootSizes.get(root) ?? 0) + 1);
  }
  const venueGiant = Math.max(0, ...venueRootSizes.values());

  // Distributions.
  const sizeHistogram = new Map<number, { components: number; players: number }>();
  for (const component of base.components) {
    const bucket = sizeHistogram.get(component.size) ?? { components: 0, players: 0 };
    bucket.components++;
    bucket.players += component.size;
    sizeHistogram.set(component.size, bucket);
  }

  const venueCountHistogram = new Map<number, number>();
  const venueCounts: number[] = [];
  for (const counts of venuesPerPlayer.values()) {
    venueCountHistogram.set(counts.size, (venueCountHistogram.get(counts.size) ?? 0) + 1);
    venueCounts.push(counts.size);
  }
  venueCounts.sort((a, b) => a - b);

  const perPlayerMatches = new Int32Array(players.length);
  for (let i = 0; i < matchCount; i++) {
    perPlayerMatches[playerA[i]]++;
    perPlayerMatches[playerB[i]]++;
  }
  const playedCounts = [...perPlayerMatches].filter(count => count > 0).sort((a, b) => a - b);

  const multiVenuePlayers = venueCounts.filter(count => count > 1).length;

  return {
    generatedAt: new Date().toISOString(),
    players: players.length,
    playersWithMatches: base.playersWithMatches,
    matches: matchCount,
    games: gameWinners.reduce((total, winners) => total + winners.length, 0),
    venues: venueList.length,

    componentCount: base.components.length,
    giantComponentSize: base.components[0]?.size ?? 0,
    giantComponentShare: base.giantShare,
    componentSizeHistogram: [...sizeHistogram.entries()]
      .map(([size, bucket]) => ({ size, ...bucket }))
      .sort((a, b) => a.size - b.size),

    playersByVenueCount: [...venueCountHistogram.entries()]
      .map(([venues, count]) => ({ venues, players: count }))
      .sort((a, b) => a.venues - b.venues),
    multiVenuePlayers,
    multiVenueShare: venueCounts.length > 0 ? multiVenuePlayers / venueCounts.length : 0,
    medianVenuesPerPlayer: percentile(venueCounts, 50),

    crossVenueMatches,
    crossVenueShare: matchCount > 0 ? crossVenueMatches / matchCount : 0,
    bridgingByType,
    leaveOneTypeOut,

    venueComponentCount: venueRootSizes.size,
    venueGiantComponentSize: venueGiant,
    venueGiantComponentShare: venueList.length > 0 ? venueGiant / venueList.length : 0,

    matchesPerPlayer: [10, 25, 50, 75, 90, 99].map(p => ({
      percentile: p,
      matches: percentile(playedCounts, p),
    })),
    playersWithAtLeast: [1, 3, 5, 10, 20, 50].map(matches => ({
      matches,
      players: playedCounts.filter(count => count >= matches).length,
    })),
  };
}
