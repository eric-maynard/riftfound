/**
 * Community detection on the weighted co-play graph - the candidate replacement
 * for "a scene is a connected component".
 *
 * **Why this module exists.** `graph.ts` partitions players into connected
 * components, and the ranking output calls a component a scene (`componentId`,
 * `componentSize`, `regionLabel`). Connectivity is the right primitive for the
 * question components were *introduced* to answer - "are these two ratings on
 * the same scale at all?" - because that is exactly what reachability decides.
 * It is a poor primitive for "which scene does this player belong to", and the
 * measured giant share (97.4% over a complete regional sample) says so: one
 * travelling player welds two cities into one component, so as coverage fills
 * in the partition collapses to a single blob.
 *
 * Community detection asks a different question - which groups of players are
 * *densely* connected to each other relative to chance - and that question has
 * an answer even on a fully connected graph. Modularity (Newman-Girvan) is the
 * objective; Louvain (Blondel et al., 2008) is the optimiser, chosen because it
 * is ~150 lines of arithmetic over typed arrays and adds no runtime dependency,
 * in the same spirit as the hand-rolled WHR solver in `whr.ts`.
 *
 * **Nothing here is published.** No item, no key and no attribute in the output
 * contract reads this module; `componentId` still means a connected component.
 * This is measurement material for `ranking-metrics.sh communities`, and the
 * numbers it produces are in scraper/CLAUDE.md under "Is a scene a connected
 * component?".
 *
 * Determinism matters as much as quality here. Louvain is usually described with
 * a randomised node order, which makes the labels reshuffle between runs on the
 * same data - fatal for a label a UI would show. Every loop below walks nodes in
 * index order and breaks ties on the smaller community id, so one graph has one
 * answer. Community *ids* are then derived from the smallest player UUID in the
 * community, exactly as component ids are, so the id survives a replay in a
 * different order.
 */

import { createHash } from 'node:crypto';
import { findComponents, venueKey } from './graph.js';
import type { ObservationSet } from './observations.js';

// ---------------------------------------------------------------------------
// The weighted graph
// ---------------------------------------------------------------------------

/**
 * An undirected weighted graph in CSR form.
 *
 * `selfLoops[i]` is the weight of i's own loop counted **once** (its
 * contribution to the degree is doubled, as usual). Loops only appear after
 * aggregation, where a community's internal weight becomes its super-node's
 * loop.
 */
export interface WeightedGraph {
  nodeCount: number;
  /** CSR row starts, length nodeCount + 1. */
  offsets: Int32Array;
  neighbours: Int32Array;
  weights: Float64Array;
  selfLoops: Float64Array;
}

/** The co-play graph of players, weighted by how many matches a pair played. */
export function buildCoPlayGraph(
  observations: ObservationSet,
  matchFilter?: (matchIndex: number) => boolean
): { graph: WeightedGraph; nodes: Int32Array; nodeOfPlayer: Int32Array } {
  const playerCount = observations.players.length;
  const nodeOfPlayer = new Int32Array(playerCount).fill(-1);
  const nodes: number[] = [];

  const pairWeight = new Map<number, number>();
  const nodeFor = (player: number): number => {
    if (nodeOfPlayer[player] >= 0) return nodeOfPlayer[player];
    nodeOfPlayer[player] = nodes.length;
    nodes.push(player);
    return nodeOfPlayer[player];
  };

  for (let i = 0; i < observations.playerA.length; i++) {
    if (matchFilter && !matchFilter(i)) continue;
    const a = nodeFor(observations.playerA[i]);
    const b = nodeFor(observations.playerB[i]);
    if (a === b) continue;
    // A pair key that fits in a double exactly: node counts here are < 2^21.
    const key = a < b ? a * 2_097_152 + b : b * 2_097_152 + a;
    pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
  }

  const nodeCount = nodes.length;
  const degree = new Int32Array(nodeCount);
  const pairs = new Int32Array(pairWeight.size * 2);
  const pairWeights = new Float64Array(pairWeight.size);
  let p = 0;
  for (const [key, weight] of pairWeight) {
    const a = Math.floor(key / 2_097_152);
    const b = key % 2_097_152;
    pairs[p * 2] = a;
    pairs[p * 2 + 1] = b;
    pairWeights[p] = weight;
    degree[a]++;
    degree[b]++;
    p++;
  }

  const offsets = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) offsets[i + 1] = offsets[i] + degree[i];
  const cursor = Int32Array.from(offsets.subarray(0, nodeCount));
  const neighbours = new Int32Array(offsets[nodeCount]);
  const weights = new Float64Array(offsets[nodeCount]);
  for (let e = 0; e < pairWeights.length; e++) {
    const a = pairs[e * 2];
    const b = pairs[e * 2 + 1];
    neighbours[cursor[a]] = b;
    weights[cursor[a]++] = pairWeights[e];
    neighbours[cursor[b]] = a;
    weights[cursor[b]++] = pairWeights[e];
  }

  return {
    graph: { nodeCount, offsets, neighbours, weights, selfLoops: new Float64Array(nodeCount) },
    nodes: Int32Array.from(nodes),
    nodeOfPlayer,
  };
}

function weightedDegrees(graph: WeightedGraph): Float64Array {
  const degrees = new Float64Array(graph.nodeCount);
  for (let i = 0; i < graph.nodeCount; i++) {
    let total = 2 * graph.selfLoops[i];
    for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e++) total += graph.weights[e];
    degrees[i] = total;
  }
  return degrees;
}

/**
 * Newman-Girvan modularity of a labelling, at a given resolution.
 *
 * Q = sum_c [ in_c / (2m) - gamma * (tot_c / (2m))^2 ], with `in_c` the weight
 * of edges with both ends in c (self-loops included once, inter-community edges
 * excluded) counted twice, as the convention requires.
 */
export function modularityOf(graph: WeightedGraph, communityOf: Int32Array, resolution = 1): number {
  const degrees = weightedDegrees(graph);
  let twoM = 0;
  for (let i = 0; i < graph.nodeCount; i++) twoM += degrees[i];
  if (twoM === 0) return 0;

  const internal = new Float64Array(graph.nodeCount);
  const total = new Float64Array(graph.nodeCount);
  for (let i = 0; i < graph.nodeCount; i++) {
    total[communityOf[i]] += degrees[i];
    internal[communityOf[i]] += 2 * graph.selfLoops[i];
    for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e++) {
      if (communityOf[graph.neighbours[e]] === communityOf[i]) internal[communityOf[i]] += graph.weights[e];
    }
  }

  let q = 0;
  for (let c = 0; c < graph.nodeCount; c++) {
    if (total[c] === 0) continue;
    q += internal[c] / twoM - resolution * (total[c] / twoM) * (total[c] / twoM);
  }
  return q;
}

// ---------------------------------------------------------------------------
// Louvain
// ---------------------------------------------------------------------------

export interface LouvainOptions {
  /**
   * Modularity resolution.
   *
   * Above 1 favours more, smaller communities; below 1 fewer, larger ones. 1 is
   * the Newman-Girvan default and is what the measurements in CLAUDE.md use.
   */
  resolution: number;
  /** Local-moving passes per level before the level is declared settled. */
  maxPasses: number;
  /** Aggregation levels before giving up. */
  maxLevels: number;
  /** Modularity gain below which a level is not accepted. */
  tolerance: number;
}

export const DEFAULT_LOUVAIN_OPTIONS: LouvainOptions = {
  resolution: 1,
  maxPasses: 40,
  maxLevels: 20,
  tolerance: 1e-7,
};

/** One pass of local moving. Returns true if anything moved. */
function localMoving(graph: WeightedGraph, communityOf: Int32Array, options: LouvainOptions): boolean {
  const degrees = weightedDegrees(graph);
  let twoM = 0;
  for (let i = 0; i < graph.nodeCount; i++) twoM += degrees[i];
  if (twoM === 0) return false;

  const communityDegree = new Float64Array(graph.nodeCount);
  for (let i = 0; i < graph.nodeCount; i++) communityDegree[communityOf[i]] += degrees[i];

  // Scratch for "weight from node i into community c", with a stamp array so it
  // can be reused without clearing the whole thing per node.
  const weightInto = new Float64Array(graph.nodeCount);
  const stamp = new Int32Array(graph.nodeCount).fill(-1);
  const candidates: number[] = [];

  let movedAny = false;
  for (let pass = 0; pass < options.maxPasses; pass++) {
    let moved = 0;
    for (let i = 0; i < graph.nodeCount; i++) {
      const from = communityOf[i];
      candidates.length = 0;
      for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e++) {
        const j = graph.neighbours[e];
        if (j === i) continue;
        const c = communityOf[j];
        if (stamp[c] !== i) {
          stamp[c] = i;
          weightInto[c] = 0;
          candidates.push(c);
        }
        weightInto[c] += graph.weights[e];
      }
      if (stamp[from] !== i) {
        stamp[from] = i;
        weightInto[from] = 0;
        candidates.push(from);
      }

      // Take i out of its community before scoring, so every candidate
      // (its own included) is scored on the same footing.
      communityDegree[from] -= degrees[i];

      let best = from;
      let bestGain = weightInto[from] - (options.resolution * communityDegree[from] * degrees[i]) / twoM;
      // Candidates are walked in discovery order; ties go to the smaller id so
      // the labelling does not depend on adjacency order.
      candidates.sort((a, b) => a - b);
      for (const c of candidates) {
        if (c === from) continue;
        const gain = weightInto[c] - (options.resolution * communityDegree[c] * degrees[i]) / twoM;
        if (gain > bestGain + options.tolerance) {
          bestGain = gain;
          best = c;
        }
      }

      communityDegree[best] += degrees[i];
      if (best !== from) {
        communityOf[i] = best;
        moved++;
      }
    }
    if (moved > 0) movedAny = true;
    if (moved === 0) break;
  }
  return movedAny;
}

/** Renumber labels to 0..k-1 in order of first appearance. */
function compact(labels: Int32Array): { labels: Int32Array; count: number } {
  const map = new Map<number, number>();
  const out = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    let next = map.get(labels[i]);
    if (next === undefined) {
      next = map.size;
      map.set(labels[i], next);
    }
    out[i] = next;
  }
  return { labels: out, count: map.size };
}

/** Collapse each community into one node. */
function aggregate(graph: WeightedGraph, communityOf: Int32Array, communityCount: number): WeightedGraph {
  const pairWeight = new Map<number, number>();
  const selfLoops = new Float64Array(communityCount);
  for (let i = 0; i < graph.nodeCount; i++) {
    const ci = communityOf[i];
    selfLoops[ci] += graph.selfLoops[i];
    for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e++) {
      const cj = communityOf[graph.neighbours[e]];
      if (cj === ci) {
        // Each internal edge is seen from both ends; a loop is counted once.
        selfLoops[ci] += graph.weights[e] / 2;
        continue;
      }
      if (ci > cj) continue;
      const key = ci * 2_097_152 + cj;
      pairWeight.set(key, (pairWeight.get(key) ?? 0) + graph.weights[e]);
    }
  }

  const degree = new Int32Array(communityCount);
  for (const key of pairWeight.keys()) {
    degree[Math.floor(key / 2_097_152)]++;
    degree[key % 2_097_152]++;
  }
  const offsets = new Int32Array(communityCount + 1);
  for (let c = 0; c < communityCount; c++) offsets[c + 1] = offsets[c] + degree[c];
  const cursor = Int32Array.from(offsets.subarray(0, communityCount));
  const neighbours = new Int32Array(offsets[communityCount]);
  const weights = new Float64Array(offsets[communityCount]);
  for (const [key, weight] of pairWeight) {
    const a = Math.floor(key / 2_097_152);
    const b = key % 2_097_152;
    neighbours[cursor[a]] = b;
    weights[cursor[a]++] = weight;
    neighbours[cursor[b]] = a;
    weights[cursor[b]++] = weight;
  }
  return { nodeCount: communityCount, offsets, neighbours, weights, selfLoops };
}

export interface LouvainResult {
  /** Community index per graph node, 0..communityCount-1. */
  communityOf: Int32Array;
  communityCount: number;
  modularity: number;
  levels: number;
}

/**
 * Louvain modularity maximisation.
 *
 * Deterministic: nodes are visited in index order and ties broken on the
 * smaller community id, so the same graph always yields the same labelling.
 */
export function louvain(graph: WeightedGraph, overrides: Partial<LouvainOptions> = {}): LouvainResult {
  const options = { ...DEFAULT_LOUVAIN_OPTIONS, ...overrides };
  let current = graph;
  let membership = new Int32Array(graph.nodeCount);
  for (let i = 0; i < graph.nodeCount; i++) membership[i] = i;

  let levels = 0;
  let quality = modularityOf(graph, membership, options.resolution);

  for (let level = 0; level < options.maxLevels; level++) {
    const labels = new Int32Array(current.nodeCount);
    for (let i = 0; i < current.nodeCount; i++) labels[i] = i;
    const moved = localMoving(current, labels, options);
    const { labels: compacted, count } = compact(labels);
    if (!moved || count === current.nodeCount) break;

    const lifted = new Int32Array(graph.nodeCount);
    for (let i = 0; i < graph.nodeCount; i++) lifted[i] = compacted[membership[i]];
    const next = modularityOf(graph, lifted, options.resolution);
    if (next <= quality + options.tolerance) break;

    membership = lifted;
    quality = next;
    current = aggregate(current, compacted, count);
    levels = level + 1;
  }

  const { labels, count } = compact(membership);
  return { communityOf: labels, communityCount: count, modularity: quality, levels };
}

/**
 * A community id derived from its smallest player UUID.
 *
 * Same construction as `componentId` in graph.ts, and the same caveat: the id
 * is a function of membership, so a community that gains or loses its
 * alphabetically-smallest member is renamed. That is the property the stability
 * measurement below is really about.
 */
export function communityIdFor(players: string[], members: number[]): string {
  let min = players[members[0]];
  for (const member of members) if (players[member] < min) min = players[member];
  return `k${createHash('sha256').update(min).digest('hex').slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// Comparing two partitions
// ---------------------------------------------------------------------------

export interface PartitionAgreement {
  /** Adjusted Rand index: 0 is chance, 1 is identical. Matching-free. */
  adjustedRand: number;
  /** Normalised mutual information (symmetric, sqrt normalisation). */
  normalisedMutualInformation: number;
  /**
   * Share of items whose label changes after mapping each left label to the
   * right label it overlaps most (greedy, largest overlap first).
   *
   * This is the number a UI cares about: it is "how many players would see a
   * different scene name next refit".
   */
  churn: number;
}

/** Contingency table between two labellings of the same items. */
function contingency(left: Int32Array, right: Int32Array): Map<number, Map<number, number>> {
  const table = new Map<number, Map<number, number>>();
  for (let i = 0; i < left.length; i++) {
    let row = table.get(left[i]);
    if (!row) table.set(left[i], (row = new Map()));
    row.set(right[i], (row.get(right[i]) ?? 0) + 1);
  }
  return table;
}

export function comparePartitions(left: Int32Array, right: Int32Array): PartitionAgreement {
  const n = left.length;
  if (n === 0) return { adjustedRand: 1, normalisedMutualInformation: 1, churn: 0 };
  const table = contingency(left, right);
  const leftTotals = new Map<number, number>();
  const rightTotals = new Map<number, number>();
  for (const [a, row] of table) {
    for (const [b, count] of row) {
      leftTotals.set(a, (leftTotals.get(a) ?? 0) + count);
      rightTotals.set(b, (rightTotals.get(b) ?? 0) + count);
    }
  }

  const choose2 = (x: number) => (x * (x - 1)) / 2;
  let sumIJ = 0;
  for (const row of table.values()) for (const count of row.values()) sumIJ += choose2(count);
  let sumI = 0;
  for (const count of leftTotals.values()) sumI += choose2(count);
  let sumJ = 0;
  for (const count of rightTotals.values()) sumJ += choose2(count);
  const expected = (sumI * sumJ) / choose2(n);
  const max = (sumI + sumJ) / 2;
  const adjustedRand = max === expected ? 1 : (sumIJ - expected) / (max - expected);

  let hLeft = 0;
  for (const count of leftTotals.values()) hLeft -= (count / n) * Math.log(count / n);
  let hRight = 0;
  for (const count of rightTotals.values()) hRight -= (count / n) * Math.log(count / n);
  let mutual = 0;
  for (const [a, row] of table) {
    for (const [b, count] of row) {
      const joint = count / n;
      mutual += joint * Math.log(joint / ((leftTotals.get(a)! / n) * (rightTotals.get(b)! / n)));
    }
  }
  const nmi = hLeft > 0 && hRight > 0 ? mutual / Math.sqrt(hLeft * hRight) : 1;

  // Greedy best match, largest overlap first, each right label claimed once.
  const cells: { left: number; right: number; count: number }[] = [];
  for (const [a, row] of table) for (const [b, count] of row) cells.push({ left: a, right: b, count });
  cells.sort((x, y) => y.count - x.count || x.left - y.left || x.right - y.right);
  const mapped = new Map<number, number>();
  const claimed = new Set<number>();
  let agreed = 0;
  for (const cell of cells) {
    if (mapped.has(cell.left) || claimed.has(cell.right)) continue;
    mapped.set(cell.left, cell.right);
    claimed.add(cell.right);
    agreed += cell.count;
  }
  return { adjustedRand, normalisedMutualInformation: nmi, churn: 1 - agreed / n };
}

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface VenueAggregate {
  venue: string;
  shopExternalId: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Distinct players with at least one match here. */
  players: number;
  matches: number;
  events: number;
}

/** Per-venue facts, which is also the answer to "what would a map view need?". */
export function venueAggregates(observations: ObservationSet): VenueAggregate[] {
  const byVenue = new Map<string, {
    shopExternalId: number | null;
    latSum: number;
    lonSum: number;
    coordCount: number;
    players: Set<number>;
    matches: number;
    events: Set<string>;
  }>();
  for (let i = 0; i < observations.playerA.length; i++) {
    const meta = observations.events[observations.event[i]];
    const venue = venueKey(meta.shopExternalId, meta.latitude, meta.longitude);
    let row = byVenue.get(venue);
    if (!row) {
      byVenue.set(venue, (row = {
        shopExternalId: meta.shopExternalId,
        latSum: 0,
        lonSum: 0,
        coordCount: 0,
        players: new Set(),
        matches: 0,
        events: new Set(),
      }));
    }
    if (meta.latitude !== null && meta.longitude !== null) {
      row.latSum += meta.latitude;
      row.lonSum += meta.longitude;
      row.coordCount++;
    }
    row.players.add(observations.playerA[i]);
    row.players.add(observations.playerB[i]);
    row.matches++;
    row.events.add(meta.externalId);
  }
  return [...byVenue.entries()]
    .map(([venue, row]) => ({
      venue,
      shopExternalId: row.shopExternalId,
      latitude: row.coordCount > 0 ? row.latSum / row.coordCount : null,
      longitude: row.coordCount > 0 ? row.lonSum / row.coordCount : null,
      players: row.players.size,
      matches: row.matches,
      events: row.events.size,
    }))
    .sort((a, b) => b.players - a.players || (a.venue < b.venue ? -1 : 1));
}

/**
 * Metro clusters: venues joined when they are within `radiusKm` of each other.
 *
 * Single-linkage, which is the honest choice for "is this the same local
 * scene geographically" - a chain of stores 20km apart really is one metro -
 * and the reason the threshold is reported alongside every number that uses it.
 */
export function metroClusters(
  venues: VenueAggregate[],
  radiusKm: number
): { metroOf: Map<string, number>; metroCount: number } {
  const parent = venues.map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let node = x;
    while (parent[node] !== root) {
      const next = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  };
  for (let i = 0; i < venues.length; i++) {
    for (let j = i + 1; j < venues.length; j++) {
      const a = venues[i];
      const b = venues[j];
      if (a.latitude === null || b.latitude === null) continue;
      if (haversineKm(a.latitude, a.longitude!, b.latitude, b.longitude!) <= radiusKm) {
        parent[find(i)] = find(j);
      }
    }
  }
  const ids = new Map<number, number>();
  const metroOf = new Map<string, number>();
  for (let i = 0; i < venues.length; i++) {
    const root = find(i);
    let id = ids.get(root);
    if (id === undefined) {
      id = ids.size;
      ids.set(root, id);
    }
    metroOf.set(venues[i].venue, id);
  }
  return { metroOf, metroCount: ids.size };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface CommunityRow {
  id: string;
  size: number;
  matches: number;
  /** Share of the community's matches played at its most-used venue. */
  dominantVenueShare: number;
  venues: number;
  /** Mean distance from the community's venue centroid, km. */
  spreadKm: number;
  /** Share of members whose home venue sits in the community's dominant metro. */
  metroPurity: number;
}

export interface CoverageRow {
  coverage: number;
  events: number;
  matches: number;
  playersWithMatches: number;
  components: number;
  giantShare: number;
  communities: number;
  largestCommunityShare: number;
  modularity: number;
}

export interface StabilityRow {
  label: string;
  /** Churn / ARI / NMI of the community labelling against the full-sample one. */
  community: PartitionAgreement;
  /**
   * The same, restricted to players whose full-sample community is large enough
   * to be worth listing in a selector. Small communities churn freely and a UI
   * would not show them, so the restricted number is the one a product cares
   * about.
   */
  communityLargeOnly: PartitionAgreement;
  /** The same, for connected components - the incumbent primitive. */
  component: PartitionAgreement;
}

export interface ResolutionRow {
  resolution: number;
  communities: number;
  modularity: number;
  largestShare: number;
  /** Agreement with the metro partition at this resolution. */
  metroAdjustedRand: number;
  metroNormalisedMutualInformation: number;
  /** Label churn on a 90% match subsample, all communities. */
  churn90: number;
}

export interface CommunityReport {
  generatedAt: string;
  resolution: number;
  playersWithMatches: number;
  edges: number;
  /** Connected components, for comparison. */
  componentCount: number;
  giantComponentShare: number;

  communityCount: number;
  modularity: number;
  levels: number;
  largestCommunityShare: number;
  communitySizes: { percentile: number; size: number }[];
  communitiesOverSize: { size: number; communities: number; players: number }[];
  topCommunities: CommunityRow[];

  /** Agreement of the community partition with geography. */
  metroRadiusKm: number;
  metroCount: number;
  vsMetro: PartitionAgreement;
  vsHomeVenue: PartitionAgreement;
  /** Communities spanning more than one metro, and metros split across communities. */
  communitiesSpanningMetros: number;
  metrosSplitAcrossCommunities: number;

  /** Coverage curve with events missing at random. */
  coverage: CoverageRow[];
  /** Coverage curve with only the earliest X% of the window captured. */
  coverageByDate: CoverageRow[];
  stability: StabilityRow[];
  resolutionSweep: ResolutionRow[];
  /** Community size above which the restricted churn is measured. */
  largeCommunityThreshold: number;
  elapsedMs: { louvain: number; components: number };
}

/** A seeded 32-bit PRNG, so a subsample is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Labels for the players that have a match, aligned with `nodes`. */
function componentLabels(observations: ObservationSet, nodes: Int32Array): Int32Array {
  const assignment = findComponents(observations);
  const ids = new Map<string, number>();
  const labels = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const id = assignment.componentIds[nodes[i]] ?? 'none';
    let index = ids.get(id);
    if (index === undefined) {
      index = ids.size;
      ids.set(id, index);
    }
    labels[i] = index;
  }
  return labels;
}

function percentileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))];
}

export function communityReport(
  observations: ObservationSet,
  options: {
    resolution?: number;
    metroRadiusKm?: number;
    coverageSteps?: number[];
    stabilityFractions?: number[];
    resolutions?: number[];
    largeCommunityThreshold?: number;
  } = {}
): CommunityReport {
  const resolution = options.resolution ?? 1;
  const metroRadiusKm = options.metroRadiusKm ?? 25;
  const coverageSteps = options.coverageSteps ?? [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  const stabilityFractions = options.stabilityFractions ?? [0.9, 0.9, 0.9, 0.8];
  const resolutions = options.resolutions ?? [0.5, 1, 2, 4, 8];
  const largeCommunityThreshold = options.largeCommunityThreshold ?? 100;

  const componentsStart = Date.now();
  const baseComponents = findComponents(observations);
  const componentsMs = Date.now() - componentsStart;

  const { graph, nodes, nodeOfPlayer } = buildCoPlayGraph(observations);
  const louvainStart = Date.now();
  const fit = louvain(graph, { resolution });
  const louvainMs = Date.now() - louvainStart;

  // Members per community, and the venue/metro facts per member.
  const members: number[][] = Array.from({ length: fit.communityCount }, () => []);
  for (let i = 0; i < nodes.length; i++) members[fit.communityOf[i]].push(nodes[i]);

  const venues = venueAggregates(observations);
  const venueByKey = new Map(venues.map(venue => [venue.venue, venue]));
  const { metroOf, metroCount } = metroClusters(venues, metroRadiusKm);

  // Home venue per player: most matches, ties on the venue key.
  const venueCounts = new Map<number, Map<string, number>>();
  const communityMatches = new Int32Array(fit.communityCount);
  const communityVenueCounts: Map<string, number>[] = Array.from({ length: fit.communityCount }, () => new Map());
  for (let i = 0; i < observations.playerA.length; i++) {
    const meta = observations.events[observations.event[i]];
    const venue = venueKey(meta.shopExternalId, meta.latitude, meta.longitude);
    for (const player of [observations.playerA[i], observations.playerB[i]]) {
      let counts = venueCounts.get(player);
      if (!counts) venueCounts.set(player, (counts = new Map()));
      counts.set(venue, (counts.get(venue) ?? 0) + 1);
    }
    const community = fit.communityOf[nodeOfPlayer[observations.playerA[i]]];
    communityMatches[community]++;
    communityVenueCounts[community].set(venue, (communityVenueCounts[community].get(venue) ?? 0) + 1);
  }
  const homeVenue = new Map<number, string>();
  for (const [player, counts] of venueCounts) {
    let best = '';
    let bestCount = -1;
    for (const [venue, count] of counts) {
      if (count > bestCount || (count === bestCount && venue < best)) {
        best = venue;
        bestCount = count;
      }
    }
    homeVenue.set(player, best);
  }

  // Partition agreement against geography.
  const communityLabels = Int32Array.from(fit.communityOf);
  const metroLabels = new Int32Array(nodes.length);
  const venueLabels = new Int32Array(nodes.length);
  const venueIds = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    const venue = homeVenue.get(nodes[i]) ?? 'unknown';
    let venueId = venueIds.get(venue);
    if (venueId === undefined) {
      venueId = venueIds.size;
      venueIds.set(venue, venueId);
    }
    venueLabels[i] = venueId;
    metroLabels[i] = metroOf.get(venue) ?? -1;
  }

  const vsMetro = comparePartitions(communityLabels, metroLabels);
  const vsHomeVenue = comparePartitions(communityLabels, venueLabels);

  const metrosPerCommunity = new Map<number, Set<number>>();
  const communitiesPerMetro = new Map<number, Set<number>>();
  for (let i = 0; i < nodes.length; i++) {
    const c = communityLabels[i];
    const m = metroLabels[i];
    let metros = metrosPerCommunity.get(c);
    if (!metros) metrosPerCommunity.set(c, (metros = new Set()));
    metros.add(m);
    let communities = communitiesPerMetro.get(m);
    if (!communities) communitiesPerMetro.set(m, (communities = new Set()));
    communities.add(c);
  }

  // Per-community rows, largest first.
  const rows: CommunityRow[] = members
    .map((memberList, community) => {
      const counts = communityVenueCounts[community];
      let dominantVenue = '';
      let dominantCount = 0;
      let totalVenueMatches = 0;
      for (const [venue, count] of counts) {
        totalVenueMatches += count;
        if (count > dominantCount || (count === dominantCount && venue < dominantVenue)) {
          dominantVenue = venue;
          dominantCount = count;
        }
      }
      let latSum = 0;
      let lonSum = 0;
      let coordVenues = 0;
      for (const venue of counts.keys()) {
        const aggregate = venueByKey.get(venue);
        if (aggregate?.latitude != null && aggregate.longitude != null) {
          latSum += aggregate.latitude;
          lonSum += aggregate.longitude;
          coordVenues++;
        }
      }
      let spreadKm = 0;
      if (coordVenues > 0) {
        const centroidLat = latSum / coordVenues;
        const centroidLon = lonSum / coordVenues;
        let distance = 0;
        for (const venue of counts.keys()) {
          const aggregate = venueByKey.get(venue);
          if (aggregate?.latitude != null && aggregate.longitude != null) {
            distance += haversineKm(centroidLat, centroidLon, aggregate.latitude, aggregate.longitude);
          }
        }
        spreadKm = distance / coordVenues;
      }
      const metroTally = new Map<number, number>();
      for (const player of memberList) {
        const metro = metroOf.get(homeVenue.get(player) ?? 'unknown') ?? -1;
        metroTally.set(metro, (metroTally.get(metro) ?? 0) + 1);
      }
      const dominantMetro = Math.max(0, ...metroTally.values());
      return {
        id: communityIdFor(observations.players, memberList),
        size: memberList.length,
        matches: communityMatches[community],
        dominantVenueShare: totalVenueMatches > 0 ? dominantCount / totalVenueMatches : 0,
        venues: counts.size,
        spreadKm,
        metroPurity: memberList.length > 0 ? dominantMetro / memberList.length : 0,
      };
    })
    .sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));

  // Coverage curves. A missing event is a missing set of edges, so partial
  // coverage systematically *understates* connectivity - and the two realistic
  // shapes of partial coverage are not the same:
  //
  // - **random**: events missing uniformly, which is the optimistic case because
  //   every venue keeps some of its edges;
  // - **chronological**: only the first X% of the window captured, which is what
  //   a backfill walking the calendar actually produces, and is pessimistic
  //   because a whole weekend of bridging play can be entirely absent.
  //
  // Both are reported, because quoting one as "coverage" would overstate how
  // much the production number can be trusted.
  const eventCount = observations.events.length;
  const measureCoverage = (step: number, keep: Uint8Array): CoverageRow => {
    const filter = (i: number) => keep[observations.event[i]] === 1;
    let matches = 0;
    const keptEvents = new Set<number>();
    for (let i = 0; i < observations.playerA.length; i++) {
      if (!filter(i)) continue;
      matches++;
      keptEvents.add(observations.event[i]);
    }
    const stepComponents = findComponents(observations, filter);
    const { graph: stepGraph } = buildCoPlayGraph(observations, filter);
    const stepFit = louvain(stepGraph, { resolution });
    const sizes = new Int32Array(stepFit.communityCount);
    for (let i = 0; i < stepGraph.nodeCount; i++) sizes[stepFit.communityOf[i]]++;
    return {
      coverage: step,
      events: keptEvents.size,
      matches,
      playersWithMatches: stepComponents.playersWithMatches,
      components: stepComponents.components.length,
      giantShare: stepComponents.giantShare,
      communities: stepFit.communityCount,
      largestCommunityShare: stepGraph.nodeCount > 0 ? Math.max(0, ...sizes) / stepGraph.nodeCount : 0,
      modularity: stepFit.modularity,
    };
  };

  const coverage: CoverageRow[] = coverageSteps.map(step => {
    const random = mulberry32(0x5eed);
    const keep = new Uint8Array(eventCount);
    for (let e = 0; e < eventCount; e++) keep[e] = random() < step ? 1 : 0;
    return measureCoverage(step, keep);
  });

  const byDay = Array.from({ length: eventCount }, (_, e) => e)
    .sort((a, b) => observations.events[a].day - observations.events[b].day || (a - b));
  const coverageByDate: CoverageRow[] = coverageSteps.map(step => {
    const keep = new Uint8Array(eventCount);
    const take = Math.round(step * eventCount);
    for (let k = 0; k < take; k++) keep[byDay[k]] = 1;
    return measureCoverage(step, keep);
  });

  // Stability: drop a share of matches and relabel. Measured on the players the
  // subsample still has, against their full-sample labels.
  const fullCommunityOfPlayer = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) fullCommunityOfPlayer.set(nodes[i], communityLabels[i]);
  const fullCommunitySizes = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    fullCommunitySizes.set(communityLabels[i], (fullCommunitySizes.get(communityLabels[i]) ?? 0) + 1);
  }
  const fullComponentLabels = componentLabels(observations, nodes);
  const fullComponentOfPlayer = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) fullComponentOfPlayer.set(nodes[i], fullComponentLabels[i]);

  const stability: StabilityRow[] = stabilityFractions.map((fraction, index) => {
    const random = mulberry32(0xc0ffee + index * 7919);
    const keep = new Uint8Array(observations.playerA.length);
    for (let i = 0; i < keep.length; i++) keep[i] = random() < fraction ? 1 : 0;
    const filter = (i: number) => keep[i] === 1;

    const { graph: subGraph, nodes: subNodes } = buildCoPlayGraph(observations, filter);
    const subFit = louvain(subGraph, { resolution });
    const subComponents = findComponents(observations, filter);

    // Align on the players present in both labellings.
    const leftCommunity: number[] = [];
    const rightCommunity: number[] = [];
    const leftLarge: number[] = [];
    const rightLarge: number[] = [];
    const leftComponent: number[] = [];
    const rightComponent: number[] = [];
    const subComponentIds = new Map<string, number>();
    for (let i = 0; i < subNodes.length; i++) {
      const player = subNodes[i];
      const full = fullCommunityOfPlayer.get(player);
      if (full === undefined) continue;
      leftCommunity.push(full);
      rightCommunity.push(subFit.communityOf[i]);
      if ((fullCommunitySizes.get(full) ?? 0) >= largeCommunityThreshold) {
        leftLarge.push(full);
        rightLarge.push(subFit.communityOf[i]);
      }
      leftComponent.push(fullComponentOfPlayer.get(player)!);
      const id = subComponents.componentIds[player] ?? 'none';
      let index2 = subComponentIds.get(id);
      if (index2 === undefined) {
        index2 = subComponentIds.size;
        subComponentIds.set(id, index2);
      }
      rightComponent.push(index2);
    }
    return {
      label: `${Math.round(fraction * 100)}% of matches (seed ${index + 1})`,
      community: comparePartitions(Int32Array.from(leftCommunity), Int32Array.from(rightCommunity)),
      communityLargeOnly: comparePartitions(Int32Array.from(leftLarge), Int32Array.from(rightLarge)),
      component: comparePartitions(Int32Array.from(leftComponent), Int32Array.from(rightComponent)),
    };
  });

  // Resolution sweep. The resolution decides how coarse a "scene" is, so it has
  // to be swept against the two things that matter - does the partition track
  // geography, and does it hold still - rather than left at 1 by default.
  const sweepRandom = mulberry32(0xbeef);
  const sweepKeep = new Uint8Array(observations.playerA.length);
  for (let i = 0; i < sweepKeep.length; i++) sweepKeep[i] = sweepRandom() < 0.9 ? 1 : 0;
  const sweepFilter = (i: number) => sweepKeep[i] === 1;
  const { graph: sweepGraph, nodes: sweepNodes } = buildCoPlayGraph(observations, sweepFilter);

  const resolutionSweep: ResolutionRow[] = resolutions.map(candidate => {
    const candidateFit = candidate === resolution ? fit : louvain(graph, { resolution: candidate });
    const candidateSizes = new Int32Array(candidateFit.communityCount);
    for (let i = 0; i < nodes.length; i++) candidateSizes[candidateFit.communityOf[i]]++;
    const vsMetroHere = comparePartitions(Int32Array.from(candidateFit.communityOf), metroLabels);

    const subFit = louvain(sweepGraph, { resolution: candidate });
    const fullOfPlayer = new Map<number, number>();
    for (let i = 0; i < nodes.length; i++) fullOfPlayer.set(nodes[i], candidateFit.communityOf[i]);
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < sweepNodes.length; i++) {
      const full = fullOfPlayer.get(sweepNodes[i]);
      if (full === undefined) continue;
      left.push(full);
      right.push(subFit.communityOf[i]);
    }
    const churn = comparePartitions(Int32Array.from(left), Int32Array.from(right)).churn;
    return {
      resolution: candidate,
      communities: candidateFit.communityCount,
      modularity: candidateFit.modularity,
      largestShare: nodes.length > 0 ? Math.max(0, ...candidateSizes) / nodes.length : 0,
      metroAdjustedRand: vsMetroHere.adjustedRand,
      metroNormalisedMutualInformation: vsMetroHere.normalisedMutualInformation,
      churn90: churn,
    };
  });

  const sizes = rows.map(row => row.size).sort((a, b) => a - b);
  return {
    generatedAt: new Date().toISOString(),
    resolution,
    playersWithMatches: baseComponents.playersWithMatches,
    edges: graph.offsets[graph.nodeCount] / 2,
    componentCount: baseComponents.components.length,
    giantComponentShare: baseComponents.giantShare,

    communityCount: fit.communityCount,
    modularity: fit.modularity,
    levels: fit.levels,
    largestCommunityShare: nodes.length > 0 ? (rows[0]?.size ?? 0) / nodes.length : 0,
    communitySizes: [10, 25, 50, 75, 90, 99].map(p => ({ percentile: p, size: percentileOf(sizes, p) })),
    communitiesOverSize: [2, 8, 25, 100, 250, 500].map(size => ({
      size,
      communities: rows.filter(row => row.size >= size).length,
      players: rows.filter(row => row.size >= size).reduce((total, row) => total + row.size, 0),
    })),
    topCommunities: rows.slice(0, 15),

    metroRadiusKm,
    metroCount,
    vsMetro,
    vsHomeVenue,
    communitiesSpanningMetros: [...metrosPerCommunity.values()].filter(set => set.size > 1).length,
    metrosSplitAcrossCommunities: [...communitiesPerMetro.values()].filter(set => set.size > 1).length,

    coverage,
    coverageByDate,
    stability,
    resolutionSweep,
    largeCommunityThreshold,
    elapsedMs: { louvain: louvainMs, components: componentsMs },
  };
}
