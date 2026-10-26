import { describe, it, expect } from 'vitest';
import { ObservationBuilder } from '../ranking/observations.js';
import { buildEras } from '../ranking/sets.js';
import { findComponents } from '../ranking/graph.js';
import {
  buildCoPlayGraph,
  comparePartitions,
  louvain,
  metroClusters,
  modularityOf,
  venueAggregates,
} from '../ranking/communities.js';
import type { EventResults } from '../database.js';

/**
 * Community detection on the co-play graph.
 *
 * The properties pinned here are the ones the "is a scene a component?"
 * argument rests on, not the surface of the API:
 *
 * - **a bridge does not merge two scenes.** Two cliques joined by a single
 *   shared player are *one* connected component and *two* communities. This is
 *   the whole case against components as a scene primitive, as an executable
 *   assertion.
 * - **the labelling is deterministic.** Louvain is normally described with a
 *   randomised node order; a scene label that reshuffles between identical runs
 *   is unusable in a UI, so the implementation must be order-free.
 * - **modularity is the quantity being maximised**, so the reported number has
 *   to agree with an independent evaluation of the same labelling.
 */

const eras = buildEras();

/** One event with explicit pairings; player names are the identity keys. */
function event(id: string, date: string, pairs: [string, string][], shopExternalId: number): EventResults {
  const players = [...new Set(pairs.flat())];
  const teamId = (player: string) => `t-${id}-${player}`;
  return {
    externalId: `prb-${id}`,
    tournamentId: id,
    eventStartDate: new Date(`${date}T18:00:00.000Z`),
    eventType: 'Nexus Night',
    playFormat: null,
    shopExternalId,
    latitude: 37 + shopExternalId * 0.5,
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

/** Every pairing among `players`, repeated `rounds` times. */
function clique(prefix: string, players: string[], shopExternalId: number, rounds = 2): EventResults[] {
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

describe('one travelling player welds two scenes into one component', () => {
  const observations = build([
    ...clique('w', west, 1),
    ...clique('e', east, 2),
    // The bridge: a single cross-venue match, which is all it takes.
    event('bridge', '2026-10-05', [['w1', 'e1']], 1),
  ]);

  it('leaves the connected-component partition with nothing to say', () => {
    const components = findComponents(observations);
    expect(components.components).toHaveLength(1);
    expect(components.giantShare).toBe(1);
  });

  it('still separates the two scenes by density', () => {
    const { graph, nodes, nodeOfPlayer } = buildCoPlayGraph(observations);
    const fit = louvain(graph);
    expect(fit.communityCount).toBe(2);
    expect(nodes.length).toBe(12);

    const community = (player: string) =>
      fit.communityOf[nodeOfPlayer[observations.players.indexOf(player)]];
    for (const player of west.slice(1)) expect(community(player)).toBe(community('w1'));
    for (const player of east.slice(1)) expect(community(player)).toBe(community('e1'));
    expect(community('w1')).not.toBe(community('e1'));
    // Two dense halves joined by one edge: modularity close to its 0.5 ceiling
    // for a two-community split.
    expect(fit.modularity).toBeGreaterThan(0.45);
  });

  it('reports the modularity of the labelling it returns', () => {
    const { graph } = buildCoPlayGraph(observations);
    const fit = louvain(graph);
    expect(modularityOf(graph, fit.communityOf, 1)).toBeCloseTo(fit.modularity, 10);
  });

  it('is deterministic, so a scene label does not reshuffle between runs', () => {
    const first = louvain(buildCoPlayGraph(observations).graph);
    const second = louvain(buildCoPlayGraph(observations).graph);
    expect([...second.communityOf]).toEqual([...first.communityOf]);
    expect(second.modularity).toBe(first.modularity);
  });
});

describe('partition agreement', () => {
  it('scores an identical labelling as identical, whatever the label values', () => {
    const left = Int32Array.from([0, 0, 1, 1, 2, 2]);
    const right = Int32Array.from([5, 5, 7, 7, 9, 9]);
    const agreement = comparePartitions(left, right);
    expect(agreement.adjustedRand).toBeCloseTo(1, 10);
    expect(agreement.normalisedMutualInformation).toBeCloseTo(1, 10);
    expect(agreement.churn).toBe(0);
  });

  it('scores an unrelated labelling near chance, and counts the churn', () => {
    const left = Int32Array.from([0, 0, 0, 1, 1, 1]);
    const right = Int32Array.from([0, 1, 0, 1, 0, 1]);
    const agreement = comparePartitions(left, right);
    expect(agreement.adjustedRand).toBeLessThan(0.3);
    // Best match sends left 0 -> right 0 and left 1 -> right 1, agreeing on 4
    // of 6 items.
    expect(agreement.churn).toBeCloseTo(2 / 6, 10);
  });
});

describe('venue aggregates', () => {
  const observations = build([...clique('w', west, 1), ...clique('e', east, 2)]);

  it('counts distinct players and matches per venue, with a centroid', () => {
    const venues = venueAggregates(observations);
    expect(venues).toHaveLength(2);
    for (const venue of venues) {
      expect(venue.players).toBe(6);
      expect(venue.matches).toBe(30);
      expect(venue.events).toBe(2);
      expect(venue.latitude).not.toBeNull();
    }
    expect(venues.map(venue => venue.venue).sort()).toEqual(['shop:1', 'shop:2']);
  });

  it('joins venues into metros only within the stated radius', () => {
    const venues = venueAggregates(observations);
    // The fixture places the two venues 0.5 degrees of latitude apart, ~55km.
    expect(metroClusters(venues, 25).metroCount).toBe(2);
    expect(metroClusters(venues, 100).metroCount).toBe(1);
  });
});
