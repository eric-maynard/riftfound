# Region polygons

Hand-drawn scene boundaries. One file per continent-ish area, each a JSON array:

```json
[
  {
    "id": "r-bay-peninsula",
    "name": "Bay Area — Peninsula",
    "rings": [ [ [-122.26, 37.52], [-122.11, 37.52], [-122.11, 37.62], [-122.26, 37.62] ] ],
    "carriesSceneId": "s94af82a16f"
  }
]
```

Expected files: `americas.json`, `emea.json`, `apac.json`. A missing file is not
an error - the loader reads whatever `*.json` is here.

## The four rules

1. **Coordinates are `[longitude, latitude]`** - GeoJSON order, longitude first.
   The loader rejects any latitude outside [-90, 90] and says it looks swapped,
   because a swapped Paris (`[48.8, 2.3]`) is a valid coordinate in Somalia and
   would otherwise place stores in the wrong hemisphere silently.
2. **`id` is hand-chosen, `r-` prefixed, lowercase-kebab, and never derived from
   which stores fall in it.** It is the thing that must not move. Changing one is
   a rename a reader sees.
3. **`rings`: outer ring first, holes after.** Rings may be left open; the loader
   closes them. A hole must be inside its own outer ring.
4. **No two regions may overlap.** A store inside both is ambiguous, so the
   loader refuses the whole set and names the pair and the coordinate. Sharing a
   border is fine and expected - coincident vertices and collinear edges are not
   an overlap.

## `carriesSceneId`

Optional, and the migration path. Set it to the existing `sceneId` this polygon
succeeds and that id **becomes the region's published id**, so a shared
`?scene=` link, the stored `VENUE#` / `SCENE#` rows, every player profile and
every ladder row keep working. `id` stays as the durable name behind it.

It must look like an engine scene id: `s` then 10 hex digits. Two regions cannot
carry the same one.

Leave it out for a region that succeeds nothing; the region then publishes under
its own `id`.

## Antimeridian

A ring's longitude span must be at most 180°. A region that genuinely crosses
180° is written with **continuous** longitudes past the line - 177 → 183, not
177 → -177 - and the loader tests a query point at `lng`, `lng ± 360`, so a
store recorded at -179 is found by a ring authored at 181.

## Checking your work

```bash
cd scripts/metrics && ./region-coverage.sh          # local SQLite
cd scripts/metrics && ./region-coverage.sh --remote # production, read-only
```

It validates every file, then reports how many venues each region holds, how
many venues fell in no region (with their coordinates and the scene they are
filed under today), and which regions hold no store at all - which is the
visible symptom of a swap that stayed inside both coordinate ranges.
