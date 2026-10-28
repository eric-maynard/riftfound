#!/usr/bin/env python3
"""Build the scene map's basemap from Natural Earth, as geometry rather than tiles.

The map of scenes does not want street cartography. Nobody picks a Riftbound
scene by looking at a park, and the raster basemap it used to draw cost 8-20
tile requests per pan from a third party, on a tile policy that asks heavy
consumers to self-host and that we were one business decision away from losing
(CARTO's keyless dark basemap now serves tiles reading "API KEY REQUIRED").

So the basemap is two small static assets we own, drawn by Leaflet as vectors:

  land-v1.json    coastlines and country outlines, one MultiPolygon
  places-v1.json  city labels, with the zoom each one earns its place at

Both are derived from Natural Earth, which is public domain and needs no
attribution. Inputs (download them yourself; they are not vendored):

  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson

Usage:

  python3 scripts/build-basemap.py ne_110m_admin_0_countries.geojson \\
      ne_50m_populated_places_simple.geojson public/basemap

Why these two scales. Countries at **110m** because the only question this
basemap answers is "where in the world am I" - at the pane's size a 50m
coastline is the same shape with four times the bytes. Places at **50m**
because the opposite is true of labels: 110m carries 243 cities, which leaves
most of the map unlabelled at the zooms where someone is actually looking for
their own scene, while 50m carries 1,251 and each one is ~30 bytes.

The output is deliberately not GeoJSON for places: a list of [name, lat, lng,
minZoom] rows is half the size of the same data wearing Feature wrappers, and
nothing downstream wants the geometry.

**The filenames are versioned** for the reason `build-rankings-mark.py` says:
`deploy.sh frontend` only invalidates `index.html`, so an asset that changes
without changing its name stays cached at the edge and in browsers. Bump the
suffix when the geometry changes.
"""

from __future__ import annotations

import json
import math
import os
import sys

# Douglas-Peucker tolerance in degrees. 0.1 deg is ~11km at the equator, which
# is below one pixel until about zoom 6 and is a generalisation Natural Earth
# has already made at 110m anyway. Measured: it takes the land file from 310KB
# to 118KB (35KB gzipped) with no visible change at the pane's size.
SIMPLIFY_DEG = 0.1

# Rings smaller than this (bounding-box degrees squared) are dropped. It is a
# box rather than a true area because the point is to lose specks, and the
# error of a box at this size is a fraction of a pixel. ~0.25 keeps Malta and
# Singapore's neighbours; it loses the uninhabited rocks.
MIN_RING_BOX = 0.08

# Two decimals is ~1.1km of longitude at the equator, which is finer than the
# simplification above and far finer than 110m Natural Earth's own geometry.
COORD_DP = 2

# Labels past this zoom are drawn from the venue pins instead: at zoom 9 a city
# label is pointing at something already under the reader's cursor.
MAX_LABEL_ZOOM = 9


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
                # not a distance, but this is a drawing tolerance and not a
                # measurement, and nothing is computed from the result.
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


def clean_ring(ring: list[list[float]]) -> list[list[float]] | None:
    """Simplify, round and close one ring, or None when nothing is left of it."""
    if ring_box(ring) < MIN_RING_BOX:
        return None
    simplified = douglas_peucker([[float(x), float(y)] for x, y in ring], SIMPLIFY_DEG)
    rounded: list[list[float]] = []
    for x, y in simplified:
        point = [round(x, COORD_DP), round(y, COORD_DP)]
        if not rounded or rounded[-1] != point:
            rounded.append(point)
    if len(rounded) < 4:
        return None
    if rounded[0] != rounded[-1]:
        rounded.append(rounded[0])
    return rounded


def build_land(path: str) -> dict:
    with open(path, encoding='utf-8') as handle:
        source = json.load(handle)

    polygons: list[list[list[list[float]]]] = []
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
            # Exterior ring only. A hole at this scale is Lesotho and the
            # Vatican; the cost of carrying every interior ring is real and the
            # visual difference at a 400px map is not.
            outer = clean_ring(part[0])
            if outer is not None:
                polygons.append([outer])

    return {
        'type': 'Feature',
        'properties': {},
        'geometry': {'type': 'MultiPolygon', 'coordinates': polygons},
    }


def build_places(path: str) -> dict:
    with open(path, encoding='utf-8') as handle:
        source = json.load(handle)

    rows: list[list] = []
    for feature in source['features']:
        properties = feature['properties']
        name = properties.get('name') or properties.get('nameascii')
        if not name:
            continue
        longitude, latitude = feature['geometry']['coordinates'][:2]
        # Natural Earth's own `min_zoom` is calibrated for web mercator and is
        # exactly the thinning this needs: it is why the world view shows
        # ~30 capitals rather than 1,251 overlapping labels.
        min_zoom = properties.get('min_zoom')
        if min_zoom is None:
            min_zoom = 7
        zoom = max(1, min(MAX_LABEL_ZOOM, int(math.ceil(float(min_zoom)))))
        rows.append([name, round(float(latitude), 3), round(float(longitude), 3), zoom])

    # Biggest first, so a renderer that caps the count keeps the useful ones.
    rows.sort(key=lambda row: (row[3], row[0]))
    return {'places': rows}


def write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, separators=(',', ':'), ensure_ascii=False)
    print(f'{path}  {os.path.getsize(path) / 1024:.1f}KB')


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__)
        return 2
    countries, places, out_dir = argv[1], argv[2], argv[3]
    land = build_land(countries)
    print(f'land rings: {len(land["geometry"]["coordinates"])}')
    write_json(os.path.join(out_dir, 'land-v1.json'), land)
    city_rows = build_places(places)
    print(f'places: {len(city_rows["places"])}')
    write_json(os.path.join(out_dir, 'places-v1.json'), city_rows)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
