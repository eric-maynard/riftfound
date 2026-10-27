import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { SceneMapEntry } from '../types/ranking';
import {
  sceneBounds,
  sceneDotRadius,
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
  scenes: SceneMapEntry[];
  selectedId: string | null;
  onSelect: (componentId: string | null) => void;
}

function SceneMap({ scenes, selectedId, onSelect }: SceneMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const sceneLayer = useRef<L.LayerGroup | null>(null);
  const venueLayer = useRef<L.LayerGroup | null>(null);
  /** Whether the view has already been fitted, so a selection does not refit. */
  const fitted = useRef(false);

  // One map for the component's lifetime. Rebuilding it on every data change
  // would reset the reader's pan and zoom, which on a world map is the whole
  // interaction.
  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = L.map(container.current, {
      center: [WORLD_VIEW.lat, WORLD_VIEW.lng],
      zoom: WORLD_VIEW.zoom,
      // The corpus spans three continents, so wrapping is wanted; a vertical
      // drag past the poles is not.
      worldCopyJump: true,
      maxBounds: [
        [-85, -Infinity],
        [85, Infinity],
      ],
      // Leaflet's default is a link to its own homepage in the corner; the
      // basemap's attribution is a licence condition and is set below.
      attributionControl: true,
    });

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
    const handler = () => onSelect(null);
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
        onSelect(scene.componentId);
      });
      dot.addTo(layer);
    }

    // Fit once, to the pins we actually got. The corpus is not where anyone
    // would guess - the largest scene is Singapore - so a fixed default view
    // opens on an empty ocean for most of it. Only once, because refitting on
    // every data change would yank the view out from under a reader mid-pan.
    if (!fitted.current && scenes.length > 0) {
      const bounds = sceneBounds(scenes);
      if (bounds) {
        instance.fitBounds(bounds, { padding: [32, 32], maxZoom: 10 });
        fitted.current = true;
      }
    }
  }, [scenes, selectedId, onSelect]);

  // The venue layer: the selected scene's actual stores, and nothing else.
  useEffect(() => {
    const layer = venueLayer.current;
    if (!layer) return;

    layer.clearLayers();
    const selected = scenes.find((scene) => scene.componentId === selectedId);
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
  }, [scenes, selectedId]);

  return (
    <div
      ref={container}
      className="scene-map"
      // The map is a graphic; everything it conveys is also in the list beside
      // it, which is the surface a keyboard or screen reader uses. Saying so
      // is better than exposing 1,200 unreachable SVG circles.
      role="application"
      aria-label="Map of Riftbound scenes. Every scene is also listed below."
    />
  );
}

export default SceneMap;
