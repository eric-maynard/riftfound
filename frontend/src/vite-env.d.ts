/// <reference types="vite/client" />

/**
 * Build-time configuration.
 *
 * This is the **first** `import.meta.env` use in the app, which is worth
 * noting: everything else the frontend needs comes from the API at runtime,
 * including the Mapbox access token's effects (geocoding is proxied through
 * `/api/events/geocode` precisely so the token stays server-side). Both
 * variables below are declared optional and both have a working default in
 * `components/SceneMap.tsx`, so a build that sets neither is the normal build
 * and not a degraded one.
 *
 * Neither is a secret. A tile URL with a token in it would be public in the
 * bundle by construction, which is exactly why the default basemap needs no
 * token at all - see the component note.
 */
interface ImportMetaEnv {
  /**
   * Basemap tile template for the scene map. Defaults to OpenStreetMap's
   * keyless raster tiles, darkened with a CSS filter (there is no keyless dark
   * OSM raster). Mapbox is the production path, since the project already pays
   * Mapbox for geocoding - and a dark Mapbox style wants
   * `.scene-map .leaflet-tile`'s filter removed:
   * `https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/{z}/{x}/{y}?access_token=pk....`
   */
  readonly VITE_MAP_TILE_URL?: string;
  /** Attribution for the above. A licence condition, not decoration. */
  readonly VITE_MAP_TILE_ATTRIBUTION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
