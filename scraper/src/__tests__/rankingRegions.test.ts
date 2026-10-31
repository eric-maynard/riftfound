import { describe, it, expect } from 'vitest';
import {
  findOverlaps,
  interiorPoint,
  parseRegions,
  placeVenues,
  pointInRings,
  RegionDataError,
  segmentsProperlyCross,
  type RegionDefinition,
  type RegionVenue,
} from '../ranking/regions.js';

/**
 * The region loader.
 *
 * Everything pinned here is something that would otherwise fail *silently* and
 * put stores somewhere a human did not put them:
 *
 * - **`[longitude, latitude]`.** The swap is the classic bug in this shape of
 *   data and half of its instances are valid coordinates somewhere else, so the
 *   half that is detectable is rejected with a message that names it.
 * - **No two regions may overlap.** A store in two regions is ambiguous.
 *   A shared *border* is not an overlap and must not be refused, because
 *   hand-drawn neighbours will have one everywhere.
 * - **Holes.** A point in a hole belongs to neither region.
 * - **The antimeridian.** Ray casting does not know the world wraps, so the
 *   wrap artifact is rejected and the deliberate form is supported.
 * - **A store in no region is null**, and nothing snaps it to the nearest
 *   polygon. Snapping is how a Mexicali store ended up filed in California.
 * - **A missing file set is not an error**, because the map is drawn by hand and
 *   an engine that refused to refit until it was finished would hold the whole
 *   ladder hostage to a drawing pass.
 */

function box(minLng: number, minLat: number, maxLng: number, maxLat: number): number[][] {
  return [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
  ];
}

function load(definitions: unknown, path = 'americas.json') {
  return parseRegions([{ path, text: JSON.stringify(definitions) }]);
}

function problems(definitions: unknown, path = 'americas.json'): string[] {
  try {
    load(definitions, path);
  } catch (error) {
    if (error instanceof RegionDataError) return error.problems;
    throw error;
  }
  throw new Error('expected the load to be refused');
}

const peninsula: RegionDefinition = {
  id: 'r-bay-peninsula',
  name: 'Bay Area — Peninsula',
  rings: [box(-122.3, 37.4, -122.1, 37.6)],
  carriesSceneId: 's94af82a16f',
};

const southBay: RegionDefinition = {
  id: 'r-bay-south',
  name: 'Bay Area — South Bay',
  rings: [box(-122.1, 37.2, -121.8, 37.45)],
};

describe('the format', () => {
  it('reads a region and publishes the carried scene id, keeping its own behind it', () => {
    const index = load([peninsula, southBay]);
    expect(index.regions.map(region => region.id)).toEqual(['r-bay-peninsula', 'r-bay-south']);

    const carried = index.byPublishedId.get('s94af82a16f')!;
    expect(carried.id).toBe('r-bay-peninsula');
    expect(carried.name).toBe('Bay Area — Peninsula');
    expect(carried.carriesSceneId).toBe('s94af82a16f');
    expect(carried.source).toBe('americas.json');

    // A region that succeeds nothing publishes under its own id.
    const fresh = index.byPublishedId.get('r-bay-south')!;
    expect(fresh.id).toBe('r-bay-south');
    expect(fresh.carriesSceneId).toBeNull();
    expect(index.byPublishedId.has('r-bay-peninsula')).toBe(false);
  });

  it('closes an open ring rather than asking a human to repeat a point', () => {
    const index = load([peninsula]);
    const ring = index.regions[0].rings[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[ring.length - 1]);

    // And an already-closed ring is not closed twice.
    const closed = load([
      { ...peninsula, rings: [[...box(-122.3, 37.4, -122.1, 37.6), [-122.3, 37.4]]] },
    ]);
    expect(closed.regions[0].rings[0]).toHaveLength(5);
  });

  it('refuses an id that is not a stable hand-chosen r- name', () => {
    expect(problems([{ ...peninsula, id: 'bay-peninsula' }])[0]).toContain("'id' must be");
    expect(problems([{ ...peninsula, id: 'r-Bay-Peninsula' }])[0]).toContain("'id' must be");
    expect(problems([{ ...peninsula, id: 's94af82a16f' }])[0]).toContain("'id' must be");
  });

  it('refuses a carriesSceneId that is not an engine scene id', () => {
    // The field's whole job is to keep a shared `?scene=` link resolving, so a
    // name or a region id in it would publish the region under an id nothing
    // downstream has ever seen - which looks exactly like the churn this
    // change exists to stop.
    const message = problems([{ ...peninsula, carriesSceneId: 'r-bay-peninsula' }])[0];
    expect(message).toContain("'carriesSceneId' must be an existing scene id");
    expect(problems([{ ...peninsula, carriesSceneId: 'Peninsula' }])[0]).toContain(
      "'carriesSceneId' must be an existing scene id"
    );
    // Absent and explicitly null both mean "succeeds nothing".
    expect(load([{ ...peninsula, carriesSceneId: null }]).regions[0].publishedId).toBe(
      'r-bay-peninsula'
    );
  });

  it('refuses a duplicate id, and two regions publishing one id', () => {
    expect(problems([peninsula, { ...peninsula, name: 'Elsewhere' }])[0]).toContain(
      "id 'r-bay-peninsula' is already used"
    );
    const clash = problems([
      peninsula,
      { ...southBay, rings: [box(10, 10, 11, 11)], carriesSceneId: 's94af82a16f' },
    ]);
    expect(clash[0]).toContain("both publish 's94af82a16f'");
  });

  it('collects every problem before refusing, so one run fixes a batch', () => {
    const found = problems([
      { id: 'nope', name: '', rings: [] },
      { ...southBay, id: 'also-nope' },
    ]);
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found.some(problem => problem.includes('americas.json[0]'))).toBe(true);
    expect(found.some(problem => problem.includes('americas.json[1]'))).toBe(true);
  });

  it('says overlaps were not checked, rather than letting silence read as clean', () => {
    // Geometry is only tested once every region parses, so a problem list with
    // no overlap in it would otherwise read as "the polygons do not overlap".
    const found = problems([
      { ...peninsula, id: 'nope' },
      { ...southBay, rings: [box(-122.2, 37.3, -121.9, 37.5)] },
    ]);
    expect(found[found.length - 1]).toContain('overlaps were NOT checked');
  });

  it('does not cascade one bad coordinate into a second complaint about the ring', () => {
    // A swapped four-point box is one mistake. Before this it printed five
    // problems - four coordinates and "needs at least 3 distinct points",
    // because the rejected points never made it into the ring - and a cascade
    // is what makes a long list unreadable.
    const found = problems([{ ...peninsula, rings: [box(37.4, -122.3, 37.6, -122.1)] }]);
    expect(found.filter(problem => problem.includes('outside [-90, 90]'))).toHaveLength(4);
    expect(found.some(problem => problem.includes('at least 3 distinct points'))).toBe(false);
  });

  it('refuses a file that is not an array of regions', () => {
    expect(parseRegions.bind(null, [{ path: 'a.json', text: '{oops' }])).toThrow(RegionDataError);
    expect(problems({ regions: [] })[0]).toContain('must be an array of regions');
  });

  it('refuses a ring that cannot enclose an area', () => {
    expect(problems([{ ...peninsula, rings: [[[0, 0], [1, 1]]] }])[0]).toContain(
      'at least 3 distinct points'
    );
    expect(problems([{ ...peninsula, rings: [] }])[0]).toContain("'rings' must be a non-empty array");
  });
});

describe('[longitude, latitude], in that order', () => {
  it('rejects a swapped pair and says that is what it looks like', () => {
    // San Francisco, written the wrong way round. 122 is not a latitude.
    const message = problems([{ ...peninsula, rings: [box(37.4, -122.3, 37.6, -122.1)] }])[0];
    expect(message).toContain('outside [-90, 90]');
    expect(message).toContain('swapped pair');
    expect(message).toContain('[longitude, latitude]');
    // The message carries the corrected pair, so the fix is mechanical.
    expect(message).toContain('[-122.3, 37.4]');
  });

  it('rejects a latitude out of range even when a swap is not the explanation', () => {
    const message = problems([{ ...peninsula, rings: [box(-122.3, 91, -122.1, 92)] }])[0];
    expect(message).toContain('outside [-90, 90]');
    expect(message).not.toContain('swapped pair');
  });

  it('refuses a non-numeric or short coordinate pair', () => {
    expect(problems([{ ...peninsula, rings: [[[0, 0], [1, 0], ['2', 1]]] }])[0]).toContain(
      'finite numbers'
    );
    expect(problems([{ ...peninsula, rings: [[[0, 0], [1, 0], [2]]] }])[0]).toContain(
      '[longitude, latitude] pair'
    );
    expect(problems([{ ...peninsula, rings: [[[0, 0], [1, 0], [Infinity, 1]]] }])[0]).toContain(
      'finite numbers'
    );
  });

  // The undetectable half, stated so nobody thinks the check above is complete:
  // a swap that stays inside both ranges is a valid polygon somewhere else, and
  // the coverage report's "regions holding no store" line is what catches it.
  it('cannot detect a swap that stays inside both coordinate ranges', () => {
    const swappedParis = load([{ ...peninsula, carriesSceneId: null, rings: [box(48.8, 2.2, 48.9, 2.4)] }]);
    expect(swappedParis.regions).toHaveLength(1);
    // Paris is not in it, which is the only symptom there is.
    expect(swappedParis.locate(48.85, 2.3)).toBeNull();
  });
});

describe('no two regions may overlap', () => {
  it('refuses a pair whose interiors meet, naming both and the coordinate', () => {
    const found = problems([peninsula, { ...southBay, rings: [box(-122.2, 37.3, -121.9, 37.5)] }]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("'r-bay-peninsula' and 'r-bay-south' overlap");
    expect(found[0]).toMatch(/-12[12]\.\d+, 37\.\d+/);
    expect(found[0]).toContain('share it instead of crossing it');
  });

  it('refuses one region drawn entirely inside another', () => {
    const found = problems([peninsula, { ...southBay, rings: [box(-122.25, 37.45, -122.15, 37.55)] }]);
    expect(found[0]).toContain('vertex-inside');
  });

  it('refuses two regions drawn with identical rings', () => {
    // Neither has a proper crossing and every vertex is on the other's
    // boundary, so the only witness is an interior point. Without that third
    // test this - a copy-paste - would load cleanly and place every store in
    // whichever file was read first.
    const found = problems([peninsula, { ...southBay, rings: [box(-122.3, 37.4, -122.1, 37.6)] }]);
    expect(found[0]).toContain('interior-point-inside');
  });

  it('allows neighbours that share a border exactly', () => {
    // The case that has to work. `southBay`'s western edge is `peninsula`'s
    // eastern edge at -122.1, with two coincident vertices and a collinear
    // overlap along it. A strict crossing test is what makes this loadable.
    expect(load([peninsula, southBay]).regions).toHaveLength(2);
    expect(findOverlaps(load([peninsula, southBay]).regions)).toEqual([]);
  });

  it('allows a T-junction, where one region ends against another edge', () => {
    const left = { ...peninsula, carriesSceneId: null, rings: [box(0, 0, 1, 2)] };
    const upper = { ...southBay, rings: [box(1, 1, 2, 2)] };
    const lower = { id: 'r-c', name: 'C', rings: [box(1, 0, 2, 1)] };
    expect(load([left, upper, lower]).regions).toHaveLength(3);
  });

  it('allows a region in another region\'s hole', () => {
    // The reason holes exist: a region drawn around an enclave another region
    // owns. Neither claims the other's stores and nothing overlaps.
    const ring = { ...peninsula, carriesSceneId: null, rings: [box(0, 0, 10, 10), box(4, 4, 6, 6)] };
    const enclave = { ...southBay, rings: [box(4, 4, 6, 6)] };
    const index = load([ring, enclave]);
    expect(index.regions).toHaveLength(2);
    expect(index.locate(5, 5)!.id).toBe('r-bay-south');
    expect(index.locate(2, 2)!.id).toBe('r-bay-peninsula');
  });

  it('only compares pairs whose boxes meet, so 900 polygons is not 400k ring tests', () => {
    // A grid of disjoint boxes: correct answer, and the bbox prefilter is what
    // makes asserting it cheap enough to be worth asserting.
    const grid: RegionDefinition[] = [];
    for (let x = 0; x < 30; x++) {
      for (let y = 0; y < 30; y++) {
        grid.push({ id: `r-${x}-${y}`, name: `${x},${y}`, rings: [box(x, y, x + 0.9, y + 0.9)] });
      }
    }
    const index = load(grid);
    expect(index.regions).toHaveLength(900);
    expect(index.locate(5.5, 7.5)!.id).toBe('r-7-5');
    // In the 0.1-degree gutter between two boxes.
    expect(index.locate(5.95, 7.5)).toBeNull();
  });
});

describe('point in polygon, with holes', () => {
  const index = load([
    { ...peninsula, carriesSceneId: null, rings: [box(0, 0, 10, 10), box(4, 4, 6, 6)] },
  ]);

  it('places a point inside the outer ring', () => {
    expect(index.locate(2, 2)!.id).toBe('r-bay-peninsula');
    expect(index.locate(9.5, 9.5)!.id).toBe('r-bay-peninsula');
  });

  it('places a point in a hole in no region at all', () => {
    expect(index.locate(5, 5)).toBeNull();
    expect(pointInRings(index.regions[0].rings, 5, 5)).toBe(false);
    expect(pointInRings(index.regions[0].rings, 2, 2)).toBe(true);
  });

  it('places a point outside the box in no region', () => {
    expect(index.locate(20, 20)).toBeNull();
    expect(index.locate(-1, 5)).toBeNull();
  });

  it('handles a concave ring, where a bbox test alone would be wrong', () => {
    // An L: the top-right quadrant is inside the bounding box and outside the
    // polygon, which is precisely what the prefilter must not be allowed to
    // decide on its own.
    const l = load([
      {
        ...peninsula,
        carriesSceneId: null,
        rings: [[[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]],
      },
    ]);
    expect(l.locate(2, 2)!.id).toBe('r-bay-peninsula');
    expect(l.locate(2, 8)!.id).toBe('r-bay-peninsula');
    expect(l.locate(8, 8)).toBeNull();
  });

  it('refuses a hole that is not inside its own outer ring', () => {
    expect(
      problems([{ ...peninsula, rings: [box(0, 0, 10, 10), box(20, 20, 21, 21)] }])[0]
    ).toContain('hole 1 is not inside the outer ring');
  });

  it('finds an interior point even for an awkward shape', () => {
    // The identical-rings overlap test depends on this, so a shape where the
    // middle latitude misses is worth pinning: a V whose centre line crosses
    // the ring four times.
    const v = [[0, 0], [2, 0], [2, 8], [3, 8], [3, 0], [5, 0], [5, 10], [0, 10]];
    const point = interiorPoint([[...v, v[0]]])!;
    expect(point).not.toBeNull();
    expect(pointInRings([[...v, v[0]]], point[0], point[1])).toBe(true);
  });
});

describe('the antimeridian', () => {
  it('rejects a ring that wraps through ±180, which reads as a global polygon', () => {
    // 179 -> -179 is the artifact: in plain lng/lat it is a 358°-wide polygon
    // spanning the world the wrong way round, and every store on earth would
    // fall in it.
    const message = problems([{ ...peninsula, rings: [box(179, -17, -179, -16)] }])[0];
    expect(message).toContain('of longitude');
    expect(message).toContain('crosses the antimeridian');
    expect(message).toContain('177 -> 183');
  });

  it('supports the deliberate form: continuous longitudes past the line', () => {
    const fiji = load([
      { ...peninsula, carriesSceneId: null, name: 'Fiji', rings: [box(177, -19, 183, -16)] },
    ]);
    // A store recorded at -179 is the same place as 181, and is found.
    expect(fiji.locate(-17.5, -179)!.name).toBe('Fiji');
    expect(fiji.locate(-17.5, 179)!.name).toBe('Fiji');
    expect(fiji.locate(-17.5, 176)).toBeNull();
    expect(fiji.locate(-17.5, 184)).toBeNull();
  });
});

describe('placing venues', () => {
  const index = load([peninsula, southBay]);

  function venue(id: number, latitude: number, longitude: number, matches = 1): RegionVenue {
    return { venue: `shop:${id}`, shopExternalId: id, latitude, longitude, matches, players: matches };
  }

  it('places each venue in one region', () => {
    const placement = placeVenues(
      [venue(1, 37.5, -122.2), venue(2, 37.3, -121.9)],
      index
    );
    expect(placement.regionOfVenue.get('shop:1')!.publishedId).toBe('s94af82a16f');
    expect(placement.regionOfVenue.get('shop:2')!.publishedId).toBe('r-bay-south');
    expect(placement.unplaced).toEqual([]);
  });

  it('reports a venue in no region and never snaps it to the nearest one', () => {
    // Mexicali, 10km from a California polygon's edge in the real data. The
    // whole failure this design refuses: it is reported, not absorbed.
    const placement = placeVenues([venue(1, 37.5, -122.2), venue(9, 32.6, -115.4, 40)], index);
    expect(placement.regionOfVenue.has('shop:9')).toBe(false);
    expect(placement.unplaced.map(row => row.venue)).toEqual(['shop:9']);
    expect(placement.unplaced[0].latitude).toBe(32.6);
    expect(placement.unplaced[0].longitude).toBe(-115.4);
  });

  it('lists the unplaced busiest first, so the gap worth drawing reads first', () => {
    const placement = placeVenues(
      [venue(7, 0, 0, 3), venue(8, 0, 1, 40), venue(9, 0, 2, 11)],
      index
    );
    expect(placement.unplaced.map(row => row.matches)).toEqual([40, 11, 3]);
  });

  it('puts a store exactly on a shared border in exactly one of the two', () => {
    // -122.1 is the border the two regions share, and the ray-casting
    // convention settles it rather than leaving it to chance: the ray runs in
    // +longitude, so a point on a region's *eastern* edge is outside it and a
    // point on its *western* edge is inside. Two neighbours sharing a border
    // therefore cannot both claim a store on it, which is a nicer property
    // than the tie-break below and is worth pinning as the normal case.
    expect(index.locateAll(37.42, -122.1)).toHaveLength(1);
    expect(index.locate(37.42, -122.1)!.id).toBe('r-bay-south');
  });

  it('resolves a hairline overlap deterministically, and counts it', () => {
    // The overlap check's documented residual: two borders that differ by less
    // than its ~1m slop are read as one shared border and load cleanly. A store
    // in that hairline really is in both polygons, so the answer is arbitrary -
    // but it must be the *same* arbitrary answer every run, and it must be
    // counted, because a hundred of these means two regions were drawn on top
    // of each other rather than beside each other.
    const hairline = load([
      { ...peninsula, carriesSceneId: null, rings: [box(0, 0, 1, 1)] },
      { ...southBay, rings: [box(0.9999999999, 0, 2, 1)] },
    ]);
    const on = venue(5, 0.5, 0.99999999995);
    expect(hairline.locateAll(0.5, 0.99999999995)).toHaveLength(2);

    const first = placeVenues([on], hairline);
    const second = placeVenues([on], hairline);
    expect(first.boundaryTies).toBe(1);
    // Lowest region id wins, so a file being renamed cannot move the store.
    expect(first.regionOfVenue.get('shop:5')!.id).toBe('r-bay-peninsula');
    expect(second.regionOfVenue.get('shop:5')!.id).toBe('r-bay-peninsula');
  });

  it('ignores a venue with coordinates that are not numbers', () => {
    const placement = placeVenues([venue(1, NaN, -122.2)], index);
    expect(placement.regionOfVenue.size).toBe(0);
    expect(placement.unplaced.map(row => row.venue)).toEqual(['shop:1']);
  });
});

describe('an empty map is a state, not a failure', () => {
  it('loads no files into an index that places nothing', () => {
    const index = parseRegions([]);
    expect(index.regions).toEqual([]);
    expect(index.files).toEqual([]);
    expect(index.locate(37.5, -122.2)).toBeNull();
  });

  it('reads several files and names each region by the one it came from', () => {
    const index = parseRegions([
      { path: 'americas.json', text: JSON.stringify([peninsula]) },
      { path: 'emea.json', text: JSON.stringify([{ ...southBay, rings: [box(2, 48, 3, 49)] }]) },
    ]);
    expect(index.files).toEqual(['americas.json', 'emea.json']);
    expect(index.regions.find(region => region.id === 'r-bay-south')!.source).toBe('emea.json');
  });
});

describe('the strict crossing test', () => {
  // Pinned directly because it is what makes a shared border loadable, and a
  // regression to a loose intersection test would refuse every correct map.
  it('is true only where two segments cross at an interior point of both', () => {
    expect(segmentsProperlyCross([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true);
  });

  it('is false for a shared endpoint, a T-junction and a collinear overlap', () => {
    expect(segmentsProperlyCross([0, 0], [2, 2], [2, 2], [4, 0])).toBe(false);
    expect(segmentsProperlyCross([0, 0], [2, 0], [1, 0], [1, 2])).toBe(false);
    expect(segmentsProperlyCross([0, 0], [4, 0], [1, 0], [3, 0])).toBe(false);
    expect(segmentsProperlyCross([0, 0], [1, 1], [2, 2], [3, 3])).toBe(false);
  });
});
