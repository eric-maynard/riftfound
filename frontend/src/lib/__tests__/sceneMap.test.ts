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
  sceneScope,
  scenePath,
  filterScenes,
  formatSpread,
  UNNAMED_SCENE_LABEL,
} from '../sceneMap';
import type { SceneMapEntry } from '../../types/ranking';

function scene(overrides: Partial<SceneMapEntry> & { componentId: string }): SceneMapEntry {
  return {
    regionLabel: 'Martinez, CA',
    playerCount: 40,
    ratedPlayers: 12,
    matchCount: 300,
    venueCount: 4,
    isGiant: false,
    comparable: true,
    latitude: 38.0194,
    longitude: -122.1341,
    spreadKm: 12.5,
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
    expect(sceneSpreadRadiusMeters(scene({ componentId: 'c', spreadKm: 12.5 }))).toBe(12_500);
    // The 133km corridor measured on the California sample: a real distance,
    // drawn as one, rather than a dot pretending to be a city.
    expect(sceneSpreadRadiusMeters(scene({ componentId: 'c', spreadKm: 133.4 }))).toBe(133_400);
  });

  it('draws no disc where there is no extent', () => {
    // A single-store scene really is a point. An arbitrary minimum radius
    // would assert a spread it does not have.
    expect(sceneSpreadRadiusMeters(scene({ componentId: 'c', spreadKm: 0 }))).toBeNull();
    expect(sceneSpreadRadiusMeters(scene({ componentId: 'c', spreadKm: null }))).toBeNull();
    expect(sceneSpreadRadiusMeters(scene({ componentId: 'c', spreadKm: -1 }))).toBeNull();
  });
});

describe('labels and copy', () => {
  it('never renders a blank name', () => {
    expect(sceneLabel(scene({ componentId: 'c', regionLabel: 'Singapore' }))).toBe('Singapore');
    expect(sceneLabel(scene({ componentId: 'c', regionLabel: null }))).toBe(UNNAMED_SCENE_LABEL);
    expect(sceneLabel(scene({ componentId: 'c', regionLabel: '   ' }))).toBe(UNNAMED_SCENE_LABEL);
  });

  it('summarises players, rated players and venues, with plurals', () => {
    expect(sceneSummary(scene({ componentId: 'c', playerCount: 4654, ratedPlayers: 1203, venueCount: 211 }))).toBe(
      '4,654 players · 1,203 rated · 211 venues'
    );
    // The one-of-everything case, which is the common shape of a tiny scene.
    expect(sceneSummary(scene({ componentId: 'c', playerCount: 1, ratedPlayers: 0, venueCount: 1 }))).toBe(
      '1 player · 0 rated · 1 venue'
    );
  });

  it('says a pin is weighted by play, and what it was computed from', () => {
    const hint = scenePlaceHint(scene({ componentId: 'c', venueCount: 4, locatedVenues: 4, spreadKm: 12.5 }));
    expect(hint).toContain('weighted by matches played');
    expect(hint).toContain('all 4 of its venues');
    // Rounded past 10km, where the decimal stops carrying information.
    expect(hint).toContain('13 km');
  });

  it('says when a pin describes only part of its scene', () => {
    // The case a reader could not otherwise see: a pin derived from 2 of 40
    // stores describes a corner of the scene, not the scene.
    const hint = scenePlaceHint(scene({ componentId: 'c', venueCount: 40, locatedVenues: 2 }));
    expect(hint).toContain('2 of its 40 venues');
  });

  it('says a single-location scene has no spread rather than printing 0 km', () => {
    const hint = scenePlaceHint(scene({ componentId: 'c', spreadKm: 0, venueCount: 1, locatedVenues: 1 }));
    expect(hint).toContain('single location');
    expect(hint).not.toContain('0 km');
  });

  it('explains an unlocated scene without blaming the ladder', () => {
    const hint = scenePlaceHint(scene({ componentId: 'c', latitude: null, longitude: null, spreadKm: null }));
    expect(hint).toContain('geocoded');
    expect(hint).not.toContain('weighted');
  });

  it('explains a scene too small to order, and that its ratings still exist', () => {
    expect(sceneComparableHint(scene({ componentId: 'c', comparable: true }), 8)).toBeNull();

    const hint = sceneComparableHint(scene({ componentId: 'c', comparable: false, playerCount: 3 }), 8);
    expect(hint).toContain('at least 8 players');
    expect(hint).toContain('3');
    // The distinction the ladder already draws: a comparison problem is not an
    // evidence problem, and the number is published either way.
    expect(hint).toContain('still published');
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
    // the ladder cannot drift.
    expect(sceneScope('c00a489935b')).toBe('component:c00a489935b');
    expect(scenePath('c00a489935b')).toBe('/rankings?region=c00a489935b');
  });

  it('encodes an id that needs it', () => {
    expect(scenePath('a b&c')).toBe('/rankings?region=a%20b%26c');
  });
});

describe('filterScenes', () => {
  const scenes = [
    scene({ componentId: 'c-sing', regionLabel: 'Singapore' }),
    scene({ componentId: 'c-bay', regionLabel: 'Martinez, CA' }),
    scene({ componentId: 'c-blank', regionLabel: null }),
  ];

  it('returns everything for an empty query', () => {
    expect(filterScenes(scenes, '')).toHaveLength(3);
    expect(filterScenes(scenes, '   ')).toHaveLength(3);
  });

  it('matches the label, case- and whitespace-insensitively', () => {
    expect(filterScenes(scenes, '  SINGA ').map((s) => s.componentId)).toEqual(['c-sing']);
    expect(filterScenes(scenes, '  singa  ').map((s) => s.componentId)).toEqual(['c-sing']);
    expect(filterScenes(scenes, 'ca').map((s) => s.componentId)).toEqual(['c-bay']);
  });

  it('matches the component id, so a shared link can be found', () => {
    expect(filterScenes(scenes, 'c-blank').map((s) => s.componentId)).toEqual(['c-blank']);
  });
});

describe('sceneBounds', () => {
  it('fits the located pins', () => {
    expect(
      sceneBounds([
        scene({ componentId: 'a', latitude: 37.77, longitude: -122.41 }),
        scene({ componentId: 'b', latitude: 1.35, longitude: 103.82 }),
        scene({ componentId: 'c', latitude: -33.87, longitude: 151.21 }),
      ])
    ).toEqual([
      [-33.87, -122.41],
      [37.77, 151.21],
    ]);
  });

  it('ignores unlocated scenes rather than folding 0,0 into the box', () => {
    expect(
      sceneBounds([
        scene({ componentId: 'a', latitude: 51.5, longitude: -0.12 }),
        scene({ componentId: 'b', latitude: null, longitude: null }),
      ])
    ).toEqual([
      [50.5, -1.12],
      [52.5, 0.88],
    ]);
  });

  it('pads a single pin so the map does not open at street level', () => {
    expect(sceneBounds([scene({ componentId: 'a', latitude: 10, longitude: 20 })])).toEqual([
      [9, 19],
      [11, 21],
    ]);
  });

  it('has nothing to fit when nothing is located', () => {
    expect(sceneBounds([])).toBeNull();
    expect(sceneBounds([scene({ componentId: 'a', latitude: null, longitude: null })])).toBeNull();
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
      locatedPlayers: 0,
      totalPlayers: 0,
      catalogueUnavailable: true,
    });
    const noneLocated = sceneCoverageSentence({
      totalScenes: 1235,
      locatedScenes: 0,
      locatedPlayers: 0,
      totalPlayers: 27318,
      catalogueUnavailable: false,
    });

    expect(cannotTell).not.toBe(noneLocated);
    expect(cannotTell).toContain('has not published');
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
        locatedPlayers: 26500,
        totalPlayers: 27318,
        catalogueUnavailable: false,
      })
    ).toBe('1,180 of 1,235 scenes on the map, holding 97% of recorded players.');
  });

  it('does not divide by zero on an empty but readable catalogue', () => {
    expect(
      sceneCoverageSentence({
        totalScenes: 1,
        locatedScenes: 1,
        locatedPlayers: 0,
        totalPlayers: 0,
        catalogueUnavailable: false,
      })
    ).toContain('0%');
  });
});
