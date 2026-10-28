import { describe, it, expect } from 'vitest';
import { ObservationBuilder } from '../ranking/observations.js';
import { buildEras } from '../ranking/sets.js';
import { haversineKm } from '../ranking/sceneMap.js';
import {
  bucketVenues,
  clusterVenuesGeographically,
  completeLinkage,
  intraSceneShares,
  matchWeightedModalLabel,
  proposeGeoScenes,
  DEFAULT_GEO_BUCKET_KM,
  DEFAULT_GEO_MAX_DIAMETER_KM,
  type GeoVenue,
} from '../ranking/geoScenes.js';
import { sceneNameOverride, SCENE_NAME_OVERRIDES } from '../ranking/sceneNames.js';
import type { EventResults } from '../database.js';

/**
 * Geographic scenes: clustering the stores instead of the co-play graph.
 *
 * The properties pinned here are the ones the method rests on, not the surface
 * of the API:
 *
 * - **a scene's diameter is bounded, so it cannot chain through a hub.**
 *   Westchester plays in New York and Nassau plays in New York; that must not
 *   make Westchester and Nassau one scene. Single linkage cannot express that
 *   and complete linkage cannot violate it, which is the whole reason for the
 *   method.
 * - **the bucketing pre-pass cannot change the answer.** It exists only so the
 *   clustering is not quadratic over 2,500 venues, and a performance trick
 *   that quietly moved a store would be the worst kind of bug here.
 * - **the partition is a function of the coordinates alone.** An
 *   order-dependent scene would reshuffle the UI between two identical runs.
 * - **a scene is only published if its players actually play each other.** A
 *   compact cluster with no internal play cannot support a ladder, and
 *   "not in a rankable scene yet" is the honest answer.
 * - **the name follows the play, not the residents.**
 * - **`componentId` is untouched.** Scenes are additive, exactly as the
 *   Louvain path already promises.
 */

const eras = buildEras();

/** Degrees of latitude per km, so a test can state a distance and mean it. */
const KM = 1 / 111.1949;

function venue(shopExternalId: number, northKm: number, eastKm = 0, label: string | null = null): GeoVenue {
  return {
    venue: `shop:${shopExternalId}`,
    shopExternalId,
    latitude: northKm * KM,
    longitude: eastKm * KM,
    matches: 10,
    label,
  };
}

/** Clusters as comparable sets of sorted venue keys. */
function partition(clusters: { venues: string[] }[]): string[][] {
  return clusters.map(cluster => [...cluster.venues].sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The bound: a scene cannot chain through a hub
// ---------------------------------------------------------------------------

describe('complete linkage under a diameter cap', () => {
  /**
   * The case the method was chosen for.
   *
   * Three stores on a line, the outer two 25km from the middle one and 50km
   * from each other. Single linkage joins all three, because each hop is
   * inside the bound - which is precisely how a 240km "New York" and a 205km
   * "Los Angeles" were produced from a 40km threshold on production data.
   * Complete linkage cannot, because a cluster's *diameter* is what is
   * bounded, so every member is within 30km of every other member.
   */
  const hubAndSpokes = [venue(1, 0), venue(2, 25), venue(3, -25)];

  it('refuses to chain two stores together through a hub', () => {
    const clusters = clusterVenuesGeographically(hubAndSpokes, { maxDiameterKm: 30 });

    // Not one cluster of three: that is the defect.
    expect(clusters.length).toBe(2);
    // And specifically not the two outer stores together - they are 50km
    // apart and only related by both being near the middle one.
    for (const cluster of clusters) {
      const both = cluster.venues.includes('shop:2') && cluster.venues.includes('shop:3');
      expect(both).toBe(false);
    }
  });

  it('keeps every published scene inside the cap, whatever the shape', () => {
    // A dense line of stores 10km apart, 200km end to end: single linkage
    // would return one 200km "scene", which is a corridor and not a metro.
    const corridor = Array.from({ length: 21 }, (_, i) => venue(100 + i, i * 10));
    const clusters = clusterVenuesGeographically(corridor, { maxDiameterKm: 30 });

    expect(clusters.length).toBeGreaterThan(1);
    for (const cluster of clusters) {
      expect(cluster.diameterKm).toBeLessThanOrEqual(30 + 1e-6);
    }
    // Every store is still placed; capping the width drops nobody.
    expect(clusters.flatMap(cluster => cluster.venues).sort()).toEqual(
      corridor.map(row => row.venue).sort()
    );
  });

  it('holds a genuinely compact scene together', () => {
    // Singapore is the sanity check: 83 stores inside a 16km span on
    // production, and it must not be split by a 30km cap. Modelled here as a
    // tight cloud whose every pair is well inside the bound.
    const dense = Array.from({ length: 25 }, (_, i) => venue(200 + i, (i % 5) * 2, Math.floor(i / 5) * 2));
    const clusters = clusterVenuesGeographically(dense, { maxDiameterKm: 30 });

    expect(clusters.length).toBe(1);
    expect(clusters[0].venues.length).toBe(25);
  });

  it('splits that same scene when the cap is tighter than it is', () => {
    // The complement of the test above, so neither is passing by accident:
    // the cap is what decides, and a cluster wider than it is split.
    const dense = Array.from({ length: 25 }, (_, i) => venue(200 + i, (i % 5) * 2, Math.floor(i / 5) * 2));
    const clusters = clusterVenuesGeographically(dense, { maxDiameterKm: 5 });

    expect(clusters.length).toBeGreaterThan(1);
    for (const cluster of clusters) expect(cluster.diameterKm).toBeLessThanOrEqual(5 + 1e-6);
  });

  it('reports the diameter it measured, not a radius or a mean', () => {
    const pair = [venue(1, 0), venue(2, 20)];
    const [cluster] = clusterVenuesGeographically(pair, { maxDiameterKm: 30 });
    expect(cluster.diameterKm).toBeCloseTo(20, 0);
  });

  it('is a function of the coordinates and nothing else', () => {
    // An order-dependent partition would give the UI a different scene map on
    // two identical runs, which is the failure `rankingCommunities.test.ts`
    // already pins for Louvain's labelling.
    const venues = [venue(5, 0), venue(2, 12), venue(9, 24), venue(1, 70), venue(7, 80)];
    const forwards = clusterVenuesGeographically(venues, { maxDiameterKm: 30 });
    const backwards = clusterVenuesGeographically([...venues].reverse(), { maxDiameterKm: 30 });
    expect(partition(backwards)).toEqual(partition(forwards));
  });

  it('places a lone store in a scene of its own rather than dropping it', () => {
    // A 30km cap produces single-store scenes by design - the production run
    // has many - so this is the normal case, not an edge.
    const clusters = clusterVenuesGeographically([venue(1, 0), venue(2, 500)], { maxDiameterKm: 30 });
    expect(partition(clusters)).toEqual([['shop:1'], ['shop:2']]);
    expect(clusters.every(cluster => cluster.diameterKm === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The bucketing pre-pass is a performance trick and must stay one
// ---------------------------------------------------------------------------

describe('the bucketing pre-pass', () => {
  /**
   * The invariant: every pair of venues in a finished cluster is within the
   * diameter cap of each other, so every cluster is single-link-connected at
   * any radius at or above that cap - which means bucketing at a larger radius
   * and clustering inside each bucket cannot separate a cluster that should
   * exist. If that ever stopped holding, stores would silently stop being
   * grouped and nothing else would look wrong.
   */
  const spread = [
    venue(1, 0),
    venue(2, 18),
    venue(3, 29),
    venue(4, 55),
    venue(5, 66),
    venue(6, 95),
    venue(7, 300),
    venue(8, 312),
  ];

  it('gives the same answer at every bucket radius above the cap', () => {
    const atCap = clusterVenuesGeographically(spread, { maxDiameterKm: 30, bucketKm: 30 });
    const atDefault = clusterVenuesGeographically(spread, {
      maxDiameterKm: 30,
      bucketKm: DEFAULT_GEO_BUCKET_KM,
    });
    const atAbsurd = clusterVenuesGeographically(spread, { maxDiameterKm: 30, bucketKm: 40_000 });

    expect(partition(atDefault)).toEqual(partition(atCap));
    expect(partition(atAbsurd)).toEqual(partition(atCap));
  });

  it('never puts two venues in one bucket unless something is within the radius', () => {
    const buckets = bucketVenues(spread, 30);
    for (let i = 0; i < spread.length; i++) {
      for (let j = i + 1; j < spread.length; j++) {
        if (buckets[i] !== buckets[j]) continue;
        // Same bucket means single-link-connected at 30km, not necessarily
        // within 30km - so the weaker, true claim: each has *a* neighbour.
        const reachable = spread.some(
          (other, k) =>
            k !== i &&
            buckets[k] === buckets[i] &&
            haversineKm(spread[i].latitude, spread[i].longitude, other.latitude, other.longitude) <= 30
        );
        expect(reachable).toBe(true);
      }
    }
  });

  it('finds neighbours across the antimeridian rather than splitting them', () => {
    // A grid keyed on longitude splits the world somewhere; if that seam is
    // the dateline, two stores 22km apart in Fiji or Kiribati become two
    // scenes and nothing visibly fails.
    const across = [
      { ...venue(1, 0), longitude: 179.9 },
      { ...venue(2, 0), longitude: -179.9 },
    ];
    expect(
      haversineKm(across[0].latitude, across[0].longitude, across[1].latitude, across[1].longitude)
    ).toBeLessThan(30);

    const buckets = bucketVenues(across, 30);
    expect(buckets[0]).toBe(buckets[1]);
    expect(clusterVenuesGeographically(across, { maxDiameterKm: 30 }).length).toBe(1);
  });

  it('finds neighbours at a high latitude, where a degree of longitude is short', () => {
    // A degree of longitude is 111km at the equator and 56km at 60 degrees
    // north, so a fixed one-cell-either-side scan misses Scandinavian
    // neighbours. The column span is derived from the latitude for this
    // reason, and this is the test that would catch it being assumed.
    const north = [
      { ...venue(1, 0), latitude: 60, longitude: 10 },
      { ...venue(2, 0), latitude: 60, longitude: 10.3 },
    ];
    expect(
      haversineKm(north[0].latitude, north[0].longitude, north[1].latitude, north[1].longitude)
    ).toBeLessThan(30);
    expect(bucketVenues(north, 30)[0]).toBe(bucketVenues(north, 30)[1]);
    expect(clusterVenuesGeographically(north, { maxDiameterKm: 30 }).length).toBe(1);
  });

  it('agrees with the unbucketed clustering on a random cloud', () => {
    // The two paths differ only by the pre-pass, so a disagreement anywhere is
    // the pre-pass being wrong. Deterministic pseudo-random, so a failure is
    // reproducible rather than occasional.
    let seed = 20261027;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const cloud = Array.from({ length: 120 }, (_, i) => ({
      ...venue(1000 + i, 0),
      latitude: next() * 4 - 2,
      longitude: next() * 4 - 2,
    }));

    const bucketed = clusterVenuesGeographically(cloud, { maxDiameterKm: 30, bucketKm: 70 });
    const direct = completeLinkage(cloud, 30).map(cluster => ({
      venues: cluster.indices.map(index => cloud[index].venue),
    }));
    expect(partition(bucketed)).toEqual(partition(direct));
  });
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

describe('naming a scene', () => {
  it('weights city labels by matches, not by how many stores carry them', () => {
    // The production shape: one busy store and two sleepy ones. Counting
    // stores names the scene after where almost nothing is played; weighting
    // by matches puts the name where the games are, which is what a reader is
    // looking for. (`modalRegion` in snapshot.ts counts one vote per *player*
    // and has the same defect for the same reason.)
    const entries = [
      { label: 'Busy City', matches: 100 },
      { label: 'Quiet Town', matches: 10 },
      { label: 'Quiet Town', matches: 10 },
    ];
    expect(matchWeightedModalLabel(entries)).toBe('Busy City');

    // The store count says otherwise, which is the point of the test.
    const byStoreCount = new Map<string, number>();
    for (const entry of entries) byStoreCount.set(entry.label, (byStoreCount.get(entry.label) ?? 0) + 1);
    expect(byStoreCount.get('Quiet Town')).toBeGreaterThan(byStoreCount.get('Busy City')!);
  });

  it('ignores an unlabelled store rather than counting it as a name', () => {
    expect(
      matchWeightedModalLabel([
        { label: null, matches: 500 },
        { label: 'Somewhere', matches: 1 },
      ])
    ).toBe('Somewhere');
  });

  it('has no name at all when nothing is geocoded', () => {
    expect(matchWeightedModalLabel([{ label: null, matches: 5 }])).toBeNull();
  });

  it('breaks a tie on the label, so a name cannot depend on iteration order', () => {
    expect(
      matchWeightedModalLabel([
        { label: 'Zeta', matches: 10 },
        { label: 'Alpha', matches: 10 },
      ])
    ).toBe('Alpha');
  });
});

describe('the curated name overrides', () => {
  it('names at most one scene each, keyed on a durable shop id', () => {
    // A shop id is the only key that survives the scene being re-clustered: a
    // scene id is carried by overlap and silently is not stable when a scene
    // splits, and a city label is the thing being corrected.
    const seen = new Set<number>();
    for (const row of SCENE_NAME_OVERRIDES) {
      expect(Number.isInteger(row.shopExternalId)).toBe(true);
      expect(row.name.trim().length).toBeGreaterThan(0);
      expect(seen.has(row.shopExternalId)).toBe(false);
      seen.add(row.shopExternalId);
    }
  });

  it('applies to the scene holding the overridden store', () => {
    const row = SCENE_NAME_OVERRIDES[0];
    const members = [
      { ...venue(row.shopExternalId, 0, 0, 'Somewhere, XX'), matches: 50 },
      { ...venue(999_999_001, 5, 0, 'Elsewhere, XX'), matches: 10 },
    ];
    expect(sceneNameOverride(members)).toBe(row.name);
  });

  it('falls through to the default rule for a scene it does not name', () => {
    expect(sceneNameOverride([venue(999_999_002, 0, 0, 'Nowhere, XX')])).toBeNull();
  });

  it('picks the busiest overridden store when a scene holds two', () => {
    // Deterministic rather than ambiguous: two overrides landing in one scene
    // must not make the name depend on member order.
    if (SCENE_NAME_OVERRIDES.length < 2) return;
    const [first, second] = SCENE_NAME_OVERRIDES;
    const members = [
      { ...venue(first.shopExternalId, 0, 0, null), matches: 10 },
      { ...venue(second.shopExternalId, 1, 0, null), matches: 99 },
    ];
    expect(sceneNameOverride(members)).toBe(second.name);
    expect(sceneNameOverride([...members].reverse())).toBe(second.name);
  });
});

// ---------------------------------------------------------------------------
// The gate: enough mutual play to rank
// ---------------------------------------------------------------------------

function event(
  id: string,
  date: string,
  pairs: [string, string][],
  shopExternalId: number,
  latitude: number,
  longitude: number
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
    latitude,
    longitude,
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

function allPairs(players: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) pairs.push([players[i], players[j]]);
  }
  return pairs;
}

const LOCALS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'];

/**
 * One dense local scene, and - 500km away - a store whose two regulars only
 * ever play visitors from the first one.
 *
 * The second store is geographically a perfect scene: one store, zero
 * diameter. It is also useless as a scene, because none of its play is between
 * its own members, so there is no evidence with which to rank them against
 * each other. That is the distinction the gate exists to draw, and geography
 * alone cannot see it.
 */
function oneRealSceneAndOneHollowOne() {
  return build([
    ...allPairs(LOCALS).length > 0
      ? [
          event('home1', '2026-10-01', allPairs(LOCALS), 1, 0, 0),
          event('home2', '2026-10-02', allPairs(LOCALS), 1, 0, 0),
          // A second store 12km away, inside the cap, so the real scene pools
          // two stores the way a scene is supposed to.
          event('home3', '2026-10-03', allPairs(LOCALS), 2, 12 * KM, 0),
        ]
      : [],
    // The hollow store: its two regulars play only visitors.
    event(
      'away1',
      '2026-10-04',
      [
        ['z1', 'l1'],
        ['z2', 'l2'],
      ],
      9,
      500 * KM,
      0
    ),
    event(
      'away2',
      '2026-10-05',
      [
        ['z1', 'l3'],
        ['z2', 'l4'],
      ],
      9,
      500 * KM,
      0
    ),
  ]);
}

describe('the intra-scene share of play', () => {
  const observations = oneRealSceneAndOneHollowOne();

  it('measures how much of a scene players play each other', () => {
    const clusters = clusterVenuesGeographically(
      // Labels are irrelevant here; the geometry is what groups the stores.
      [venue(1, 0), venue(2, 12), venue(9, 500)],
      { maxDiameterKm: 30 }
    );
    const sceneOf = new Map<string, string>();
    clusters.forEach((cluster, index) => {
      for (const key of cluster.venues) sceneOf.set(key, String(index));
    });

    const shares = intraSceneShares(observations, sceneOf);
    const home = [...shares.entries()].find(([id]) => sceneOf.get('shop:1') === id)![1];
    const away = [...shares.entries()].find(([id]) => sceneOf.get('shop:9') === id)![1];

    // The real scene's players almost only play each other.
    expect(home.share).toBeGreaterThan(0.8);
    // The hollow one's play is entirely against another scene, so there is
    // nothing in it with which to rank its own two members.
    expect(away.players).toBe(2);
    expect(away.internal).toBe(0);
    expect(away.share).toBe(0);
  });

  it('refuses to publish a scene nobody plays inside, and places its venues nowhere', () => {
    const assignment = proposeGeoScenes(observations, {
      generatedAt: new Date('2026-10-27T00:00:00.000Z'),
    });

    // The real scene is published and pools both its stores.
    const published = assignment.venues.map(row => row.venue).sort();
    expect(published).toEqual(['shop:1', 'shop:2']);

    // The hollow store gets no scene at all. That is the honest state - every
    // reader already has to render `sceneId: null` - rather than a ladder for
    // two people who have never played each other.
    expect(assignment.venues.some(row => row.venue === 'shop:9')).toBe(false);

    const geo = assignment.stats.geo!;
    expect(geo.unrankableScenes).toBe(1);
    expect(geo.unrankableVenues).toBe(1);
    expect(geo.unrankablePlayers).toBe(2);
    expect(geo.clusters).toBe(assignment.scenes.length + geo.unrankableScenes);
  });

  it('can be asked to keep the failures, for a report that wants to show them', () => {
    const kept = proposeGeoScenes(observations, { keepUnrankable: true });
    expect(kept.venues.some(row => row.venue === 'shop:9')).toBe(true);
    const hollow = kept.scenes.find(scene => scene.intraShare === 0);
    expect(hollow?.rankable).toBe(false);
  });

  it('publishes the gate it used, so a reader is not guessing', () => {
    const assignment = proposeGeoScenes(observations, { minIntraShare: 0.25 });
    expect(assignment.geo?.minIntraShare).toBe(0.25);
    // A looser gate publishes the hollow store; the knob is doing the work and
    // the number travels with the answer.
    expect(assignment.geo?.maxDiameterKm).toBe(DEFAULT_GEO_MAX_DIAMETER_KM);
  });
});

// ---------------------------------------------------------------------------
// The proposal, as stored
// ---------------------------------------------------------------------------

describe('proposeGeoScenes', () => {
  const observations = oneRealSceneAndOneHollowOne();

  it('is an ordinary SceneAssignment, so the storage and the diff are unchanged', () => {
    const assignment = proposeGeoScenes(observations, {
      venueLabels: new Map([
        ['shop:1', 'Busy City, XX'],
        ['shop:2', 'Quiet Town, XX'],
      ]),
      generatedAt: new Date('2026-10-27T00:00:00.000Z'),
    });

    expect(assignment.method).toBe('geo');
    expect(assignment.generatedAt).toBe('2026-10-27T00:00:00.000Z');
    // Null rather than a stand-in number: no Louvain resolution was used, and
    // writing one would claim provenance this run does not have.
    expect(assignment.resolution).toBeNull();
    expect(assignment.stats.modularity).toBeNull();
    expect(assignment.stats.communities).toBeNull();
    expect(assignment.geo).toEqual({
      maxDiameterKm: DEFAULT_GEO_MAX_DIAMETER_KM,
      bucketKm: DEFAULT_GEO_BUCKET_KM,
      minIntraShare: 0.5,
    });

    // Every venue in exactly one scene, and every scene named.
    expect(new Set(assignment.venues.map(row => row.venue)).size).toBe(assignment.venues.length);
    expect(assignment.scenes.length).toBe(1);
    expect(assignment.scenes[0].label).toBe('Busy City, XX');
    expect(assignment.scenes[0].extentKm).toBeCloseTo(12, 0);
  });

  it('never keys a scene on a geocode', () => {
    // `venueKey`'s `geo:` fallback rounds to ~1km, which is right for a graph
    // node and wrong for a durable id - the id would move if the geocode did.
    // An unresolved organizer stays off the map until `shopMatch.ts` resolves
    // it, exactly as the Louvain path promises.
    const withOrganizer = build([
      ...allPairs(LOCALS).map((pair, index) =>
        event(`o${index}`, '2026-10-01', [pair], 1, 0, 0)
      ),
      { ...event('unresolved', '2026-10-02', allPairs(LOCALS), 1, 0, 0), shopExternalId: null },
    ]);
    const assignment = proposeGeoScenes(withOrganizer);
    expect(assignment.venues.every(row => row.venue.startsWith('shop:'))).toBe(true);
  });

  it('keeps a scene id across a re-clustering that changes the membership', () => {
    // The carry-over is about *naming stability* and has nothing to do with
    // which clustering proposed the membership, so geographic mode reuses the
    // same mechanism rather than inventing a second one. A selector whose
    // entries reshuffle is unshippable whichever method drew them.
    const first = proposeGeoScenes(observations, { generatedAt: new Date('2026-10-01T00:00:00.000Z') });
    const sceneId = first.scenes[0].sceneId;

    // A third store joins the same scene.
    const grown = build([
      ...allPairs(LOCALS).map((pair, index) => event(`g${index}`, '2026-10-01', [pair], 1, 0, 0)),
      event('g-second', '2026-10-02', allPairs(LOCALS), 2, 12 * KM, 0),
      event('g-third', '2026-10-03', allPairs(LOCALS), 3, 20 * KM, 0),
    ]);
    const second = proposeGeoScenes(grown, { previous: first });

    expect(second.scenes.length).toBe(1);
    expect(second.scenes[0].sceneId).toBe(sceneId);
    expect(second.venues.map(row => row.venue).sort()).toEqual(['shop:1', 'shop:2', 'shop:3']);
  });

  it('gives a genuinely different scene a new id rather than inheriting a name', () => {
    const first = proposeGeoScenes(observations);
    const elsewhere = build([
      ...allPairs(['x1', 'x2', 'x3', 'x4', 'x5', 'x6']).map((pair, index) =>
        event(`x${index}`, '2026-10-01', [pair], 77, 2000 * KM, 0)
      ),
    ]);
    const second = proposeGeoScenes(elsewhere, { previous: first });
    expect(second.scenes[0].sceneId).not.toBe(first.scenes[0].sceneId);
  });

  it('keeps one level of rollback and never nests it twice', () => {
    const first = proposeGeoScenes(observations, { generatedAt: new Date('2026-10-01T00:00:00.000Z') });
    const second = proposeGeoScenes(observations, {
      previous: first,
      generatedAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    const third = proposeGeoScenes(observations, {
      previous: second,
      generatedAt: new Date('2026-10-03T00:00:00.000Z'),
    });
    expect(third.previous?.generatedAt).toBe('2026-10-02T00:00:00.000Z');
    expect((third.previous as { previous?: unknown }).previous).toBeUndefined();
  });

  it('reports a store purity that says whose play it is, not that it is perfect', () => {
    const assignment = proposeGeoScenes(observations);
    for (const row of assignment.venues) {
      expect(row.purity).toBeGreaterThan(0);
      expect(row.purity).toBeLessThanOrEqual(1);
    }
    // The two stores of the real scene are played almost entirely by their own
    // scene's players, so purity is high - and it is a measurement rather than
    // a constant, which `stats.medianPurity` repeats.
    expect(assignment.stats.medianPurity).toBeGreaterThan(0.8);
  });
});
