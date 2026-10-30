#!/usr/bin/env python3
"""Build the scene map's basemap from Natural Earth, as geometry rather than tiles.

The map of scenes does not want street cartography - nobody picks a Riftbound
scene by looking at a park - and it does not want somebody else's tile quota
either (CARTO's keyless dark basemap now serves tiles reading "API KEY
REQUIRED"; OpenStreetMap's own policy asks heavy consumers to self-host). So
the basemap is static geometry we serve ourselves and draw in the app's
colours.

**It is tiered, and the tiers exist because one scale cannot do both jobs.**
The first version shipped Natural Earth 110m alone, and 110m is 1:110,000,000:
San Francisco Bay is 60km across and simply *is not in the file* - not
simplified away, absent. At the zoom where somebody picks a scene the coast was
a smooth line and San Francisco and San Jose were two dots in a blank field.
So:

  land-v1.json         110m countries. The world view. One fetch, always.
  places-v1.json       the ~240 cities Natural Earth labels at zoom 4 and below.
  detail/<x>_<y>.json  10m coastline, lakes, 10m admin-1 boundaries and the
                       other ~7,000 cities, clipped into 10-degree cells.

The cells are the whole trick: a global 10m land file is 775KB-1.6MB gzipped,
which is not a lazy fetch, it is a download. Clipped into 10-degree cells it is
~1.2MB on disk and **a metro view costs one or two cells** - 2-20KB gzipped -
because that is all that is on screen. This is one flat grid, deliberately: a
second level would be a tile pyramid, and if this map ever needs one then the
honest answer is a tile provider rather than a pyramid of our own.

Public domain (Natural Earth), so no key, no quota and no attribution
requirement. Inputs, which are not vendored - download them yourself:

  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces_lines.geojson

Usage:

  python3 scripts/build-basemap.py ne_110m_admin_0_countries.geojson \\
      ne_10m_land.geojson ne_10m_lakes.geojson \\
      ne_10m_populated_places_simple.geojson \\
      ne_10m_admin_1_states_provinces_lines.geojson public/basemap

Both tiers' **filenames are versioned**, for the reason `build-rankings-mark.py`
gives: `deploy.sh frontend` only invalidates `index.html`, so an asset that
changes without changing its name stays cached at the edge and in browsers.
Bump the suffix when the geometry changes, in the script and in
`components/SceneMap.tsx` together.
"""

from __future__ import annotations

import json
import math
import os
import sys

# --- World tier -------------------------------------------------------------

# Douglas-Peucker tolerance for the 110m outlines, in degrees. ~11km, which is
# below a pixel until zoom 6 and far below the generalisation 110m has already
# had. The detail tier takes over long before it would show.
WORLD_SIMPLIFY_DEG = 0.1
WORLD_COORD_DP = 2
# Rings smaller than this (bounding box, square degrees) are dropped from the
# world tier: at that scale they are specks, and the detail tier has them.
WORLD_MIN_RING_BOX = 0.08

# --- Detail tier ------------------------------------------------------------

# 10 degrees. Small enough that a metro view needs one or two cells, large
# enough that there are ~460 files rather than thousands.
CELL_DEG = 10

# ~220m. At zoom 12 that is six pixels and at zoom 9 it is one, so the coast
# stops being polygonal before anyone can see that it was. Tightening it to
# 0.001 doubles the payload for detail no view of a *scene* resolves.
DETAIL_SIMPLIFY_DEG = 0.002
DETAIL_COORD_DP = 3
# ~1.5km square. Keeps the islands a reader could name, drops the rocks.
DETAIL_MIN_RING_BOX = 0.0002

# Lakes down to this Natural Earth scale rank. 6 keeps the Great Lakes, Geneva,
# Constance, Biwa and the rest of the water people orient by; past it they are
# reservoirs that say nothing about where a scene plays.
LAKE_MAX_SCALERANK = 6

# Admin-1 boundaries down to this Natural Earth `MIN_ZOOM`.
#
# **10m, not 50m**, and that is a correction rather than a preference: Natural
# Earth's 50m admin-1 *lines* layer covers 111 of our 460 cells - the US,
# Canada, Brazil, Australia - and has **no German Länder, no French régions and
# no Japanese prefectures at all**, which are exactly the countries where this
# map is otherwise a featureless slab. The 10m layer is worldwide.
#
# It is also 10,179 features including every Slovenian municipality, so it is
# cut at zoom 7: states, provinces, Länder and prefectures stay, the parish
# boundaries go. 7 rather than 6 is forced by the data - Germany's 34 Länder
# and Japan's 111 prefectures are *all* at 7, and 6 drops both countries
# entirely, which is the opposite of the point.
ADMIN1_MAX_ZOOM = 7

# Boundaries are simplified five times harder than coastlines, because they are
# not coastlines: an administrative line is an abstraction that often follows a
# river nobody is checking against, and 1km of wobble in it is invisible where
# the same error in a bay is the bay. Measured on the Rhine-Main cell: 26KB
# gzipped down to 14KB, with no visible change to any Land boundary.
ADMIN1_SIMPLIFY_DEG = 0.01

# Places are split at Natural Earth's own `min_zoom`: 4 and below is the world
# tier, above it rides in the cells. Split rather than duplicated, so no label
# is ever drawn twice.
WORLD_PLACE_MAX_ZOOM = 4
DETAIL_PLACE_MAX_ZOOM = 10


def douglas_peucker(points: list[list[float]], tolerance: float) -> list[list[float]]:
    """Classic DP, iterative so a 10,000-point ring cannot blow the stack."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        ax, ay = points[first]
        bx, by = points[last]
        dx, dy = bx - ax, by - ay
        span = dx * dx + dy * dy
        worst, index = -1.0, -1
        for i in range(first + 1, last):
            px, py = points[i]
            if span == 0:
                distance = math.hypot(px - ax, py - ay)
            else:
                # Perpendicular distance to the segment, in degrees. Degrees are
                # not a distance, but this is a drawing tolerance rather than a
                # measurement and nothing is computed from the result.
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / span))
                distance = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if distance > worst:
                worst, index = distance, i
        if worst > tolerance and index > 0:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))
    return [point for point, kept in zip(points, keep) if kept]


def ring_box(ring: list[list[float]]) -> float:
    xs = [point[0] for point in ring]
    ys = [point[1] for point in ring]
    return (max(xs) - min(xs)) * (max(ys) - min(ys))


def tidy(points: list[list[float]], tolerance: float, places: int, close: bool):
    """Simplify, round, drop repeats - and close the ring if it is one."""
    simplified = douglas_peucker(points, tolerance)
    out: list[list[float]] = []
    for x, y in simplified:
        point = [round(x, places), round(y, places)]
        if not out or out[-1] != point:
            out.append(point)
    if close:
        if len(out) < 4:
            return None
        if out[0] != out[-1]:
            out.append(out[0])
    elif len(out) < 2:
        return None
    return out


def polygon_rings(path: str, outer_only: bool = False):
    """Every ring of every (multi)polygon, with the feature's properties."""
    with open(path, encoding='utf-8') as handle:
        source = json.load(handle)
    for feature in source['features']:
        geometry = feature.get('geometry') or {}
        kind = geometry.get('type')
        if kind == 'Polygon':
            parts = [geometry['coordinates']]
        elif kind == 'MultiPolygon':
            parts = geometry['coordinates']
        else:
            continue
        for part in parts:
            for index, ring in enumerate(part):
                if outer_only and index > 0:
                    continue
                yield feature['properties'], [[float(x), float(y)] for x, y in ring]


def line_strings(path: str, max_zoom: float | None = None):
    with open(path, encoding='utf-8') as handle:
        source = json.load(handle)
    for feature in source['features']:
        if max_zoom is not None:
            # Natural Earth spells this key upper-case in the admin-1 lines and
            # lower-case nearly everywhere else, so read both rather than
            # silently keeping all 10,179 features.
            properties = feature['properties']
            zoom = properties.get('MIN_ZOOM', properties.get('min_zoom'))
            if zoom is not None and float(zoom) > max_zoom:
                continue
        geometry = feature.get('geometry') or {}
        kind = geometry.get('type')
        if kind == 'LineString':
            parts = [geometry['coordinates']]
        elif kind == 'MultiLineString':
            parts = geometry['coordinates']
        else:
            continue
        for part in parts:
            yield [[float(x), float(y)] for x, y in part]


def clip_ring(ring, west, south, east, north):
    """Sutherland-Hodgman against the cell. Keeps a filled shape filled."""
    def inside(point, edge):
        if edge == 0:
            return point[0] >= west
        if edge == 1:
            return point[0] <= east
        if edge == 2:
            return point[1] >= south
        return point[1] <= north

    def cut(a, b, edge):
        ax, ay = a
        bx, by = b
        if edge in (0, 1):
            x = west if edge == 0 else east
            t = (x - ax) / (bx - ax)
            return [x, ay + t * (by - ay)]
        y = south if edge == 2 else north
        t = (y - ay) / (by - ay)
        return [ax + t * (bx - ax), y]

    out = ring
    for edge in range(4):
        if not out:
            return []
        source, out = out, []
        for i, current in enumerate(source):
            previous = source[i - 1]
            current_in, previous_in = inside(current, edge), inside(previous, edge)
            if current_in:
                if not previous_in:
                    out.append(cut(previous, current, edge))
                out.append(current)
            elif previous_in:
                out.append(cut(previous, current, edge))
    return out


def clip_line(line, west, south, east, north):
    """Split a line into the runs of it that lie inside the cell."""
    runs: list[list[list[float]]] = []
    current: list[list[float]] = []
    for point in line:
        if west <= point[0] <= east and south <= point[1] <= north:
            current.append(point)
        elif current:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    return runs


def cells_for(points, step: int):
    """Every cell key a shape's bounding box touches."""
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    x0 = int(math.floor(min(xs) / step)) * step
    x1 = int(math.floor(max(xs) / step)) * step
    y0 = int(math.floor(min(ys) / step)) * step
    y1 = int(math.floor(max(ys) / step)) * step
    for cx in range(x0, x1 + step, step):
        for cy in range(y0, y1 + step, step):
            yield cx, cy


def build_world_land(path: str) -> dict:
    polygons = []
    for _, ring in polygon_rings(path, outer_only=True):
        if ring_box(ring) < WORLD_MIN_RING_BOX:
            continue
        cleaned = tidy(ring, WORLD_SIMPLIFY_DEG, WORLD_COORD_DP, close=True)
        if cleaned:
            # Exterior ring only. A hole at this scale is Lesotho and the
            # Vatican; carrying every interior ring costs real bytes for a
            # difference no 400px map shows.
            polygons.append([cleaned])
    return {
        'type': 'Feature',
        'properties': {},
        'geometry': {'type': 'MultiPolygon', 'coordinates': polygons},
    }


def place_rows(path: str, low: int, high: int) -> list[list]:
    with open(path, encoding='utf-8') as handle:
        source = json.load(handle)
    rows = []
    for feature in source['features']:
        properties = feature['properties']
        name = properties.get('name') or properties.get('nameascii')
        if not name:
            continue
        raw_zoom = properties.get('min_zoom')
        zoom = 9 if raw_zoom is None else int(math.ceil(float(raw_zoom)))
        zoom = max(1, min(DETAIL_PLACE_MAX_ZOOM, zoom))
        if not (low < zoom <= high):
            continue
        longitude, latitude = feature['geometry']['coordinates'][:2]
        rows.append([name, round(float(latitude), 3), round(float(longitude), 3), zoom])
    rows.sort(key=lambda row: (row[3], row[0]))
    return rows


def write_json(path: str, payload) -> int:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, separators=(',', ':'), ensure_ascii=False)
    return os.path.getsize(path)


def main(argv: list[str]) -> int:
    if len(argv) != 7:
        print(__doc__)
        return 2
    countries, land10, lakes10, places10, admin1, out_dir = argv[1:7]

    # --- world tier ---
    world = build_world_land(countries)
    size = write_json(os.path.join(out_dir, 'land-v1.json'), world)
    print(f'land-v1.json       {size/1024:7.1f}KB  {len(world["geometry"]["coordinates"])} rings')

    world_places = place_rows(places10, 0, WORLD_PLACE_MAX_ZOOM)
    size = write_json(os.path.join(out_dir, 'places-v1.json'), {'places': world_places})
    print(f'places-v1.json     {size/1024:7.1f}KB  {len(world_places)} cities')

    # --- detail tier, clipped into cells ---
    cells: dict[tuple[int, int], dict[str, list]] = {}

    def cell(key):
        return cells.setdefault(key, {'land': [], 'water': [], 'lines': [], 'places': []})

    def add_rings(source_iter, bucket, min_box):
        for ring in source_iter:
            if ring_box(ring) < min_box:
                continue
            for key in cells_for(ring, CELL_DEG):
                piece = clip_ring(ring, key[0], key[1], key[0] + CELL_DEG, key[1] + CELL_DEG)
                if len(piece) < 4:
                    continue
                cleaned = tidy(piece, DETAIL_SIMPLIFY_DEG, DETAIL_COORD_DP, close=True)
                if cleaned:
                    cell(key)[bucket].append(cleaned)

    add_rings((ring for _, ring in polygon_rings(land10)), 'land', DETAIL_MIN_RING_BOX)
    add_rings(
        (
            ring
            for properties, ring in polygon_rings(lakes10, outer_only=True)
            if (properties.get('scalerank') if properties.get('scalerank') is not None else 99)
            <= LAKE_MAX_SCALERANK
        ),
        'water',
        DETAIL_MIN_RING_BOX,
    )

    for line in line_strings(admin1, max_zoom=ADMIN1_MAX_ZOOM):
        for key in cells_for(line, CELL_DEG):
            for run in clip_line(line, key[0], key[1], key[0] + CELL_DEG, key[1] + CELL_DEG):
                cleaned = tidy(run, ADMIN1_SIMPLIFY_DEG, DETAIL_COORD_DP, close=False)
                if cleaned:
                    cell(key)['lines'].append(cleaned)

    for row in place_rows(places10, WORLD_PLACE_MAX_ZOOM, DETAIL_PLACE_MAX_ZOOM):
        _, latitude, longitude, _ = row
        key = (
            int(math.floor(longitude / CELL_DEG)) * CELL_DEG,
            int(math.floor(latitude / CELL_DEG)) * CELL_DEG,
        )
        cell(key)['places'].append(row)

    total = 0
    biggest = []
    for key, payload in sorted(cells.items()):
        name = f'{key[0]}_{key[1]}-v1.json'
        size = write_json(os.path.join(out_dir, 'detail', name), payload)
        total += size
        biggest.append((size, name))
    biggest.sort(reverse=True)

    # The manifest, so the client knows which cells exist and never asks for an
    # ocean. One small fetch beside the world tier, rather than a 404 per pan.
    manifest = {
        'step': CELL_DEG,
        'cells': [f'{x}_{y}' for x, y in sorted(cells)],
    }
    size = write_json(os.path.join(out_dir, 'detail', 'manifest-v1.json'), manifest)
    print(f'detail/manifest    {size/1024:7.1f}KB  {len(cells)} cells')
    print(f'detail cells       {total/1024/1024:7.2f}MB total on disk')
    print('largest cells:', ', '.join(f'{name} {s/1024:.0f}KB' for s, name in biggest[:5]))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
