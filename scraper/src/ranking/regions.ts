/**
 * Regions: hand-drawn polygons, and the point-in-polygon test that places a
 * store in one.
 *
 * ## Why a drawn polygon rather than a cluster
 *
 * A scene used to be a complete-linkage cluster of venue coordinates at a 30km
 * diameter cap, re-run by an operator. The churn that produced was not a bug in
 * the clustering - it is what re-running an agglomeration on more data *does*:
 * the last re-cluster moved **308 of 2,518 shared venues (12.2%)**, created 474
 * scene ids and retired 144. A reader's scene label changed and their
 * bookmarked `?scene=` link died, for no reason they could see and no reason
 * anybody decided. An entire id-carrying mechanism (`carrySceneIds`, venue-set
 * Jaccard at 0.5) existed only to bound that damage, and the curated name table
 * keyed names on a cluster's *busiest shop id*, which silently detached the
 * first time a busier store opened.
 *
 * A polygon does not move. A store's region is therefore a **point-in-polygon
 * test**: deterministic, stable, and changing only when a human edits a
 * polygon. The id is chosen by that human and is never derived from membership,
 * which is the whole point - it is the thing that must not move.
 *
 * ## The format
 *
 * One JSON file per continent-ish area under `regions/` (`americas.json`,
 * `emea.json`, `apac.json`), each an array of:
 *
 * ```json
 * {
 *   "id": "r-bay-peninsula",
 *   "name": "Bay Area — Peninsula",
 *   "rings": [ [ [lng, lat], [lng, lat], ... ] ],
 *   "carriesSceneId": "s94af82a16f"
 * }
 * ```
 *
 * - **`id`** - stable, hand-chosen, `r-` prefixed, lowercase-kebab. Never
 *   derived from membership.
 * - **`rings`** - outer ring first, optional holes after. **Coordinates are
 *   `[longitude, latitude]`, GeoJSON order.** Rings may be left open; the
 *   loader closes them.
 * - **`carriesSceneId`** - optional. The `sceneId` this polygon succeeds. Where
 *   present it **becomes the region's published id**, so a shared `?scene=`
 *   link and every stored item keep working; `id` is the durable name behind
 *   it. See `publishedId`.
 *
 * ## `[longitude, latitude]`. In that order. Longitude first.
 *
 * Said loudly because the swap is *the* classic bug in this shape of data and
 * it fails silently - a swapped San Francisco lands at 37°E 122°N, which is not
 * a place, and a swapped Paris (2.3, 48.8 -> 48.8, 2.3) lands in Somalia and is
 * a perfectly valid coordinate. So the loader **rejects** any pair whose
 * latitude is outside [-90, 90] and says in the message that it looks swapped,
 * rather than placing stores in the ocean. A swap that stays inside both ranges
 * cannot be detected from the numbers alone and is what the coverage report is
 * for: a region that places no venues is the visible symptom.
 *
 * ## The antimeridian, stated rather than hand-waved
 *
 * Ray casting in plain lng/lat has no idea the world wraps, so a ring with a
 * point at 179 and the next at -179 is read as a 358°-wide polygon spanning the
 * entire globe the wrong way round. Two rules, both enforced:
 *
 * 1. **A ring's longitude span must be <= 180°.** This rejects the wrap
 *    artifact above, and also rejects a region nobody should be drawing as one
 *    polygon in the first place.
 * 2. **A region that genuinely crosses 180° is authored with continuous
 *    longitudes past the line** - Fiji as 177 -> 183, not 177 -> -177 - which
 *    is why longitudes up to ±360 are accepted. At `locate` time the query
 *    point is tried at `lng`, `lng - 360` and `lng + 360`, so a store recorded
 *    at -179 is found by a ring authored at 181.
 *
 * ## Efficiency
 *
 * 3,928 venues against ~600-900 polygons is 3.5M full polygon tests if done
 * naively, and a polygon here can carry hundreds of vertices. So:
 *
 * - every region carries its **bounding box**, and a point outside it is
 *   rejected in four comparisons;
 * - the boxes are indexed into a 5°-cell **grid**, so a query touches only the
 *   handful of regions whose box covers its cell rather than all 900.
 *
 * The full ring test therefore runs ~once per venue. Overlap detection at load
 * is the expensive half and is bounded the same way - only bbox-overlapping
 * pairs are compared edge by edge.
 *
 * ## What fails loudly
 *
 * Every one of these refuses the load with a message naming the file, the
 * region and the coordinate, because the alternative in each case is stores
 * filed somewhere a human did not put them:
 *
 * - a malformed file, entry, ring or coordinate pair;
 * - a latitude outside [-90, 90] (the swapped pair above);
 * - a ring spanning more than 180° of longitude (the antimeridian above);
 * - a duplicate `id`, or two regions claiming one published id;
 * - a hole that is not inside its own outer ring;
 * - **two regions that overlap.** A store in two regions is ambiguous and the
 *   data is wrong; see `findOverlaps` for what "overlap" means here and what it
 *   deliberately permits (a shared border).
 *
 * And the one thing that is *reported* rather than fatal: **a store in no
 * region gets `regionId: null`.** It is never snapped to the nearest polygon.
 * Snapping is how a Mexicali store ended up filed in California, and the
 * polygons will be incomplete for a long time - so the honest answer is a null
 * and a line in `scripts/metrics/region-coverage.sh`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the region files live, relative to this module. */
export const REGIONS_DIRNAME = 'regions';

/**
 * A region id: `r-` then lowercase-kebab.
 *
 * The `r-` prefix is not decoration - it is what makes a region id
 * unmistakable beside a scene id (`s` + 10 hex) in a log line, a diff or a
 * `carriesSceneId` field. A region id that looked like a scene id would make
 * the one field that matters here, `carriesSceneId`, impossible to review.
 */
export const REGION_ID_PATTERN = /^r-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A scene id, as the engine has always written them: `s` + 10 hex.
 *
 * Validated so that a `carriesSceneId` holding a region id, a label or a
 * typo is refused at load rather than publishing a region under an id nothing
 * downstream has ever seen - which would look exactly like the churn this
 * whole change exists to stop.
 */
export const SCENE_ID_PATTERN = /^s[0-9a-f]{10}$/;

/** Degrees of slop when asking "is this point *on* that edge". ~1.1m at worst. */
const BOUNDARY_EPS = 1e-5;

/** Degrees of slop in the orientation tests that decide a proper crossing. */
const CROSS_EPS = 1e-12;

/** Grid cell size in degrees, for the bbox index. */
const CELL_DEG = 5;

/** One region, exactly as it is written in a file. */
export interface RegionDefinition {
  id: string;
  name: string;
  /** Outer ring first, holes after. Each point is `[longitude, latitude]`. */
  rings: number[][][];
  /** The `sceneId` this polygon succeeds, if any. See `publishedId`. */
  carriesSceneId?: string;
}

export interface RegionBounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/** One region, loaded, closed, boxed and ready to be tested against. */
export interface LoadedRegion {
  /** The durable hand-chosen name. Never published downstream on its own. */
  id: string;
  name: string;
  /**
   * The id everything downstream sees: `carriesSceneId` where the polygon
   * succeeds an existing scene, `id` otherwise.
   *
   * This is the mapping that keeps a shared `?scene=` link alive and the stored
   * `VENUE#` / `SCENE#` / profile / ladder rows pointing at something. It is
   * deliberately explicit rather than a fallback buried in a caller.
   */
  publishedId: string;
  /** Present only where the region succeeds a clustered scene. */
  carriesSceneId: string | null;
  /** Closed rings: outer first, then holes. `[longitude, latitude]`. */
  rings: number[][][];
  bounds: RegionBounds;
  /** Which file this came from, so a problem can be fixed where it was written. */
  source: string;
}

/** Everything that was wrong with a region file set. */
export class RegionDataError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `region data is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map(problem => `  - ${problem}`).join('\n')
    );
    this.name = 'RegionDataError';
    this.problems = problems;
  }
}

/** One file, as read off disk - separated out so the parser is pure. */
export interface RegionSource {
  /** A short name for messages: the file's basename. */
  path: string;
  text: string;
}

/**
 * The loaded regions, with the lookup built over them.
 */
export interface RegionIndex {
  regions: LoadedRegion[];
  /** Files that were read, in load order. Empty is a valid state: see `loadRegionIndex`. */
  files: string[];
  /** Published id -> region. One entry per region; collisions are refused at load. */
  byPublishedId: Map<string, LoadedRegion>;
  /**
   * The region containing this point, or null.
   *
   * Null is a real answer and the caller must carry it as one. Nothing here
   * snaps to the nearest polygon.
   */
  locate(latitude: number, longitude: number): LoadedRegion | null;
  /**
   * Every region containing this point.
   *
   * Length >= 2 is only reachable for a point lying exactly on a border two
   * regions share, since overlapping interiors are refused at load. `locate`
   * breaks that tie on the region id and `placeVenues` counts it.
   */
  locateAll(latitude: number, longitude: number): LoadedRegion[];
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A ring's bounding box. The ring is `[lng, lat]` pairs. */
export function ringBounds(ring: number[][]): RegionBounds {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

function unionBounds(a: RegionBounds, b: RegionBounds): RegionBounds {
  return {
    minLng: Math.min(a.minLng, b.minLng),
    minLat: Math.min(a.minLat, b.minLat),
    maxLng: Math.max(a.maxLng, b.maxLng),
    maxLat: Math.max(a.maxLat, b.maxLat),
  };
}

function boundsOverlap(a: RegionBounds, b: RegionBounds): boolean {
  return (
    a.minLng <= b.maxLng && b.minLng <= a.maxLng && a.minLat <= b.maxLat && b.minLat <= a.maxLat
  );
}

function withinBounds(bounds: RegionBounds, lng: number, lat: number): boolean {
  return (
    lng >= bounds.minLng && lng <= bounds.maxLng && lat >= bounds.minLat && lat <= bounds.maxLat
  );
}

/** Close a ring if it is open. The loader always stores closed rings. */
function closeRing(ring: number[][]): number[][] {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, [first[0], first[1]]];
}

/**
 * Ray casting: is `[lng, lat]` inside this ring?
 *
 * The ray is cast in the +longitude direction at a fixed latitude, counting
 * edge crossings; odd is inside. The result on the boundary itself is
 * unspecified by construction - which is why every caller that cares asks
 * `pointOnRing` first rather than trusting this at the edge.
 */
export function pointInRing(ring: number[][], lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Is `[lng, lat]` within `eps` degrees of one of this ring's edges? */
export function pointOnRing(ring: number[][], lng: number, lat: number, eps = BOUNDARY_EPS): boolean {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (pointOnSegment(ring[j], ring[i], lng, lat, eps)) return true;
  }
  return false;
}

function pointOnSegment(a: number[], b: number[], lng: number, lat: number, eps: number): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.abs(lng - a[0]) <= eps && Math.abs(lat - a[1]) <= eps;
  }
  let t = ((lng - a[0]) * dx + (lat - a[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const px = a[0] + t * dx;
  const py = a[1] + t * dy;
  return Math.hypot(lng - px, lat - py) <= eps;
}

/**
 * Inside the outer ring and not inside any hole.
 *
 * Holes are the reason this is not just `pointInRing`: a region drawn around a
 * lake, or around an enclave another region owns, carries the hole as a second
 * ring and a point in it belongs to neither.
 */
export function pointInRings(rings: number[][][], lng: number, lat: number): boolean {
  if (rings.length === 0) return false;
  if (!pointInRing(rings[0], lng, lat)) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(rings[i], lng, lat)) return false;
  }
  return true;
}

function pointOnAnyRing(rings: number[][][], lng: number, lat: number): boolean {
  for (const ring of rings) if (pointOnRing(ring, lng, lat)) return true;
  return false;
}

function cross(o: number[], a: number[], b: number[]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * Do these two segments cross at a point interior to **both**?
 *
 * Deliberately strict, and that strictness is the whole reason the overlap
 * check is usable on hand-drawn data: two neighbouring regions sharing a border
 * have coincident vertices and collinear edges all along it, and a test that
 * called those an intersection would refuse every correctly drawn map. A shared
 * vertex, a T-junction and a collinear overlap are all **not** crossings here.
 */
export function segmentsProperlyCross(a1: number[], a2: number[], b1: number[], b2: number[]): boolean {
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  const opposite = (p: number, q: number): boolean =>
    (p > CROSS_EPS && q < -CROSS_EPS) || (p < -CROSS_EPS && q > CROSS_EPS);
  return opposite(d1, d2) && opposite(d3, d4);
}

/**
 * A point strictly inside this region, or null for a degenerate one.
 *
 * Needed for the one overlap case the crossing and vertex tests between them
 * miss: two regions drawn with *identical* rings, or one nested inside another
 * sharing its whole boundary. Neither has a proper crossing and neither has a
 * vertex strictly inside the other, so the only witness left is an interior
 * point - which is cheap once per region and is tested against the other
 * region's rings directly.
 *
 * Found by scanning a horizontal line across the outer ring, taking the
 * midpoint of the widest interval the ring's crossings bound, and rejecting it
 * if it lands in a hole. Several latitudes are tried, because one line can miss
 * on a crescent.
 */
export function interiorPoint(rings: number[][][]): number[] | null {
  if (rings.length === 0) return null;
  const outer = rings[0];
  const bounds = ringBounds(outer);
  const fractions = [0.5, 0.25, 0.75, 0.1, 0.9, 0.37, 0.63];
  for (const fraction of fractions) {
    const lat = bounds.minLat + (bounds.maxLat - bounds.minLat) * fraction;
    const crossings: number[] = [];
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const [xi, yi] = outer[i];
      const [xj, yj] = outer[j];
      if (yi > lat !== yj > lat) {
        crossings.push(((xj - xi) * (lat - yi)) / (yj - yi) + xi);
      }
    }
    crossings.sort((a, b) => a - b);
    let best: number[] | null = null;
    let bestWidth = 0;
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const width = crossings[i + 1] - crossings[i];
      if (width <= 0) continue;
      const candidate = [crossings[i] + width / 2, lat];
      if (!pointInRings(rings, candidate[0], candidate[1])) continue;
      if (width > bestWidth) {
        bestWidth = width;
        best = candidate;
      }
    }
    if (best) return best;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Overlap detection
// ---------------------------------------------------------------------------

/** One pair of regions whose interiors meet, and where. */
export interface RegionOverlap {
  a: string;
  b: string;
  /** What witnessed it, for a message a human can act on. */
  reason: 'edges-cross' | 'vertex-inside' | 'interior-point-inside';
  /** `[longitude, latitude]` of the witness. */
  at: number[];
}

/**
 * Every pair of regions whose **interiors** meet.
 *
 * Three witnesses, in increasing cost, and a pair is reported on the first one
 * that fires:
 *
 * 1. a vertex of one strictly inside the other (and not on its boundary);
 * 2. a proper crossing between an edge of one and an edge of the other;
 * 3. one region's interior point inside the other - the identical-rings case.
 *
 * Together these catch every overlap that matters. What they deliberately do
 * **not** flag is a shared border, which hand-drawn neighbours will have
 * everywhere: coincident vertices and collinear edges are not crossings, and a
 * vertex on the other region's boundary is not strictly inside it. The residual
 * blind spot is an overlap narrower than `BOUNDARY_EPS` (~1m) with no vertex
 * inside and no proper crossing, which is a hairline and cannot put a store in
 * two regions at the precision a geocode carries.
 *
 * Bounded by the bbox prefilter: only pairs whose boxes meet are compared edge
 * by edge, which on a real map is a region's handful of neighbours rather than
 * all 900.
 */
export function findOverlaps(regions: LoadedRegion[]): RegionOverlap[] {
  const points = regions.map(region => interiorPoint(region.rings));
  const overlaps: RegionOverlap[] = [];

  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i];
      const b = regions[j];
      if (!boundsOverlap(a.bounds, b.bounds)) continue;

      const witness = overlapWitness(a, b, points[i], points[j]);
      if (witness) overlaps.push({ a: a.id, b: b.id, ...witness });
    }
  }
  return overlaps;
}

function overlapWitness(
  a: LoadedRegion,
  b: LoadedRegion,
  aInterior: number[] | null,
  bInterior: number[] | null
): { reason: RegionOverlap['reason']; at: number[] } | null {
  for (const [host, guest] of [
    [b, a],
    [a, b],
  ] as const) {
    for (const ring of guest.rings) {
      for (const point of ring) {
        if (!withinBounds(host.bounds, point[0], point[1])) continue;
        if (pointOnAnyRing(host.rings, point[0], point[1])) continue;
        if (pointInRings(host.rings, point[0], point[1])) {
          return { reason: 'vertex-inside', at: [point[0], point[1]] };
        }
      }
    }
  }

  for (const ringA of a.rings) {
    for (let i = 0, j = ringA.length - 1; i < ringA.length; j = i++) {
      for (const ringB of b.rings) {
        for (let k = 0, l = ringB.length - 1; k < ringB.length; l = k++) {
          if (segmentsProperlyCross(ringA[j], ringA[i], ringB[l], ringB[k])) {
            return { reason: 'edges-cross', at: [ringA[i][0], ringA[i][1]] };
          }
        }
      }
    }
  }

  if (aInterior && pointInRings(b.rings, aInterior[0], aInterior[1])) {
    return { reason: 'interior-point-inside', at: aInterior };
  }
  if (bInterior && pointInRings(a.rings, bInterior[0], bInterior[1])) {
    return { reason: 'interior-point-inside', at: bInterior };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return typeof value;
}

/**
 * Parse and validate a set of region files into an index.
 *
 * Pure: it takes the file texts rather than reading them, so the whole
 * validation surface is testable without a fixture directory. Every problem is
 * collected before anything is thrown, because a drawing pass fixes a batch of
 * coordinates at a time and one error per run would be a day of round trips.
 */
export function parseRegions(sources: RegionSource[]): RegionIndex {
  const problems: string[] = [];
  const regions: LoadedRegion[] = [];
  const byId = new Map<string, LoadedRegion>();
  const byPublishedId = new Map<string, LoadedRegion>();

  for (const source of sources) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.text);
    } catch (error) {
      problems.push(
        `${source.path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`
      );
      continue;
    }
    if (!Array.isArray(parsed)) {
      problems.push(`${source.path}: must be an array of regions, got ${describe(parsed)}`);
      continue;
    }

    parsed.forEach((entry, index) => {
      const where = `${source.path}[${index}]`;
      const loaded = validateRegion(entry, where, problems, source.path);
      if (!loaded) return;

      const clash = byId.get(loaded.id);
      if (clash) {
        problems.push(
          `${where}: id '${loaded.id}' is already used by ${clash.source}. A region id is the ` +
            'one thing that must never move, so it cannot be shared.'
        );
        return;
      }
      byId.set(loaded.id, loaded);
      regions.push(loaded);
    });
  }

  // Published ids after every file is in, so the message can name both sides
  // wherever they were written.
  for (const region of regions) {
    const clash = byPublishedId.get(region.publishedId);
    if (clash) {
      problems.push(
        `'${region.id}' (${region.source}) and '${clash.id}' (${clash.source}) both publish ` +
          `'${region.publishedId}'. Two polygons cannot succeed one scene id - a '?scene=' link ` +
          'would resolve to whichever loaded first.'
      );
      continue;
    }
    byPublishedId.set(region.publishedId, region);
  }

  if (problems.length > 0) {
    // Geometry is only checked once every region parses: an overlap test over a
    // half-read set would report pairs that may not exist and miss pairs that
    // do. Said out loud, because a problem list with no overlap in it otherwise
    // reads as "the polygons do not overlap".
    problems.push(
      'overlaps were NOT checked - fix the problems above and run again, since an overlap ' +
        'test needs every region to have parsed'
    );
  } else {
    for (const overlap of findOverlaps(regions)) {
      problems.push(
        `'${overlap.a}' and '${overlap.b}' overlap (${overlap.reason} at ` +
          `${overlap.at[0].toFixed(5)}, ${overlap.at[1].toFixed(5)}). A store inside both is ` +
          'ambiguous: move one border so they share it instead of crossing it.'
      );
    }
  }

  if (problems.length > 0) throw new RegionDataError(problems);

  return buildIndex(
    regions,
    sources.map(source => source.path),
    byPublishedId
  );
}

function validateRegion(
  entry: unknown,
  where: string,
  problems: string[],
  source: string
): LoadedRegion | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    problems.push(`${where}: must be an object, got ${describe(entry)}`);
    return null;
  }
  const record = entry as Record<string, unknown>;
  const before = problems.length;

  const id = record.id;
  if (typeof id !== 'string' || !REGION_ID_PATTERN.test(id)) {
    problems.push(
      `${where}: 'id' must be lowercase-kebab with an 'r-' prefix (e.g. 'r-bay-peninsula'), ` +
        `got ${JSON.stringify(id)}`
    );
  }

  const name = record.name;
  if (typeof name !== 'string' || name.trim() === '') {
    problems.push(`${where}: 'name' must be a non-empty string, got ${JSON.stringify(name)}`);
  }

  let carriesSceneId: string | null = null;
  if (record.carriesSceneId !== undefined && record.carriesSceneId !== null) {
    if (typeof record.carriesSceneId !== 'string' || !SCENE_ID_PATTERN.test(record.carriesSceneId)) {
      problems.push(
        `${where}: 'carriesSceneId' must be an existing scene id ('s' then 10 hex digits), got ` +
          `${JSON.stringify(record.carriesSceneId)}. It is the id a shared '?scene=' link ` +
          'carries, not a name for the region.'
      );
    } else {
      carriesSceneId = record.carriesSceneId;
    }
  }

  const rings = validateRings(record.rings, where, problems);

  if (problems.length > before) return null;

  const closed = rings!.map(closeRing);
  const bounds = closed.slice(1).reduce(
    (total, ring) => unionBounds(total, ringBounds(ring)),
    ringBounds(closed[0])
  );
  return {
    id: id as string,
    name: (name as string).trim(),
    publishedId: carriesSceneId ?? (id as string),
    carriesSceneId,
    rings: closed,
    bounds,
    source,
  };
}

function validateRings(value: unknown, where: string, problems: string[]): number[][][] | null {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${where}: 'rings' must be a non-empty array (outer ring first), got ${describe(value)}`);
    return null;
  }

  const before = problems.length;
  const rings: number[][][] = [];

  value.forEach((ring, ringIndex) => {
    const label = ringIndex === 0 ? 'outer ring' : `hole ${ringIndex}`;
    if (!Array.isArray(ring)) {
      problems.push(`${where}: ${label} must be an array of [lng, lat] pairs, got ${describe(ring)}`);
      return;
    }
    const points: number[][] = [];
    // Problems already reported for *this ring's own points*. A ring whose
    // coordinates were rejected must not also be told it has too few points:
    // one swapped box would print five problems for one mistake, and the
    // cascade is what makes a long list unreadable.
    const pointsBefore = problems.length;
    ring.forEach((point, pointIndex) => {
      const at = `${where} ${label} point ${pointIndex}`;
      if (!Array.isArray(point) || point.length < 2) {
        problems.push(`${at}: must be a [longitude, latitude] pair, got ${describe(point)}`);
        return;
      }
      const [lng, lat] = point as unknown[];
      if (typeof lng !== 'number' || !Number.isFinite(lng) || typeof lat !== 'number' || !Number.isFinite(lat)) {
        problems.push(`${at}: both coordinates must be finite numbers, got ${JSON.stringify(point)}`);
        return;
      }
      if (Math.abs(lat) > 90) {
        const swapped = Math.abs(lng) <= 90;
        problems.push(
          `${at}: latitude ${lat} is outside [-90, 90]` +
            (swapped
              ? ` - this looks like a swapped pair. Coordinates are [longitude, latitude]: write ` +
                `[${lat}, ${lng}].`
              : '. Coordinates are [longitude, latitude].')
        );
        return;
      }
      if (Math.abs(lng) > 360) {
        problems.push(`${at}: longitude ${lng} is outside [-360, 360]`);
        return;
      }
      points.push([lng, lat]);
    });

    if (problems.length > pointsBefore) return;

    const closed = closeRing(points);
    // Three distinct points is the floor for an area. A closed ring repeats its
    // first point, so the closed form needs four.
    if (closed.length < 4) {
      problems.push(
        `${where}: ${label} needs at least 3 distinct points to enclose an area, got ${points.length}`
      );
      return;
    }
    const bounds = ringBounds(closed);
    if (bounds.maxLng - bounds.minLng > 180) {
      problems.push(
        `${where}: ${label} spans ${(bounds.maxLng - bounds.minLng).toFixed(1)}° of longitude, ` +
          'which is more than half the world. Either a coordinate is wrong, or the ring crosses ' +
          'the antimeridian by wrapping through ±180 - write continuous longitudes past the line ' +
          'instead (177 -> 183, not 177 -> -177).'
      );
      return;
    }
    rings.push(closed);
  });

  if (problems.length > before) return null;

  // A hole outside its own outer ring is a drawing mistake that would otherwise
  // silently subtract nothing, or subtract from a neighbour.
  const outer = rings[0];
  for (let i = 1; i < rings.length; i++) {
    const point = interiorPoint([rings[i]]);
    const inside = point ? pointInRing(outer, point[0], point[1]) : false;
    if (!inside) {
      problems.push(
        `${where}: hole ${i} is not inside the outer ring. A hole subtracts from its own region ` +
          'and nothing else.'
      );
    }
  }
  if (problems.length > before) return null;

  return rings;
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

function cellKey(latCell: number, lngCell: number): string {
  return `${latCell}:${lngCell}`;
}

function latCellOf(lat: number): number {
  return Math.min(
    Math.floor(180 / CELL_DEG) - 1,
    Math.max(0, Math.floor((lat + 90) / CELL_DEG))
  );
}

/** Longitude cell, wrapped - so a ring authored at 181 indexes where -179 queries. */
function lngCellOf(lng: number): number {
  const cells = Math.floor(360 / CELL_DEG);
  return ((Math.floor((lng + 180) / CELL_DEG) % cells) + cells) % cells;
}

function buildIndex(
  regions: LoadedRegion[],
  files: string[],
  byPublishedId: Map<string, LoadedRegion>
): RegionIndex {
  // Stable order, so two loads of the same data answer identically and a
  // boundary tie-break is reproducible.
  const ordered = [...regions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const grid = new Map<string, LoadedRegion[]>();
  for (const region of ordered) {
    const { bounds } = region;
    for (let lat = bounds.minLat; ; lat += CELL_DEG) {
      const latCell = latCellOf(Math.min(lat, bounds.maxLat));
      for (let lng = bounds.minLng; ; lng += CELL_DEG) {
        const key = cellKey(latCell, lngCellOf(Math.min(lng, bounds.maxLng)));
        const bucket = grid.get(key);
        if (bucket) {
          if (bucket[bucket.length - 1] !== region) bucket.push(region);
        } else {
          grid.set(key, [region]);
        }
        if (lng >= bounds.maxLng) break;
      }
      if (lat >= bounds.maxLat) break;
    }
  }

  const locateAll = (latitude: number, longitude: number): LoadedRegion[] => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    const candidates = grid.get(cellKey(latCellOf(latitude), lngCellOf(longitude)));
    if (!candidates) return [];
    const hits: LoadedRegion[] = [];
    for (const region of candidates) {
      // The antimeridian: a ring authored past ±180 is tested against the
      // query point shifted into its own longitude frame. See the module note.
      for (const lng of [longitude, longitude - 360, longitude + 360]) {
        if (!withinBounds(region.bounds, lng, latitude)) continue;
        if (pointInRings(region.rings, lng, latitude)) {
          hits.push(region);
          break;
        }
      }
    }
    return hits;
  };

  return {
    regions: ordered,
    files,
    byPublishedId,
    locateAll,
    locate: (latitude, longitude) => {
      const hits = locateAll(latitude, longitude);
      // Overlapping interiors are refused at load, so >1 hit means the point
      // sits exactly on a shared border. Pick on the id rather than on grid
      // order: an arbitrary-but-stable answer beats a store that changes region
      // because a file was renamed.
      return hits.length === 0 ? null : hits[0];
    },
  };
}

// ---------------------------------------------------------------------------
// Loading from disk
// ---------------------------------------------------------------------------

/**
 * Read every `*.json` under `dir` (default: `regions/` beside this module) and
 * build the index.
 *
 * **A missing or empty directory is not an error.** The polygons are being
 * drawn by hand and will be incomplete for a long time; an engine that refused
 * to refit until the map was finished would hold the whole ladder hostage to a
 * drawing pass. With no regions every venue comes back `regionId: null`, every
 * scene field is null, and the coverage report says so - which is exactly the
 * state the stored assignment used to produce before an operator had ever
 * re-clustered.
 *
 * Invalid *content* is a different thing and does throw. A file that exists and
 * is wrong is a mistake somebody can fix; silently skipping it would place
 * stores nowhere and look like missing polygons.
 */
export function loadRegionIndex(dir: string = join(__dirname, REGIONS_DIRNAME)): RegionIndex {
  let names: string[];
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json')).sort();
  } catch {
    return parseRegions([]);
  }
  return parseRegions(
    names.map(name => ({ path: name, text: readFileSync(join(dir, name), 'utf8') }))
  );
}

// ---------------------------------------------------------------------------
// Placing venues
// ---------------------------------------------------------------------------

/** One store, as the placement sees it. */
export interface RegionVenue {
  /** `venueKey` form, always `shop:<id>` - a region is never keyed on a geocode. */
  venue: string;
  shopExternalId: number;
  latitude: number;
  longitude: number;
  /** Matches played here. Orders the unplaced list so the busiest gap reads first. */
  matches: number;
  /** Distinct players with this as their home store, for the same reason. */
  players?: number;
  /** City label from the shops table, for a human reading the coverage report. */
  label?: string | null;
}

export interface RegionPlacement {
  /** Venue key -> the region it fell in. */
  regionOfVenue: Map<string, LoadedRegion>;
  /** Venues in no region, busiest first. Reported, never snapped. */
  unplaced: RegionVenue[];
  /**
   * Venues that fell exactly on a border two regions share.
   *
   * Deterministically resolved (lowest region id wins) and counted, because a
   * handful is a drawing nicety and a hundred means two regions were drawn on
   * top of each other in a way the overlap test's ~1m slop let through.
   */
  boundaryTies: number;
}

/**
 * Place every venue by its coordinates.
 *
 * One bbox-indexed lookup each: 3,928 venues against ~900 polygons costs ~3,928
 * ring tests rather than 3.5M. A venue in no region lands in `unplaced` with
 * its coordinates intact so a polygon can be drawn for it; nothing is snapped
 * to the nearest one.
 */
export function placeVenues(venues: RegionVenue[], index: RegionIndex): RegionPlacement {
  const regionOfVenue = new Map<string, LoadedRegion>();
  const unplaced: RegionVenue[] = [];
  let boundaryTies = 0;

  for (const venue of venues) {
    const hits = index.locateAll(venue.latitude, venue.longitude);
    if (hits.length === 0) {
      unplaced.push(venue);
      continue;
    }
    if (hits.length > 1) boundaryTies++;
    regionOfVenue.set(venue.venue, hits[0]);
  }

  unplaced.sort(
    (a, b) => b.matches - a.matches || (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0)
  );
  return { regionOfVenue, unplaced, boundaryTies };
}
