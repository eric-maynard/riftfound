import { describe, it, expect } from 'vitest';
import { ObservationBuilder } from '../ranking/observations.js';
import { buildEras } from '../ranking/sets.js';
import { findComponents } from '../ranking/graph.js';
import { buildSnapshot, DEFAULT_SNAPSHOT_OPTIONS } from '../ranking/snapshot.js';
import {
  assignScenesFromRegions,
  DEFAULT_MIN_INTRA_SHARE,
  SCENE_ASSIGNMENT_VERSION,
} from '../ranking/scenes.js';
import { parseRegions, type RegionDefinition } from '../ranking/regions.js';
import type { EventResults } from '../database.js';

/**
 * Scenes: the venue -> scene assignment, derived from the drawn regions.
 *
 * The properties pinned here are the ones the design rests on, not the surface
 * of the API:
 *
 * - **a store belongs to one scene**, by point-in-polygon test, and the purity
 *   says how true that is of its play.
 * - **`componentId` is untouched.** A scene is an addition; redefining the
 *   component would silently corrupt `crossComponentUncertainty`, whose formula
 *   is only valid for a connected component.
 * - **a region's id does not move when the membership does.** That is the
 *   entire reason this replaced a clustering, and `carriesSceneId` is how the
 *   ids a clustering already handed out survive the move.
 * - **the play-share measurement is a health signal, not a gate.** A region
 *   below the bar is published with `ladderMeaningful: false`; it does not
 *   vanish, because a human drew it.
 * - **a store in no region is null, and reported.** Nothing is snapped to the
 *   nearest polygon.
 * - **a geocode is never a venue id.** `venueKey`'s `geo:` fallback moves if the
 *   geocode moves, so an unresolved organizer gets no venue item and no scene.
 */

const eras = buildEras();

function event(
  id: string,
  date: string,
  pairs: [string, string][],
  shopExternalId: number | null
): EventResults {
  const players = [...new Set(pairs.flat())];
  const teamId = (player: string) => `t-${id}-${player}`;
  return {
    externalId: `prb-${id}`,
    tournamentId: id,
    eventStartDate: new Date(`${date}T18:00:00.000Z`),
    eventType: 'Nexus Night',
    playFormat: null,
    shopExternalId,
    latitude: 37 + (shopExternalId ?? 9) * 0.5,
    longitude: -122,
    status: 'final',
    roundCount: 1,
    playerCount: players.length,
    openMatches: 0,
    players: players.map(player => ({
      teamId: teamId(player),
      playerId: player,
      name: `Name ${player}`,
      tagLine: 'NA1',
    })),
    standings: [],
    rounds: [
      {
        section: 0,
        roundNumber: 1,
        status: 'FINALIZED',
        byeTeamIds: [],
        matches: pairs.map(([a, b], index) => ({
          matchId: `${id}-m${index}`,
          tableNumber: index + 1,
          status: 'COMPLETED',
          bye: false,
          sides: [
            { teamId: teamId(a), outcome: 'WIN', gameWins: 1 },
            { teamId: teamId(b), outcome: 'LOSS', gameWins: 0 },
          ],
          games: [{ number: 1, winnerTeamId: teamId(a) }],
        })),
      },
    ],
    sourceUpdatedAt: null,
    capturedAt: '2026-10-25T00:00:00.000Z',
  };
}

function build(facts: EventResults[]) {
  const builder = new ObservationBuilder(eras, new Map(), Number.POSITIVE_INFINITY, false);
  for (const fact of facts) builder.addResults(fact);
  return builder.finish();
}

/** Every pairing among `players`, repeated `rounds` times, all at one store. */
function clique(prefix: string, players: string[], shopExternalId: number | null, rounds = 2): EventResults[] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) pairs.push([players[i], players[j]]);
  }
  return Array.from({ length: rounds }, (_, round) =>
    event(`${prefix}${round}`, `2026-10-0${round + 1}`, pairs, shopExternalId)
  );
}

const west = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
const east = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'];

/**
 * Two dense local scenes, each with two stores, joined by one travelling
 * player. The component partition sees one blob; the regions see two.
 *
 * The fixture's shops sit at latitude `37 + shopId * 0.5` on longitude -122, so
 * shop:1 and shop:2 are at 37.5 and 38.0 and shop:3 and shop:4 at 38.5 and 39.0
 * - which is what the two boxes below are drawn around.
 */
function twoScenes() {
  return build([
    ...clique('w', west, 1),
    ...clique('w2nd', west, 2, 1),
    ...clique('e', east, 3),
    ...clique('e2nd', east, 4, 1),
    event('bridge', '2026-10-05', [['w1', 'e1']], 1),
  ]);
}

/** A closed-enough axis-aligned box, in `[lng, lat]` order. */
function box(minLng: number, minLat: number, maxLng: number, maxLat: number): number[][] {
  return [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
  ];
}

function regions(...definitions: RegionDefinition[]) {
  return parseRegions([{ path: 'test.json', text: JSON.stringify(definitions) }]);
}

/** Two boxes: one over shop:1 and shop:2, one over shop:3 and shop:4. */
function twoRegions() {
  return regions(
    {
      id: 'r-west',
      name: 'West Valley',
      rings: [box(-122.5, 37.25, -121.5, 38.25)],
      // The id a clustering already handed out, carried forward so a shared
      // `?scene=` link and the stored items keep resolving.
      carriesSceneId: 's94af82a16f',
    },
    { id: 'r-east', name: 'East Valley', rings: [box(-122.5, 38.25, -121.5, 39.25)] }
  );
}

describe('assignScenesFromRegions', () => {
  const observations = twoScenes();

  it('assigns every store to exactly one region, and says how pure that is', () => {
    const assignment = assignScenesFromRegions(observations, twoRegions(), {
      generatedAt: new Date('2026-10-26T00:00:00.000Z'),
    });

    expect(assignment.version).toBe(SCENE_ASSIGNMENT_VERSION);
    expect(assignment.minIntraShare).toBe(DEFAULT_MIN_INTRA_SHARE);
    expect(assignment.venues.map(row => row.venue)).toEqual([
      'shop:1',
      'shop:2',
      'shop:3',
      'shop:4',
    ]);
    // One row per venue: a store cannot be in two regions. The loader refuses
    // overlapping polygons outright, so this is the downstream half of it.
    expect(new Set(assignment.venues.map(row => row.venue)).size).toBe(assignment.venues.length);

    const sceneOf = new Map(assignment.venues.map(row => [row.venue, row.sceneId]));
    expect(sceneOf.get('shop:1')).toBe(sceneOf.get('shop:2'));
    expect(sceneOf.get('shop:3')).toBe(sceneOf.get('shop:4'));
    expect(sceneOf.get('shop:1')).not.toBe(sceneOf.get('shop:3'));
    expect(assignment.scenes).toHaveLength(2);
    expect(assignment.unplaced).toEqual([]);
    expect(assignment.stats.boundaryTies).toBe(0);

    // The stores with no visitors from the other scene are perfectly pure; the
    // bridge venue is not, which is exactly the signal purity exists to carry.
    expect(assignment.venues.find(row => row.venue === 'shop:2')!.purity).toBe(1);
    const bridged = assignment.venues.find(row => row.venue === 'shop:1')!;
    expect(bridged.purity).toBeLessThan(1);
    expect(bridged.purity).toBeGreaterThan(0.9);
    expect(assignment.stats.medianPurity).toBeGreaterThan(0.9);
  });

  it('publishes the carried scene id, and keeps the region id behind it', () => {
    // This is the migration in one assertion. The polygon's own id is
    // `r-west`; what every reader sees is the scene id the clustering had
    // already handed out, so a bookmarked `?scene=s94af82a16f` still resolves
    // and no stored item is orphaned.
    const assignment = assignScenesFromRegions(observations, twoRegions());
    const west = assignment.venues.find(row => row.venue === 'shop:1')!;
    expect(west.sceneId).toBe('s94af82a16f');
    expect(west.regionId).toBe('r-west');

    const scene = assignment.scenes.find(row => row.sceneId === 's94af82a16f')!;
    expect(scene.regionId).toBe('r-west');
    expect(scene.label).toBe('West Valley');

    // A region that succeeds nothing publishes under its own id, which is
    // deliberately distinguishable from a scene id at a glance.
    const east = assignment.venues.find(row => row.venue === 'shop:3')!;
    expect(east.sceneId).toBe('r-east');
    expect(east.regionId).toBe('r-east');
  });

  it('takes a region name verbatim, never deriving one from the stores in it', () => {
    // The old rule was the match-weighted modal city label of a cluster's
    // venues, corrected by a table keyed on the cluster's busiest shop id -
    // which detached the first time a busier store opened. A polygon carries
    // its own name, so no city label can change it.
    const assignment = assignScenesFromRegions(observations, twoRegions(), {
      venueLabels: new Map([
        ['shop:1', 'Oakland, CA'],
        ['shop:2', 'Oakland, CA'],
      ]),
    });
    expect(assignment.scenes.map(scene => scene.label).sort()).toEqual([
      'East Valley',
      'West Valley',
    ]);
  });

  it('does not change what componentId means - the whole graph is still one component', () => {
    expect(findComponents(observations).components).toHaveLength(1);
    expect(assignScenesFromRegions(observations, twoRegions()).scenes).toHaveLength(2);
  });

  it('is deterministic - the same inputs give byte-identical assignments', () => {
    const at = new Date('2026-10-26T00:00:00.000Z');
    const a = assignScenesFromRegions(observations, twoRegions(), { generatedAt: at });
    const b = assignScenesFromRegions(observations, twoRegions(), { generatedAt: at });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('is unmoved by a store opening outside every region', () => {
    // The whole point of the change. Under the clustering, adding a store
    // re-ran an agglomeration and moved boundaries elsewhere; here the two
    // regions report the identical membership and the new store is reported as
    // unplaced rather than absorbed by whichever polygon is nearest.
    const before = assignScenesFromRegions(observations, twoRegions());
    const after = assignScenesFromRegions(
      build([
        ...clique('w', west, 1),
        ...clique('w2nd', west, 2, 1),
        ...clique('e', east, 3),
        ...clique('e2nd', east, 4, 1),
        ...clique('f', ['f1', 'f2', 'f3', 'f4'], 5),
        event('bridge', '2026-10-05', [['w1', 'e1']], 1),
      ]),
      twoRegions()
    );

    expect(after.venues.map(row => `${row.venue}=${row.sceneId}`)).toEqual(
      before.venues.map(row => `${row.venue}=${row.sceneId}`)
    );
    expect(after.scenes.map(scene => scene.sceneId)).toEqual(
      before.scenes.map(scene => scene.sceneId)
    );
    // shop:5 sits at 39.5, north of both boxes.
    expect(after.unplaced.map(row => row.venue)).toEqual(['shop:5']);
    expect(after.stats.unplacedVenues).toBe(1);
    expect(after.stats.unplacedPlayers).toBe(4);
    expect(after.unplaced[0].latitude).toBeCloseTo(39.5, 6);
    expect(after.unplaced[0].longitude).toBeCloseTo(-122, 6);
  });

  it('never assigns a scene to a venue without a real shop id', () => {
    // An organizer that never resolved to a shop: venueKey falls back to a 1km
    // coordinate rounding, which would move if the geocode moved. The fixture
    // puts such an event at latitude 41.5, so it is also outside both boxes -
    // the assertion is that it is not even a candidate.
    const withUnresolved = build([
      ...clique('w', west, 1),
      ...clique('u', ['u1', 'u2', 'u3', 'u4'], null),
    ]);
    const assignment = assignScenesFromRegions(withUnresolved, twoRegions());
    expect(assignment.venues.every(row => row.venue.startsWith('shop:'))).toBe(true);
    expect(assignment.unplaced.every(row => row.venue.startsWith('shop:'))).toBe(true);
    expect(assignment.venues.every(row => Number.isFinite(row.shopExternalId))).toBe(true);
  });

  it('reports the extent of the stores actually in a region, not of the polygon', () => {
    const assignment = assignScenesFromRegions(observations, twoRegions());
    // shop:1 and shop:2 are half a degree of latitude apart, ~55km.
    const west = assignment.scenes.find(scene => scene.regionId === 'r-west')!;
    expect(west.extentKm).toBeGreaterThan(50);
    expect(west.extentKm).toBeLessThan(60);
    expect(assignment.stats.maxExtentKm).toBe(
      Math.max(...assignment.scenes.map(scene => scene.extentKm))
    );
  });
});

describe('the play-share measurement is a health signal, not a gate', () => {
  it('publishes a region whose players mostly play elsewhere, flagged', () => {
    // Four locals who only ever play visitors from the eastern scene: their
    // store's internal play share is 0, which under the clustering deleted the
    // scene and published its venues with no scene at all. A human drew this
    // boundary, so it stays - with the measurement attached.
    const visitors: [string, string][] = [
      ['h1', 'e1'],
      ['h2', 'e2'],
      ['h3', 'e3'],
      ['h4', 'e4'],
    ];
    const observations = build([
      ...clique('e', east, 3),
      ...clique('e2nd', east, 4, 1),
      event('away0', '2026-10-01', visitors, 1),
      event('away1', '2026-10-02', visitors, 1),
    ]);
    const assignment = assignScenesFromRegions(observations, twoRegions());

    const hollow = assignment.scenes.find(scene => scene.regionId === 'r-west')!;
    expect(hollow.intraShare).toBe(0);
    expect(hollow.ladderMeaningful).toBe(false);
    // Published, named, and holding its store - the two assertions that say
    // this is not a gate.
    expect(assignment.venues.find(row => row.venue === 'shop:1')!.sceneId).toBe('s94af82a16f');
    expect(assignment.unplaced).toEqual([]);

    const healthy = assignment.scenes.find(scene => scene.regionId === 'r-east')!;
    expect(healthy.ladderMeaningful).toBe(true);
    expect(healthy.intraShare).toBeGreaterThan(0.5);

    expect(assignment.stats.lowIntraShareScenes).toBe(1);
    expect(assignment.stats.lowIntraSharePlayers).toBe(4);
  });

  it('reads the flag against the published threshold, so the bar is visible', () => {
    const observations = twoScenes();
    const strict = assignScenesFromRegions(observations, twoRegions(), { minIntraShare: 1.1 });
    expect(strict.minIntraShare).toBe(1.1);
    expect(strict.scenes.every(scene => scene.ladderMeaningful)).toBe(false);
    expect(strict.stats.lowIntraShareScenes).toBe(2);
    // And still nothing is withheld: every store keeps its region.
    expect(strict.venues).toHaveLength(4);
    expect(strict.unplaced).toEqual([]);
  });
});

describe('the refit places stores in regions, it does not fit a partition', () => {
  const observations = twoScenes();
  const venueLabels = new Map([
    ['shop:1', 'Oakland, CA'],
    ['shop:2', 'Oakland, CA'],
    ['shop:3', 'Fresno, CA'],
    ['shop:4', 'Fresno, CA'],
  ]);
  const base = {
    ...DEFAULT_SNAPSHOT_OPTIONS,
    eras,
    venueLabels,
    matchLogEvents: new Set<string>(),
    whr: {},
    // Every player here has 10 matches at most; the real bar would admit few of
    // them and the venue roster is what is being checked, not the bar.
    minGames: 1,
    maxUncertaintyElo: 1000,
    minComponentSize: 1,
    generatedAt: new Date('2026-10-26T00:00:00.000Z'),
  };

  it('publishes venue items with null scenes until a polygon contains them', () => {
    const { snapshot, diagnostics } = buildSnapshot(observations, { ...base, sceneAssignment: null });
    expect(diagnostics.scenesUnassigned).toBe(true);
    expect(snapshot.scenes).toHaveLength(0);
    expect(snapshot.venues).toHaveLength(4);
    for (const venue of snapshot.venues) {
      expect(venue.sceneId).toBeNull();
      expect(venue.sceneLabel).toBeNull();
      expect(venue.scenePurity).toBeNull();
    }
    for (const profile of snapshot.profiles) expect(profile.sceneId).toBeNull();
  });

  it('carries the region onto the venue, the profile and the ladder row', () => {
    const assignment = assignScenesFromRegions(observations, twoRegions(), { venueLabels });
    const { snapshot, diagnostics } = buildSnapshot(observations, { ...base, sceneAssignment: assignment });

    expect(diagnostics.scenesUnassigned).toBe(false);
    expect(diagnostics.venueCount).toBe(4);
    expect(diagnostics.sceneCount).toBe(2);

    const venues = new Map(snapshot.venues.map(venue => [venue.venue, venue]));
    const one = venues.get('shop:1')!;
    expect(one.shopExternalId).toBe(1);
    expect(one.name).toBe('Oakland, CA');
    // The *store's* city label and the *region's* name are different things,
    // and the region's is what the scene fields carry.
    expect(one.sceneId).toBe('s94af82a16f');
    expect(one.sceneLabel).toBe('West Valley');
    expect(one.scenePurity).toBeGreaterThan(0.9);
    expect(one.latitude).toBeCloseTo(37.5, 6);
    expect(one.events).toBe(3); // two clique rounds plus the bridge event
    expect(one.players).toBe(7); // six westerners plus the visiting easterner

    // The roster is ordered by matches played here and carries the rating.
    expect(one.topPlayers.length).toBeGreaterThan(1);
    for (let i = 1; i < one.topPlayers.length; i++) {
      expect(one.topPlayers[i - 1].matches).toBeGreaterThanOrEqual(one.topPlayers[i].matches);
    }
    expect(one.topPlayersTruncated).toBe(false);

    // Every venue's scene exists in the scene directory, and the counts agree.
    const sceneIds = new Set(snapshot.scenes.map(scene => scene.sceneId));
    for (const venue of snapshot.venues) expect(sceneIds.has(venue.sceneId!)).toBe(true);
    expect(snapshot.scenes.reduce((sum, scene) => sum + scene.venueCount, 0)).toBe(4);
    expect(snapshot.scenes.reduce((sum, scene) => sum + scene.playerCount, 0)).toBe(
      snapshot.profiles.length
    );

    // The additive fields reach the profile and the ladder row too.
    for (const profile of snapshot.profiles) expect(sceneIds.has(profile.sceneId!)).toBe(true);
    for (const row of snapshot.rankings) expect(sceneIds.has(row.sceneId!)).toBe(true);

    // And `componentId` is untouched: still one component for everybody.
    expect(new Set(snapshot.profiles.map(profile => profile.componentId)).size).toBe(1);
  });

  it('publishes the play-share measurement on the SCENE# item', () => {
    // The API and UI say "this region's ladder is not meaningful yet" off these
    // two fields, which is only possible because the region is still here to
    // say it about.
    const assignment = assignScenesFromRegions(observations, twoRegions(), { venueLabels });
    const { snapshot } = buildSnapshot(observations, { ...base, sceneAssignment: assignment });
    for (const scene of snapshot.scenes) {
      expect(scene.regionId).toMatch(/^r-/);
      expect(typeof scene.intraShare).toBe('number');
      expect(scene.ladderMeaningful).toBe(true);
    }
    const west = snapshot.scenes.find(scene => scene.regionId === 'r-west')!;
    expect(west.sceneId).toBe('s94af82a16f');
    expect(west.label).toBe('West Valley');
  });

  it('gives each scene a place, from the same derivation a component gets', () => {
    // `scenePlace` takes venue tallies and knows nothing about which partition
    // produced them, which is why the map could move from `COMPONENT#` to
    // `SCENE#` without a line of arithmetic changing, and why the move to
    // polygons did not touch it either.
    const assignment = assignScenesFromRegions(observations, twoRegions(), { venueLabels });
    const { snapshot } = buildSnapshot(observations, { ...base, sceneAssignment: assignment });

    for (const scene of snapshot.scenes) {
      expect(scene.latitude).not.toBeNull();
      expect(scene.longitude).not.toBeNull();
      expect(scene.locatedVenues).toBe(scene.venueCount);
      expect(scene.locatedMatches).toBe(scene.matchCount);
      expect(scene.nearestVenueKm).not.toBeNull();
      // The busiest venues, descending, so `topVenues` is a map's drill-down
      // rather than whatever order a Map iterated in.
      expect(scene.topVenues.length).toBeGreaterThan(0);
      for (let i = 1; i < scene.topVenues.length; i++) {
        expect(scene.topVenues[i - 1].matchCount).toBeGreaterThanOrEqual(scene.topVenues[i].matchCount);
      }
      // Weighted by play, which means the centroid lies inside the span of the
      // stores it was computed from - stated against the scene's own venues
      // rather than a hardcoded box, so the assertion is about the arithmetic
      // and not about where the fixture happens to put its shops.
      const lats = scene.topVenues.map(venue => venue.latitude);
      expect(scene.latitude!).toBeGreaterThanOrEqual(Math.min(...lats) - 1e-6);
      expect(scene.latitude!).toBeLessThanOrEqual(Math.max(...lats) + 1e-6);
      const lons = scene.topVenues.map(venue => venue.longitude);
      expect(scene.longitude!).toBeGreaterThanOrEqual(Math.min(...lons) - 1e-6);
      expect(scene.longitude!).toBeLessThanOrEqual(Math.max(...lons) + 1e-6);
    }
  });

  it('names the rating pool a scene links to, without becoming one', () => {
    // A scene is not a rating scale: only a connected component is one, because
    // `crossComponentUncertainty` is correct for nothing else. The engine
    // therefore writes no `RANKING#scene:<id>` board - the API's `scene:<id>`
    // scope filters this pool's board instead - so the item carries the pool as
    // a separate field and `componentId` keeps its meaning.
    const assignment = assignScenesFromRegions(observations, twoRegions(), { venueLabels });
    const { snapshot } = buildSnapshot(observations, { ...base, sceneAssignment: assignment });

    const pools = new Set(snapshot.profiles.map(profile => profile.componentId));
    expect(pools.size).toBe(1);
    const [onlyPool] = [...pools];

    // Both scenes point at that one pool - which is the normal case and the
    // whole reason a scene cannot own a ladder: two places, one scale.
    expect(snapshot.scenes).toHaveLength(2);
    for (const scene of snapshot.scenes) {
      expect(scene.componentId).toBe(onlyPool);
      expect(scene.componentCount).toBe(1);
      expect(scene.componentSize).toBe(snapshot.profiles.length);
      // And the pool id is not the scene id. A UI that swapped them would ask
      // the API for `component:<a scene id>` and get an empty board.
      expect(scene.componentId).not.toBe(scene.sceneId);
    }
  });

  it('caps the denormalised roster and says it was cut short', () => {
    const assignment = assignScenesFromRegions(observations, twoRegions(), { venueLabels });
    const { snapshot } = buildSnapshot(observations, {
      ...base,
      sceneAssignment: assignment,
      venueTopPlayers: 3,
    });
    const one = snapshot.venues.find(venue => venue.venue === 'shop:1')!;
    expect(one.topPlayers).toHaveLength(3);
    expect(one.topPlayersTruncated).toBe(true);
    // The cap does not change the real count.
    expect(one.players).toBe(7);
  });

  it('leaves an unresolved organizer off the map entirely', () => {
    const withUnresolved = build([
      ...clique('w', west, 1),
      ...clique('u', ['u1', 'u2', 'u3', 'u4'], null),
    ]);
    const { snapshot } = buildSnapshot(withUnresolved, { ...base, sceneAssignment: null });
    expect(snapshot.venues.map(venue => venue.venue)).toEqual(['shop:1']);
    expect(snapshot.venues.every(venue => venue.venue.startsWith('shop:'))).toBe(true);
  });
});
