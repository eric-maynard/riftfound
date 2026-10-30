import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { SceneMapEntry } from '../types/ranking';
import {
  sceneBounds,
  sceneDotRadius,
  sceneFocusBounds,
  sceneLabel,
  sceneSpreadRadiusMeters,
  WORLD_VIEW,
} from '../lib/sceneMap';

/**
 * The map canvas. Pins only - every word about a scene is the page's job.
 *
 * ## Why Leaflet
 *
 * 42KB gzipped, no token, no WebGL, and SVG markers React can hand it
 * directly - against Mapbox GL JS's ~800KB and a client-side token the
 * frontend does not currently carry at all (there is no `import.meta.env` use
 * anywhere in `src/`, and the Mapbox token is server-side, used by the
 * geocoder behind `/api/events/geocode`). Nothing here needs vector tiles,
 * 3D, or a style editor; it needs ~1,200 circles on a basemap.
 *
 * ## Why there are no tiles
 *
 * The basemap is **geometry we serve ourselves**: coastlines as one
 * MultiPolygon and city names as labels, both built from Natural Earth by
 * `scripts/build-basemap.py` into `public/basemap/`. It used to be
 * OpenStreetMap's raster tiles under a CSS `invert()`, and every part of that
 * was wrong for this map:
 *
 * - **the detail was not ours to want.** Roads, landuse and buildings, on a map
 *   whose only question is which of 1,286 dots is the reader's scene. You
 *   cannot accidentally ship a road when the only things on the map are the
 *   things you drew.
 * - **it was somebody else's quota.** 8-20 tile requests per pan from a third
 *   party, on a usage policy that asks heavy consumers to self-host. CARTO's
 *   keyless dark basemap - the first choice here - now serves tiles reading
 *   "API KEY REQUIRED" across every one of them, and any keyless CDN basemap
 *   is one business decision away from the same. Two static JSON files on our
 *   own CloudFront have no such cliff: ~40KB and ~17KB gzipped, fetched once
 *   and cached, against a per-pan tile bill forever.
 * - **it had to be fought into the theme.** The app is dark throughout and
 *   there is no keyless dark OSM raster, so the tiles were inverted and
 *   hue-rotated in CSS - a filter that also had to be kept off the markers so
 *   their measured contrast survived. Our own geometry is simply drawn in the
 *   app's own tokens.
 *
 * Natural Earth is public domain, so none of this needs a licence or a key.
 *
 * `VITE_MAP_TILE_URL` is still honoured and is now the **escape hatch rather
 * than the plan**: set it and this draws raster tiles instead, which is the
 * route to a minimal Mapbox style if the geometry ever proves too bare. That
 * reintroduces a key and a per-request bill, so it is a decision to take
 * deliberately.
 *
 * At high zoom there is no local detail, because there is no imagery and
 * nothing is invented to fill the gap. That is the correct trade here: the
 * venue pins carry the local context, and a scene is picked by where it is in
 * the world rather than by which street it plays on.
 *
 * ## The two radii
 *
 * Each scene is drawn twice, and the distinction is the whole correctness
 * argument (see `lib/sceneMap.ts`):
 *
 * - a **ground disc** whose radius is the scene's real `spreadKm`. It scales
 *   with zoom because it is a distance, and it is absent for a single-venue
 *   scene, which genuinely has no extent.
 * - a **pixel dot** sized by player count. It does *not* scale with zoom,
 *   because a count is not a distance. Drawing population as a ground radius
 *   is how a map like this starts claiming a 4,654-player scene covers a
 *   continent.
 *
 * Venue pins are drawn for the selected scene only, so a zoomed-in reader sees
 * the actual stores rather than one disc over a city, and a zoomed-out one is
 * not given 6,000 dots.
 *
 * Leaflet is imperative and owns its DOM, so this component is a thin
 * imperative shell: one map instance for its lifetime, and layers rebuilt in
 * effects keyed on the data. React never renders a child into the container.
 */

/**
 * Raster tiles, when something sets `VITE_MAP_TILE_URL`. Unset - the default -
 * the basemap is the geometry below. See the component note.
 */
const TILE_URL = import.meta.env.VITE_MAP_TILE_URL ?? null;
const TILE_ATTRIBUTION = import.meta.env.VITE_MAP_TILE_ATTRIBUTION ?? '';

/**
 * The basemap assets, versioned in their filenames because `deploy.sh frontend`
 * only invalidates `index.html` - an asset that changes without changing its
 * name stays cached at the edge and in browsers.
 *
 * Fetched at runtime rather than imported, and that is load-bearing: an
 * `import` of a JSON file is inlined by Rollup into whichever chunk imports it,
 * which would put 119KB of coastline into a JavaScript bundle and re-download
 * it on every deploy. As a fetch it is a static file with its own cache entry,
 * and it stays out of the bundle entirely.
 */
const BASEMAP_BASE = `${import.meta.env.BASE_URL}basemap/`;
const LAND_URL = `${BASEMAP_BASE}land-v1.json`;
const PLACES_URL = `${BASEMAP_BASE}places-v1.json`;
const MANIFEST_URL = `${BASEMAP_BASE}detail/manifest-v1.json`;
const cellUrl = (key: string) => `${BASEMAP_BASE}detail/${key}-v1.json`;

/** `[name, latitude, longitude, minimum zoom]` - see `scripts/build-basemap.py`. */
type PlaceRow = [string, number, number, number];
type Ring = [number, number][];

interface Basemap {
  land: unknown;
  places: PlaceRow[];
}

/**
 * One 10-degree cell of the detail tier: 10m coastline, the lakes big enough
 * to orient by, admin-1 boundaries, and the ~7,000 cities too small for the
 * world tier.
 */
interface DetailCell {
  land: Ring[];
  water: Ring[];
  lines: Ring[];
  places: PlaceRow[];
}

/**
 * The zoom at which the world tier stops carrying information.
 *
 * Chosen by looking rather than by taste. Natural Earth 110m is 1:110,000,000:
 * San Francisco Bay is 60km end to end and is **not in that file at all** - not
 * simplified away, absent - and the same goes for Puget Sound, the Thames
 * estuary and the Singapore strait. Around zoom 5 that starts to show as a
 * coast that is too smooth to be anywhere; by 6 it is a lie. So 6 is where the
 * cells take over, which is also around where a reader has stopped looking at
 * continents and started looking for their own city.
 */
const DETAIL_ZOOM = 6;

/** Cell size in degrees. Must match `CELL_DEG` in scripts/build-basemap.py. */
const CELL_DEG = 10;

/** One fetch per page load, shared by both maps that can exist in it. */
let basemapRequest: Promise<Basemap> | null = null;
/** Which cells exist, so a view over the Pacific asks for nothing. */
let manifestRequest: Promise<Set<string>> | null = null;
/** Cells already fetched, by key. Lives for the page, not the component. */
const cellCache = new Map<string, Promise<DetailCell>>();

function loadBasemap(): Promise<Basemap> {
  if (!basemapRequest) {
    basemapRequest = Promise.all([
      fetch(LAND_URL).then((response) => response.json()),
      fetch(PLACES_URL).then((response) => response.json()),
    ])
      .then(([land, places]) => ({ land, places: (places.places ?? []) as PlaceRow[] }))
      .catch((error: unknown) => {
        // A map with no coastline is a map with pins on a blank field, which is
        // degraded but still usable - and the next mount retries.
        basemapRequest = null;
        throw error;
      });
  }
  return basemapRequest;
}

function loadManifest(): Promise<Set<string>> {
  if (!manifestRequest) {
    manifestRequest = fetch(MANIFEST_URL)
      .then((response) => response.json())
      .then((body) => new Set<string>(body.cells ?? []))
      .catch((error: unknown) => {
        manifestRequest = null;
        throw error;
      });
  }
  return manifestRequest;
}

function loadCell(key: string): Promise<DetailCell> {
  let request = cellCache.get(key);
  if (!request) {
    request = fetch(cellUrl(key))
      .then((response) => response.json())
      .then((body) => ({
        land: body.land ?? [],
        water: body.water ?? [],
        lines: body.lines ?? [],
        places: body.places ?? [],
      }))
      .catch((error: unknown) => {
        cellCache.delete(key);
        throw error;
      });
    cellCache.set(key, request);
  }
  return request;
}

/** The cell keys a view covers. One or two at a metro zoom, a handful at 6. */
function cellsForBounds(bounds: L.LatLngBounds): string[] {
  const west = Math.floor(Math.max(-180, bounds.getWest()) / CELL_DEG) * CELL_DEG;
  const east = Math.floor(Math.min(179.999, bounds.getEast()) / CELL_DEG) * CELL_DEG;
  const south = Math.floor(Math.max(-90, bounds.getSouth()) / CELL_DEG) * CELL_DEG;
  const north = Math.floor(Math.min(89.999, bounds.getNorth()) / CELL_DEG) * CELL_DEG;
  const keys: string[] = [];
  // A view wider than the world would otherwise ask for every cell there is;
  // past about 36 cells it is a world view and the world tier is the answer.
  if ((east - west) / CELL_DEG > 36) return keys;
  for (let x = west; x <= east; x += CELL_DEG) {
    for (let y = south; y <= north; y += CELL_DEG) {
      keys.push(`${x}_${y}`);
    }
  }
  return keys;
}

/**
 * The basemap's own colours, in the app's palette.
 *
 * Land is `--color-bg-tertiary` on a `--color-bg` sea: the same two surfaces
 * the rest of the section is built from, so the markers keep the contrast they
 * were measured at (the event chips' `#bd93f9` is 4.67:1 on `#363b43`). The
 * coastline is `--color-border`, which is the token for a hairline that is not
 * text. City labels are `--color-text-muted`, 7.22:1 on the land fill.
 */
const COLOR_LAND = '#3a4150';
const COLOR_COAST = '#7684b5';
/** The sea, matching `.scene-map`'s own background so a lake reads as water. */
const COLOR_SEA = '#21222c';
/** Admin-1 boundaries: the same hairline token the rest of the app uses. */
const COLOR_BORDER = '#6272a4';

/**
 * Labels drawn at once, most prominent first. A cap, not a target.
 *
 * Raised from 90 with the detail tier: "which dot is San Francisco and which
 * is San Jose" is a *labelling* question as much as a coastline one, and the
 * cities that answer it are exactly the ones a tight cap drops. The viewport
 * filter does most of the thinning - this is the backstop for a wide view over
 * somewhere dense, like the Ruhr or the Kanto plain.
 */
const MAX_LABELS = 140;

/**
 * Marker colours, from the app's own palette.
 *
 * `--color-purple` for a scene whose board can be ordered and
 * `--color-text-muted` for one that cannot, which is the same distinction the
 * ladder draws between a position and a dash - and it is never the only
 * signal: the selected scene gets a ring, and the panel beside the map spells
 * the reason out in words. The spread disc is the same hue at low opacity, so
 * it reads as belonging to its dot rather than as a second datum.
 */
const COLOR_COMPARABLE = '#bd93f9';
const COLOR_SMALL = '#a0aede';
const COLOR_SELECTED = '#8be9fd';
const COLOR_VENUE = '#ff79c6';
/**
 * The pointed-at scene. The page's lightest ink, which is deliberately *not*
 * one of the hues above: a highlight is a transient "this one", and reusing the
 * selected cyan or the comparable purple would make a hover look like a state.
 * It is never the only signal either - the matching row lights up at the same
 * time, and the marker grows.
 */
const COLOR_HIGHLIGHT = '#f8f8f2';
const HIGHLIGHT_GROWTH = 3;

interface SceneMapProps {
  /** Scenes with a publishable pin. These are the only ones that get a dot. */
  scenes: SceneMapEntry[];
  /**
   * The selected scene, whichever list it came from.
   *
   * Passed in rather than looked up in `scenes`, because a **dispersed** scene
   * is deliberately not in `scenes` - it has no honest pin - and yet its
   * venues are exactly what the map should show when a reader asks about it.
   */
  selected: SceneMapEntry | null;
  selectedId: string | null;
  onSelect: (componentId: string | null) => void;
  /**
   * The scene to emphasise without selecting it - the other half of the scene
   * picker's split pane talking to this one. Null when nothing is pointed at.
   *
   * Emphasis is applied by restyling the one marker rather than by rebuilding
   * the layer: there are 1,286 of them, and a hover that rebuilt all of them
   * would make the pane feel broken.
   */
  highlightedId?: string | null;
  /**
   * Called as the pointer enters and leaves a pin, so the list beside the map
   * can light the matching row. Omitted on the map page, which has no such
   * list; the venue layer and the tooltips are unaffected either way.
   */
  onHighlight?: (componentId: string | null) => void;
  /**
   * Which surface this canvas is drawn on. Four behaviours hang off it, and
   * all four are about the difference between a page about every scene and a
   * canvas inside a filter control (`SceneSelect`'s pane):
   *
   * - **the first frame.** `page` fits the whole corpus once, because its
   *   question is "where are the scenes". `mini` frames the *selected* scene
   *   when there is one, because its question is "is this the one I meant" -
   *   and a 1,286-pin world view in a thumbnail answers neither.
   * - **refitting.** `mini` refits whenever the `scenes` array changes, because
   *   in the pane that array *is* the search result: typing `berlin` should
   *   take the map to Berlin, the way the list goes to Berlin. `page` fits once
   *   and then the view belongs to the reader.
   * - **the wheel.** `mini` starts with `scrollWheelZoom` off and turns it on
   *   when the reader clicks into the map, off again when focus leaves. A short
   *   map in the middle of a scrolling page must not swallow the page's scroll;
   *   a reader who has clicked into it is asking to zoom.
   * - **the chrome.** `.scene-map.is-mini` is shorter and sets its own type
   *   scale for Leaflet's attribution.
   *
   * Everything else - the two radii, the colours, the venue layer, the
   * tooltips, the click-to-clear - is identical by construction, because one
   * map drawn two sizes is the point and a second copy of this file would
   * drift from it within a release.
   */
  variant?: 'page' | 'mini';
}

function SceneMap({
  scenes,
  selected,
  selectedId,
  onSelect,
  highlightedId = null,
  onHighlight,
  variant = 'page',
}: SceneMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  /**
   * The map instance, and with it the one place its view lives: anything that
   * ever needs to ask "what is on screen" - a future "scope the ladder to this
   * area", say - reads `map.current.getBounds()` and `getZoom()` here rather
   * than keeping a second copy of the view in React state.
   */
  const map = useRef<L.Map | null>(null);
  const landLayer = useRef<L.LayerGroup | null>(null);
  /** The 10m tier, drawn over the world tier and in place of it once loaded. */
  const detailLayer = useRef<L.LayerGroup | null>(null);
  const labelLayer = useRef<L.LayerGroup | null>(null);
  const sceneLayer = useRef<L.LayerGroup | null>(null);
  const venueLayer = useRef<L.LayerGroup | null>(null);
  /** Whether the view has already been fitted, so a selection does not refit. */
  const fitted = useRef(false);
  /** The scenes the view was last fitted to, so only a *new* set refits it. */
  const fittedTo = useRef<SceneMapEntry[] | null>(null);
  /** The box of that fit, so a container resize can re-apply it. */
  const fittedBounds = useRef<[[number, number], [number, number]] | null>(null);
  /** Whether the reader has dragged. After that the view is theirs. */
  const userMoved = useRef(false);
  /**
   * Every drawn dot by scene id, with the style it was drawn with, so the
   * highlight can lift one marker and put it back without touching the rest.
   */
  const dots = useRef(new Map<string, { dot: L.CircleMarker; radius: number; stroke: string; weight: number }>());
  /** Which marker is currently lifted, so it can be put back. */
  const lifted = useRef<string | null>(null);
  /**
   * Set when a click *on this map* made the current selection, so the framing
   * effect below can tell "the reader clicked that pin" from "the selection
   * changed somewhere else". Flying to a dot the reader just clicked moves the
   * ground under their finger for no information; flying to a scene chosen
   * elsewhere - a dispersed scene off the chip list, or a `?region=` arriving
   * in the URL - is the only way the map shows it at all.
   */
  const selfSelected = useRef(false);

  // One map for the component's lifetime. Rebuilding it on every data change
  // would reset the reader's pan and zoom, which on a world map is the whole
  // interaction.
  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = L.map(container.current, {
      center: [WORLD_VIEW.lat, WORLD_VIEW.lng],
      zoom: WORLD_VIEW.zoom,
      // The corpus spans three continents - California to Singapore to
      // Australia - so a reader panning west out of the Pacific should arrive
      // in Asia rather than at the edge of the world.
      worldCopyJump: true,
      // Deliberately no `maxBounds`. Clamping latitude to the Mercator range
      // means an infinite longitude bound, which Leaflet projects to NaN and
      // which breaks panning rather than limiting it. Over-dragging past the
      // poles is a cosmetic annoyance; a map that will not pan is not.
      attributionControl: true,
      // See `variant`: a short map inside a scrolling column must not eat the
      // page's scroll before the reader has asked it to.
      scrollWheelZoom: variant !== 'mini',
    });

    // ...and asking is clicking into it. Leaflet fires `focus` on a click or a
    // tab into the container, so this is its own notion of "engaged" rather
    // than a hover test, which would arm the wheel for a pointer merely
    // passing over on the way down the page.
    if (variant === 'mini') {
      instance.on('focus', () => instance.scrollWheelZoom.enable());
      instance.on('blur', () => instance.scrollWheelZoom.disable());
    }

    /* Two panes under the markers, so the basemap cannot end up on top of the
       scenes. Layer order inside one pane is insertion order, and the land
       arrives from a fetch *after* the scene layer has been created - without
       its own pane it would be drawn over every pin. Neither pane takes
       pointer events: a click on the sea is a click on the map, not on a
       country. */
    instance.createPane('basemapWorld').style.zIndex = '200';
    instance.createPane('basemapDetail').style.zIndex = '210';
    instance.createPane('basemapLabels').style.zIndex = '250';
    for (const name of ['basemapWorld', 'basemapDetail', 'basemapLabels']) {
      const pane = instance.getPane(name);
      if (pane) pane.style.pointerEvents = 'none';
    }

    if (TILE_URL) {
      // The escape hatch: raster tiles when something configures them.
      L.tileLayer(TILE_URL, {
        attribution: TILE_ATTRIBUTION,
        maxZoom: 18,
        detectRetina: false,
      }).addTo(instance);
    } else {
      instance.attributionControl.addAttribution('Natural Earth');
    }

    landLayer.current = L.layerGroup([], { pane: 'basemapWorld' }).addTo(instance);
    detailLayer.current = L.layerGroup([], { pane: 'basemapDetail' }).addTo(instance);
    labelLayer.current = L.layerGroup([], { pane: 'basemapLabels' }).addTo(instance);
    sceneLayer.current = L.layerGroup().addTo(instance);
    venueLayer.current = L.layerGroup().addTo(instance);

    map.current = instance;

    // Once the reader has dragged, the view is theirs and nothing below may
    // take it back.
    instance.on('dragstart', () => {
      userMoved.current = true;
    });

    /* Leaflet measures its container once, at construction, and this one is
       inside a popover inside a grid: its final width can arrive a frame
       later, and a map that measured itself at the wrong size draws into a
       corner and - worse - keeps a centre and zoom chosen for a viewport that
       never existed, which is how a fit to every pin ends up showing the
       Atlantic. So the element is watched, and a resize re-applies the last
       fit unless the reader has since taken the view over. */
    const resize = new ResizeObserver(() => {
      instance.invalidateSize({ animate: false });
      if (userMoved.current || !fittedBounds.current) return;
      instance.fitBounds(fittedBounds.current, { padding: [16, 16], maxZoom: 10 });
    });
    resize.observe(container.current);

    return () => {
      resize.disconnect();
      instance.remove();
      map.current = null;
      landLayer.current = null;
      detailLayer.current = null;
      labelLayer.current = null;
      sceneLayer.current = null;
      venueLayer.current = null;
      fitted.current = false;
    };
    // No dependencies at all, deliberately: anything in this list would tear
    // the map down and rebuild it on a re-render, losing the reader's pan and
    // zoom. The basemap click handler is bound in its own effect below so it
    // can follow a changing callback without that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /*
   * The basemap, in two tiers.
   *
   * **World tier**: 110m country outlines and the ~240 cities Natural Earth
   * labels at zoom 4 and below. One fetch, kept for the life of the page,
   * right for a view of continents.
   *
   * **Detail tier**: 10m coastline, lakes, admin-1 boundaries and the other
   * ~7,000 cities, clipped into 10-degree cells and fetched **only for the
   * cells on screen**, and only past `DETAIL_ZOOM`. A global 10m land file is
   * 775KB-1.6MB gzipped, which is a download rather than a lazy fetch; the
   * same geometry cut into cells costs 2-20KB for the one or two a metro view
   * actually shows.
   *
   * The two tiers must not be drawn at once, and that is not a performance
   * nicety: where 110m says land and 10m says water - San Francisco Bay,
   * Puget Sound, the Zuiderzee - the coarse fill would show straight through
   * the gap the detail tier exists to open. So the world layer is **removed**
   * as soon as every cell covering the view is in hand, and put back the
   * moment the reader zooms out or pans somewhere that has not loaded yet.
   *
   * Labels are drawn per view from both tiers together, each city carrying the
   * zoom it earns its place at (`min_zoom`), so the world view gets ~20 and a
   * metro view gets the cities around it rather than a soup.
   *
   * Nothing here is interactive. A label is orientation, not a target: these
   * are cities, and the only clickable things on this map are scenes.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance || TILE_URL) return;
    let live = true;

    /** Cells drawn into the detail layer already, so a pan redraws nothing. */
    const drawn = new Set<string>();
    /** Every city in hand, world tier plus the cells loaded so far. */
    let places: PlaceRow[] = [];
    let manifest: Set<string> | null = null;

    const drawLabels = () => {
      const layer = labelLayer.current;
      if (!layer || !live) return;
      layer.clearLayers();
      // Natural Earth cuts `min_zoom` for a full-screen map, so this adds one
      // level - in a 380px pane the unadjusted rule leaves whole continents
      // blank, and a label is the only thing on this basemap a reader can
      // orient by. The floor of 2 is what keeps the world view from having no
      // labels at all: fitted to a corpus spanning California to Singapore,
      // this map opens at zoom 0 or 1, below every tier Natural Earth has.
      const zoom = Math.max(2, instance.getZoom() + 1);
      const bounds = instance.getBounds();
      const candidates = places
        .filter(([, latitude, longitude, minZoom]) => {
          if (minZoom > zoom) return false;
          return bounds.contains([latitude, longitude]);
        })
        // Most prominent first, so both the collision filter below and the cap
        // keep the cities worth keeping.
        .sort((a, b) => a[3] - b[3]);

      /* Label collision, which the zoom tiers alone do not solve: over the
         Rhine-Main or the Kanto plain, Natural Earth's `min_zoom` lets thirty
         cities through at one zoom and they overprint each other into a grey
         smear - measured, 37 labels in a 350px pane with Nürnberg sitting on
         Fürth. So a label is drawn only where it does not land on one already
         placed, taking the more prominent city first. The box is the drawn
         text's rough size at this font rather than the dot's: the dot is 3px
         and the name beside it is what actually overlaps. */
      const placed: [number, number][] = [];
      const visible: PlaceRow[] = [];
      for (const row of candidates) {
        if (visible.length >= MAX_LABELS) break;
        const point = instance.latLngToContainerPoint([row[1], row[2]]);
        if (placed.some(([x, y]) => Math.abs(x - point.x) < 66 && Math.abs(y - point.y) < 13)) {
          continue;
        }
        placed.push([point.x, point.y]);
        visible.push(row);
      }

      for (const [name, latitude, longitude] of visible) {
        L.marker([latitude, longitude], {
          interactive: false,
          keyboard: false,
          pane: 'basemapLabels',
          // A dot and its name, as one icon: a floating name says nothing
          // about *where* it is, and two layers would be two things to keep in
          // step. The anchor is the dot, so the name sits to its right.
          icon: L.divIcon({
            className: 'scene-map-place',
            html: `<span class="scene-map-place-dot"></span><span class="scene-map-place-name"></span>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
        })
          .addTo(layer)
          // Set as text rather than interpolated into the HTML above: these
          // names come from a file we build, but a basemap is exactly the kind
          // of asset that gets swapped for someone else's one day.
          .getElement()
          ?.querySelector('.scene-map-place-name')
          ?.appendChild(document.createTextNode(name));
      }
    };

    const drawCell = (key: string, data: DetailCell) => {
      const layer = detailLayer.current;
      if (!layer || !live || drawn.has(key)) return;
      drawn.add(key);
      for (const ring of data.land) {
        L.polygon(ring.map(([x, y]) => [y, x] as [number, number]), {
          pane: 'basemapDetail',
          interactive: false,
          color: COLOR_COAST,
          weight: 0.7,
          opacity: 0.85,
          fillColor: COLOR_LAND,
          fillOpacity: 1,
        }).addTo(layer);
      }
      // Lakes, drawn in the sea's colour over the land they sit in. Without
      // them a 10m coastline puts Toronto and Chicago in the middle of a
      // featureless slab.
      for (const ring of data.water) {
        L.polygon(ring.map(([x, y]) => [y, x] as [number, number]), {
          pane: 'basemapDetail',
          interactive: false,
          color: COLOR_COAST,
          weight: 0.5,
          opacity: 0.6,
          fillColor: COLOR_SEA,
          fillOpacity: 1,
        }).addTo(layer);
      }
      /* Admin-1 boundaries - states, provinces, Länder - which are what makes
         "which of these dots is in California" answerable at all, and the only
         thing on the basemap inside a large country.

         Secondary to the coast by **pattern**, not by visibility: the first
         version drew them as a 0.5px hairline at 0.55 opacity in the border
         token, which on the land fill was a line nobody could see, and an
         invisible line is not a subtle one. Same hue as the coast, dashed, a
         shade lighter in weight. */
      for (const line of data.lines) {
        L.polyline(line.map(([x, y]) => [y, x] as [number, number]), {
          pane: 'basemapDetail',
          interactive: false,
          color: COLOR_BORDER,
          weight: 0.9,
          opacity: 0.8,
          dashArray: '5 4',
        }).addTo(layer);
      }
      if (data.places.length > 0) places = places.concat(data.places);
    };

    /**
     * Whether the detail tier covers what is on screen - and therefore whether
     * the coarse world layer has to go, so its filled-in bays stop showing
     * through. A cell the manifest does not list is open ocean: nothing to
     * load and nothing missing.
     */
    const detailCovers = (keys: string[]) =>
      manifest !== null && keys.every((key) => drawn.has(key) || !manifest!.has(key));

    const syncWorldLayer = (covered: boolean) => {
      const layer = landLayer.current;
      if (!layer) return;
      const shown = instance.hasLayer(layer);
      if (covered && shown) instance.removeLayer(layer);
      else if (!covered && !shown) instance.addLayer(layer);
    };

    const refresh = () => {
      if (!live) return;
      const zoom = instance.getZoom();
      if (zoom < DETAIL_ZOOM || manifest === null) {
        syncWorldLayer(false);
        drawLabels();
        return;
      }
      const keys = cellsForBounds(instance.getBounds()).filter((key) => manifest!.has(key));
      const missing = keys.filter((key) => !drawn.has(key));
      syncWorldLayer(detailCovers(keys));
      drawLabels();
      if (missing.length === 0) return;
      Promise.all(
        missing.map((key) =>
          loadCell(key)
            .then((data) => drawCell(key, data))
            .catch(() => {
              // One cell short is a patch of missing coast, not a broken map.
            })
        )
      ).then(() => {
        if (!live) return;
        syncWorldLayer(detailCovers(cellsForBounds(instance.getBounds()).filter((key) => manifest!.has(key))));
        drawLabels();
      });
    };

    loadBasemap()
      .then((basemap) => {
        if (!live) return;
        const layer = landLayer.current;
        if (layer) {
          L.geoJSON(basemap.land as Parameters<typeof L.geoJSON>[0], {
            pane: 'basemapWorld',
            interactive: false,
            style: {
              color: COLOR_COAST,
              weight: 0.7,
              opacity: 0.85,
              fillColor: COLOR_LAND,
              fillOpacity: 1,
            },
          }).addTo(layer);
        }
        places = basemap.places;
        drawLabels();
        return loadManifest();
      })
      .then((cells) => {
        if (!live || !cells) return;
        manifest = cells;
        refresh();
      })
      .catch(() => {
        // Pins on a blank field. Degraded, not broken, and not worth a banner
        // on a control whose job is picking a scene from a list.
      });

    instance.on('moveend zoomend', refresh);
    return () => {
      live = false;
      instance.off('moveend zoomend', refresh);
    };
  }, []);

  // Clicking the basemap clears the selection - the only way out of a scene's
  // panel without hunting for a close button. Its own effect so the handler
  // tracks the current `onSelect` without recreating the map.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const handler = () => {
      selfSelected.current = true;
      onSelect(null);
    };
    instance.on('click', handler);
    return () => {
      instance.off('click', handler);
    };
  }, [onSelect]);

  // The scene layer: one disc and one dot per located scene.
  useEffect(() => {
    const instance = map.current;
    const layer = sceneLayer.current;
    if (!instance || !layer) return;

    layer.clearLayers();
    dots.current.clear();
    lifted.current = null;

    const maxPlayers = scenes.reduce((most, scene) => Math.max(most, scene.playerCount), 1);
    // Smallest last, so a tiny scene inside a big one's disc is still
    // clickable. Leaflet draws in insertion order.
    const ordered = [...scenes].sort((a, b) => b.playerCount - a.playerCount);

    for (const scene of ordered) {
      if (scene.latitude === null || scene.longitude === null) continue;
      const position: L.LatLngExpression = [scene.latitude, scene.longitude];
      const selected = scene.componentId === selectedId;
      const colour = selected ? COLOR_SELECTED : scene.comparable ? COLOR_COMPARABLE : COLOR_SMALL;

      // The ground disc: a real distance, so metres and no stroke weight that
      // would read as a boundary. Non-interactive, so it never steals a click
      // from the dot inside it.
      const spread = sceneSpreadRadiusMeters(scene);
      if (spread !== null) {
        L.circle(position, {
          radius: spread,
          color: colour,
          weight: 1,
          opacity: 0.35,
          fillColor: colour,
          fillOpacity: 0.08,
          interactive: false,
        }).addTo(layer);
      }

      // The dot: a count, in pixels, at every zoom.
      const radius = sceneDotRadius(scene.playerCount, maxPlayers);
      const stroke = selected ? COLOR_SELECTED : '#21222c';
      const weight = selected ? 3 : 1;
      const dot = L.circleMarker(position, {
        radius,
        color: stroke,
        weight,
        fillColor: colour,
        fillOpacity: 0.85,
      });
      dots.current.set(scene.componentId, { dot, radius, stroke, weight });
      // The tooltip is the name alone. Everything else about the scene is in
      // the panel, which is reachable by keyboard and readable by a screen
      // reader; a tooltip is neither.
      dot.bindTooltip(sceneLabel(scene), { direction: 'top' });
      dot.on('click', (event) => {
        // Otherwise the map's own click handler clears the selection the dot
        // just made.
        L.DomEvent.stopPropagation(event);
        selfSelected.current = true;
        onSelect(scene.componentId);
      });
      if (onHighlight) {
        dot.on('mouseover', () => onHighlight(scene.componentId));
        dot.on('mouseout', () => onHighlight(null));
      }
      dot.addTo(layer);
    }

    // Fit to the pins we actually got. The corpus is not where anyone would
    // guess - the largest scene is Singapore - so a fixed default view opens on
    // an empty ocean for most of it.
    //
    // *When* to refit is the whole of the difference between the two surfaces.
    // The page fits once and the view is then the reader's: refitting on every
    // data change would yank it out from under them mid-pan. In the picker's
    // pane the `scenes` array is the search result, so a new array means the
    // reader has typed, and following the typing is the point - but a new
    // *selection* or a hover must not move anything, which is why this tests
    // the array's identity rather than simply running.
    //
    // Skipped on a mini map that already has a scene to show, because the
    // framing effect below is about to open on that scene and fitting the world
    // first would be a camera move the reader watches happen for nothing.
    const framingSelection = variant === 'mini' && selected !== null && !fitted.current;
    const wantsFit = variant === 'mini' ? fittedTo.current !== scenes : !fitted.current;
    if (wantsFit && !framingSelection && scenes.length > 0) {
      const bounds = sceneBounds(scenes);
      if (bounds) {
        instance.fitBounds(bounds, { padding: [32, 32], maxZoom: 10 });
        fitted.current = true;
        fittedTo.current = scenes;
        fittedBounds.current = bounds;
      }
    } else if (variant === 'mini') {
      // Remember what we were given even when the selection framed the view,
      // so the next *query* refits and the next selection does not.
      fittedTo.current = scenes;
    }
  }, [scenes, selected, selectedId, onSelect, onHighlight, variant]);

  /*
   * The highlight: one marker lifted, nothing else touched.
   *
   * This is the map half answering the list half. It restyles in place rather
   * than rebuilding the layer, because the layer is up to 1,286 markers and
   * this runs on every pointer move between rows.
   *
   * `scenes` is a dependency because a rebuild throws the marker table away;
   * without it, a highlight that survived a query would point at a dead marker.
   */
  useEffect(() => {
    const previous = lifted.current === null ? null : dots.current.get(lifted.current);
    if (previous) {
      previous.dot.setRadius(previous.radius);
      previous.dot.setStyle({ color: previous.stroke, weight: previous.weight });
    }
    lifted.current = highlightedId;
    const next = highlightedId === null ? null : dots.current.get(highlightedId);
    if (next) {
      next.dot.setRadius(next.radius + HIGHLIGHT_GROWTH);
      next.dot.setStyle({ color: COLOR_HIGHLIGHT, weight: 3 });
      next.dot.bringToFront();
    }
  }, [highlightedId, scenes]);

  // The venue layer: the selected scene's actual stores, and nothing else.
  //
  // This is the whole picture for a **dispersed** scene, not a detail of it.
  // Such a scene has no dot and no disc, because its centroid is further from
  // every one of its venues than a place can be - measured, the largest is
  // 2,080km out into the Pacific - so these pins are the only true thing the
  // map can say about where it plays.
  useEffect(() => {
    const layer = venueLayer.current;
    if (!layer) return;

    layer.clearLayers();
    if (!selected) return;

    for (const venue of selected.topVenues) {
      L.circleMarker([venue.latitude, venue.longitude], {
        radius: 5,
        color: '#21222c',
        weight: 1,
        fillColor: COLOR_VENUE,
        fillOpacity: 0.9,
      })
        // No name, because the API carries none - the engine's component item
        // does not store one. The count is what a reader can act on.
        .bindTooltip(`${venue.matchCount.toLocaleString('en-US')} matches here`, { direction: 'top' })
        .addTo(layer);
    }
  }, [selected]);

  // Framing one scene - `mini` only. See `variant`.
  //
  // A selection the reader did not make on this map is the case that needs it:
  // the picker opens with whatever scene the ladder is already scoped to, and a
  // **dispersed** scene can only be chosen off the chip list, because it has no
  // pin to click. Both would otherwise leave the canvas showing wherever it
  // happened to be - which for a dispersed scene would look exactly like the
  // map having lost it.
  useEffect(() => {
    const instance = map.current;
    if (!instance || variant !== 'mini') return;
    if (selfSelected.current) {
      // The reader clicked this pin; they can see it. Reset and leave the view.
      selfSelected.current = false;
      return;
    }
    if (!selected) return;
    const bounds = sceneFocusBounds(selected);
    if (!bounds) return;
    fittedBounds.current = bounds;
    /* `maxZoom` decides what "show me this scene" means, and the answer is the
       metro rather than the block. It was 9 while the basemap ran out of
       coastline and names at about that depth; with the detail tier underneath
       the limit is no longer the map but the question - at 11 a 350px pane
       covers ~8km, which is a corner of San Francisco Bay rather than the Bay,
       and a reader asking which scene this is wants the city around it. 10 is
       ~30km across: the whole Bay, with San Francisco, Oakland and San Jose
       all named on it. */
    instance.fitBounds(bounds, { padding: [16, 16], maxZoom: 10 });
    fitted.current = true;
  }, [selected, variant]);

  return (
    <div
      ref={container}
      className={variant === 'mini' ? 'scene-map is-mini' : 'scene-map'}
      // The map is a graphic; everything it conveys is also in the list beside
      // it, which is the surface a keyboard or screen reader uses. Saying so
      // is better than exposing 1,200 unreachable SVG circles.
      //
      // In the picker that surface is the list in the same pane, which holds
      // every scene this map draws and every scene it cannot.
      role="application"
      aria-label={
        variant === 'mini'
          ? 'Map of Riftbound scenes. Every scene is also in the list beside it.'
          : 'Map of Riftbound scenes. Every scene is also listed below.'
      }
    />
  );
}

export default SceneMap;
