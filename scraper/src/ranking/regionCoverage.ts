/**
 * The region coverage report: what the drawn polygons cover, and what they miss.
 *
 * This exists because **the polygons will be incomplete for a long time and
 * that has to be visible**. A clustering covered every store by construction -
 * every venue landed in some cluster, so there was never anything to report. A
 * drawn map covers whatever somebody has drawn, and a store outside every
 * polygon gets `regionId: null` and is *reported* rather than snapped to the
 * nearest one. Snapping is how a Mexicali store ended up filed in California.
 *
 * So this is the feedback loop for the drawing pass, and the three things it
 * prints are the three ways a hand-drawn map goes wrong:
 *
 * 1. **Unplaced venues**, busiest first, with their coordinates and the scene
 *    they are filed under today - which is what tells a human which polygon to
 *    draw next and what to call it.
 * 2. **Regions holding no store at all.** The visible symptom of a swapped
 *    `[lat, lng]` pair that stayed inside both coordinate ranges, which the
 *    loader cannot detect from the numbers alone (see `regions.ts`).
 * 3. **Regions whose extent is not metro-scale**, and regions below the
 *    play-share bar. Neither is fatal; both are a polygon worth a second look.
 *
 * Usage (via scripts/metrics/region-coverage.sh, which sets the DB env):
 *
 *   regionCoverage.ts                 # validate, place, report
 *   regionCoverage.ts --days 400      # replay window (default: 400)
 *   regionCoverage.ts --max-unplaced 60   # how many unplaced stores to list
 *   regionCoverage.ts --json          # machine-readable, for an agent drawing
 *
 * **Read-only.** It writes nothing, touches no derived item and cannot trigger
 * a refit. It is the same idiom as `report.ts` and shares its replay helpers.
 *
 * Nothing player-identifying is logged, exactly as in the passes: this prints
 * shop ids, region ids and counts. A shop id is not a person.
 */

import { loadEventNames, loadVenueScenes } from '../database.js';
import { replayDates, replayFacts, resolveVenueLabels } from './pass.js';
import { buildEras, parsePrereleaseTypes, parseSetTable, DEFAULT_PRERELEASE_OPTIONS } from './sets.js';
import { loadRegionIndex, RegionDataError, type LoadedRegion } from './regions.js';
import { assignScenesFromRegions, type SceneAssignment } from './scenes.js';

interface Args {
  days: number;
  maxUnplaced: number;
  json: boolean;
  /** Read the polygons from somewhere other than the checked-in directory. */
  dir?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string, fallback: number): number => {
    const inline = argv.find(arg => arg.startsWith(`--${name}=`));
    if (inline) return Number(inline.split('=')[1]);
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1] !== undefined) return Number(argv[index + 1]);
    return fallback;
  };
  const text = (name: string): string | undefined => {
    const inline = argv.find(arg => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    days: value('days', Number(process.env.RANKING_HISTORY_DAYS ?? '400')),
    maxUnplaced: value('max-unplaced', 40),
    json: argv.includes('--json'),
    dir: text('dir'),
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

/**
 * An extent above this is worth a human look.
 *
 * Not a gate and not a cap - nothing clamps a drawn polygon. It is the width
 * the old clustering bounded a scene to, kept here as the yardstick a reader
 * already has: at 30km the New York area resolves into the seven scenes a local
 * would draw, and at 50km it starts merging across San Francisco Bay, which is
 * a ferry rather than a scene. A region reporting 400km is a corridor or a
 * country, which is a drawing decision somebody should make on purpose.
 */
const METRO_EXTENT_KM = 30;

interface Coverage {
  regions: number;
  files: string[];
  assignment: SceneAssignment;
  /** Regions holding no replayed store. The swap symptom. */
  empty: LoadedRegion[];
  /** Published store -> the scene it is filed under today, for the unplaced list. */
  current: Map<number, { sceneId: string | null; sceneLabel: string | null }>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let index;
  try {
    index = loadRegionIndex(args.dir);
  } catch (error) {
    if (error instanceof RegionDataError) {
      // The whole point of collecting problems rather than throwing on the
      // first: a drawing pass fixes a batch of coordinates at a time.
      console.error('Region data is invalid. Nothing was placed.\n');
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  // The same replay the reports use, with the same window and the same
  // prerelease attribution, so a figure here can be compared with one there.
  const { table: setTable } = parseSetTable(process.env.RANKING_SET_TABLE);
  const eras = buildEras(setTable);
  console.log(
    `Replaying ${args.days} days of stored facts from DB_TYPE=${process.env.DB_TYPE ?? 'sqlite'}`
  );
  const eventNames = await loadEventNames(args.days, 2).catch(() => new Map<string, string>());
  const { observations } = await replayFacts({
    dates: replayDates(new Date(), args.days, 2),
    eras,
    eventNames,
    maxMatches: Number.POSITIVE_INFINITY,
    prerelease: {
      prereleaseTypes: parsePrereleaseTypes(process.env.RANKING_PRERELEASE_TYPES),
      leadDays: Number(
        process.env.RANKING_PRERELEASE_LEAD_DAYS ?? DEFAULT_PRERELEASE_OPTIONS.leadDays
      ),
    },
  });
  const venueLabels = await resolveVenueLabels(observations);
  const assignment = assignScenesFromRegions(observations, index, { venueLabels });

  const occupied = new Set(assignment.venues.map(row => row.regionId));
  const coverage: Coverage = {
    regions: index.regions.length,
    files: index.files,
    assignment,
    empty: index.regions.filter(region => !occupied.has(region.id)),
    current: await loadVenueScenes().catch(() => new Map()),
  };

  if (args.json) {
    console.log(JSON.stringify(toJson(coverage, args), null, 2));
    return;
  }
  print(coverage, args);
}

function toJson(coverage: Coverage, args: Args) {
  const { stats, unplaced, scenes } = coverage.assignment;
  return {
    files: coverage.files,
    stats,
    unplaced: unplaced.slice(0, args.maxUnplaced).map(venue => ({
      ...venue,
      currentSceneId: coverage.current.get(venue.shopExternalId)?.sceneId ?? null,
      currentSceneLabel: coverage.current.get(venue.shopExternalId)?.sceneLabel ?? null,
    })),
    unplacedTotal: unplaced.length,
    emptyRegions: coverage.empty.map(region => ({
      id: region.id,
      name: region.name,
      source: region.source,
      bounds: region.bounds,
    })),
    wideRegions: scenes
      .filter(scene => scene.extentKm > METRO_EXTENT_KM)
      .map(scene => ({ regionId: scene.regionId, label: scene.label, extentKm: scene.extentKm })),
    lowPlayShareRegions: scenes
      .filter(scene => !scene.ladderMeaningful)
      .map(scene => ({ regionId: scene.regionId, label: scene.label, intraShare: scene.intraShare })),
  };
}

function print(coverage: Coverage, args: Args): void {
  const { stats, unplaced, scenes, venues } = coverage.assignment;

  console.log('=== REGION COVERAGE ===\n');
  console.log(
    coverage.files.length > 0
      ? `Polygons: ${stats.regions} across ${coverage.files.length} file(s) - ${coverage.files.join(', ')}`
      : 'Polygons: none. Add region files under scraper/src/ranking/regions/ ' +
          '(see the README there for the format).'
  );
  console.log('');

  const placeable = venues.length + unplaced.length;
  console.log(table([
    {
      'venues replayed': placeable,
      placed: venues.length,
      'in no region': unplaced.length,
      coverage: placeable > 0 ? percent(venues.length / placeable) : '-',
      'regions holding a store': `${stats.regionsWithVenues} of ${stats.regions}`,
      'border ties': stats.boundaryTies,
    },
  ]));

  // The unplaced list is the actionable half of this report. Busiest first,
  // with the scene a reader sees today beside it, because that label is what
  // the next polygon should probably be called - and because a store that
  // *has* a scene today and no polygon is a reader whose bookmark is about to
  // stop resolving, which is more urgent than one that never had one.
  console.log(
    `\nVenues in no region (${unplaced.length}, busiest first, showing ${Math.min(args.maxUnplaced, unplaced.length)})`
  );
  console.log(table(unplaced.slice(0, args.maxUnplaced).map(venue => {
    const current = coverage.current.get(venue.shopExternalId);
    return {
      shop: venue.shopExternalId,
      matches: venue.matches,
      players: venue.players,
      latitude: venue.latitude.toFixed(4),
      longitude: venue.longitude.toFixed(4),
      city: venue.label ?? '-',
      'filed as today': current?.sceneLabel ?? current?.sceneId ?? '-',
    };
  })));
  if (unplaced.length > args.maxUnplaced) {
    console.log(`  ... and ${unplaced.length - args.maxUnplaced} more (--max-unplaced N)`);
  }

  // A drawn region with no store in it is the only visible symptom of a
  // swapped coordinate pair that stayed inside both ranges - the loader cannot
  // tell a valid polygon in Somalia from an invalid one in Paris.
  console.log(`\nRegions holding no replayed store (${coverage.empty.length})`);
  console.log(table(coverage.empty.map(region => ({
    region: region.id,
    name: region.name,
    file: region.source,
    'centre lng': ((region.bounds.minLng + region.bounds.maxLng) / 2).toFixed(4),
    'centre lat': ((region.bounds.minLat + region.bounds.maxLat) / 2).toFixed(4),
  }))));
  if (coverage.empty.length > 0) {
    console.log(
      '  A region with no store is usually one of three things: a polygon drawn ahead of the\n' +
        '  data (fine), a polygon in the wrong place, or a swapped [lat, lng] pair that stayed\n' +
        '  inside both coordinate ranges - which is the one case the loader cannot catch.'
    );
  }

  const wide = scenes
    .filter(scene => scene.extentKm > METRO_EXTENT_KM)
    .sort((a, b) => b.extentKm - a.extentKm);
  console.log(`\nRegions wider than ${METRO_EXTENT_KM}km across their own stores (${wide.length})`);
  console.log(table(wide.slice(0, 25).map(scene => ({
    region: scene.regionId,
    name: scene.label,
    'extent km': scene.extentKm,
    'in-scene play': percent(scene.intraShare),
  }))));

  // The play-share measurement, published as a health signal rather than
  // enforced as a gate. It used to *delete* a scene below the bar; a region
  // exists because a human drew it, so what the number decides now is whether
  // its ladder is worth presenting. See ranking/scenes.ts.
  const low = scenes
    .filter(scene => !scene.ladderMeaningful)
    .sort((a, b) => a.intraShare - b.intraShare);
  console.log(
    `\nRegions below the ${coverage.assignment.minIntraShare} play-share bar (${low.length} of ` +
      `${scenes.length}, holding ${stats.lowIntraSharePlayers} players)`
  );
  console.log(table(low.slice(0, 25).map(scene => ({
    region: scene.regionId,
    name: scene.label,
    'in-scene play': percent(scene.intraShare),
    'extent km': scene.extentKm,
  }))));
  console.log(
    '  These regions are published, named and on the map. The figure says their *ladder* is\n' +
      '  not meaningful yet - most of their players\' games are against people outside them -\n' +
      '  and the API and UI say so. It is not a reason to redraw a boundary on its own.'
  );

  console.log('\nDistribution');
  console.log(table([
    {
      'median in-scene play': percent(stats.medianIntraShare),
      'median extent km': stats.medianExtentKm,
      'max extent km': stats.maxExtentKm,
      'median store purity': percent(stats.medianPurity),
      'split stores (<60%)': stats.splitVenues,
    },
  ]));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
