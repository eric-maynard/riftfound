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
 * ## Why these tiles
 *
 * OpenStreetMap's standard raster tiles: **keyless**, so the default build
 * spends nothing, needs no account and puts no credential in a public bundle.
 *
 * CARTO's basemap was the first choice and was tried and rejected, on evidence
 * rather than policy - `basemaps.cartocdn.com/dark_all` now serves tiles
 * reading "API KEY REQUIRED" diagonally across every one of them. Any keyless
 * CDN basemap is one business decision away from the same, which is the
 * argument for the override below rather than for a different free provider.
 *
 * `VITE_MAP_TILE_URL` is that override, and **it is the production path**:
 * Mapbox raster tiles, since the project already pays Mapbox for geocoding, so
 * switching is one environment variable and no new vendor. It is deliberately
 * not the default, for two reasons that both matter - Mapbox tiles bill per
 * request, and the default build has no token to put in the URL (the geocoding
 * token is server-side, behind `/api/events/geocode`, which is where it should
 * stay). OSM's tile usage policy asks that heavy consumers run their own
 * cache; a page behind a preview flag is not one, but **this is the thing to
 * change before Rankings stops being unlisted**, not after.
 *
 * ## Why the basemap is filtered rather than a dark style
 *
 * There is no keyless dark OSM raster, and the app is a dark theme throughout:
 * a white basemap under the Dracula palette is the one combination where none
 * of the marker colours clears contrast against what is behind it. So the
 * tiles are inverted and hue-rotated in CSS (`.scene-map .leaflet-tile`),
 * which costs no request, leaves the attribution untouched, and tracks
 * whatever tile source is configured. A Mapbox dark style would want that
 * filter removed, which is why it is one rule and not baked into the markers.
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

/** Tiles. See the component note; override to swap in Mapbox or anything else. */
const TILE_URL =
  import.meta.env.VITE_MAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  import.meta.env.VITE_MAP_TILE_ATTRIBUTION ??
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

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
   * Which surface this canvas is drawn on. Three behaviours hang off it, and
   * all three are about the difference between a page about every scene and a
   * ~190px canvas inside a filter control (`SceneMiniMap`):
   *
   * - **the first frame.** `page` fits the whole corpus once, because its
   *   question is "where are the scenes". `mini` frames the *selected* scene
   *   when there is one, because its question is "is this the one I meant" -
   *   and a 1,286-pin world view in a thumbnail answers neither.
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

function SceneMap({ scenes, selected, selectedId, onSelect, variant = 'page' }: SceneMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const sceneLayer = useRef<L.LayerGroup | null>(null);
  const venueLayer = useRef<L.LayerGroup | null>(null);
  /** Whether the view has already been fitted, so a selection does not refit. */
  const fitted = useRef(false);
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

    L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 18,
      // A dark basemap is one request per tile either way; this only stops the
      // browser asking for retina tiles on a desktop display.
      detectRetina: false,
    }).addTo(instance);

    sceneLayer.current = L.layerGroup().addTo(instance);
    venueLayer.current = L.layerGroup().addTo(instance);

    map.current = instance;

    return () => {
      instance.remove();
      map.current = null;
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
      const dot = L.circleMarker(position, {
        radius: sceneDotRadius(scene.playerCount, maxPlayers),
        color: selected ? COLOR_SELECTED : '#21222c',
        weight: selected ? 3 : 1,
        fillColor: colour,
        fillOpacity: 0.85,
      });
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
      dot.addTo(layer);
    }

    // Fit once, to the pins we actually got. The corpus is not where anyone
    // would guess - the largest scene is Singapore - so a fixed default view
    // opens on an empty ocean for most of it. Only once, because refitting on
    // every data change would yank the view out from under a reader mid-pan.
    //
    // Skipped on a mini map that already has a scene to show: the framing
    // effect below is about to open on that scene, and fitting the world first
    // would be one wasted camera move the reader watches happen.
    const framingSelection = variant === 'mini' && selected !== null;
    if (!fitted.current && !framingSelection && scenes.length > 0) {
      const bounds = sceneBounds(scenes);
      if (bounds) {
        instance.fitBounds(bounds, { padding: [32, 32], maxZoom: 10 });
        fitted.current = true;
      }
    }
  }, [scenes, selected, selectedId, onSelect, variant]);

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
    // `maxZoom` keeps a single-venue scene from opening at street level, where
    // a basemap of one road is a worse answer than a neighbourhood.
    instance.fitBounds(bounds, { padding: [16, 16], maxZoom: 11 });
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
      // In the picker that surface is the By name mode, which is where the
      // label points instead - and it is the picker's *default*, so no reader
      // is sent to a map to find a scene.
      role="application"
      aria-label={
        variant === 'mini'
          ? 'Map of Riftbound scenes. Every scene can also be chosen by name, in this picker’s By name mode.'
          : 'Map of Riftbound scenes. Every scene is also listed below.'
      }
    />
  );
}

export default SceneMap;
