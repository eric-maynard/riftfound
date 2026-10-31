/**
 * The map's arithmetic and copy, without a DOM.
 *
 * The group that matters most is the first: **a count and a distance are drawn
 * differently and must never be swapped.** A scene's ground disc is its real
 * spread in metres; its dot is its player count in pixels. Drawing the count
 * as a ground radius is how a map of this shape starts asserting that a
 * 4,654-player scene spans a continent, so the two scales are tested
 * separately and the disc is tested to vanish where there is no extent.
 */

import { describe, it, expect } from 'vitest';
import {
  sceneDotRadius,
  sceneSpreadRadiusMeters,
  sceneLabel,
  sceneSummary,
  scenePlaceHint,
  sceneComparableHint,
  sceneBounds,
  sceneCoverageSentence,
  sceneFocusBounds,
  sceneLadderNote,
  scenePurityHint,
  scenePurityLabel,
  sceneScope,
  filterScenes,
  formatSpread,
  UNNAMED_SCENE_LABEL,
} from '../sceneMap';
import type { SceneMapEntry } from '../../types/ranking';

function scene(overrides: Partial<SceneMapEntry> & { sceneId: string }): SceneMapEntry {
  return {
    label: 'Martinez, CA',
    playerCount: 40,
    ratedPlayers: 12,
    matchCount: 300,
    venueCount: 4,
    medianPurity: 1,
    isGiant: false,
    // Distinct from `sceneId`, because a scene is not a rating scale and the
    // two ids must never be interchangeable in a fixture either.
    componentId: 'c-pool',
    componentSize: 400,
    componentCount: 1,
    comparable: true,
    latitude: 38.0194,
    longitude: -122.1341,
    spreadKm: 12.5,
    nearestVenueKm: 3.1,
    dispersed: false,
    locatedVenues: 4,
    locatedMatches: 300,
    topVenues: [],
    ...overrides,
  };
}

describe('the two radii are different quantities', () => {
  it('scales the dot by the square root of the count, so areas compare', () => {
    // Four times the players is twice the radius and four times the area,
    // which is the only scaling a reader can compare by eye.
    const small = sceneDotRadius(100, 1600);
    const large = sceneDotRadius(1600, 1600);
    const base = sceneDotRadius(0, 1600);
    expect((large - base) / (small - base)).toBeCloseTo(4, 5);
  });

  it('keeps the smallest scene visible and the largest a dot', () => {
    // The measured corpus spans 2 to 4,654 players - a factor of 2,327 - so a
    // linear radius would put the smallest scene under one pixel.
    const tiny = sceneDotRadius(2, 4654);
    const giant = sceneDotRadius(4654, 4654);
    expect(tiny).toBeGreaterThanOrEqual(4);
    expect(giant).toBeLessThanOrEqual(22);
    expect(giant).toBeGreaterThan(tiny);
  });

  it('floors a zero or nonsense count rather than vanishing', () => {
    expect(sceneDotRadius(0, 100)).toBe(4);
    expect(sceneDotRadius(Number.NaN, 100)).toBe(4);
    expect(sceneDotRadius(-5, 100)).toBe(4);
  });

  it('never exceeds the ceiling when the count exceeds the stated maximum', () => {
    // A stale `max` would otherwise draw one scene off the screen.
    expect(sceneDotRadius(10_000, 100)).toBeLessThanOrEqual(22);
  });

  it('draws the ground disc at the spread, in metres', () => {
    expect(sceneSpreadRadiusMeters(scene({ sceneId: 'c', spreadKm: 12.5 }))).toBe(12_500);
    // The 133km corridor measured on the California sample: a real distance,
    // drawn as one, rather than a dot pretending to be a city.
    expect(sceneSpreadRadiusMeters(scene({ sceneId: 'c', spreadKm: 133.4 }))).toBe(133_400);
  });

  it('draws no disc where there is no extent', () => {
    // A single-store scene really is a point. An arbitrary minimum radius
    // would assert a spread it does not have.
    expect(sceneSpreadRadiusMeters(scene({ sceneId: 'c', spreadKm: 0 }))).toBeNull();
    expect(sceneSpreadRadiusMeters(scene({ sceneId: 'c', spreadKm: null }))).toBeNull();
    expect(sceneSpreadRadiusMeters(scene({ sceneId: 'c', spreadKm: -1 }))).toBeNull();
  });
});

describe('labels and copy', () => {
  it('never renders a blank name, and falls back to the id rather than a word', () => {
    expect(sceneLabel(scene({ sceneId: 'c', label: 'Singapore' }))).toBe('Singapore');
    // `Scene <id>`, matching the ladder's picker: an id is a handle a reader
    // can share and search for, where "Unnamed scene" repeated down a list is
    // indistinguishable from a bug. `UNNAMED_SCENE_LABEL` is still exported
    // for copy that talks *about* unnamed scenes.
    expect(sceneLabel(scene({ sceneId: 's94af82a16f', label: null }))).toBe('Scene s94af82a16f');
    expect(sceneLabel(scene({ sceneId: 'c', label: '   ' }))).toBe('Scene c');
    expect(UNNAMED_SCENE_LABEL).toBe('Unnamed scene');
  });

  it('summarises players, rated players and venues, with plurals', () => {
    expect(sceneSummary(scene({ sceneId: 'c', playerCount: 4654, ratedPlayers: 1203, venueCount: 211 }))).toBe(
      '4,654 players · 1,203 rated · 211 venues'
    );
    // The one-of-everything case, which is the common shape of a tiny scene.
    expect(sceneSummary(scene({ sceneId: 'c', playerCount: 1, ratedPlayers: 0, venueCount: 1 }))).toBe(
      '1 player · 0 rated · 1 venue'
    );
  });

  it('says a pin is weighted by play, and what it was computed from', () => {
    const hint = scenePlaceHint(scene({ sceneId: 'c', venueCount: 4, locatedVenues: 4, spreadKm: 12.5 }));
    expect(hint).toContain('weighted by matches played');
    expect(hint).toContain('all 4 of its venues');
    // Rounded past 10km, where the decimal stops carrying information.
    expect(hint).toContain('13 km');
  });

  it('says when a pin describes only part of its scene', () => {
    // The case a reader could not otherwise see: a pin derived from 2 of 40
    // stores describes a corner of the scene, not the scene.
    const hint = scenePlaceHint(scene({ sceneId: 'c', venueCount: 40, locatedVenues: 2 }));
    expect(hint).toContain('2 of its 40 venues');
  });

  it('says a single-location scene has no spread rather than printing 0 km', () => {
    const hint = scenePlaceHint(scene({ sceneId: 'c', spreadKm: 0, venueCount: 1, locatedVenues: 1 }));
    expect(hint).toContain('single location');
    expect(hint).not.toContain('0 km');
  });

  it('explains an unlocated scene without blaming the ladder', () => {
    const hint = scenePlaceHint(scene({ sceneId: 'c', latitude: null, longitude: null, spreadKm: null }));
    expect(hint).toContain('geocoded');
    expect(hint).not.toContain('weighted');
  });

  it('explains a board too small to order, and that its ratings still exist', () => {
    expect(sceneComparableHint(scene({ sceneId: 'c', comparable: true }), 8)).toBeNull();

    // **It quotes the pool's size, not the scene's.** This used to read "a
    // position needs a scene of at least 8 players, and this one has 3",
    // measuring the scene against a threshold the scene is not measured by - a
    // 3-store scene inside a 2,000-player pool orders perfectly well. The
    // depth a position is earned among is the pool's.
    const hint = sceneComparableHint(
      scene({ sceneId: 'c', comparable: false, playerCount: 40, componentId: 'c-tiny', componentSize: 4 }),
      8
    );
    expect(hint).toContain('a pool of at least 8 players');
    expect(hint).toContain('has 4');
    expect(hint).not.toContain('40');
    // The distinction the ladder already draws: a comparison problem is not an
    // evidence problem, and the number is published either way.
    expect(hint).toContain('still published');

    // No pool at all is a third answer, and it is not "too small".
    const orphan = sceneComparableHint(
      scene({ sceneId: 'c', comparable: false, componentId: null, componentSize: null }),
      8
    );
    expect(orphan).toContain('No positions yet');
    expect(orphan).not.toContain('Too small');
  });

  it("describes this scene's own board, and names the pool as the second link", () => {
    // This note used to be an *apology* for the link: a scene had no board, so
    // the panel's button opened the pool's and the copy had to warn, before the
    // click, that `Peninsula` would land on a ladder named after somewhere
    // else. The ladder has a `scene:<id>` scope now - the pool's board filtered
    // to this scene's rows - so the note describes what the link opens, and the
    // pool is the second link rather than a caveat on the first.
    const note = sceneLadderNote(scene({ sceneId: 's-pen', componentId: 'c-bay', componentSize: 1688 }));
    expect(note).toContain('this scene’s board is that pool filtered to the players who play here');
    expect(note).toContain('1,688 players');
    // The caveat it must not go back to making: a board the reader did not ask
    // for, presented as the one they clicked.
    expect(note).not.toContain('covers other scenes too, so this opens');
  });

  it("says when a scene's players are not even on one scale", () => {
    // The honest caveat of the whole design. A scene board is comparable
    // *internally* because the scene sits inside one pool; this is the case
    // where it does not, so the board is the largest pool and some of the
    // scene's own players are on another. Reachable: an event's pairings
    // connect the players they pair, and the engine places a player from the
    // history it last replayed. A fact about the pools, not about the scene,
    // which cannot be split.
    const note = sceneLadderNote(
      scene({ sceneId: 's', componentId: 'c', componentSize: 90, componentCount: 3 })
    );
    expect(note).toContain('3 separate rating pools');
    expect(note).toContain('not all on one scale');
    expect(note).toContain('largest of them');
  });

  it('says a scene with no pool has an empty board, not a missing one', () => {
    // The board exists and is empty, which says "nobody who plays here has been
    // placed yet" better than a withheld link ever did - and the scene is a
    // fact about its stores either way.
    const note = sceneLadderNote(
      scene({ sceneId: 's', componentId: null, componentSize: null, componentCount: 0 })
    );
    expect(note).toContain('board is empty');
    expect(note).toContain('still where these stores are');
  });

  it('stays quiet about purity unless the scene is genuinely split', () => {
    // 100% means nothing to say, so neither half is offered at all.
    expect(scenePurityHint(scene({ sceneId: 's', medianPurity: 1 }))).toBeNull();
    expect(scenePurityLabel(scene({ sceneId: 's', medianPurity: 1 }))).toBeNull();
    expect(scenePurityHint(scene({ sceneId: 's', medianPurity: null }))).toBeNull();
    expect(scenePurityLabel(scene({ sceneId: 's', medianPurity: null }))).toBeNull();

    // The figure is the figure; the hint says what it is a share *of*, and
    // that a split store is a real thing rather than a defect. The two halves
    // were one sentence that read the number out loud, which is the shape
    // this pass exists to remove.
    expect(scenePurityLabel(scene({ sceneId: 's', medianPurity: 0.76 }))).toBe('76%');
    const hint = scenePurityHint(scene({ sceneId: 's', medianPurity: 0.76 }));
    expect(hint).not.toContain('76%');
    expect(hint).toContain('rather than a mistake');
  });

  it('formats a spread at the precision it carries', () => {
    expect(formatSpread(0.4)).toBe('400 m');
    expect(formatSpread(4.25)).toBe('4.3 km');
    expect(formatSpread(133.4)).toBe('133 km');
    expect(formatSpread(1204)).toBe('1,204 km');
  });
});

describe('links to the ladder', () => {
  it('uses the scope the ladder already takes', () => {
    // A scene *is* a connected component, so the scope is the one
    // /api/rankings has always accepted. Spelled in one place so the map and
    // the ladder cannot drift. The *paths* are tested in ranking.test.ts,
    // beside the module they live in.
    // The argument is a **componentId** - a scene's `componentId`, which is
    // the pool it leads to - and never a `sceneId`. A scene is not a scope.
    expect(sceneScope('c00a489935b')).toBe('component:c00a489935b');
  });
});

describe('filterScenes', () => {
  const scenes = [
    scene({ sceneId: 'c-sing', label: 'Singapore' }),
    scene({ sceneId: 'c-bay', label: 'Martinez, CA' }),
    scene({ sceneId: 'c-blank', label: null }),
  ];

  it('returns everything for an empty query', () => {
    expect(filterScenes(scenes, '')).toHaveLength(3);
    expect(filterScenes(scenes, '   ')).toHaveLength(3);
  });

  it('matches the label, case- and whitespace-insensitively', () => {
    expect(filterScenes(scenes, '  SINGA ').map((s) => s.sceneId)).toEqual(['c-sing']);
    expect(filterScenes(scenes, '  singa  ').map((s) => s.sceneId)).toEqual(['c-sing']);
    expect(filterScenes(scenes, 'ca').map((s) => s.sceneId)).toEqual(['c-bay']);
  });

  it('matches the scene id, so a shared ?scene= link can be found by paste', () => {
    expect(filterScenes(scenes, 'c-blank').map((s) => s.sceneId)).toEqual(['c-blank']);
  });
});

describe('sceneBounds', () => {
  it('fits the located pins', () => {
    expect(
      sceneBounds([
        scene({ sceneId: 'a', latitude: 37.77, longitude: -122.41 }),
        scene({ sceneId: 'b', latitude: 1.35, longitude: 103.82 }),
        scene({ sceneId: 'c', latitude: -33.87, longitude: 151.21 }),
      ])
    ).toEqual([
      [-33.87, -122.41],
      [37.77, 151.21],
    ]);
  });

  it('ignores unlocated scenes rather than folding 0,0 into the box', () => {
    const london = scene({ sceneId: 'a', latitude: 51.5, longitude: -0.12, spreadKm: 0 });
    const box = sceneBounds([london, scene({ sceneId: 'b', latitude: null, longitude: null })]);
    // Centred on the one located pin, not on the midpoint between it and the
    // Gulf of Guinea.
    expect(box).not.toBeNull();
    expect((box![0][0] + box![1][0]) / 2).toBeCloseTo(51.5, 10);
    expect((box![0][1] + box![1][1]) / 2).toBeCloseTo(-0.12, 10);
  });

  /**
   * One pin has no extent, so the pad alone says what the frame means - and
   * there must be exactly one answer to that in this module. `sceneBounds`
   * used to pad a flat degree (222km) where `sceneFocusBounds` pads
   * `MIN_FRAME_KM` (30km), which in the picker's 349x320 pane is the
   * difference between zoom 6 - the threshold the detail tier switches on at,
   * where 10m and 110m coastline look alike - and zoom 9, the metro the 30km
   * figure was measured for.
   */
  it('frames a single pin at the same scale as framing that scene', () => {
    const only = scene({ sceneId: 'a', latitude: 10, longitude: 20, spreadKm: 0 });
    expect(sceneBounds([only])).toEqual(sceneFocusBounds(only));
  });

  it('has nothing to fit when nothing is located', () => {
    expect(sceneBounds([])).toBeNull();
    expect(sceneBounds([scene({ sceneId: 'a', latitude: null, longitude: null })])).toBeNull();
  });
});

describe('sceneCoverageSentence', () => {
  it('distinguishes "we cannot tell" from "nothing is located"', () => {
    // These are different answers, not degrees of the same one. The first is
    // the live state until the engine refits with the place fields; the second
    // is a gap in the shops table.
    const cannotTell = sceneCoverageSentence({
      totalScenes: 0,
      locatedScenes: 0,
      dispersedScenes: 0,
      locatedPlayers: 0,
      unassignedVenues: null,
      totalPlayers: 0,
      catalogueUnavailable: true,
    });
    const noneLocated = sceneCoverageSentence({
      totalScenes: 1235,
      locatedScenes: 0,
      dispersedScenes: 0,
      locatedPlayers: 0,
      unassignedVenues: null,
      totalPlayers: 27318,
      catalogueUnavailable: false,
    });

    expect(cannotTell).not.toBe(noneLocated);
    expect(cannotTell).toContain('no store has been placed in a scene');
    // And it never claims there are no scenes, which "0 scenes" would.
    expect(cannotTell).not.toContain('0 scenes');
    expect(noneLocated).toContain('1,235 scenes');
    expect(noneLocated).toContain('none of them locatable');
  });

  it('leads with the ratio when some scenes are located', () => {
    expect(
      sceneCoverageSentence({
        totalScenes: 1235,
        locatedScenes: 1180,
        dispersedScenes: 0,
        locatedPlayers: 26500,
        unassignedVenues: null,
        totalPlayers: 27318,
        catalogueUnavailable: false,
      })
    ).toBe('1,180 of 1,235 scenes on the map, holding 97% of recorded players.');
  });

  it('names the dispersed scenes, because they hold the missing players', () => {
    // The production shape: 1,282 of 1,302 scenes are pinned and they hold
    // only 60% of the players, because the 20 that are not hold the other
    // 40%. Without the second clause a reader is left wondering where they
    // went.
    const sentence = sceneCoverageSentence({
      totalScenes: 1302,
      locatedScenes: 1282,
      dispersedScenes: 20,
      locatedPlayers: 19038,
      unassignedVenues: null,
      totalPlayers: 31893,
      catalogueUnavailable: false,
    });
    expect(sentence).toContain('1,282 of 1,302 scenes');
    expect(sentence).toContain('60%');
    expect(sentence).toContain('20 more play across too many regions to pin');
  });

  it('counts the stores in no scene, because nothing else on the page can', () => {
    // A store that failed the rankability gate is absent from a catalogue of
    // scenes by construction, so it cannot be listed. If this line does not
    // count it, nothing does, and a reader looking for Palo Alto concludes the
    // map lost it. 38 venues on the live production assignment.
    const sentence = sceneCoverageSentence({
      totalScenes: 1123,
      locatedScenes: 1123,
      dispersedScenes: 0,
      unassignedVenues: 38,
      locatedPlayers: 33737,
      totalPlayers: 33737,
      catalogueUnavailable: false,
    });
    expect(sentence).toContain('38 stores are in no scene yet');

    // One store reads as one store.
    expect(
      sceneCoverageSentence({
        totalScenes: 5,
        locatedScenes: 5,
        dispersedScenes: 0,
        unassignedVenues: 1,
        locatedPlayers: 10,
        totalPlayers: 10,
        catalogueUnavailable: false,
      })
    ).toContain('1 store is in no scene yet');

    // And an engine that does not publish the figure says nothing, rather than
    // claiming every store is placed.
    const silent = sceneCoverageSentence({
      totalScenes: 5,
      locatedScenes: 5,
      dispersedScenes: 0,
      unassignedVenues: null,
      locatedPlayers: 10,
      totalPlayers: 10,
      catalogueUnavailable: false,
    });
    expect(silent).not.toContain('no scene');
  });

  it('does not divide by zero on an empty but readable catalogue', () => {
    expect(
      sceneCoverageSentence({
        totalScenes: 1,
        locatedScenes: 1,
        dispersedScenes: 0,
        locatedPlayers: 0,
        unassignedVenues: null,
        totalPlayers: 0,
        catalogueUnavailable: false,
      })
    ).toContain('0%');
  });
});

describe('a dispersed scene', () => {
  it('explains the missing pin with the distance that caused it', () => {
    // The measured worst case: 2,138 players across 103 venues, centroid
    // 2,080km out in the Pacific. "Spans several regions" is vague; the
    // number is a fact a reader can weigh.
    const hint = scenePlaceHint(
      scene({
        sceneId: 'c-pacific',
        dispersed: true,
        latitude: null,
        longitude: null,
        spreadKm: 5871.6,
        nearestVenueKm: 2079.7,
        venueCount: 103,
      })
    );

    expect(hint).toContain('103 venues');
    expect(hint).toContain('2,080 km');
    expect(hint).toContain('busiest venues are shown instead');
    // Never the sentence for a scene nobody has geocoded: this one is mapped
    // perfectly well, it is simply not in one place.
    expect(hint).not.toContain('geocoded');
  });

  it('still explains itself when the distance is missing', () => {
    const hint = scenePlaceHint(
      scene({ sceneId: 'c', dispersed: true, latitude: null, longitude: null, nearestVenueKm: null })
    );
    expect(hint).toContain('too far apart');
    expect(hint).not.toContain('null');
  });

  it('is told apart from a scene with no geography at all', () => {
    const dispersed = scenePlaceHint(
      scene({ sceneId: 'a', dispersed: true, latitude: null, longitude: null, nearestVenueKm: 900 })
    );
    const ungeocoded = scenePlaceHint(
      scene({ sceneId: 'b', dispersed: false, latitude: null, longitude: null, nearestVenueKm: null })
    );
    expect(dispersed).not.toBe(ungeocoded);
    expect(ungeocoded).toContain('geocoded');
  });
});

/**
 * The frame for one scene, which is what the picker's mini map opens on.
 *
 * The case that carries the whole feature is the **dispersed** one: such a
 * scene has no centroid to fly to, and framing nothing would look exactly like
 * the map having lost the scene the ladder is scoped to.
 */
describe('sceneFocusBounds', () => {
  it('frames a located scene on its pin, padded by its own spread', () => {
    const bounds = sceneFocusBounds(
      scene({ sceneId: 'a', latitude: 0, longitude: 0, spreadKm: 111 })
    );
    // On the equator a degree is ~111km each way, so a 111km spread is ~1deg.
    expect(bounds).not.toBeNull();
    const [[south, west], [north, east]] = bounds!;
    expect(south).toBeCloseTo(-1, 2);
    expect(north).toBeCloseTo(1, 2);
    expect(west).toBeCloseTo(-1, 2);
    expect(east).toBeCloseTo(1, 2);
  });

  it('opens on a neighbourhood for a single-venue scene, not a street', () => {
    // No extent at all: the floor is what stops `fitBounds` zooming to a
    // basemap of one road, where a single building is less use than a city.
    const bounds = sceneFocusBounds(
      scene({ sceneId: 'a', latitude: 10, longitude: 20, spreadKm: null })
    );
    const [[south, west], [north, east]] = bounds!;
    expect(north - south).toBeGreaterThan(0.05);
    expect(east - west).toBeGreaterThan(0.05);
  });

  it('frames a dispersed scene on its venues, which are its only real places', () => {
    // Toronto, roughly: a centroid 2,328km from its nearest venue is withheld
    // by the API, so the venues are all there is - and they are what the map
    // draws for such a scene.
    const bounds = sceneFocusBounds(
      scene({
        sceneId: 'c-tor',
        dispersed: true,
        latitude: null,
        longitude: null,
        spreadKm: 1858,
        topVenues: [
          { shopExternalId: 1, latitude: 43.65, longitude: -79.38, matchCount: 400 },
          { shopExternalId: 2, latitude: 43.7, longitude: -79.2, matchCount: 120 },
        ],
      })
    );
    const [[south, west], [north, east]] = bounds!;
    expect(south).toBeLessThan(43.65);
    expect(north).toBeGreaterThan(43.7);
    expect(west).toBeLessThan(-79.38);
    expect(east).toBeGreaterThan(-79.2);
    // And emphatically *not* the 1,858km spread: that figure is the reason the
    // scene has no pin, not a radius to open the camera at.
    expect(north - south).toBeLessThan(1);
  });

  it('has nothing to frame for a scene with neither pin nor venue', () => {
    expect(
      sceneFocusBounds(
        scene({ sceneId: 'a', latitude: null, longitude: null, topVenues: [] })
      )
    ).toBeNull();
  });

  it('pads longitude by more degrees at high latitude, since degrees shrink', () => {
    const equator = sceneFocusBounds(
      scene({ sceneId: 'a', latitude: 0, longitude: 0, spreadKm: 50 })
    )!;
    const arctic = sceneFocusBounds(
      scene({ sceneId: 'b', latitude: 70, longitude: 0, spreadKm: 50 })
    )!;
    expect(arctic[1][1] - arctic[0][1]).toBeGreaterThan(equator[1][1] - equator[0][1]);
  });
});
