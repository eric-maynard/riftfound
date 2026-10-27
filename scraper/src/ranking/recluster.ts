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
} from './scenes.js';

interface Args {
  write: boolean;
  show: boolean;
  rollback: boolean;
  json: boolean;
  resolution: number;
  carryJaccard: number;
  historyDays: number;
  maxMoves: number;
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
  return {
    write: flag('write'),
    show: flag('show'),
    rollback: flag('rollback'),
    json: flag('json'),
    resolution: value('resolution', Number(process.env.RANKING_SCENE_RESOLUTION ?? DEFAULT_SCENE_RESOLUTION)),
    carryJaccard: value('carry-jaccard', DEFAULT_CARRY_JACCARD),
    historyDays: value('days', Number(process.env.RANKING_HISTORY_DAYS ?? '400')),
    maxMoves: value('max-moves', 25),
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

function printAssignment(label: string, assignment: SceneAssignment | null): void {
  if (!assignment) {
    console.log(`${label}: none stored - no re-clustering has ever been accepted.`);
    return;
  }
  console.log(`${label}: ${assignment.venues.length} venues in ${assignment.scenes.length} scenes`);
  console.log(
    `  made ${assignment.generatedAt}, resolution ${assignment.resolution}, ` +
      `carry-jaccard ${assignment.carryJaccard}`
  );
  const stats = assignment.stats;
  console.log(
    `  at clustering time: ${stats.players} players, ${stats.matches} matches, ` +
      `modularity ${stats.modularity.toFixed(4)}, ${stats.communities} communities, ` +
      `median purity ${percent(stats.medianPurity)}, ${stats.splitVenues} split venues`
  );
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
  if (proposed.scenes.length > 0 && venuesPerScene < 3) {
    notes.push(
      `STOP: ${proposed.venues.length} venues in ${proposed.scenes.length} scenes is ` +
        `${venuesPerScene.toFixed(1)} stores per scene. A scene pools several stores - that is what ` +
        'makes it a scene rather than a venue - so this is a fragmented graph, almost always because ' +
        'the results backfill has not filled in enough of the window yet. Very high modularity ' +
        'alongside it is the same symptom, not reassurance. Wait for coverage; do not publish this.'
    );
  }

  if (current === null) {
    notes.push(
      notes.length > 0
        ? 'FIRST RUN: nothing to diff against, so the churn and id-carry gates do not apply - ' +
            'which is exactly why the gates above are the ones that have to hold.'
        : 'FIRST RUN: nothing to diff against, so every scene is new by definition. Check ' +
            'modularity, purity and stores-per-scene before accepting.'
    );
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
  if (proposed.stats.modularity < 0.3) {
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
  if (proposed.resolution !== (current?.resolution ?? proposed.resolution)) {
    notes.push(
      `NOTE: resolution changed ${current?.resolution} -> ${proposed.resolution}. gamma = 1 is the ` +
        'measured stability optimum (12.1% churn, vs 19.7% at 0.5 and 21.8% at 2), so churn from a ' +
        'knob change is self-inflicted and should not be read as a change in the data.'
    );
  }
  if (notes.length === 0) notes.push('OK: churn, id carry-over, modularity and purity are all in range.');
  return notes;
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
  const proposed = proposeScenes(observations, {
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
