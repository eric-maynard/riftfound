/**
 * Geographic scenes: cluster the **stores**, not the co-play graph.
 *
 * ## Why this exists alongside Louvain
 *
 * `scenes.ts` clusters players by who they play and projects that onto stores.
 * That is the better definition and it stays - see its module note, and the
 * measurements in scraper/CLAUDE.md. It is also, today, **refused by its own
 * gate**: the production dry run proposes ~2.3 stores per scene because the
 * results backfill has not captured enough cross-venue edges to join stores
 * into communities yet. A scene map nobody can publish is not a scene map.
 *
 * So this module answers the same question from the other side, with data that
 * is already complete: **2,516 of 2,516 production venues have coordinates.**
 * Geography is available now, inference is not, and `scraper/CLAUDE.md` already
 * recommended exactly this split - "Geography as the label, inference as the
 * definition" - with the order reversed until the graph fills in.
 *
 * ## What a scene is, in two properties
 *
 * Both are load-bearing and this module measures both:
 *
 * 1. **It is metro-scale.** Not a region, not a corridor, not a country.
 * 2. **Its players play each other enough to be ranked.** That is the *purpose*
 *    of pooling stores at all, and it is the gate below.
 *
 * ## Why complete linkage, and why single linkage is categorically wrong
 *
 * Single linkage joins two stores when they are merely *near* each other, and
 * nearness is not transitive in the way a scene is. Westchester plays in New
 * York and Nassau plays in New York; that does not make Westchester and Nassau
 * one scene, and they are 60km apart with the city in between. Single linkage
 * cannot express that distinction - it chains through the hub and welds all
 * three together. Measured, that is not a hypothetical: at a 40km single-link
 * threshold production produced a 240km "New York" and a 205km "Los Angeles",
 * and the component the whole investigation started from was a 1,514km blob
 * labelled "New York, New York" whose five busiest stores were in California.
 *
 * **Complete linkage** agglomerates only while the merged cluster's *diameter*
 * - its maximum pairwise distance - stays within the bound. Every member is
 * therefore within the bound of every other member, and transitivity through a
 * hub cannot happen by construction. A cluster is a clique in the
 * "within-bound" graph, which is precisely the statement "these stores are all
 * near each other" as against "these stores are all near something".
 *
 * ## The bound: 30km diameter
 *
 * Measured on the real `VENUE#` coordinates. At 30km, 33 New York-area venues
 * resolve into 7 scenes that an inhabitant would recognise - the city itself,
 * Nassau, Westchester, north Jersey, central Jersey - and 24 Bay Area venues
 * into South Bay, Peninsula, East Bay and the Delta. At 50km it starts merging
 * across San Francisco Bay (Redwood City with Alameda), which is a ferry, not a
 * scene. 30km is the largest bound that does not do that.
 *
 * The consequence to be honest about: **30km produces small scenes**, some of
 * them a single store. That is what makes the play-share gate below matter more
 * than it did, not less.
 *
 * ## The gate: intra-scene share of play
 *
 * The Louvain path gated on *stores per scene*, because on a sparse co-play
 * graph it had no better signal. Stores per scene is a proxy for the thing that
 * actually matters, and geographic mode can measure that thing directly: of all
 * the matches involving a scene's players, what share are against other players
 * in the same scene. A scene whose players mostly play elsewhere cannot support
 * a ladder however tidy its map looks.
 *
 * So the gate is the share, and a scene below it is **not published at all**.
 * Its venues come back carrying no scene, which is a state every reader already
 * has to render: `sceneId` has been null on every item since the feature
 * shipped. "This venue is not in a rankable scene yet" is a true sentence and a
 * better answer than a two-player ladder.
 *
 * ## What is deliberately not here
 *
 * - **`componentId` is untouched**, exactly as in `scenes.ts`. It answers "are
 *   these two ratings on the same scale" and `crossComponentUncertainty` is
 *   only correct for a connected component. Scenes are additive.
 * - **No new storage.** The output is a `SceneAssignment`, written by
 *   `saveSceneAssignment`, diffed by `diffSceneAssignments`, rolled back
 *   through the same `previous` slot. Ids are carried forward by the same
 *   venue-set Jaccard overlap (`carrySceneIds`), because that mechanism is
 *   about *naming stability* and has nothing to do with which clustering
 *   proposed the membership.
 * - **No geocode is ever an id.** `venueKey`'s `geo:` fallback rounds to ~1km
 *   and would move if the geocode moved, so only a real `shopExternalId` gets
 *   a scene - the same rule `scenes.ts` states at length.
 */

import { venueKey } from './graph.js';
import { haversineKm } from './sceneMap.js';
import type { ObservationSet } from './observations.js';
import {
  carrySceneIds,
  DEFAULT_CARRY_JACCARD,
  SCENE_ASSIGNMENT_VERSION,
  type GeoSceneAssignmentStats,
  type SceneAssignment,
  type SceneRecord,
  type SceneVenueAssignment,
} from './scenes.js';
import { sceneNameOverride } from './sceneNames.js';

/**
 * Maximum diameter of a scene, km.
 *
 * Measured on production venue coordinates: 30km reproduces the metro
 * structure a local would draw (New York / Nassau / Westchester as three
 * scenes; South Bay / Peninsula / East Bay as three more), and 50km starts
 * merging across San Francisco Bay. See the module note.
 */
export const DEFAULT_GEO_MAX_DIAMETER_KM = 30;

/**
 * The loose single-link radius that buckets venues before the real clustering.
 *
 * **A performance partition, not a modelling knob.** Complete linkage is
 * O(n^2) in memory and worse in time, and there are 2,516 venues. But every
 * pair of venues in one finished scene is within `maxDiameterKm` of each other,
 * so every scene is single-link-connected at any radius >= that bound - which
 * means bucketing at a comfortably larger radius and clustering inside each
 * bucket **cannot change the answer**. `geoScenes.test.ts` pins that
 * invariant, because it is the one assumption here that would fail silently.
 */
export const DEFAULT_GEO_BUCKET_KM = 70;

/**
 * Minimum share of a scene's players' matches that must be against other
 * players in the same scene.
 *
 * See `summariseIntraShares` for the measured distribution this was read off.
 */
export const DEFAULT_MIN_INTRA_SHARE = 0.5;

/**
 * A bucket this big is re-bucketed at a tighter radius before complete linkage.
 *
 * Single linkage at 70km chains across a dense continent - the Low Countries
 * into the Rhine and on into France - so one bucket can in principle hold most
 * of Europe, and the merge loop is superlinear in bucket size. Any radius above
 * `maxDiameterKm` preserves the invariant, so tightening is free of
 * correctness consequences; it is bounded below by `BUCKET_FLOOR_FACTOR` so it
 * can never reach the diameter cap itself.
 */
const MAX_BUCKET_VENUES = 900;

/** The tightest the bucketing radius may be driven, as a multiple of the cap. */
const BUCKET_FLOOR_FACTOR = 1.5;

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.320;
const DEG = Math.PI / 180;

/** One store, as the clustering sees it. */
export interface GeoVenue {
  /** `venueKey` form, always `shop:<id>`. */
  venue: string;
  shopExternalId: number;
  latitude: number;
  longitude: number;
  /** Matches played here. The weight for naming and for ordering a report. */
  matches: number;
  /** City label from the shops table, or null until reverse geocoding lands. */
  label: string | null;
}

/** One proposed cluster, before the play-share gate has looked at it. */
export interface GeoCluster {
  venues: string[];
  /** Maximum pairwise distance, km. <= `maxDiameterKm` by construction. */
  diameterKm: number;
}

// ---------------------------------------------------------------------------
// Per-venue facts
// ---------------------------------------------------------------------------

/**
 * Venue -> coordinates, matches and label, for every venue with a real shop id.
 *
 * Coordinates are the **mean** of the venue's events' coordinates, for the
 * reason `VENUE#` already gives: a store does not move, but the two event
 * sources geocode it ~20m apart, so "whichever event was read last" wobbles
 * where a mean is stable. A venue whose events carried no coordinates at all is
 * excluded - it cannot be placed, and placing it anyway is the one failure
 * `sceneMap.ts` refuses in three different ways.
 */
export function geoVenues(
  observations: ObservationSet,
  labels: Map<string, string> = new Map()
): GeoVenue[] {
  const rows = new Map<
    string,
    { shopExternalId: number; latSum: number; lonSum: number; coords: number; matches: number }
  >();

  for (let i = 0; i < observations.playerA.length; i++) {
    const meta = observations.events[observations.event[i]];
    if (meta.shopExternalId === null || meta.shopExternalId === undefined) continue;
    const venue = venueKey(meta.shopExternalId, meta.latitude, meta.longitude);
    let row = rows.get(venue);
    if (!row) {
      rows.set(
        venue,
        (row = { shopExternalId: meta.shopExternalId, latSum: 0, lonSum: 0, coords: 0, matches: 0 })
      );
    }
    row.matches++;
    if (meta.latitude !== null && meta.longitude !== null) {
      row.latSum += meta.latitude;
      row.lonSum += meta.longitude;
      row.coords++;
    }
  }

  const venues: GeoVenue[] = [];
  for (const [venue, row] of rows) {
    if (row.coords === 0) continue;
    venues.push({
      venue,
      shopExternalId: row.shopExternalId,
      latitude: row.latSum / row.coords,
      longitude: row.lonSum / row.coords,
      matches: row.matches,
      label: labels.get(venue) ?? null,
    });
  }
  // Sorted by venue key so every downstream tie-break is reproducible.
  venues.sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0));
  return venues;
}

// ---------------------------------------------------------------------------
// Stage 1: bucket the venues (a performance partition, not a clustering)
// ---------------------------------------------------------------------------

/**
 * Single-linkage connected components at `radiusKm`, over a spatial grid.
 *
 * The grid is what keeps this off O(n^2): venues are binned into cells one
 * radius across, and each venue is compared only against the cells that can
 * hold a point within the radius. The cell *column* count is derived from the
 * latitude rather than assumed, because a degree of longitude is 111km at the
 * equator and 56km at 60 degrees north - scanning a fixed one cell either side
 * would miss neighbours in Scandinavia, which is a silent wrong answer rather
 * than a slow one. Columns wrap, so a cluster straddling the antimeridian is
 * found rather than split.
 *
 * Returns a bucket index per venue, in input order.
 */
export function bucketVenues(venues: GeoVenue[], radiusKm: number): number[] {
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

  const cellDegLat = radiusKm / KM_PER_DEG_LAT;
  const cellDegLon = radiusKm / KM_PER_DEG_LON_EQUATOR;
  const lonCells = Math.max(1, Math.ceil(360 / cellDegLon));
  const rowOf = (latitude: number): number => Math.floor((latitude + 90) / cellDegLat);
  const colOf = (longitude: number): number =>
    ((Math.floor((longitude + 180) / cellDegLon) % lonCells) + lonCells) % lonCells;

  const grid = new Map<string, number[]>();
  for (let i = 0; i < venues.length; i++) {
    const key = `${rowOf(venues[i].latitude)}:${colOf(venues[i].longitude)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  for (let i = 0; i < venues.length; i++) {
    const a = venues[i];
    // Row and column ranges derived from the search radius itself, so the
    // scanned neighbourhood is provably a superset of the points within it.
    const rowLo = rowOf(a.latitude - cellDegLat);
    const rowHi = rowOf(a.latitude + cellDegLat);
    const cos = Math.max(Math.cos(a.latitude * DEG), 1e-9);
    const degLon = Math.min(180, radiusKm / (KM_PER_DEG_LON_EQUATOR * cos));
    const colSpan = Math.floor(degLon / cellDegLon) + 1;
    // Near the poles the needed longitude span exceeds the whole circle, so
    // every column is a candidate; elsewhere it is a window around this one.
    const columns: number[] = [];
    if (colSpan * 2 + 1 >= lonCells) {
      for (let col = 0; col < lonCells; col++) columns.push(col);
    } else {
      const centre = colOf(a.longitude);
      for (let step = -colSpan; step <= colSpan; step++) {
        columns.push(((centre + step) % lonCells + lonCells) % lonCells);
      }
    }

    for (let row = rowLo; row <= rowHi; row++) {
      for (const col of columns) {
        const cell = grid.get(`${row}:${col}`);
        if (!cell) continue;
        for (const j of cell) {
          if (j <= i) continue;
          const b = venues[j];
          if (haversineKm(a.latitude, a.longitude, b.latitude, b.longitude) <= radiusKm) {
            parent[find(i)] = find(j);
          }
        }
      }
    }
  }

  const ids = new Map<number, number>();
  return venues.map((_, i) => {
    const root = find(i);
    let id = ids.get(root);
    if (id === undefined) ids.set(root, (id = ids.size));
    return id;
  });
}

// ---------------------------------------------------------------------------
// Stage 2: complete linkage inside a bucket
// ---------------------------------------------------------------------------

/**
 * Complete-linkage agglomeration cut at `maxDiameterKm`.
 *
 * Clusters are merged in increasing order of their complete-link distance (the
 * *maximum* distance between any member of one and any member of the other),
 * and only while that distance stays inside the bound. Because every active
 * cluster therefore already has a diameter within the bound, the merge
 * condition reduces to the link distance alone - and the finished clusters are
 * exactly the cliques of the "within-bound" graph, which is the property that
 * stops a scene chaining through a hub.
 *
 * Only pairs already inside the bound can ever merge, so adjacency is seeded
 * from those pairs and shrinks monotonically: a neighbour that drops out of a
 * merged cluster's adjacency can never come back. That is what keeps this
 * tractable - the loop runs over a sparse adjacency rather than a full matrix.
 *
 * Ties break on the clusters' smallest venue key, so the partition is a
 * function of the coordinates and nothing else. An order-dependent scene would
 * reshuffle the UI between two identical runs, which is the failure
 * `rankingCommunities.test.ts` already pins for Louvain.
 *
 * Returns clusters as arrays of indices into `members`.
 */
export function completeLinkage(
  members: GeoVenue[],
  maxDiameterKm: number
): { indices: number[]; diameterKm: number }[] {
  const n = members.length;
  if (n === 0) return [];

  const distance = (i: number, j: number): number =>
    haversineKm(
      members[i].latitude,
      members[i].longitude,
      members[j].latitude,
      members[j].longitude
    );

  // One live cluster per venue to start with.
  const clusterMembers: number[][] = members.map((_, i) => [i]);
  const smallestKey: string[] = members.map(venue => venue.venue);
  const diameter: number[] = members.map(() => 0);
  const alive: boolean[] = members.map(() => true);
  // Adjacency: complete-link distance to every cluster still inside the bound.
  const linkTo: Map<number, number>[] = members.map(() => new Map<number, number>());

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = distance(i, j);
      if (d > maxDiameterKm) continue;
      linkTo[i].set(j, d);
      linkTo[j].set(i, d);
    }
  }

  for (;;) {
    let bestA = -1;
    let bestB = -1;
    let bestLink = Number.POSITIVE_INFINITY;
    for (let a = 0; a < n; a++) {
      if (!alive[a]) continue;
      for (const [b, link] of linkTo[a]) {
        if (b <= a || !alive[b]) continue;
        if (link > maxDiameterKm) continue;
        if (
          bestA < 0 ||
          link < bestLink ||
          (link === bestLink &&
            (smallestKey[a] < smallestKey[bestA] ||
              (smallestKey[a] === smallestKey[bestA] && smallestKey[b] < smallestKey[bestB])))
        ) {
          bestA = a;
          bestB = b;
          bestLink = link;
        }
      }
    }
    if (bestA < 0) break;

    // Merge B into A. The merged diameter is the link distance or either
    // cluster's own diameter, whichever is largest - all three are inside the
    // bound, so the invariant holds.
    clusterMembers[bestA] = [...clusterMembers[bestA], ...clusterMembers[bestB]];
    diameter[bestA] = Math.max(diameter[bestA], diameter[bestB], bestLink);
    if (smallestKey[bestB] < smallestKey[bestA]) smallestKey[bestA] = smallestKey[bestB];
    alive[bestB] = false;

    // Adjacency of the merged cluster is the intersection of the two, taking
    // the larger link each time: a neighbour that only one of them could reach
    // is, by definition, further than the bound from the other.
    const merged = new Map<number, number>();
    for (const [c, linkA] of linkTo[bestA]) {
      if (c === bestB || !alive[c]) continue;
      const linkB = linkTo[bestB].get(c);
      if (linkB === undefined) continue;
      const link = Math.max(linkA, linkB);
      if (link <= maxDiameterKm) merged.set(c, link);
    }
    // Drop the dead cluster and the stale entries pointing at either of them.
    for (const c of linkTo[bestA].keys()) if (!merged.has(c)) linkTo[c]?.delete(bestA);
    for (const c of linkTo[bestB].keys()) linkTo[c]?.delete(bestB);
    linkTo[bestB] = new Map();
    linkTo[bestA] = merged;
    for (const [c, link] of merged) linkTo[c].set(bestA, link);
  }

  const clusters: { indices: number[]; diameterKm: number }[] = [];
  for (let a = 0; a < n; a++) {
    if (!alive[a]) continue;
    clusters.push({
      indices: [...clusterMembers[a]].sort((x, y) =>
        members[x].venue < members[y].venue ? -1 : 1
      ),
      diameterKm: diameter[a],
    });
  }
  return clusters;
}

/**
 * The whole geometry: bucket, then complete-link inside each bucket.
 *
 * A bucket over `MAX_BUCKET_VENUES` is re-bucketed at a tighter radius first
 * (see the constant). Tightening cannot change the answer because any radius
 * above the diameter cap still contains every finished cluster whole; it only
 * splits work that the merge loop would otherwise do against a continent.
 */
export function clusterVenuesGeographically(
  venues: GeoVenue[],
  options: { maxDiameterKm?: number; bucketKm?: number } = {}
): GeoCluster[] {
  const maxDiameterKm = options.maxDiameterKm ?? DEFAULT_GEO_MAX_DIAMETER_KM;
  const bucketKm = options.bucketKm ?? DEFAULT_GEO_BUCKET_KM;
  const floor = maxDiameterKm * BUCKET_FLOOR_FACTOR;

  const clusters: GeoCluster[] = [];

  const run = (group: GeoVenue[], radiusKm: number): void => {
    if (group.length === 0) return;
    if (group.length > MAX_BUCKET_VENUES && radiusKm > floor) {
      const tighter = Math.max(floor, radiusKm / 2);
      const buckets = new Map<number, GeoVenue[]>();
      bucketVenues(group, tighter).forEach((bucket, i) => {
        const list = buckets.get(bucket);
        if (list) list.push(group[i]);
        else buckets.set(bucket, [group[i]]);
      });
      // A tightening that did not actually split anything would recurse for
      // ever; fall through to the clustering instead.
      if (buckets.size > 1) {
        for (const list of [...buckets.values()].sort((a, b) =>
          a[0].venue < b[0].venue ? -1 : 1
        )) {
          run(list, tighter);
        }
        return;
      }
    }
    for (const cluster of completeLinkage(group, maxDiameterKm)) {
      clusters.push({
        venues: cluster.indices.map(index => group[index].venue),
        diameterKm: Math.round(cluster.diameterKm * 10) / 10,
      });
    }
  };

  const buckets = new Map<number, GeoVenue[]>();
  bucketVenues(venues, bucketKm).forEach((bucket, i) => {
    const list = buckets.get(bucket);
    if (list) list.push(venues[i]);
    else buckets.set(bucket, [venues[i]]);
  });
  for (const list of [...buckets.values()].sort((a, b) => (a[0].venue < b[0].venue ? -1 : 1))) {
    run(list, bucketKm);
  }

  // Largest first, ties on the smallest venue key: a stable report order, and
  // the order `carrySceneIds` wants for deciding who inherits a contested id.
  clusters.sort((a, b) => b.venues.length - a.venues.length || (a.venues[0] < b.venues[0] ? -1 : 1));
  return clusters;
}

// ---------------------------------------------------------------------------
// The gate: how much of a scene's play is inside it
// ---------------------------------------------------------------------------

/**
 * Each player's **home** venue: where they played the most matches.
 *
 * Identical rule and identical tie-break to `snapshot.ts`, deliberately. A
 * player's scene is their home venue's scene everywhere in this codebase, and
 * two definitions of "home" would make the per-scene player counts here
 * disagree with the ones on the stored `SCENE#` item for no visible reason.
 */
export function homeVenues(observations: ObservationSet): Map<number, string> {
  const counts = new Map<number, Map<string, number>>();
  const add = (player: number, venue: string): void => {
    let row = counts.get(player);
    if (!row) counts.set(player, (row = new Map()));
    row.set(venue, (row.get(venue) ?? 0) + 1);
  };
  for (let i = 0; i < observations.playerA.length; i++) {
    const meta = observations.events[observations.event[i]];
    const venue = venueKey(meta.shopExternalId, meta.latitude, meta.longitude);
    add(observations.playerA[i], venue);
    add(observations.playerB[i], venue);
  }

  const home = new Map<number, string>();
  for (const [player, row] of counts) {
    let best = '';
    let bestCount = -1;
    for (const [venue, count] of row) {
      // Ties broken by venue key so the choice is deterministic across runs.
      if (count > bestCount || (count === bestCount && venue < best)) {
        best = venue;
        bestCount = count;
      }
    }
    home.set(player, best);
  }
  return home;
}

/** What the play-share gate measured about one proposed scene. */
export interface SceneIntraShare {
  /** Matches with at least one side's home scene here. The denominator. */
  matches: number;
  /** Of those, how many had **both** sides' home scene here. */
  internal: number;
  /** `internal / matches`, or 0 when the scene's players played nothing. */
  share: number;
  /** Distinct players whose home venue is in this scene. */
  players: number;
}

/**
 * For each scene, the share of its players' play that stays inside it.
 *
 * The denominator is every match with *at least one* side living in the scene,
 * and the numerator is the subset with both. That is the question the owner
 * asked - "can you expect that players in the area are playing against each
 * other enough to be accurately ranked" - rather than the easier one a
 * venue-keyed count would answer: a match between two locals played while
 * visiting another city still counts as internal here, because the pair of
 * *people* is what a rating is estimated from.
 *
 * A match between two scenes contributes to both denominators and to neither
 * numerator, which is why the shares do not sum to anything in particular.
 */
export function intraSceneShares(
  observations: ObservationSet,
  sceneOfVenue: Map<string, string>,
  home: Map<number, string> = homeVenues(observations)
): Map<string, SceneIntraShare> {
  const sceneOfPlayer = new Map<number, string>();
  for (const [player, venue] of home) {
    const sceneId = sceneOfVenue.get(venue);
    if (sceneId !== undefined) sceneOfPlayer.set(player, sceneId);
  }

  const rows = new Map<string, SceneIntraShare>();
  const row = (sceneId: string): SceneIntraShare => {
    let found = rows.get(sceneId);
    if (!found) rows.set(sceneId, (found = { matches: 0, internal: 0, share: 0, players: 0 }));
    return found;
  };
  for (const sceneId of sceneOfVenue.values()) row(sceneId);
  for (const sceneId of sceneOfPlayer.values()) row(sceneId).players++;

  for (let i = 0; i < observations.playerA.length; i++) {
    const a = sceneOfPlayer.get(observations.playerA[i]);
    const b = sceneOfPlayer.get(observations.playerB[i]);
    if (a === undefined && b === undefined) continue;
    if (a !== undefined && b !== undefined && a === b) {
      const only = row(a);
      only.matches++;
      only.internal++;
      continue;
    }
    if (a !== undefined) row(a).matches++;
    if (b !== undefined) row(b).matches++;
  }

  for (const value of rows.values()) {
    value.share = value.matches > 0 ? value.internal / value.matches : 0;
  }
  return rows;
}

/**
 * The distribution a threshold should be read off, **weighted by players**.
 *
 * A scene of 3 and a scene of 2,976 are not equally interesting, so an
 * unweighted median would be dominated by the single-store scenes that a 30km
 * bound necessarily produces a lot of - and would say the corpus is unrankable
 * when almost every *player* is in a scene that is fine.
 */
export function summariseIntraShares(
  shares: Iterable<SceneIntraShare>
): { percentiles: { p: number; share: number }[]; scenes: number; players: number } {
  const rows = [...shares].sort((a, b) => a.share - b.share);
  const players = rows.reduce((total, row) => total + row.players, 0);
  const percentiles: { p: number; share: number }[] = [];
  for (const p of [10, 25, 50, 75, 90]) {
    const target = (players * p) / 100;
    let seen = 0;
    let share = rows.length > 0 ? rows[rows.length - 1].share : 0;
    for (const row of rows) {
      seen += row.players;
      if (seen >= target) {
        share = row.share;
        break;
      }
    }
    percentiles.push({ p, share });
  }
  return { percentiles, scenes: rows.length, players };
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Most common city label among a cluster's venues, **weighted by matches**.
 *
 * Weighted by matches and not by venue count or player count, and that is the
 * fix for a specific observed bug rather than a preference. `modalRegion` in
 * `snapshot.ts` counts one vote per player, and that is exactly how a
 * California blob came to be called "New York, New York": California's mass was
 * split across a dozen city labels while New York's was concentrated in one, so
 * the plurality winner was a label almost nobody in the cluster was near. Match
 * weight puts the name where the play is, which is the thing a reader is trying
 * to find.
 *
 * Ties on the alphabetically smaller label, so a name cannot depend on map
 * iteration order.
 */
export function matchWeightedModalLabel(entries: { label: string | null; matches: number }[]): string | null {
  const weights = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.label) continue;
    weights.set(entry.label, (weights.get(entry.label) ?? 0) + entry.matches);
  }
  let best: string | null = null;
  let bestWeight = 0;
  for (const [label, weight] of weights) {
    if (weight > bestWeight || (weight === bestWeight && best !== null && label < best)) {
      best = label;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * The name a cluster is published under.
 *
 * Three sources, in order:
 *
 * 1. **A curated override**, keyed on the busiest venue's `shopExternalId`.
 *    The default rule gets perhaps half of these right, and the half it gets
 *    wrong are wrong in a way a local notices instantly ("Milpitas CA" for the
 *    South Bay). See `sceneNames.ts` for why the key is a shop id.
 * 2. **The match-weighted modal city label.**
 * 3. **The label the id carried last time**, so a scene whose stores have not
 *    been reverse-geocoded yet does not flicker to null between runs.
 */
export function sceneLabelFor(
  members: GeoVenue[],
  previousLabel: string | null | undefined
): string | null {
  const override = sceneNameOverride(members);
  if (override) return override;
  return (
    matchWeightedModalLabel(members.map(venue => ({ label: venue.label, matches: venue.matches }))) ??
    previousLabel ??
    null
  );
}

// ---------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------

export interface ProposeGeoScenesOptions {
  maxDiameterKm?: number;
  bucketKm?: number;
  minIntraShare?: number;
  carryJaccard?: number;
  /** Venue key -> label, from the shops table, for naming a scene. */
  venueLabels?: Map<string, string>;
  /** The assignment in force, so ids can be carried forward. */
  previous?: SceneAssignment | null;
  generatedAt?: Date;
  /**
   * Keep scenes that fail the play-share gate instead of dropping them.
   *
   * Off by default and only ever set by a report that wants to *show* the
   * rejects. Publishing a scene whose players do not play each other is the
   * thing the gate exists to prevent.
   */
  keepUnrankable?: boolean;
}

/**
 * Cluster the venues geographically and derive a venue -> scene assignment.
 *
 * Four steps:
 *
 * 1. Per-venue mean coordinates, matches and city label.
 * 2. Bucket loosely, then complete-link inside each bucket at the diameter cap.
 * 3. Measure each cluster's intra-scene share of play and **drop the ones that
 *    cannot support a ladder**. Their venues are published with no scene.
 * 4. Carry ids forward by venue-set Jaccard and name each scene.
 *
 * The return value is an ordinary `SceneAssignment`: same storage, same diff,
 * same rollback slot, same `--write` gate.
 */
export function proposeGeoScenes(
  observations: ObservationSet,
  options: ProposeGeoScenesOptions = {}
): SceneAssignment {
  const maxDiameterKm = options.maxDiameterKm ?? DEFAULT_GEO_MAX_DIAMETER_KM;
  const bucketKm = options.bucketKm ?? DEFAULT_GEO_BUCKET_KM;
  const minIntraShare = options.minIntraShare ?? DEFAULT_MIN_INTRA_SHARE;
  const carryJaccard = options.carryJaccard ?? DEFAULT_CARRY_JACCARD;

  const venues = geoVenues(observations, options.venueLabels ?? new Map());
  const byKey = new Map(venues.map(venue => [venue.venue, venue]));
  const clusters = clusterVenuesGeographically(venues, { maxDiameterKm, bucketKm });

  // Provisional ids, only so the shares can be keyed on something. The real
  // ids are carried after the gate, against the clusters that survive it -
  // otherwise a rejected cluster could claim an id and strand the scene that
  // should have inherited it.
  const provisional = new Map<string, number>();
  clusters.forEach((cluster, index) => {
    for (const venue of cluster.venues) provisional.set(venue, index);
  });
  const home = homeVenues(observations);
  const shares = intraSceneShares(
    observations,
    new Map([...provisional].map(([venue, index]) => [venue, String(index)])),
    home
  );

  const kept: { cluster: GeoCluster; share: SceneIntraShare }[] = [];
  let unrankableScenes = 0;
  let unrankablePlayers = 0;
  let unrankableVenues = 0;
  for (let index = 0; index < clusters.length; index++) {
    const share = shares.get(String(index)) ?? { matches: 0, internal: 0, share: 0, players: 0 };
    if (share.share >= minIntraShare || options.keepUnrankable) {
      kept.push({ cluster: clusters[index], share });
      continue;
    }
    unrankableScenes++;
    unrankablePlayers += share.players;
    unrankableVenues += clusters[index].venues.length;
  }

  const previousLabels = new Map((options.previous?.scenes ?? []).map(scene => [scene.sceneId, scene.label]));
  const sceneIds = carrySceneIds(
    kept.map(entry => entry.cluster.venues),
    options.previous,
    carryJaccard
  );

  const assignedVenues: SceneVenueAssignment[] = [];
  const scenes: SceneRecord[] = [];
  for (let i = 0; i < kept.length; i++) {
    const { cluster, share } = kept[i];
    const sceneId = sceneIds[i];
    const members = cluster.venues.map(venue => byKey.get(venue)!);
    scenes.push({
      sceneId,
      label: sceneLabelFor(members, previousLabels.get(sceneId)),
      extentKm: cluster.diameterKm,
      intraShare: Math.round(share.share * 1000) / 1000,
      rankable: share.share >= minIntraShare,
    });
    for (const venue of cluster.venues) {
      assignedVenues.push({
        venue,
        shopExternalId: byKey.get(venue)!.shopExternalId,
        sceneId,
        purity: 0,
      });
    }
  }

  // Venue purity, recomputed against the scenes that survived the gate: the
  // share of this store's player-match participations made by players who
  // live in its scene. The geographic analogue of the Louvain purity, and the
  // same honest reading - a low number is a store whose crowd comes from
  // somewhere else, which is worth showing rather than hiding.
  const sceneOfVenue = new Map(assignedVenues.map(row => [row.venue, row.sceneId]));
  const participation = new Map<string, { inScene: number; total: number }>();
  for (let i = 0; i < observations.playerA.length; i++) {
    const meta = observations.events[observations.event[i]];
    if (meta.shopExternalId === null || meta.shopExternalId === undefined) continue;
    const venue = venueKey(meta.shopExternalId, meta.latitude, meta.longitude);
    const sceneId = sceneOfVenue.get(venue);
    if (sceneId === undefined) continue;
    let row = participation.get(venue);
    if (!row) participation.set(venue, (row = { inScene: 0, total: 0 }));
    for (const player of [observations.playerA[i], observations.playerB[i]]) {
      row.total++;
      const playerHome = home.get(player);
      if (playerHome !== undefined && sceneOfVenue.get(playerHome) === sceneId) row.inScene++;
    }
  }
  for (const row of assignedVenues) {
    const counts = participation.get(row.venue);
    row.purity = counts && counts.total > 0 ? Math.round((counts.inScene / counts.total) * 1000) / 1000 : 0;
  }

  assignedVenues.sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0));
  scenes.sort((a, b) => (a.sceneId < b.sceneId ? -1 : a.sceneId > b.sceneId ? 1 : 0));

  const extents = scenes.map(scene => scene.extentKm ?? 0).sort((a, b) => a - b);
  const purities = assignedVenues.map(row => row.purity).sort((a, b) => a - b);
  const summary = summariseIntraShares(kept.map(entry => entry.share));
  const geoStats: GeoSceneAssignmentStats = {
    clusters: clusters.length,
    maxExtentKm: extents.length > 0 ? extents[extents.length - 1] : 0,
    medianExtentKm: median(extents),
    medianIntraShare:
      Math.round((summary.percentiles.find(row => row.p === 50)?.share ?? 0) * 1000) / 1000,
    unrankableScenes,
    unrankablePlayers,
    unrankableVenues,
    rankablePlayers: summary.players,
  };

  // One level of undo only, exactly as `proposeScenes` does it: the replaced
  // assignment is kept but its own `previous` is dropped, so the stored row
  // cannot grow without bound.
  const previousWithoutChain: Omit<SceneAssignment, 'previous'> | null = options.previous
    ? {
        version: options.previous.version,
        generatedAt: options.previous.generatedAt,
        method: options.previous.method,
        resolution: options.previous.resolution,
        carryJaccard: options.previous.carryJaccard,
        geo: options.previous.geo,
        venues: options.previous.venues,
        scenes: options.previous.scenes,
        stats: options.previous.stats,
      }
    : null;

  return {
    version: SCENE_ASSIGNMENT_VERSION,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    method: 'geo',
    // Null, not a placeholder: no Louvain resolution was used, and writing one
    // here would claim provenance the run does not have.
    resolution: null,
    carryJaccard,
    geo: { maxDiameterKm, bucketKm, minIntraShare },
    venues: assignedVenues,
    scenes,
    stats: {
      venues: assignedVenues.length,
      scenes: scenes.length,
      players: observations.players.length,
      matches: observations.playerA.length,
      modularity: null,
      communities: null,
      medianPurity: median(purities),
      splitVenues: purities.filter(purity => purity < 0.6).length,
      geo: geoStats,
    },
    previous: previousWithoutChain,
  };
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
