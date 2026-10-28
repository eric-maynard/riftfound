/**
 * Scenes: the persisted answer to "which local scene does this store belong to".
 *
 * ## Why this is not `componentId`
 *
 * `componentId` is a connected component of the co-play graph, and it has a
 * *statistical* job: `crossComponentUncertainty` is only correct for a
 * connected component, because the floating rating offset it corrects for is a
 * property of reachability and nothing else. It also stopped being informative
 * as a product label - a measured 97.4% of players sit in one component, so a
 * component-keyed "Scene" selector lists one entry containing everybody, and
 * that gets *worse* as the backfill fills in (see scraper/CLAUDE.md, "Is a
 * scene a connected component?").
 *
 * Louvain communities over the same graph answer the question properly
 * (modularity 0.83, largest group 15.4%, shape invariant across coverage
 * levels), and venue -> community is nearly a function: the median venue plays
 * **99.3%** of its matches inside one community. That last number is the whole
 * licence for this module. "This store belongs to one scene" is an honest
 * statement about the data, not a simplification of it.
 *
 * ## Why the assignment is persisted rather than recomputed
 *
 * The measured blocker was never compute (199ms for 7,732 players) - it was
 * **naming stability**. Refitting the partition on 90% of the matches moves
 * 12-18% of players to a different community, and ids derived from membership
 * churn worse still. A scene selector whose entries reshuffle daily is not
 * shippable.
 *
 * So a scene assignment is a **deliberate, occasional act**, not a by-product
 * of a refit:
 *
 * - `proposeScenes` runs the clustering and produces a candidate assignment.
 *   It is only ever called by the operator CLI (`ranking/recluster.ts`).
 * - The result is stored once (`saveSceneAssignment`) and every refit in
 *   between simply *reads* it. The rating pass stays stateless about the model
 *   and gains exactly one piece of read-only input.
 * - Between re-clusterings a store's scene therefore cannot move at all - not
 *   by a point of modularity, not by one travelling player. That is the
 *   property the UI needs and the one a per-refit computation cannot give.
 *
 * ## Why ids are carried by venue overlap
 *
 * A scene id derived from its membership is renamed whenever that membership
 * changes, so ids are instead **carried forward from the previous assignment**
 * by Jaccard overlap, keeping the old id above `DEFAULT_CARRY_JACCARD` (0.5).
 * The overlap is computed on **venue** sets, not player sets: a shop id is a
 * durable identity that persists across seasons, while the player population
 * of a scene turns over continuously, so venue overlap is the more stable of
 * the two signals for the thing being named. (The 12-18% churn figures in
 * scraper/CLAUDE.md are *player*-label churn from the measurement that
 * motivated this design; `diffSceneAssignments` reports venue churn, which is
 * what this assignment actually governs. They are not the same number and are
 * not quoted as if they were.)
 *
 * A proposed scene that matches nothing gets a fresh content-derived id, so a
 * genuinely new scene is new rather than inheriting a name.
 *
 * ## What is deliberately *not* here
 *
 * - `componentId` keeps its meaning, untouched. Scenes are additive.
 * - No scene is ever assigned to a venue without a real `shopExternalId`.
 *   `venueKey`'s `geo:` fallback rounds coordinates to ~1km, which is fine for
 *   a graph node and wrong for a durable key: the id would move if the geocode
 *   moved. Unresolved organizers stay off the map until `shopMatch.ts`
 *   resolves them.
 */

import { createHash } from 'node:crypto';
import { venueKey } from './graph.js';
import { buildCoPlayGraph, louvain, type LouvainOptions } from './communities.js';
import type { ObservationSet } from './observations.js';

/** Bumped when the stored assignment's shape changes. */
export const SCENE_ASSIGNMENT_VERSION = 1;

/**
 * Minimum Jaccard overlap of venue sets for a proposed scene to keep the
 * previous assignment's id.
 *
 * 0.5 is the threshold the stability analysis in scraper/CLAUDE.md recommends,
 * and it has a tidy property: two proposed scenes cannot both exceed 0.5
 * against the same previous scene, so the carry-over is unambiguous without a
 * tie-break rule.
 */
export const DEFAULT_CARRY_JACCARD = 0.5;

/**
 * Louvain resolution for a scene re-clustering.
 *
 * gamma = 1 is the measured stability optimum, not a default inherited from the
 * literature: swept against partition churn on the complete California sample,
 * 0.5 -> 19.7%, **1 -> 12.1%**, 2 -> 21.8%.
 */
export const DEFAULT_SCENE_RESOLUTION = 1;

/** One store's scene, as stored. */
export interface SceneVenueAssignment {
  /** `venueKey` form, always `shop:<id>` - a scene is never keyed on a geocode. */
  venue: string;
  shopExternalId: number;
  sceneId: string;
  /**
   * Share of this venue's player-match participations that sat in the scene's
   * community when the assignment was made. The median was 99.3% on the
   * California sample; a low value is a genuinely split store, not an error.
   */
  purity: number;
}

/** One scene, as stored. Counts are recomputed per refit and are not kept here. */
export interface SceneRecord {
  sceneId: string;
  /** Modal venue label (a city, from the shop row), or null when none is geocoded. */
  label: string | null;
  /**
   * Great-circle distance between this scene's two farthest venues, km - its
   * **diameter**, not a radius or a mean spread.
   *
   * Geographic mode only, and it is the number that mode exists to bound: a
   * scene is meant to be a metro or a district of one, and an unbounded extent
   * is the defect that made single-linkage unusable (a 1,514km "New York"
   * whose busiest stores were all in California). Absent on a Louvain
   * assignment, which does not constrain geography at all.
   */
  extentKm?: number;
  /**
   * Share of this scene's players' matches that are against other players in
   * the same scene.
   *
   * This is the *purpose* of a scene stated as a number - "players in the area
   * play each other enough to be accurately ranked" - rather than the
   * stores-per-scene proxy the Louvain path had to use on a sparse graph.
   * Absent on an assignment written before it was measured.
   */
  intraShare?: number;
  /**
   * Whether this scene clears `minIntraShare`: enough mutual play to support a
   * ladder. A scene below the bar is **not stored** in geographic mode (its
   * venues come back with no scene at all), so a stored `false` can only come
   * from a run that deliberately kept them.
   */
  rankable?: boolean;
}

/** Which clustering produced an assignment. */
export type SceneMethod = 'louvain' | 'geo';

/**
 * The persisted assignment: the only cross-refit state the rating pass has.
 *
 * Stored as a single row (gzipped on DynamoDB), because it is read in full at
 * the start of every refit and written only when an operator re-clusters.
 * `previous` is one level of undo, so a bad re-clustering is one command to
 * roll back; it is dropped from the item it is nested in to keep the chain from
 * growing without bound.
 */
export interface SceneAssignment {
  version: number;
  /** ISO timestamp of the re-clustering that produced this assignment. */
  generatedAt: string;
  /**
   * Which clustering produced this assignment.
   *
   * Absent on an assignment written before geographic mode existed, and such
   * an assignment was always Louvain - so a missing value reads as `louvain`
   * rather than as unknown.
   */
  method?: SceneMethod;
  /**
   * Louvain resolution used, so a diff can say whether the knob moved.
   *
   * **Null in geographic mode**, which has no resolution. Deliberately null
   * rather than a placeholder number: writing the Louvain default here would
   * say a knob was used when it was not, and the one thing a diff must not do
   * is invent provenance.
   */
  resolution: number | null;
  /** Jaccard threshold ids were carried at. Both methods carry ids this way. */
  carryJaccard: number;
  /** Geographic mode's knobs, for the same reason `resolution` is stored. */
  geo?: GeoSceneKnobs;
  venues: SceneVenueAssignment[];
  scenes: SceneRecord[];
  /** Counts at the time of clustering, for the runbook's sanity checks. */
  stats: SceneAssignmentStats;
  /** The assignment this one replaced, for rollback. Never nested twice. */
  previous?: Omit<SceneAssignment, 'previous'> | null;
}

/**
 * Geographic mode's knobs. See `geoScenes.ts` for how each was measured.
 */
export interface GeoSceneKnobs {
  /**
   * Hard cap on a scene's **diameter** - its maximum pairwise venue distance.
   * Every member is within this of every other member, which is what stops a
   * scene chaining through a hub. 30km.
   */
  maxDiameterKm: number;
  /**
   * The loose single-link radius that buckets venues before the real
   * clustering. A performance partition only; it cannot change the answer as
   * long as it comfortably exceeds `maxDiameterKm`.
   */
  bucketKm: number;
  /** Minimum intra-scene share of play for a scene to be published. */
  minIntraShare: number;
}

export interface SceneAssignmentStats {
  venues: number;
  scenes: number;
  players: number;
  matches: number;
  /**
   * Modularity of the player partition the assignment came from.
   *
   * **Null in geographic mode**, which does not maximise modularity and whose
   * clusters have no modularity to report. The stop condition that reads this
   * is skipped rather than evaluated against a stand-in, because a stand-in
   * would be a gate passing on a number nothing computed.
   */
  modularity: number | null;
  /** Communities Louvain found, which is >= the number of scenes with a venue. */
  communities: number | null;
  /** Median venue purity. The 99.3% figure, recomputed. */
  medianPurity: number;
  /** Venues whose dominant community holds under 60% of their play. */
  splitVenues: number;
  /** Geographic mode only: the extent distribution and the play-share gate. */
  geo?: GeoSceneAssignmentStats;
}

/**
 * What geographic mode measured about its own output.
 *
 * The two halves are the scene's two defining properties: `maxExtentKm` /
 * `medianExtentKm` say it is metro-scale, and the intra-share figures say its
 * players actually play each other. Both are reported, because a proposal that
 * is compact and has no internal play is as useless as a rankable corridor.
 */
export interface GeoSceneAssignmentStats {
  /** Clusters the geometry produced, before the play-share gate. */
  clusters: number;
  /** Widest published scene, km. Must be <= `maxDiameterKm` by construction. */
  maxExtentKm: number;
  medianExtentKm: number;
  /** Player-weighted median of the published scenes' intra-scene play share. */
  medianIntraShare: number;
  /** Scenes the play-share gate rejected, and the players in them. */
  unrankableScenes: number;
  unrankablePlayers: number;
  /** Venues in those rejected scenes: they are published with no scene. */
  unrankableVenues: number;
  /** Players in published scenes, the denominator the shares above are over. */
  rankablePlayers: number;
}

/** A scene id derived from its venue membership. Only used for a brand-new scene. */
function freshSceneId(venues: string[]): string {
  const sorted = [...venues].sort();
  return `s${createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 10)}`;
}

/**
 * Give each proposed cluster an id, carrying the previous assignment's ids
 * forward by venue-set Jaccard overlap.
 *
 * Shared by both clustering methods on purpose. The carry-over is not a
 * property of Louvain - it is the mechanism that makes *any* re-clustering
 * shippable, because an id derived from membership is renamed whenever the
 * membership moves (see the module note). Switching method is already enough
 * churn for one run; switching the naming mechanism at the same time would
 * make the diff unreadable, and the diff is the gate.
 *
 * Clusters are matched **largest first**, so when two proposals overlap the
 * same previous scene the bigger one is the heir. Returns one id per input
 * cluster, in input order.
 */
export function carrySceneIds(
  clusters: string[][],
  previous: SceneAssignment | null | undefined,
  carryJaccard: number
): string[] {
  const previousVenues = new Map<string, Set<string>>();
  for (const assignment of previous?.venues ?? []) {
    let bucket = previousVenues.get(assignment.sceneId);
    if (!bucket) previousVenues.set(assignment.sceneId, (bucket = new Set()));
    bucket.add(assignment.venue);
  }

  // Largest first, ties on the smallest venue key, so the heir of a contested
  // id cannot depend on Map iteration order.
  const order = clusters
    .map((venues, index) => ({ index, venues }))
    .sort(
      (a, b) => b.venues.length - a.venues.length || (a.venues[0] < b.venues[0] ? -1 : 1)
    );

  const claimed = new Set<string>();
  const ids: string[] = new Array(clusters.length);

  for (const { index, venues } of order) {
    const proposed = new Set(venues);
    let carried: string | null = null;
    let bestOverlap = 0;
    for (const [sceneId, before] of previousVenues) {
      if (claimed.has(sceneId)) continue;
      let intersection = 0;
      for (const venue of proposed) if (before.has(venue)) intersection++;
      if (intersection === 0) continue;
      const jaccard = intersection / (proposed.size + before.size - intersection);
      if (jaccard > bestOverlap || (jaccard === bestOverlap && carried !== null && sceneId < carried)) {
        bestOverlap = jaccard;
        carried = sceneId;
      }
    }
    if (carried !== null && bestOverlap >= carryJaccard) {
      claimed.add(carried);
      ids[index] = carried;
    } else {
      ids[index] = freshSceneId(venues);
    }
  }

  return ids;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface ProposeScenesOptions {
  /** Louvain resolution. See DEFAULT_SCENE_RESOLUTION. */
  resolution?: number;
  /** Venue key -> label, from the shops table, for naming a scene. */
  venueLabels?: Map<string, string>;
  /** The assignment in force, so ids can be carried forward. */
  previous?: SceneAssignment | null;
  carryJaccard?: number;
  generatedAt?: Date;
  louvain?: Partial<LouvainOptions>;
}

/**
 * Cluster the co-play graph and derive a venue -> scene assignment from it.
 *
 * Three steps, in order:
 *
 * 1. Louvain communities over the player co-play graph, weighted by matches
 *    played. Deterministic: nodes are visited in index order and ties broken on
 *    the smaller community id, so the same observations always give the same
 *    partition.
 * 2. Each venue is assigned to the community holding the largest share of its
 *    player-match participations, and that share is recorded as the purity.
 *    This is what makes the output a statement about *stores* rather than about
 *    players: a store has one scene, and the purity says how true that is.
 * 3. Ids are carried from `previous` by venue-set Jaccard overlap, so a scene
 *    that is recognisably the same scene keeps its name.
 *
 * Venues without a real `shopExternalId` are excluded entirely - see the module
 * note on `venueKey`'s `geo:` fallback.
 */
export function proposeScenes(
  observations: ObservationSet,
  options: ProposeScenesOptions = {}
): SceneAssignment {
  const resolution = options.resolution ?? DEFAULT_SCENE_RESOLUTION;
  const carryJaccard = options.carryJaccard ?? DEFAULT_CARRY_JACCARD;
  const labels = options.venueLabels ?? new Map<string, string>();

  const { graph, nodeOfPlayer } = buildCoPlayGraph(observations);
  const fit = louvain(graph, { ...options.louvain, resolution });

  // Venue -> community participation counts. One participation per player per
  // match, which weights a venue's busy nights more than its quiet ones -
  // the same weighting the graph itself uses.
  const perVenue = new Map<string, { shopExternalId: number; counts: Map<number, number>; total: number }>();
  const countFor = (venue: string, shopExternalId: number, player: number) => {
    const node = nodeOfPlayer[player];
    if (node < 0) return;
    const community = fit.communityOf[node];
    let row = perVenue.get(venue);
    if (!row) perVenue.set(venue, (row = { shopExternalId, counts: new Map(), total: 0 }));
    row.counts.set(community, (row.counts.get(community) ?? 0) + 1);
    row.total++;
  };

  for (let i = 0; i < observations.playerA.length; i++) {
    const meta = observations.events[observations.event[i]];
    if (meta.shopExternalId === null || meta.shopExternalId === undefined) continue;
    const venue = venueKey(meta.shopExternalId, meta.latitude, meta.longitude);
    countFor(venue, meta.shopExternalId, observations.playerA[i]);
    countFor(venue, meta.shopExternalId, observations.playerB[i]);
  }

  // Community -> its venues, which is the set the ids are carried on.
  const venuesByCommunity = new Map<number, string[]>();
  const purityByVenue = new Map<string, number>();
  const shopByVenue = new Map<string, number>();
  for (const [venue, row] of perVenue) {
    let best = -1;
    let bestCount = -1;
    for (const [community, count] of row.counts) {
      // Ties on the smaller community index, so the result is order-independent.
      if (count > bestCount || (count === bestCount && community < best)) {
        best = community;
        bestCount = count;
      }
    }
    if (best < 0) continue;
    const bucket = venuesByCommunity.get(best);
    if (bucket) bucket.push(venue);
    else venuesByCommunity.set(best, [venue]);
    purityByVenue.set(venue, row.total > 0 ? bestCount / row.total : 0);
    shopByVenue.set(venue, row.shopExternalId);
  }

  const previousLabels = new Map((options.previous?.scenes ?? []).map(scene => [scene.sceneId, scene.label]));

  const proposals = [...venuesByCommunity.entries()]
    .map(([community, venues]) => ({ community, venues: [...venues].sort() }))
    .sort((a, b) => b.venues.length - a.venues.length || (a.venues[0] < b.venues[0] ? -1 : 1));

  const sceneIds = carrySceneIds(
    proposals.map(proposal => proposal.venues),
    options.previous,
    carryJaccard
  );

  const venues: SceneVenueAssignment[] = [];
  const scenes: SceneRecord[] = [];

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];
    const sceneId = sceneIds[i];

    // Name it from geography, which is cheap and reliable precisely because
    // venue -> scene is nearly a function. A carried id keeps its old label
    // when no venue in it is geocoded yet, so a name does not flicker to null.
    const label =
      modalLabel(proposal.venues.map(venue => labels.get(venue) ?? null)) ??
      previousLabels.get(sceneId) ??
      null;
    scenes.push({ sceneId, label });
    for (const venue of proposal.venues) {
      venues.push({
        venue,
        shopExternalId: shopByVenue.get(venue)!,
        sceneId,
        purity: Math.round((purityByVenue.get(venue) ?? 0) * 1000) / 1000,
      });
    }
  }

  venues.sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0));
  scenes.sort((a, b) => (a.sceneId < b.sceneId ? -1 : a.sceneId > b.sceneId ? 1 : 0));

  const purities = venues.map(assignment => assignment.purity);
  // One level of undo only: the replaced assignment is kept, but its own
  // `previous` is dropped so the stored row cannot grow without bound.
  const previousWithoutChain: Omit<SceneAssignment, 'previous'> | null = options.previous
    ? {
        version: options.previous.version,
        generatedAt: options.previous.generatedAt,
        resolution: options.previous.resolution,
        carryJaccard: options.previous.carryJaccard,
        venues: options.previous.venues,
        scenes: options.previous.scenes,
        stats: options.previous.stats,
      }
    : null;

  return {
    version: SCENE_ASSIGNMENT_VERSION,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    resolution,
    carryJaccard,
    venues,
    scenes,
    stats: {
      venues: venues.length,
      scenes: scenes.length,
      players: graph.nodeCount,
      matches: observations.playerA.length,
      modularity: fit.modularity,
      communities: fit.communityCount,
      medianPurity: median(purities),
      splitVenues: purities.filter(purity => purity < 0.6).length,
    },
    previous: previousWithoutChain,
  };
}

/** Most common non-null label, ties on the alphabetically smaller one. */
function modalLabel(labels: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const label of labels) {
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && label < best)) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

/** One store that would change scene. */
export interface SceneMove {
  venue: string;
  shopExternalId: number;
  fromSceneId: string | null;
  fromLabel: string | null;
  toSceneId: string;
  toLabel: string | null;
  purity: number;
}

export interface SceneDiff {
  /** Venues in both assignments. The denominator for `churn`. */
  shared: number;
  /** Venues that would change scene, as a share of `shared`. */
  churn: number;
  moved: SceneMove[];
  added: SceneMove[];
  /** Venues in the current assignment that the proposal no longer places. */
  removed: { venue: string; shopExternalId: number; sceneId: string }[];
  /** Scene ids kept, created and retired. */
  carriedScenes: number;
  newScenes: string[];
  retiredScenes: string[];
  medianPurityBefore: number;
  medianPurityAfter: number;
}

/**
 * What accepting a proposed assignment would change.
 *
 * This is the gate the runbook is built around: a re-clustering is accepted on
 * the *diff*, never on the modularity. A good one moves a handful of boundary
 * stores and keeps almost every id; a bad one renames scenes wholesale, which
 * is exactly the failure the overlap carry-over exists to prevent and exactly
 * what this function makes visible before anything is written.
 */
export function diffSceneAssignments(
  current: SceneAssignment | null,
  proposed: SceneAssignment
): SceneDiff {
  const before = new Map((current?.venues ?? []).map(assignment => [assignment.venue, assignment]));
  const after = new Map(proposed.venues.map(assignment => [assignment.venue, assignment]));
  const labelBefore = new Map((current?.scenes ?? []).map(scene => [scene.sceneId, scene.label]));
  const labelAfter = new Map(proposed.scenes.map(scene => [scene.sceneId, scene.label]));

  const moved: SceneMove[] = [];
  const added: SceneMove[] = [];
  let shared = 0;

  for (const [venue, assignment] of after) {
    const previous = before.get(venue);
    const move: SceneMove = {
      venue,
      shopExternalId: assignment.shopExternalId,
      fromSceneId: previous?.sceneId ?? null,
      fromLabel: previous ? labelBefore.get(previous.sceneId) ?? null : null,
      toSceneId: assignment.sceneId,
      toLabel: labelAfter.get(assignment.sceneId) ?? null,
      purity: assignment.purity,
    };
    if (!previous) {
      added.push(move);
      continue;
    }
    shared++;
    if (previous.sceneId !== assignment.sceneId) moved.push(move);
  }

  const removed: { venue: string; shopExternalId: number; sceneId: string }[] = [];
  for (const [venue, assignment] of before) {
    if (!after.has(venue)) {
      removed.push({ venue, shopExternalId: assignment.shopExternalId, sceneId: assignment.sceneId });
    }
  }

  const beforeIds = new Set((current?.scenes ?? []).map(scene => scene.sceneId));
  const afterIds = new Set(proposed.scenes.map(scene => scene.sceneId));
  const newScenes = [...afterIds].filter(id => !beforeIds.has(id)).sort();
  const retiredScenes = [...beforeIds].filter(id => !afterIds.has(id)).sort();

  // Most moved first, so a truncated report shows the decisions worth reading:
  // a store moving at low purity was always a close call, one at high purity
  // means the clustering genuinely changed its mind.
  moved.sort((a, b) => b.purity - a.purity || (a.venue < b.venue ? -1 : 1));

  return {
    shared,
    churn: shared > 0 ? moved.length / shared : 0,
    moved,
    added,
    removed,
    carriedScenes: [...afterIds].filter(id => beforeIds.has(id)).length,
    newScenes,
    retiredScenes,
    medianPurityBefore: median((current?.venues ?? []).map(assignment => assignment.purity)),
    medianPurityAfter: median(proposed.venues.map(assignment => assignment.purity)),
  };
}

/** Venue key -> scene, for the refit. An empty assignment leaves every scene null. */
export function sceneLookup(assignment: SceneAssignment | null): {
  sceneOfVenue: Map<string, string>;
  purityOfVenue: Map<string, number>;
  labelOfScene: Map<string, string | null>;
} {
  return {
    sceneOfVenue: new Map((assignment?.venues ?? []).map(row => [row.venue, row.sceneId])),
    purityOfVenue: new Map((assignment?.venues ?? []).map(row => [row.venue, row.purity])),
    labelOfScene: new Map((assignment?.scenes ?? []).map(row => [row.sceneId, row.label])),
  };
}
