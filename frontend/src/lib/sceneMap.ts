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

/**
 * The label for a scene with no name of its own.
 *
 * Kept for the copy that talks *about* unnamed scenes. `sceneLabel` itself
 * falls back to `Scene <id>` rather than to this, matching the ladder picker:
 * an id is a handle a reader can share and search for, where "Unnamed scene"
 * repeated down a list is indistinguishable from a bug.
 */
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

/** A scene's display name: the engine's label, else a blank-proof fallback. */
export function sceneLabel(scene: SceneMapEntry): string {
  const label = scene.label?.trim();
  return label && label.length > 0 ? label : `Scene ${scene.sceneId}`;
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

/**
 * Why the board a scene leads to cannot be ordered, or null when it can.
 *
 * **The gate is on the pool, not on the scene**, and the wording has to say so
 * or it is simply wrong: this used to read "a position needs a scene of at
 * least 8 players, and this one has 3", which quoted the scene's own count
 * against a threshold the scene is not measured by. A rating is identified
 * against the players it was earned among, so the depth that matters is the
 * pool's - a 3-store scene inside a 2,000-player pool orders fine, and a
 * 40-player scene whose pool is 6 does not.
 */
export function sceneComparableHint(scene: SceneMapEntry, minComponentSize: number): string | null {
  if (scene.comparable) return null;
  if (scene.componentId === null) {
    return 'No positions yet: none of the players who play here has been placed in a rating pool.';
  }
  const size = scene.componentSize === null ? 'fewer' : formatCount(scene.componentSize);
  return (
    `Too small to order: a position needs a pool of at least ${minComponentSize} players who have played ` +
    `each other, and the one these players are in has ${size}. The ratings are still published.`
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
 * The scope string for the ladder a scene's players are ranked on.
 *
 * **The argument is a `componentId`, not a `sceneId`, and that is the whole
 * distinction this module now has to keep.** A scene is a cluster of stores; a
 * scope is a rating scale, and only a connected component is one, because
 * `crossComponentUncertainty` is correct for nothing else. So a scene's row
 * links at `scene.componentId` - the pool most of its players sit in - and the
 * copy beside it says the two things separately rather than letting the link
 * assert they are one. A scene with no pool has no scope at all; see
 * `sceneLadderNote`.
 */
export function sceneScope(componentId: string): string {
  return `component:${componentId}`;
}

/**
 * What this scene's ladder is, and what the pool link beside it is for, in one
 * sentence. Never null: a scene always has a board now, even an empty one.
 *
 * **This used to be an apology for the link, and it is a description of it.**
 * The panel's button opened `component:<the pool these players sit in>`,
 * because a scene had no board - so the note had to say, before the click,
 * that `Peninsula` would land on a ladder named after somewhere else. The
 * ladder has a `scene:<id>` scope now: it is the pool's board filtered to this
 * scene's rows and re-ranked among them, so the link goes where the name says.
 *
 * The pair is still two facts and still has to be stated as two - *this is the
 * Peninsula scene* and *these players' ratings are on one scale with these
 * others'* - but the second is now the **second link** rather than a caveat on
 * the first, which is the right shape for it: a reader who wants to know who
 * else is on this scale can go and look.
 *
 * Three answers, and the middle one is the common one:
 *
 * - **no pool** - nobody who plays here has been replayed yet. The board exists
 *   and is empty, which says so better than a withheld link did;
 * - **one pool** - say how big it is, so "see the whole rating pool" is a
 *   known quantity before the click;
 * - **more than one pool** - the honest caveat of the whole design. A scene
 *   board is comparable internally *because* the scene sits inside one pool,
 *   and this is the case where it does not: the board is the largest of them,
 *   so some of the scene's own players are on another one.
 */
export function sceneLadderNote(scene: SceneMapEntry): string {
  if (scene.componentId === null) {
    return (
      'Nobody who plays here has been placed in a rating pool yet, so this scene’s board is empty ' +
      'for now. The scene is still where these stores are.'
    );
  }
  const size =
    scene.componentSize === null
      ? ''
      : ` It holds ${formatCount(scene.componentSize)} player${scene.componentSize === 1 ? '' : 's'}.`;
  if (scene.componentCount > 1) {
    return (
      `The players here sit in ${formatCount(scene.componentCount)} separate rating pools, so they are not ` +
      'all on one scale: this scene’s board shows the largest of them, and the rest of its players are ' +
      `on another.${size}`
    );
  }
  return (
    'Ratings are only comparable between players whose games chain together, and everyone here is in one ' +
    'such pool - which covers other scenes too, so this scene’s board is that pool filtered to the ' +
    `players who play here.${size}`
  );
}

/**
 * How honestly "this store belongs to one scene" holds across the scene, or
 * null when it holds outright or is unknown.
 *
 * The engine stores a purity per store - the share of that store's play that
 * sat inside the scene at clustering time - and the median over a scene's
 * stores is 100% for almost all of them. A low number is a genuinely split
 * scene, which is worth showing rather than hiding, and it is only worth a line
 * when it is not 1.
 */
export function scenePurityHint(scene: SceneMapEntry): string | null {
  if (scene.medianPurity === null || scene.medianPurity >= 0.999) return null;
  return (
    `Its stores play a median ${Math.round(scene.medianPurity * 100)}% of their games inside this scene. ` +
    'A store that plays more outside it is a genuinely split store rather than a mistake.'
  );
}

/*
 * `scenePath`, `sceneMapPath` and `SCENE_MAP_PARAM` deliberately live in
 * `lib/ranking.ts` instead of here, even though this is the page that reads
 * them most. They are links into the Rankings section, and the event page -
 * which is in the **eager** bundle - needs two of them for its scene line.
 * This module is otherwise reached only from lazily-imported code - the
 * `/rankings/map` route and the scene picker's mini map - and Rollup hoists a
 * module shared between an eager and a lazy chunk into the eager one *whole*:
 * importing one path builder from here put all of
 * this file (its copy, its geometry, its coverage sentences) into the bundle
 * every calendar visitor downloads. The link builders are scope plumbing and
 * `lib/ranking.ts` already owns scopes, so that is where they went - which
 * keeps this module in the lazy chunk and the whole scene line down to
 * 0.71KB gzipped on the eager one.
 */

/**
 * Filter the scene list by a free-text query.
 *
 * Matches the scene's label and its id, the same two things the ladder's own
 * `filterSceneOptions` matches, so searching here and searching in the picker
 * behave the same way. Case- and whitespace-insensitive.
 */
export function filterScenes(scenes: SceneMapEntry[], query: string): SceneMapEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return scenes;
  return scenes.filter((scene) => {
    const label = (scene.label ?? '').toLowerCase();
    // The scene id is matched too, so a `?scene=` link a reader was handed is
    // findable by paste as well as by name.
    return label.includes(needle) || scene.sceneId.toLowerCase().includes(needle);
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

  /* A single pin has no extent, so the pad alone decides what the frame means
     - the same question `MIN_FRAME_KM` below already answers, and it must not
     be answered twice. This used to be a flat **one degree**: 222km of
     latitude, which in the picker's pane fits at exactly zoom 6, the threshold
     `DETAIL_ZOOM` sits on - so a reader who typed one scene's name got the 10m
     tier by a single level, at a scale where 10m and 110m look alike. Measured
     in Chromium at 1280px, typing `santiago, chile` framed at **zoom 6**
     before and at **zoom 8** now. At `MIN_FRAME_KM` it is the metro that
     figure was measured for, and the two single-pin frames in this file
     agree - which is what the test asserts, rather than either number. */
  if (south === north && west === east) {
    return padBounds(south, west, north, east, MIN_FRAME_KM);
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
  unassignedVenues: number | null;
  catalogueUnavailable: boolean;
}): string {
  if (coverage.catalogueUnavailable) {
    return 'No scene map yet — no store has been placed in a scene, so there is nothing to draw.';
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
  // The stores in **no** scene are named here and nowhere else on the page.
  // They cannot be listed - they are absent from a catalogue of scenes by
  // construction - so if this line does not count them, nothing does, and a
  // reader looking for Palo Alto is left to conclude the map lost it.
  const unassigned =
    coverage.unassignedVenues !== null && coverage.unassignedVenues > 0
      ? ` ${formatCount(coverage.unassignedVenues)} store${coverage.unassignedVenues === 1 ? ' is' : 's are'} in no scene yet.`
      : '';
  return (
    `${formatCount(coverage.locatedScenes)} of ${formatCount(coverage.totalScenes)} scenes on the map, ` +
    `holding ${playerShare}% of recorded players.${dispersed}${unassigned}`
  );
}

/**
 * The box the map should show when a reader asks about **one** scene.
 *
 * `sceneBounds` above answers "where is the whole corpus"; this answers "where
 * is this one", which is the question the scene picker's mini map opens on. A
 * world fit is the right first frame for a page about 1,286 scenes and the
 * wrong one for a control whose job is to confirm the scene already chosen.
 *
 * Two cases, and they take their geometry from different fields on purpose:
 *
 * - a **dispersed** scene has no centroid worth flying to - its own is
 *   150-2,300km from its nearest venue - so the box is drawn around the venues
 *   it actually plays at, the same pins `SceneMap` draws for it. Those are the
 *   only honest coordinates such a scene has.
 * - a **located** scene is framed on its pin, padded by its own `spreadKm`, so
 *   a 133km corridor opens showing the corridor rather than a street corner.
 *
 * Null when there is nothing to frame - no pin and no located venue - and the
 * caller then leaves the reader's view alone rather than flying to `0, 0`.
 *
 * The padding converts km to degrees crudely: one degree of latitude is ~111km
 * and one of longitude is that times the cosine of the latitude. That is
 * accurate enough for a camera and for nothing else - nothing is measured from
 * it, and `fitBounds` rounds to a zoom level anyway. The cosine is floored so a
 * scene near a pole cannot divide the longitude padding by zero.
 */
const KM_PER_DEGREE = 111;
/**
 * Smallest half-width of the frame, so a single-venue scene opens on its city
 * rather than on its street.
 *
 * 30km, raised from 6 after looking at the result: a scene with one venue has
 * no extent, so this figure alone decides what "show me this scene" means, and
 * 6km framed a corner of San Francisco Bay - close enough to see the pin,
 * nowhere near enough to see *where* it is. Measured in the picker's pane: a
 * 30km half-width puts the whole Bay on screen with San Francisco, Oakland and
 * San Jose all named, which is the scale the question is actually asked at.
 */
const MIN_FRAME_KM = 30;

export function sceneFocusBounds(
  scene: SceneMapEntry
): [[number, number], [number, number]] | null {
  if (scene.latitude === null || scene.longitude === null) {
    // Dispersed, or simply ungeocoded: frame the venues if there are any.
    const venues = scene.topVenues;
    if (venues.length === 0) return null;
    let south = venues[0].latitude;
    let north = venues[0].latitude;
    let west = venues[0].longitude;
    let east = venues[0].longitude;
    for (const venue of venues) {
      if (venue.latitude < south) south = venue.latitude;
      if (venue.latitude > north) north = venue.latitude;
      if (venue.longitude < west) west = venue.longitude;
      if (venue.longitude > east) east = venue.longitude;
    }
    return padBounds(south, west, north, east, MIN_FRAME_KM);
  }

  const reach = Math.max(MIN_FRAME_KM, scene.spreadKm ?? 0);
  return padBounds(scene.latitude, scene.longitude, scene.latitude, scene.longitude, reach);
}

function padBounds(
  south: number,
  west: number,
  north: number,
  east: number,
  padKm: number
): [[number, number], [number, number]] {
  const latPad = padKm / KM_PER_DEGREE;
  const shrink = Math.max(0.1, Math.cos((((south + north) / 2) * Math.PI) / 180));
  const lngPad = padKm / (KM_PER_DEGREE * shrink);
  return [
    [south - latPad, west - lngPad],
    [north + latPad, east + lngPad],
  ];
}
