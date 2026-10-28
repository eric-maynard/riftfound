/**
 * The scene re-clustering operator path.
 *
 * Re-clustering is a **deliberate, occasional act**, not a cron job. That is
 * the whole reason this is a separate CLI rather than a step in the rating
 * pass: a Louvain partition refitted on 90% of the matches moves 12-18% of its
 * player labels, so a scene recomputed every refit would reshuffle a UI
 * selector daily (see ranking/scenes.ts and scraper/CLAUDE.md). Between runs of
 * this script a store's scene cannot move at all.
 *
 * It is read-only unless `--write` is passed, and even then the sequence is
 * always: cluster, **diff against what is live**, print the churn and the
 * stores that would move, then write. The diff is the gate. Modularity is not:
 * a partition can have excellent modularity and still rename every scene, which
 * is the one failure that matters to a reader.
 *
 * Usage (via scripts/metrics/scene-recluster.sh, which sets the DB env):
 *
 *   recluster.ts                      # propose and diff, write nothing
 *   recluster.ts --write              # accept the proposal
 *   recluster.ts --show               # print the live assignment and stop
 *   recluster.ts --rollback --write   # restore the assignment this one replaced
 *   recluster.ts --resolution 1.5     # sweep the knob (gamma = 1 is the optimum)
 *   recluster.ts --max-moves 40       # how many moved stores to list
 *   recluster.ts --json               # machine-readable, for an agent driving it
 *
 *   recluster.ts --method geo                      # cluster the stores, not the graph
 *   recluster.ts --method geo --max-diameter 30    # the bound on a scene's width
 *   recluster.ts --method geo --min-intra-share 0.5  # the rankability gate
 *   recluster.ts --method geo --show-scenes 25     # list the biggest proposals
 *
 * **Two methods, and neither replaces the other.** `louvain` is the better
 * long-term definition of a scene and stays the default; see `scenes.ts`.
 * `geo` clusters venue coordinates instead, because the co-play graph is not
 * yet connected enough for Louvain to clear its own gate while venue
 * coordinates are 100% complete today; see `geoScenes.ts`. Both write the same
 * `SceneAssignment` through the same `--write` gate.
 *
 * Nothing player-identifying is logged, exactly as in the passes: this prints
 * venue keys, scene ids and counts. A venue key is a shop id, not a person.
 */

import { loadEventNames, loadSceneAssignment, saveSceneAssignment } from '../database.js';
import { replayDates, replayFacts, resolveVenueLabels } from './pass.js';
import { buildEras, parsePrereleaseTypes, parseSetTable, DEFAULT_PRERELEASE_OPTIONS } from './sets.js';
import {
  diffSceneAssignments,
  proposeScenes,
  DEFAULT_CARRY_JACCARD,
  DEFAULT_SCENE_RESOLUTION,
  type SceneAssignment,
  type SceneDiff,
  type SceneMethod,
} from './scenes.js';
import {
  geoVenues,
  proposeGeoScenes,
  DEFAULT_GEO_BUCKET_KM,
  DEFAULT_GEO_MAX_DIAMETER_KM,
  DEFAULT_MIN_INTRA_SHARE,
  type GeoVenue,
} from './geoScenes.js';
import type { ObservationSet } from './observations.js';

interface Args {
  write: boolean;
  show: boolean;
  rollback: boolean;
  json: boolean;
  method: SceneMethod;
  resolution: number;
  carryJaccard: number;
  historyDays: number;
  maxMoves: number;
  maxDiameterKm: number;
  bucketKm: number;
  minIntraShare: number;
  showScenes: number;
  keepUnrankable: boolean;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const value = (name: string, fallback: number): number => {
    const inline = argv.find(arg => arg.startsWith(`--${name}=`));
    if (inline) return Number(inline.split('=')[1]);
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1] !== undefined) return Number(argv[index + 1]);
    return fallback;
  };
  const text = (name: string, fallback: string): string => {
    const inline = argv.find(arg => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1] !== undefined) return argv[index + 1];
    return fallback;
  };

  const method = text('method', 'louvain');
  if (method !== 'louvain' && method !== 'geo') {
    throw new Error(`--method must be 'louvain' or 'geo', not '${method}'`);
  }

  return {
    write: flag('write'),
    show: flag('show'),
    rollback: flag('rollback'),
    json: flag('json'),
    method,
    resolution: value('resolution', Number(process.env.RANKING_SCENE_RESOLUTION ?? DEFAULT_SCENE_RESOLUTION)),
    carryJaccard: value('carry-jaccard', DEFAULT_CARRY_JACCARD),
    historyDays: value('days', Number(process.env.RANKING_HISTORY_DAYS ?? '400')),
    maxMoves: value('max-moves', 25),
    // `--radius` is accepted as an alias because the bound was called a radius
    // before the method settled on complete linkage, where it is a diameter.
    maxDiameterKm: value('max-diameter', value('radius', DEFAULT_GEO_MAX_DIAMETER_KM)),
    bucketKm: value('bucket-km', DEFAULT_GEO_BUCKET_KM),
    minIntraShare: value('min-intra-share', DEFAULT_MIN_INTRA_SHARE),
    showScenes: value('show-scenes', 0),
    keepUnrankable: flag('keep-unrankable'),
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function table(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return '  (none)';
  const columns = Object.keys(rows[0]);
  const widths = columns.map(column =>
    Math.max(column.length, ...rows.map(row => String(row[column] ?? '').length))
  );
  const line = (cells: (string | number)[]) =>
    '  ' + cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ');
  return [
    line(columns),
    line(widths.map(width => '-'.repeat(width))),
    ...rows.map(row => line(columns.map(column => row[column]))),
  ].join('\n');
}

/** An assignment with no `method` predates geographic mode, so it is Louvain. */
function methodOf(assignment: SceneAssignment): SceneMethod {
  return assignment.method ?? 'louvain';
}

function printAssignment(label: string, assignment: SceneAssignment | null): void {
  if (!assignment) {
    console.log(`${label}: none stored - no re-clustering has ever been accepted.`);
    return;
  }
  const method = methodOf(assignment);
  console.log(
    `${label}: ${assignment.venues.length} venues in ${assignment.scenes.length} scenes (${method})`
  );
  console.log(
    `  made ${assignment.generatedAt}, ` +
      (method === 'geo'
        ? `max diameter ${assignment.geo?.maxDiameterKm}km, ` +
          `min intra-share ${assignment.geo?.minIntraShare}, `
        : `resolution ${assignment.resolution}, `) +
      `carry-jaccard ${assignment.carryJaccard}`
  );
  const stats = assignment.stats;
  console.log(
    `  at clustering time: ${stats.players} players, ${stats.matches} matches, ` +
      (stats.modularity !== null ? `modularity ${stats.modularity.toFixed(4)}, ` : '') +
      (stats.communities !== null ? `${stats.communities} communities, ` : '') +
      `median purity ${percent(stats.medianPurity)}, ${stats.splitVenues} split venues`
  );
  const geo = stats.geo;
  if (geo) {
    console.log(
      `  geometry: ${geo.clusters} clusters, extent median ${geo.medianExtentKm}km / ` +
        `max ${geo.maxExtentKm}km; intra-scene play share (player-weighted median) ` +
        `${percent(geo.medianIntraShare)}`
    );
    console.log(
      `  not rankable: ${geo.unrankableScenes} clusters holding ${geo.unrankableVenues} venues ` +
        `and ${geo.unrankablePlayers} players - published with no scene`
    );
  }
  console.log(`  rollback available: ${assignment.previous ? `yes (${assignment.previous.generatedAt})` : 'no'}`);
}

/** The verdicts the runbook tells an operator to read. Order is deliberate. */
function warnings(diff: SceneDiff, proposed: SceneAssignment, current: SceneAssignment | null): string[] {
  const notes: string[] = [];

  // Fragmentation first, because it is the one gate a first run cannot skip and
  // the one the production backfill actually trips. Measured 2026-10-27 at ~25%
  // national coverage: 2,149 venues clustered into 1,042 scenes, i.e. about two
  // stores each, with modularity 0.9844. That is not a scene map - it is the
  // co-play graph not yet being connected enough to have scenes, and a
  // complete region looked nothing like it (390 venues, 51 communities).
  const venuesPerScene = proposed.scenes.length > 0 ? proposed.venues.length / proposed.scenes.length : 0;
  const geo = proposed.stats.geo;

  if (methodOf(proposed) === 'louvain') {
    if (proposed.scenes.length > 0 && venuesPerScene < 3) {
      notes.push(
        `STOP: ${proposed.venues.length} venues in ${proposed.scenes.length} scenes is ` +
          `${venuesPerScene.toFixed(1)} stores per scene. A scene pools several stores - that is what ` +
          'makes it a scene rather than a venue - so this is a fragmented graph, almost always because ' +
          'the results backfill has not filled in enough of the window yet. Very high modularity ' +
          'alongside it is the same symptom, not reassurance. Wait for coverage; do not publish this.'
      );
    }
  } else if (geo) {
    // Geographic mode does **not** gate on stores per scene, and that is a
    // deliberate replacement rather than a missing check. Stores per scene was
    // a proxy the Louvain path used because a sparse co-play graph gave it no
    // better signal; the thing it was proxying for - whether a scene's players
    // actually play each other enough to be ranked - is measured directly
    // here. A 30km diameter cap produces single-store scenes *by design*, so
    // the old proxy would stop a good proposal for the wrong reason.
    const share = geo.rankablePlayers + geo.unrankablePlayers;
    const unplacedShare = share > 0 ? geo.unrankablePlayers / share : 0;
    if (geo.medianIntraShare < 0.5) {
      notes.push(
        `STOP: the player-weighted median scene plays only ${percent(geo.medianIntraShare)} of its ` +
          'matches against its own members. A scene exists so that the players in it can be ranked ' +
          'against each other, and below about half its play being internal there is not enough ' +
          'mutual evidence to order anybody - whatever the map says. Loosen the diameter cap or ' +
          'wait for coverage; do not publish this.'
      );
    } else if (geo.medianIntraShare < 0.65) {
      notes.push(
        `CAUTION: median intra-scene play share ${percent(geo.medianIntraShare)}. Workable, but read ` +
          'the per-scene list before accepting: a scene near the gate is one travelling cohort away ' +
          'from failing it.'
      );
    }
    if (unplacedShare > 0.5) {
      notes.push(
        `CAUTION: ${geo.unrankableScenes} clusters failed the play-share gate, holding ` +
          `${geo.unrankablePlayers} of ${share} players (${percent(unplacedShare)}). Those venues are ` +
          'published with **no scene**, which is honest and is the intended behaviour - but if most ' +
          'players land there, the bound is cutting through real scenes rather than between them.'
      );
    }
    if (geo.maxExtentKm > (proposed.geo?.maxDiameterKm ?? DEFAULT_GEO_MAX_DIAMETER_KM) + 0.5) {
      notes.push(
        `STOP: a scene is ${geo.maxExtentKm}km across against a cap of ${proposed.geo?.maxDiameterKm}km. ` +
          'Complete linkage cannot produce that, so this is a bug in the clustering rather than a ' +
          'judgement call about the data.'
      );
    }
  }

  if (current !== null && methodOf(current) !== methodOf(proposed)) {
    notes.push(
      `NOTE: method changed ${methodOf(current)} -> ${methodOf(proposed)}. The two cluster different ` +
        'things, so near-total churn and almost no carried ids are expected and are not a signal ' +
        'about the data. Read the moved list as a comparison of the two methods, not as drift.'
    );
  }

  if (current === null) {
    if (notes.length > 0) {
      notes.push(
        'FIRST RUN: nothing to diff against, so the churn and id-carry gates do not apply - ' +
          'which is exactly why the gates above are the ones that have to hold.'
      );
    } else if (methodOf(proposed) === 'geo') {
      // Deliberately different advice from the Louvain branch. Modularity does
      // not exist here, and stores-per-scene is *expected* to be low: a 30km
      // diameter cap produces single-store scenes by design, so reading it as
      // fragmentation would reject a good proposal for the wrong reason.
      notes.push(
        'FIRST RUN: nothing to diff against, so every scene is new by definition. Read the extent ' +
          'column (a scene wider than a metro is the defect this method exists to prevent), the ' +
          'intra-share column (the share of a scene\'s play that is against its own members - the ' +
          'reason to pool stores at all), and the not-rankable counts above. Do **not** read ' +
          'stores-per-scene as fragmentation here: a diameter cap produces small scenes on purpose, ' +
          'and the play-share gate is what replaces that proxy.'
      );
    } else {
      notes.push(
        'FIRST RUN: nothing to diff against, so every scene is new by definition. Check ' +
          'modularity, purity and stores-per-scene before accepting.'
      );
    }
    return notes;
  }
  if (diff.churn > 0.25) {
    notes.push(
      `STOP: ${percent(diff.churn)} of shared venues would change scene. Above ~25% this is a ` +
        're-partition, not a refresh - a reader would see most stores renamed. Check whether a ' +
        'large new event tier entered the window, and re-run with the default resolution before accepting.'
    );
  } else if (diff.churn > 0.1) {
    notes.push(
      `CAUTION: ${percent(diff.churn)} venue churn. Read the moved list below and satisfy yourself ` +
        'that the moves are boundary stores, not whole cities.'
    );
  }
  if (current.scenes.length > 0 && diff.carriedScenes / current.scenes.length < 0.7) {
    notes.push(
      `STOP: only ${diff.carriedScenes} of ${current.scenes.length} scene ids carried over. Ids are ` +
        'carried by venue-set Jaccard, so a low carry rate means the scenes themselves were ' +
        'redrawn and every saved link or bookmark to a scene would break.'
    );
  }
  if (proposed.stats.modularity !== null && proposed.stats.modularity < 0.3) {
    notes.push(
      `STOP: modularity ${proposed.stats.modularity.toFixed(4)} is below the ~0.3 the literature ` +
        'treats as real community structure. There is no scene structure in this graph to publish; ' +
        'the usual cause is too little coverage (see the chronological coverage table in ' +
        'scraper/CLAUDE.md).'
    );
  }
  if (proposed.stats.medianPurity < 0.9) {
    notes.push(
      `CAUTION: median venue purity ${percent(proposed.stats.medianPurity)}, against 99.3% measured ` +
        'on a complete region. "A store belongs to one scene" is only honest while this is high.'
    );
  }
  if (
    proposed.resolution !== null &&
    current?.resolution !== null &&
    proposed.resolution !== (current?.resolution ?? proposed.resolution)
  ) {
    notes.push(
      `NOTE: resolution changed ${current?.resolution} -> ${proposed.resolution}. gamma = 1 is the ` +
        'measured stability optimum (12.1% churn, vs 19.7% at 0.5 and 21.8% at 2), so churn from a ' +
        'knob change is self-inflicted and should not be read as a change in the data.'
    );
  }
  if (notes.length === 0) notes.push('OK: churn, id carry-over, modularity and purity are all in range.');
  return notes;
}

/**
 * The biggest proposed scenes, as a table a human can judge the naming on.
 *
 * `cities` is the point of it: a scene's published label is one name, and the
 * only way to tell whether that name is right is to see which towns the scene
 * actually spans. The busiest store's shop id is printed because that is the
 * key a curated override is written against (`sceneNames.ts`), so a reader who
 * disagrees with a name has the one number they need to fix it.
 */
function sceneRows(
  proposed: SceneAssignment,
  observations: ObservationSet,
  venueLabels: Map<string, string>,
  limit: number
): Record<string, string | number>[] {
  const venues = geoVenues(observations, venueLabels);
  const byKey = new Map(venues.map(venue => [venue.venue, venue]));
  const members = new Map<string, GeoVenue[]>();
  for (const row of proposed.venues) {
    const venue = byKey.get(row.venue);
    if (!venue) continue;
    const list = members.get(row.sceneId);
    if (list) list.push(venue);
    else members.set(row.sceneId, [venue]);
  }

  const labelOf = new Map(proposed.scenes.map(scene => [scene.sceneId, scene]));
  return [...members.entries()]
    .map(([sceneId, list]) => {
      const matches = list.reduce((total, venue) => total + venue.matches, 0);
      const busiest = [...list].sort(
        (a, b) => b.matches - a.matches || a.shopExternalId - b.shopExternalId
      );
      const cities = [
        ...new Map(
          busiest.filter(venue => venue.label).map(venue => [venue.label as string, true])
        ).keys(),
      ];
      const scene = labelOf.get(sceneId);
      return {
        sceneId,
        stores: list.length,
        matches,
        km: scene?.extentKm ?? '-',
        intra: scene?.intraShare !== undefined ? percent(scene.intraShare) : '-',
        busiestShop: busiest[0].shopExternalId,
        label: scene?.label ?? '(unnamed)',
        cities: cities.slice(0, 3).join(' / ') + (cities.length > 3 ? ` +${cities.length - 3}` : ''),
      };
    })
    .sort((a, b) => b.matches - a.matches || (a.sceneId < b.sceneId ? -1 : 1))
    .slice(0, limit);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const current = await loadSceneAssignment();

  if (args.show) {
    printAssignment('Live assignment', current);
    if (args.json) console.log(JSON.stringify(current));
    return;
  }

  if (args.rollback) {
    if (!current?.previous) {
      console.error('Nothing to roll back to: the live assignment has no stored predecessor.');
      process.exitCode = 1;
      return;
    }
    const restored: SceneAssignment = { ...current.previous, previous: null };
    printAssignment('Live assignment', current);
    printAssignment('Would restore', restored);
    if (!args.write) {
      console.log('\nDry run. Add --write to restore it.');
      return;
    }
    await saveSceneAssignment(restored);
    console.log(
      `\nRolled back to the assignment of ${restored.generatedAt}. ` +
        'Rollback is one level deep, so there is nothing further to undo to; ' +
        'the scene fields on the items change on the next refit, not now.'
    );
    return;
  }

  const { table: setTable, warning } = parseSetTable(process.env.RANKING_SET_TABLE);
  if (warning) console.warn(`[scenes] ${warning}; using the curated set table`);
  const eras = buildEras(setTable);
  const eventNames = await loadEventNames(args.historyDays, 2).catch(() => new Map<string, string>());
  const { observations, daysRead } = await replayFacts({
    dates: replayDates(new Date(), args.historyDays, 2),
    eras,
    eventNames,
    maxMatches: Number.POSITIVE_INFINITY,
    prerelease: {
      prereleaseTypes: parsePrereleaseTypes(process.env.RANKING_PRERELEASE_TYPES),
      leadDays: Number(process.env.RANKING_PRERELEASE_LEAD_DAYS ?? DEFAULT_PRERELEASE_OPTIONS.leadDays),
    },
  });

  if (observations.playerA.length === 0) {
    console.error('No match facts in the window: nothing to cluster.');
    process.exitCode = 1;
    return;
  }

  const venueLabels = await resolveVenueLabels(observations);
  const proposed =
    args.method === 'geo'
      ? proposeGeoScenes(observations, {
          maxDiameterKm: args.maxDiameterKm,
          bucketKm: args.bucketKm,
          minIntraShare: args.minIntraShare,
          carryJaccard: args.carryJaccard,
          venueLabels,
          previous: current,
          keepUnrankable: args.keepUnrankable,
        })
      : proposeScenes(observations, {
          resolution: args.resolution,
          carryJaccard: args.carryJaccard,
          venueLabels,
          previous: current,
        });
  const diff = diffSceneAssignments(current, proposed);
  const notes = warnings(diff, proposed, current);

  if (args.json) {
    console.log(
      JSON.stringify({
        daysRead,
        matches: observations.playerA.length,
        proposed: { ...proposed, previous: undefined },
        diff: { ...diff, moved: diff.moved.slice(0, args.maxMoves) },
        notes,
        written: false,
      })
    );
  } else {
    console.log(`Replayed ${daysRead} days: ${observations.playerA.length} matches\n`);
    printAssignment('Live assignment', current);
    console.log('');
    printAssignment('Proposed', proposed);

    console.log('\n--- WHAT WOULD CHANGE ---\n');
    console.log(
      table([
        {
          metric: 'venues in both',
          value: diff.shared,
        },
        { metric: 'venues that would move', value: `${diff.moved.length} (${percent(diff.churn)})` },
        { metric: 'venues newly placed', value: diff.added.length },
        { metric: 'venues no longer placed', value: diff.removed.length },
        { metric: 'scene ids carried over', value: diff.carriedScenes },
        { metric: 'scene ids created', value: diff.newScenes.length },
        { metric: 'scene ids retired', value: diff.retiredScenes.length },
        {
          metric: 'stores per scene',
          value:
            proposed.scenes.length > 0
              ? (proposed.venues.length / proposed.scenes.length).toFixed(1)
              : '-',
        },
        {
          metric: 'median venue purity',
          value: `${percent(diff.medianPurityBefore)} -> ${percent(diff.medianPurityAfter)}`,
        },
      ])
    );

    if (args.showScenes > 0) {
      console.log(`\n--- THE ${args.showScenes} BIGGEST PROPOSED SCENES ---\n`);
      console.log(table(sceneRows(proposed, observations, venueLabels, args.showScenes)));
      if (proposed.scenes.length > args.showScenes) {
        console.log(`  ... and ${proposed.scenes.length - args.showScenes} more (--show-scenes to see them)`);
      }
    }

    if (diff.moved.length > 0) {
      console.log('\nStores that would change scene (highest purity first - those are the real changes of mind)');
      console.log(
        table(
          diff.moved.slice(0, args.maxMoves).map(move => ({
            venue: move.venue,
            from: `${move.fromLabel ?? '(unlabelled)'} ${move.fromSceneId ?? ''}`.trim(),
            to: `${move.toLabel ?? '(unlabelled)'} ${move.toSceneId}`.trim(),
            purity: percent(move.purity),
          }))
        )
      );
      if (diff.moved.length > args.maxMoves) {
        console.log(`  ... and ${diff.moved.length - args.maxMoves} more (--max-moves to see them)`);
      }
    }

    console.log('\n--- VERDICT ---\n');
    for (const note of notes) console.log(`  ${note}`);
  }

  if (!args.write) {
    if (!args.json) {
      console.log('\nDry run: nothing written. Add --write to accept this assignment.');
      console.log('A refit picks it up on its next run; stored items keep the old scene until then.');
    }
    return;
  }

  await saveSceneAssignment(proposed);
  if (args.json) console.log(JSON.stringify({ written: true, generatedAt: proposed.generatedAt }));
  else {
    console.log(`\nWritten. Assignment ${proposed.generatedAt} is now live.`);
    console.log('Roll back with: ./scene-recluster.sh --rollback --write');
    console.log('Scene fields on the stored items change on the next refit, not now.');
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
