import { describe, it, expect } from 'vitest';
import { ObservationBuilder } from '../ranking/observations.js';
import { buildEras } from '../ranking/sets.js';
import { findComponents } from '../ranking/graph.js';
import { buildSnapshot, DEFAULT_SNAPSHOT_OPTIONS } from '../ranking/snapshot.js';
import {
  DEFAULT_CARRY_JACCARD,
  DEFAULT_SCENE_RESOLUTION,
  diffSceneAssignments,
  proposeScenes,
  SCENE_ASSIGNMENT_VERSION,
} from '../ranking/scenes.js';
import type { EventResults } from '../database.js';

/**
 * Scenes: the persisted venue -> scene assignment.
 *
 * The properties pinned here are the ones the design rests on, not the surface
 * of the API:
 *
 * - **a store belongs to one scene**, and the purity says how true that is.
 * - **`componentId` is untouched.** A scene is an addition; redefining the
 *   component would silently corrupt `crossComponentUncertainty`, whose formula
 *   is only valid for a connected component.
 * - **ids survive a re-clustering** when the scene is recognisably the same
 *   scene, because they are carried by venue-set Jaccard rather than derived
 *   from membership. That is the entire reason this is persisted state.
 * - **a geocode is never a venue id.** `venueKey`'s `geo:` fallback moves if the
 *   geocode moves, so an unresolved organizer gets no venue item and no scene.
 * - **an unassigned scene is null, not invented.** A refit that has never seen
 *   a re-clustering publishes venues with no scene rather than clustering on
 *   the fly.
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
 * player. The component partition sees one blob; the scene partition sees two.
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

describe('proposeScenes', () => {
  const observations = twoScenes();

  it('assigns every store to exactly one scene, and says how pure that is', () => {
    const assignment = proposeScenes(observations, { generatedAt: new Date('2026-10-26T00:00:00.000Z') });

    expect(assignment.version).toBe(SCENE_ASSIGNMENT_VERSION);
    expect(assignment.resolution).toBe(DEFAULT_SCENE_RESOLUTION);
    expect(assignment.carryJaccard).toBe(DEFAULT_CARRY_JACCARD);
    expect(assignment.venues.map(row => row.venue).sort()).toEqual([
      'shop:1',
      'shop:2',
      'shop:3',
      'shop:4',
    ]);
    // One row per venue: a store cannot be in two scenes.
    expect(new Set(assignment.venues.map(row => row.venue)).size).toBe(assignment.venues.length);

    const sceneOf = new Map(assignment.venues.map(row => [row.venue, row.sceneId]));
    expect(sceneOf.get('shop:1')).toBe(sceneOf.get('shop:2'));
    expect(sceneOf.get('shop:3')).toBe(sceneOf.get('shop:4'));
    expect(sceneOf.get('shop:1')).not.toBe(sceneOf.get('shop:3'));
    expect(assignment.scenes).toHaveLength(2);

    // The stores with no visitors from the other scene are perfectly pure; the
    // bridge venue is not, which is exactly the signal purity exists to carry.
    expect(assignment.venues.find(row => row.venue === 'shop:2')!.purity).toBe(1);
    const bridged = assignment.venues.find(row => row.venue === 'shop:1')!;
    expect(bridged.purity).toBeLessThan(1);
    expect(bridged.purity).toBeGreaterThan(0.9);
    expect(assignment.stats.medianPurity).toBeGreaterThan(0.9);
  });

  it('does not change what componentId means - the whole graph is still one component', () => {
    expect(findComponents(observations).components).toHaveLength(1);
    expect(proposeScenes(observations).scenes).toHaveLength(2);
  });

  it('never assigns a scene to a venue without a real shop id', () => {
    // An organizer that never resolved to a shop: venueKey falls back to a 1km
    // coordinate rounding, which would move if the geocode moved.
    const withUnresolved = build([
      ...clique('w', west, 1),
      ...clique('u', ['u1', 'u2', 'u3', 'u4'], null),
    ]);
    const assignment = proposeScenes(withUnresolved);
    expect(assignment.venues.every(row => row.venue.startsWith('shop:'))).toBe(true);
    expect(assignment.venues.every(row => Number.isFinite(row.shopExternalId))).toBe(true);
  });

  it('is deterministic - the same observations give byte-identical assignments', () => {
    const at = new Date('2026-10-26T00:00:00.000Z');
    const a = proposeScenes(observations, { generatedAt: at });
    const b = proposeScenes(observations, { generatedAt: at });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('names a scene from its venues and keeps the old name when nothing is geocoded', () => {
    const labels = new Map([
      ['shop:1', 'Oakland, CA'],
      ['shop:2', 'Oakland, CA'],
    ]);
    const named = proposeScenes(observations, { venueLabels: labels });
    const sceneOf = new Map(named.venues.map(row => [row.venue, row.sceneId]));
    const labelOf = new Map(named.scenes.map(scene => [scene.sceneId, scene.label]));
    expect(labelOf.get(sceneOf.get('shop:1')!)).toBe('Oakland, CA');
    // The other scene has no geocoded venue yet, so it is honestly unlabelled.
    expect(labelOf.get(sceneOf.get('shop:3')!)).toBeNull();

    // Re-clustering without labels keeps the name a carried scene already had,
    // so a label does not flicker to null between runs.
    const again = proposeScenes(observations, { previous: named });
    const labelAgain = new Map(again.scenes.map(scene => [scene.sceneId, scene.label]));
    const sceneAgain = new Map(again.venues.map(row => [row.venue, row.sceneId]));
    expect(labelAgain.get(sceneAgain.get('shop:1')!)).toBe('Oakland, CA');
  });
});

describe('ids survive a re-clustering', () => {
  it('carries an id forward when the scene is recognisably the same scene', () => {
    const before = proposeScenes(twoScenes());
    // A new store joins the western scene and the two scenes play a bit more.
    // The membership changed, so a membership-derived id would be renamed.
    const after = proposeScenes(
      build([
        ...clique('w', west, 1),
        ...clique('w2nd', west, 2, 1),
        ...clique('w3rd', west, 5, 1),
        ...clique('e', east, 3),
        ...clique('e2nd', east, 4, 1),
        event('bridge', '2026-10-05', [['w1', 'e1']], 1),
      ]),
      { previous: before }
    );

    const beforeIds = new Set(before.scenes.map(scene => scene.sceneId));
    const afterIds = new Set(after.scenes.map(scene => scene.sceneId));
    expect([...afterIds].filter(id => beforeIds.has(id))).toHaveLength(2);

    const diff = diffSceneAssignments(before, after);
    expect(diff.churn).toBe(0);
    expect(diff.added.map(move => move.venue)).toEqual(['shop:5']);
    expect(diff.newScenes).toEqual([]);
    expect(diff.retiredScenes).toEqual([]);
    expect(diff.carriedScenes).toBe(2);
  });

  it('gives a genuinely new scene a new id rather than inheriting a name', () => {
    const before = proposeScenes(build([...clique('w', west, 1), ...clique('w2nd', west, 2, 1)]));
    const after = proposeScenes(
      build([
        ...clique('w', west, 1),
        ...clique('w2nd', west, 2, 1),
        // A second scene appears, with no venue in common with the first.
        ...clique('e', east, 3),
        ...clique('e2nd', east, 4, 1),
      ]),
      { previous: before }
    );
    const diff = diffSceneAssignments(before, after);
    expect(diff.newScenes).toHaveLength(1);
    expect(diff.carriedScenes).toBe(1);
    expect(diff.churn).toBe(0);
  });

  it('keeps one level of rollback and never nests it twice', () => {
    const first = proposeScenes(twoScenes());
    expect(first.previous).toBeNull();
    const second = proposeScenes(twoScenes(), { previous: first });
    expect(second.previous?.generatedAt).toBe(first.generatedAt);
    const third = proposeScenes(twoScenes(), { previous: second });
    expect(third.previous?.generatedAt).toBe(second.generatedAt);
    expect((third.previous as Record<string, unknown>).previous).toBeUndefined();
  });

  it('reports the churn and the stores that would move', () => {
    const before = proposeScenes(twoScenes());
    // Force a re-partition by handing the diff a proposal whose venues are
    // deliberately shuffled between the two scene ids.
    const [sceneA, sceneB] = before.scenes.map(scene => scene.sceneId);
    const swapped = {
      ...before,
      venues: before.venues.map(row => ({
        ...row,
        sceneId: row.sceneId === sceneA ? sceneB : sceneA,
      })),
    };
    const diff = diffSceneAssignments(before, swapped);
    expect(diff.shared).toBe(4);
    expect(diff.moved).toHaveLength(4);
    expect(diff.churn).toBe(1);
    // Highest purity first: those are the real changes of mind, not close calls.
    expect(diff.moved[0].purity).toBeGreaterThanOrEqual(diff.moved[3].purity);
    expect(diff.moved[0].fromSceneId).not.toBe(diff.moved[0].toSceneId);
  });
});

describe('the refit reads the assignment, it does not fit one', () => {
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

  it('publishes venue items with null scenes until a re-clustering exists', () => {
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

  it('carries the stored scene onto the venue, the profile and the ladder row', () => {
    const assignment = proposeScenes(observations, { venueLabels });
    const { snapshot, diagnostics } = buildSnapshot(observations, { ...base, sceneAssignment: assignment });

    expect(diagnostics.scenesUnassigned).toBe(false);
    expect(diagnostics.venueCount).toBe(4);
    expect(diagnostics.sceneCount).toBe(2);

    const venues = new Map(snapshot.venues.map(venue => [venue.venue, venue]));
    const one = venues.get('shop:1')!;
    expect(one.shopExternalId).toBe(1);
    expect(one.name).toBe('Oakland, CA');
    expect(one.sceneId).not.toBeNull();
    expect(one.sceneLabel).toBe('Oakland, CA');
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

  it('caps the denormalised roster and says it was cut short', () => {
    const assignment = proposeScenes(observations, { venueLabels });
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
