/**
 * Scenes: the venue -> scene assignment, derived from the drawn regions.
 *
 * ## Why this is no longer persisted, and why that is the point
 *
 * A scene used to be a **clustering**, and because a clustering is a function of
 * its input, the only way to stop a reader's scene label moving every time the
 * corpus grew was to compute it rarely and store the answer. That is what this
 * module used to be: a `SCENE_ASSIGNMENT` row, an operator CLI to propose a new
 * one, a diff to gate it, one level of rollback, and a venue-set Jaccard
 * carry-over (`carrySceneIds`) whose entire job was to limit the renaming the
 * re-clustering caused.
 *
 * It did not work well enough, and the numbers say so: the last re-clustering
 * moved **308 of 2,518 shared venues (12.2%)**, created 474 scene ids and
 * retired 144. So a reader's label changed and their bookmarked `?scene=` link
 * died - and the curated name table keyed names on a cluster's *busiest shop
 * id*, which detaches silently the first time a busier store opens (it already
 * had, for Macarthur).
 *
 * A store's region is now a **point-in-polygon test** against polygons a human
 * drew (`regions.ts`). That is deterministic, so there is nothing to persist:
 * the assignment is recomputed on every refit and comes out identical unless
 * somebody edited a polygon. No stored row, no diff, no rollback slot, no
 * carry-over - a region id *is* stable, rather than being made to look stable.
 *
 * ## What survived unchanged, and what it means now
 *
 * - **A scene belongs to the venue, not the player.** A player's scene is their
 *   home venue's scene, one hop, no new inference.
 * - **`purity`** is still the share of a store's player-match participations
 *   made by players who live in its own scene. A low number is a genuinely
 *   split store, not an error.
 * - **`componentId` is untouched, permanently.** It is a connected component of
 *   the co-play graph and `crossComponentUncertainty` is only correct for one.
 *   Regions are additive, exactly as scenes were.
 * - **No geocode is ever an id.** `venueKey`'s `geo:` fallback rounds to ~1km
 *   and would move if the geocode moved, so only a real `shopExternalId` gets a
 *   scene. Unresolved organizers stay off the map until `shopMatch.ts` resolves
 *   them.
 *
 * ## The play-share measurement is a health signal now, not a gate
 *
 * `minIntraShare` (0.5) used to **delete** a scene whose players mostly play
 * elsewhere: its venues came back carrying no scene at all. Under a clustering
 * that was defensible - the cluster was a proposal, and a proposal whose players
 * do not play each other is a bad proposal.
 *
 * Under polygons it is not. **The region exists because a human drew it**, and
 * deleting it would mean a drawn boundary silently disappearing from the map
 * because of a match count - which is the churn this whole change removes,
 * reintroduced through a side door. So the measurement is published instead:
 * `intraShare` and `ladderMeaningful` ride the `SCENE#` item, and the API and UI
 * say *"this region's ladder is not meaningful yet"* rather than making the
 * region vanish. The number is the same number, measured the same way; only
 * what it decides has changed.
 */

import { venueKey } from './graph.js';
import { haversineKm } from './sceneMap.js';
import type { ObservationSet } from './observations.js';
import {
  placeVenues,
  type LoadedRegion,
  type RegionIndex,
  type RegionVenue,
} from './regions.js';

/** Bumped when the assignment's in-memory shape changes. */
export const SCENE_ASSIGNMENT_VERSION = 2;

/**
 * Minimum share of a scene's players' matches that are against other players in
 * the same scene, for its **ladder** to be presented as meaningful.
 *
 * 0.5 is the threshold the measured distribution recommended when this number
 * was a publishing gate, and it is kept unchanged so the figure is comparable
 * across the move: player-weighted percentiles over the 30km clustering were
 * p10 0.77, p25 0.87, p50 0.94, so 0.5 sits in the sparse left tail. What
 * changed is the consequence - see the module note. Below it the region is still
 * published, still named and still on the map; its ladder carries a caveat.
 */
export const DEFAULT_MIN_INTRA_SHARE = 0.5;

/** One store's scene, as the refit reads it. */
export interface SceneVenueAssignment {
  /** `venueKey` form, always `shop:<id>` - a scene is never keyed on a geocode. */
  venue: string;
  shopExternalId: number;
  /**
   * The published scene id: the region's `carriesSceneId` where it succeeds a
   * clustered scene, its `id` otherwise. This is what a `?scene=` link carries.
   */
  sceneId: string;
  /** The region's own durable id, for a report that needs to name the polygon. */
  regionId: string;
  /**
   * Share of this venue's player-match participations made by players whose
   * home store is in this same scene. A low value is a genuinely split store.
   */
  purity: number;
}

/** One scene, as the refit reads it. */
export interface SceneRecord {
  sceneId: string;
  /** The region's durable id behind the published one. */
  regionId: string;
  /** The region's name, as the human who drew it wrote it. Never derived. */
  label: string;
  /**
   * Great-circle distance between this region's two farthest **occupied**
   * venues, km.
   *
   * A property of where the play is, not of the polygon: a region drawn
   * generously around a metro reports the spread of the stores actually in it.
   * It is a health figure for a reader of the coverage report - a 400km extent
   * says a polygon is a corridor or a country rather than a scene - and is not
   * a bound on anything, because nothing clamps it any more.
   */
  extentKm: number;
  /**
   * Share of this scene's players' matches that are against other players in
   * the same scene.
   *
   * The *purpose* of a scene stated as a number: "players in the area play each
   * other enough to be accurately ranked".
   */
  intraShare: number;
  /**
   * Whether that share clears `minIntraShare`.
   *
   * **A statement about the ladder, not about the region.** False means the
   * region's players mostly play outside it, so ordering them among themselves
   * says little - not that the region is wrong or should not exist. It is
   * published so a caller can say so; nothing is withheld on it here.
   */
  ladderMeaningful: boolean;
}

/** A store that fell in no region. Reported, never snapped to the nearest one. */
export interface UnplacedVenue {
  venue: string;
  shopExternalId: number;
  latitude: number;
  longitude: number;
  matches: number;
  players: number;
  /** City label from the shops table, or null until reverse geocoding lands. */
  label: string | null;
}

/**
 * The venue -> scene assignment one refit reads.
 *
 * Built in memory from the region files on every refit. Deliberately **not**
 * stored: a point-in-polygon test is a function of the polygons and the
 * coordinates, both of which are already in hand, so storing the answer would
 * only add a way for the stored copy and the files to disagree.
 */
export interface SceneAssignment {
  version: number;
  /** When this assignment was computed. Equal to the refit time. */
  generatedAt: string;
  /** The region files it was built from, so a log line can say what was loaded. */
  regionFiles: string[];
  /** The play-share threshold `ladderMeaningful` was read against. */
  minIntraShare: number;
  venues: SceneVenueAssignment[];
  scenes: SceneRecord[];
  /**
   * Stores in no region at all. The coverage report's input.
   *
   * **Only stores that could have been placed.** A venue whose events carried
   * no coordinates is absent from this list *and* from `venues`, because it is
   * not a gap in the map - no polygon could ever contain it. The scope
   * directory's `unassignedVenues` counts both, since it is answering "how many
   * published stores have no scene"; this list answers "where should the next
   * polygon go", which is a different question and would be noise with
   * unplaceable stores in it.
   */
  unplaced: UnplacedVenue[];
  stats: SceneAssignmentStats;
}

export interface SceneAssignmentStats {
  venues: number;
  scenes: number;
  players: number;
  matches: number;
  /** Polygons loaded, against the ones that actually hold a store. */
  regions: number;
  regionsWithVenues: number;
  /** Stores in no region, and the players whose home store is one of them. */
  unplacedVenues: number;
  unplacedPlayers: number;
  /**
   * Stores that fell exactly on a border two regions share.
   *
   * Resolved deterministically; counted because a handful is a drawing nicety
   * and a hundred means two polygons were drawn on top of each other within the
   * overlap check's ~1m slop.
   */
  boundaryTies: number;
  /** Player-weighted median intra-scene play share. */
  medianIntraShare: number;
  /** Scenes below `minIntraShare`, and the players in them. The health signal. */
  lowIntraShareScenes: number;
  lowIntraSharePlayers: number;
  medianPurity: number;
  /** Venues whose dominant scene holds under 60% of their play. */
  splitVenues: number;
  maxExtentKm: number;
  medianExtentKm: number;
}

// ---------------------------------------------------------------------------
// Per-venue facts
// ---------------------------------------------------------------------------

/**
 * Venue -> coordinates, matches, home players and label, for every venue with a
 * real shop id.
 *
 * Coordinates are the **mean** of the venue's events' coordinates, for the
 * reason `VENUE#` already gives: a store does not move, but the two event
 * sources geocode it ~20m apart, so "whichever event was read last" wobbles
 * where a mean is stable. A venue whose events carried no coordinates at all is
 * excluded - it cannot be placed by a polygon, and placing it anyway is exactly
 * the snapping this design refuses.
 */
export function regionVenues(
  observations: ObservationSet,
  labels: Map<string, string> = new Map(),
  home: Map<number, string> = homeVenues(observations)
): RegionVenue[] {
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

  const homeCounts = new Map<string, number>();
  for (const venue of home.values()) homeCounts.set(venue, (homeCounts.get(venue) ?? 0) + 1);

  const venues: RegionVenue[] = [];
  for (const [venue, row] of rows) {
    if (row.coords === 0) continue;
    venues.push({
      venue,
      shopExternalId: row.shopExternalId,
      latitude: row.latSum / row.coords,
      longitude: row.lonSum / row.coords,
      matches: row.matches,
      players: homeCounts.get(venue) ?? 0,
      label: labels.get(venue) ?? null,
    });
  }
  // Sorted by venue key so every downstream tie-break is reproducible.
  venues.sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0));
  return venues;
}

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

// ---------------------------------------------------------------------------
// The play-share measurement
// ---------------------------------------------------------------------------

/** What the play-share measurement found about one scene. */
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
 * unweighted median would be dominated by the small scenes a fine-grained map
 * necessarily produces a lot of - and would say the corpus is unrankable when
 * almost every *player* is in a scene that is fine.
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
// The assignment
// ---------------------------------------------------------------------------

export interface AssignScenesOptions {
  /** Venue key -> city label, from the shops table. Only used for the report. */
  venueLabels?: Map<string, string>;
  minIntraShare?: number;
  generatedAt?: Date;
}

/**
 * Place every venue in a region and derive the venue -> scene assignment.
 *
 * Four steps, none of which involves a clustering:
 *
 * 1. Per-venue mean coordinates, matches, home players and city label.
 * 2. One point-in-polygon test each (`placeVenues`). A venue in no region is
 *    **reported**, never snapped.
 * 3. Measure each region's intra-scene share of play and publish it with
 *    `ladderMeaningful`. Nothing is dropped on it.
 * 4. Venue purity, against the regions the venues landed in.
 *
 * A region holding no venue is not published: a `SCENE#` item for it would be a
 * named, empty row in the scene directory and on the map, and the directory is
 * built from the regions that a refit actually saw play in. The polygon is still
 * there and picks the region up the moment a store in it is replayed - which is
 * the asymmetry that makes drawing ahead of the data safe.
 */
export function assignScenesFromRegions(
  observations: ObservationSet,
  regions: RegionIndex,
  options: AssignScenesOptions = {}
): SceneAssignment {
  const minIntraShare = options.minIntraShare ?? DEFAULT_MIN_INTRA_SHARE;
  const home = homeVenues(observations);
  const venues = regionVenues(observations, options.venueLabels ?? new Map(), home);
  const placement = placeVenues(venues, regions);

  const byKey = new Map(venues.map(venue => [venue.venue, venue]));
  const sceneOfVenue = new Map<string, string>();
  const membersOfScene = new Map<string, { region: LoadedRegion; venues: string[] }>();
  for (const venue of venues) {
    const region = placement.regionOfVenue.get(venue.venue);
    if (!region) continue;
    sceneOfVenue.set(venue.venue, region.publishedId);
    let bucket = membersOfScene.get(region.publishedId);
    if (!bucket) membersOfScene.set(region.publishedId, (bucket = { region, venues: [] }));
    bucket.venues.push(venue.venue);
  }

  const shares = intraSceneShares(observations, sceneOfVenue, home);

  const scenes: SceneRecord[] = [];
  for (const [sceneId, bucket] of membersOfScene) {
    const share = shares.get(sceneId) ?? { matches: 0, internal: 0, share: 0, players: 0 };
    scenes.push({
      sceneId,
      regionId: bucket.region.id,
      label: bucket.region.name,
      extentKm: occupiedExtentKm(bucket.venues.map(key => byKey.get(key)!)),
      intraShare: Math.round(share.share * 1000) / 1000,
      ladderMeaningful: share.share >= minIntraShare,
    });
  }

  // Venue purity: the share of this store's player-match participations made by
  // players who live in its own scene. The same honest reading it has always
  // had - a low number is a store whose crowd comes from somewhere else, which
  // is worth showing rather than hiding.
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

  const assignedVenues: SceneVenueAssignment[] = [];
  for (const venue of venues) {
    const region = placement.regionOfVenue.get(venue.venue);
    if (!region) continue;
    const counts = participation.get(venue.venue);
    assignedVenues.push({
      venue: venue.venue,
      shopExternalId: venue.shopExternalId,
      sceneId: region.publishedId,
      regionId: region.id,
      purity:
        counts && counts.total > 0 ? Math.round((counts.inScene / counts.total) * 1000) / 1000 : 0,
    });
  }

  assignedVenues.sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0));
  scenes.sort((a, b) => (a.sceneId < b.sceneId ? -1 : a.sceneId > b.sceneId ? 1 : 0));

  const unplaced: UnplacedVenue[] = placement.unplaced.map(venue => ({
    venue: venue.venue,
    shopExternalId: venue.shopExternalId,
    latitude: venue.latitude,
    longitude: venue.longitude,
    matches: venue.matches,
    players: venue.players ?? 0,
    label: venue.label ?? null,
  }));

  const summary = summariseIntraShares(
    scenes.map(scene => shares.get(scene.sceneId)!).filter(Boolean)
  );
  const low = scenes.filter(scene => !scene.ladderMeaningful);
  const purities = assignedVenues.map(row => row.purity).sort((a, b) => a - b);
  const extents = scenes.map(scene => scene.extentKm).sort((a, b) => a - b);

  return {
    version: SCENE_ASSIGNMENT_VERSION,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    regionFiles: regions.files,
    minIntraShare,
    venues: assignedVenues,
    scenes,
    unplaced,
    stats: {
      venues: assignedVenues.length,
      scenes: scenes.length,
      players: observations.players.length,
      matches: observations.playerA.length,
      regions: regions.regions.length,
      regionsWithVenues: membersOfScene.size,
      unplacedVenues: unplaced.length,
      unplacedPlayers: unplaced.reduce((total, venue) => total + venue.players, 0),
      boundaryTies: placement.boundaryTies,
      medianIntraShare:
        Math.round((summary.percentiles.find(row => row.p === 50)?.share ?? 0) * 1000) / 1000,
      lowIntraShareScenes: low.length,
      lowIntraSharePlayers: low.reduce(
        (total, scene) => total + (shares.get(scene.sceneId)?.players ?? 0),
        0
      ),
      medianPurity: median(purities),
      splitVenues: purities.filter(purity => purity < 0.6).length,
      maxExtentKm: extents.length > 0 ? extents[extents.length - 1] : 0,
      medianExtentKm: median(extents),
    },
  };
}

/** Great-circle distance between the two farthest of these venues, km. */
function occupiedExtentKm(venues: RegionVenue[]): number {
  let widest = 0;
  for (let i = 0; i < venues.length; i++) {
    for (let j = i + 1; j < venues.length; j++) {
      const km = haversineKm(
        venues[i].latitude,
        venues[i].longitude,
        venues[j].latitude,
        venues[j].longitude
      );
      if (km > widest) widest = km;
    }
  }
  return Math.round(widest * 10) / 10;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Venue key -> scene, for the refit. An empty assignment leaves every scene null.
 *
 * The one reader of an assignment, and the reason the shape above is not simply
 * three maps: `snapshot.ts` needs the scene of a venue, the purity of a venue
 * and the label of a scene, and nothing else.
 */
export function sceneLookup(assignment: SceneAssignment | null): {
  sceneOfVenue: Map<string, string>;
  purityOfVenue: Map<string, number>;
  labelOfScene: Map<string, string>;
  recordOfScene: Map<string, SceneRecord>;
} {
  return {
    sceneOfVenue: new Map((assignment?.venues ?? []).map(row => [row.venue, row.sceneId])),
    purityOfVenue: new Map((assignment?.venues ?? []).map(row => [row.venue, row.purity])),
    labelOfScene: new Map((assignment?.scenes ?? []).map(row => [row.sceneId, row.label])),
    recordOfScene: new Map((assignment?.scenes ?? []).map(row => [row.sceneId, row])),
  };
}
