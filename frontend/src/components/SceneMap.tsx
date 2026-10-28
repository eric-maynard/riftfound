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
const LAND_URL = `${import.meta.env.BASE_URL}basemap/land-v1.json`;
const PLACES_URL = `${import.meta.env.BASE_URL}basemap/places-v1.json`;

/** `[name, latitude, longitude, minimum zoom]` - see `scripts/build-basemap.py`. */
type PlaceRow = [string, number, number, number];

interface Basemap {
  land: unknown;
  places: PlaceRow[];
}

/** One fetch per page load, shared by both maps that can exist in it. */
let basemapRequest: Promise<Basemap> | null = null;

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

/** Labels drawn at once, highest zoom floor first. A cap, not a target. */
const MAX_LABELS = 90;

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
    instance.createPane('basemapLand').style.zIndex = '200';
    instance.createPane('basemapLabels').style.zIndex = '250';
    for (const name of ['basemapLand', 'basemapLabels']) {
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

    landLayer.current = L.layerGroup([], { pane: 'basemapLand' }).addTo(instance);
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
      instance.fitBounds(fittedBounds.current, { padding: [16, 16], maxZoom: 9 });
    });
    resize.observe(container.current);

    return () => {
      resize.disconnect();
      instance.remove();
      map.current = null;
      landLayer.current = null;
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
   * The basemap: coastlines once, city labels per view.
   *
   * The land is static - one MultiPolygon, added and never touched again. The
   * labels are not: 1,251 of them drawn at once would be a soup at any zoom
   * and a waste at every one, so each carries the zoom it earns its place at
   * (Natural Earth's own `min_zoom`) and the layer is rebuilt for what is
   * actually on screen whenever the view settles. That is ~20 labels on the
   * world view and under 90 anywhere else.
   *
   * Nothing here is interactive. A label is orientation, not a target: these
   * are cities, and the only clickable things on this map are scenes.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    let live = true;

    const drawLabels = (places: PlaceRow[]) => {
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
      const visible = places
        .filter(([, latitude, longitude, minZoom]) => {
          if (minZoom > zoom) return false;
          return bounds.contains([latitude, longitude]);
        })
        // Most prominent first, so the cap keeps the cities worth keeping.
        .sort((a, b) => a[3] - b[3])
        .slice(0, MAX_LABELS);

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

    loadBasemap()
      .then(({ land, places }) => {
        if (!live) return;
        const layer = landLayer.current;
        if (layer && !TILE_URL) {
          L.geoJSON(land as Parameters<typeof L.geoJSON>[0], {
            pane: 'basemapLand',
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
        drawLabels(places);
        instance.on('moveend zoomend', () => drawLabels(places));
      })
      .catch(() => {
        // Pins on a blank field. Degraded, not broken, and not worth a banner
        // on a control whose job is picking a scene from a list.
      });

    return () => {
      live = false;
      instance.off('moveend zoomend');
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
        instance.fitBounds(bounds, { padding: [32, 32], maxZoom: 9 });
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
    // `maxZoom` keeps a single-venue scene from opening too deep. The number
    // is the basemap's: there is no imagery and the densest city labels run out
    // around zoom 9, so past it the map is a plain field with one pin on it -
    // which is a worse answer than the same pin over a labelled region.
    instance.fitBounds(bounds, { padding: [16, 16], maxZoom: 9 });
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
