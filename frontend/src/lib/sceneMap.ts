/**
 * Pure helpers for the map of scenes.
 *
 * Everything the map decides that is not Leaflet's job lives here, for the
 * reason `lib/ranking.ts` and `lib/tournament.ts` exist: it is testable without
 * a DOM, and a map is mostly arithmetic with a bad reputation.
 *
 * The one thing worth reading before the rest: **a scene's marker encodes two
 * different quantities and they must not be confused.** Its *radius in metres*
 * is `spreadKm` - a real distance on the ground, the mean distance from the
 * centroid to the stores the scene plays at - so zooming in makes it cover the
 * same actual area, because that is what it means. Its *radius in pixels*
 * would encode player count, which is not a distance and must never be drawn
 * as one. Drawing size-by-population as a ground circle is the standard way a
 * map of this kind starts lying: a 4,654-player scene would appear to span a
 * continent.
 *
 * So the map draws both, as two layers with different jobs:
 *
 * - a **ground disc** of radius `spreadKm`, which says "the stores are spread
 *   over about this much map", and shrinks to nothing for a single-store scene
 *   because that scene really is a point;
 * - a **pixel dot** sized by player count, which says "this many players", and
 *   stays the same size at every zoom because a count has no extent.
 */

import type { SceneMapEntry } from '../types/ranking';

/** The label for a scene with no region name of its own. */
export const UNNAMED_SCENE_LABEL = 'Unnamed scene';

/**
 * Where the map opens when nothing says otherwise.
 *
 * Not San Francisco, which is the calendar's default and the wrong instinct
 * here: this page's question is "where are the scenes", and the answer is
 * spread over three continents. It opens on the whole world and then fits to
 * the pins it actually got, so a corpus that is 17% Singapore does not open
 * looking empty.
 */
export const WORLD_VIEW = { lat: 20, lng: 0, zoom: 2 } as const;

/** Pixel radius of a scene's dot. See the module note for why this is not metres. */
const MIN_DOT_PX = 4;
const MAX_DOT_PX = 22;

/**
 * Dot radius in **pixels**, by player count.
 *
 * Square-rooted, so the dot's *area* is proportional to the count - the only
 * scaling a reader can compare by eye, and the difference between a legible
 * map and one where Singapore's 4,654 players erase the rest of the world. On
 * the measured corpus the counts span 2 to 4,654, which is a factor of 2,327:
 * linear radius would put the smallest scene below one pixel.
 *
 * Clamped at both ends. The floor is a target a finger can hit; the ceiling is
 * where a dot stops being a dot. `max` is passed in rather than measured here
 * so the scale is shared by the map and its legend, which must agree or the
 * legend is decoration.
 */
export function sceneDotRadius(playerCount: number, maxPlayerCount: number): number {
  if (!Number.isFinite(playerCount) || playerCount <= 0) return MIN_DOT_PX;
  const ceiling = Math.max(1, maxPlayerCount);
  const share = Math.min(1, Math.sqrt(playerCount) / Math.sqrt(ceiling));
  return MIN_DOT_PX + share * (MAX_DOT_PX - MIN_DOT_PX);
}

/**
 * Radius in **metres** of the ground disc, or null when there is nothing
 * honest to draw.
 *
 * Null for a scene whose spread is zero or unknown: a single-store scene has
 * no extent, and drawing it with an arbitrary minimum radius would assert one.
 * The dot still marks it, which is the correct amount to say about a point.
 */
export function sceneSpreadRadiusMeters(scene: SceneMapEntry): number | null {
  if (scene.spreadKm === null || !Number.isFinite(scene.spreadKm) || scene.spreadKm <= 0) return null;
  return scene.spreadKm * 1000;
}

/** A scene's display name: its region, else its id, never a blank. */
export function sceneLabel(scene: SceneMapEntry): string {
  const label = scene.regionLabel?.trim();
  return label && label.length > 0 ? label : UNNAMED_SCENE_LABEL;
}

/**
 * The one-line summary under a scene's name.
 *
 * Player count first because it is the thing being compared, then the rated
 * share, then the venues. The rated count is included even when it is zero -
 * that is the common case at this coverage and it is informative, not an
 * omission.
 */
export function sceneSummary(scene: SceneMapEntry): string {
  const players = `${formatCount(scene.playerCount)} player${scene.playerCount === 1 ? '' : 's'}`;
  const rated = `${formatCount(scene.ratedPlayers)} rated`;
  const venues = `${formatCount(scene.venueCount)} venue${scene.venueCount === 1 ? '' : 's'}`;
  return `${players} · ${rated} · ${venues}`;
}

/**
 * What the pin's position actually claims, as the hover hint.
 *
 * This is the honesty text, and it is a hint rather than body copy for the
 * same reason every other caveat on these pages is: a reader wants the scene,
 * not our method. Two facts it has to carry, because neither is visible from
 * the marker:
 *
 * - the centroid is **weighted by play**, not a bounding-box centre;
 * - it was computed from `locatedVenues` of `venueCount` stores, which on a
 *   partially-geocoded scene is the difference between a pin that describes
 *   the scene and one that describes a corner of it.
 */
export function scenePlaceHint(scene: SceneMapEntry): string {
  if (scene.dispersed) {
    // The scene is real, well mapped, and genuinely not in one place. Say the
    // number, because "spans several regions" is vague where "the centre of
    // its play is 2,080 km from the nearest store" is a fact a reader can
    // weigh - and it is the fact that explains the missing pin.
    const away = scene.nearestVenueKm === null ? null : formatSpread(scene.nearestVenueKm);
    return (
      `This scene plays across ${formatCount(scene.venueCount)} venues too far apart to have one place on the map` +
      (away === null ? '. ' : `: the centre of its play is ${away} from the nearest of them. `) +
      'Its busiest venues are shown instead.'
    );
  }

  if (scene.latitude === null || scene.longitude === null) {
    return 'No venue of this scene has been geocoded, so it has no place on the map.';
  }

  const basis =
    scene.locatedVenues >= scene.venueCount
      ? `all ${formatCount(scene.venueCount)} of its venues`
      : `${formatCount(scene.locatedVenues)} of its ${formatCount(scene.venueCount)} venues`;
  const spread =
    scene.spreadKm === null || scene.spreadKm <= 0
      ? 'Its play is at a single location.'
      : `Its venues are a mean ${formatSpread(scene.spreadKm)} from that point.`;

  return `Centred on ${basis}, weighted by matches played at each. ${spread}`;
}

/** Why a scene's board cannot be ordered, or null when it can. */
export function sceneComparableHint(scene: SceneMapEntry, minComponentSize: number): string | null {
  if (scene.comparable) return null;
  return (
    `Too small to order: a position needs a scene of at least ${minComponentSize} players, ` +
    `and this one has ${formatCount(scene.playerCount)}. The ratings are still published.`
  );
}

/** `4.2 km` / `133 km` - one decimal only where it carries information. */
export function formatSpread(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${formatCount(Math.round(km))} km`;
}

/** Thousands separators, matching the ladder's tabular figures. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * The scope string for a scene's leaderboard.
 *
 * A scene *is* a connected component, so this is `component:<id>` - the scope
 * `/api/rankings` has always taken. Named here so the map and the ladder
 * cannot drift on the spelling.
 */
export function sceneScope(componentId: string): string {
  return `component:${componentId}`;
}

/** The ladder path for a scene. The preview flag is added by the caller. */
export function scenePath(componentId: string): string {
  return `/rankings?region=${encodeURIComponent(componentId)}`;
}

/**
 * Filter the scene list by a free-text query.
 *
 * Matches the region label and the component id, the same two things the
 * ladder's own `filterSceneOptions` matches, so searching here and searching
 * in the picker behave the same way. Case- and whitespace-insensitive.
 */
export function filterScenes(scenes: SceneMapEntry[], query: string): SceneMapEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return scenes;
  return scenes.filter((scene) => {
    const label = (scene.regionLabel ?? '').toLowerCase();
    return label.includes(needle) || scene.componentId.toLowerCase().includes(needle);
  });
}

/**
 * The bounds the map should open on, as `[[south, west], [north, east]]`, or
 * null when there is nothing to fit.
 *
 * Fitted to the pins rather than to a hardcoded view, because the corpus is
 * not where anyone would guess: the largest scene is Singapore and the rest
 * runs from California to Australia. A fixed default would open on an empty
 * ocean for most of it.
 *
 * Longitudes are **not** normalised across the antimeridian here. A bounding
 * box spanning the Pacific is genuinely the whole world, which is what Leaflet
 * then shows, and the clever version - picking the shorter of the two possible
 * spans - gets a global corpus wrong far more often than it helps.
 */
export function sceneBounds(
  scenes: SceneMapEntry[]
): [[number, number], [number, number]] | null {
  const located = scenes.filter(
    (scene): scene is SceneMapEntry & { latitude: number; longitude: number } =>
      scene.latitude !== null && scene.longitude !== null
  );
  if (located.length === 0) return null;

  let south = located[0].latitude;
  let north = located[0].latitude;
  let west = located[0].longitude;
  let east = located[0].longitude;
  for (const scene of located) {
    if (scene.latitude < south) south = scene.latitude;
    if (scene.latitude > north) north = scene.latitude;
    if (scene.longitude < west) west = scene.longitude;
    if (scene.longitude > east) east = scene.longitude;
  }

  // A single pin has no extent, so pad it to something Leaflet can fit
  // without zooming to street level.
  if (south === north && west === east) {
    return [
      [south - 1, west - 1],
      [north + 1, east + 1],
    ];
  }
  return [
    [south, west],
    [north, east],
  ];
}

/**
 * The sentence the page leads with.
 *
 * Three states, and they are genuinely different answers rather than degrees
 * of the same one:
 *
 * - **the catalogue could not be read** - the engine has never refitted, or
 *   this deploy's engine predates the place fields. We do not know where the
 *   scenes are, and saying "0 scenes" would claim there are none.
 * - **scenes exist, none is located** - every one of them is real and none of
 *   their stores has been geocoded. That is a gap in the shops table, not in
 *   the ladder.
 * - **some are located** - the usual case, and the count is the caveat.
 */
export function sceneCoverageSentence(coverage: {
  totalScenes: number;
  locatedScenes: number;
  dispersedScenes: number;
  locatedPlayers: number;
  totalPlayers: number;
  catalogueUnavailable: boolean;
}): string {
  if (coverage.catalogueUnavailable) {
    return 'No scene map yet — the rating engine has not published where its scenes are.';
  }
  if (coverage.locatedScenes === 0) {
    return `${formatCount(coverage.totalScenes)} scenes, none of them locatable — no venue in any of them has been geocoded.`;
  }
  const playerShare =
    coverage.totalPlayers > 0
      ? Math.round((coverage.locatedPlayers / coverage.totalPlayers) * 100)
      : 0;
  // The dispersed count is named rather than folded into "not on the map",
  // because it is the surprising half of the ratio: measured on production,
  // 20 of 1,302 scenes are dispersed and they hold 40% of the players, so a
  // reader seeing "1,282 of 1,302 scenes, 60% of players" would otherwise be
  // left to wonder where the other 40% went.
  const dispersed =
    coverage.dispersedScenes > 0
      ? ` ${formatCount(coverage.dispersedScenes)} more play across too many regions to pin.`
      : '';
  return (
    `${formatCount(coverage.locatedScenes)} of ${formatCount(coverage.totalScenes)} scenes on the map, ` +
    `holding ${playerShare}% of recorded players.${dispersed}`
  );
}
