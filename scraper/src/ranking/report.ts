/**
 * The connectivity / accuracy report, as a CLI.
 *
 * Driven by `scripts/metrics/ranking-metrics.sh`. It shares the graph, model and
 * validation code with the production pass rather than reimplementing it, so the
 * numbers in a report are the numbers the ladder was built from.
 *
 * Three jobs:
 *
 * - **connectivity** - measure the co-play graph. This is the measurement that
 *   decides whether a global ladder is meaningful at all, and it is the first
 *   thing to re-run when the data grows.
 * - **validate** - held-out accuracy against Riot's own tiebreakers, plus
 *   sweeps of the prior strength and the observation level. The only honest way
 *   to pick those two knobs.
 * - **fit** - a dry-run refit, to see what the publishing bar admits.
 * - **communities** - Louvain community detection on the same graph, plus the
 *   coverage curve, the geographic agreement and the stability measurements
 *   that decide whether a "scene" should stay a connected component. Nothing
 *   here is published: see ranking/communities.ts.
 * - **venues** - per-venue aggregates, the input a map view would need.
 *
 * Reads a fact source that is either the configured database (`DB_TYPE`) or an
 * NDJSON file of captured facts, which is how a regional sample can be analysed
 * before the production backfill has finished.
 */

import { readFileSync } from 'node:fs';
import { loadEventNames } from '../database.js';
import { ObservationBuilder, dayNumber, type ObservationSet } from './observations.js';
import { connectivityReport, type ConnectivityReport } from './graph.js';
import { communityReport, venueAggregates, type CommunityReport } from './communities.js';
import { buildEras, DEFAULT_PRERELEASE_OPTIONS, parseSetTable, parsePrereleaseTypes, type SetEra } from './sets.js';
import { replayDates, replayFacts, resolveVenueLabels, runRankingPass } from './pass.js';
import { gamesPerMatchByType, sweepObservationLevel, sweepPriorSigma, validate, validateByType } from './validate.js';
import { buildSnapshot, DEFAULT_SNAPSHOT_OPTIONS } from './snapshot.js';
import type { EventResults, EventRoster } from '../database.js';

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
  return [line(columns), line(widths.map(width => '-'.repeat(width))), ...rows.map(row => line(columns.map(column => row[column])))].join('\n');
}

/** Facts from an NDJSON file written by a sampling script. */
function loadNdjson(path: string, eras: readonly SetEra[]): ObservationSet {
  const builder = new ObservationBuilder(eras, new Map(), Number.POSITIVE_INFINITY, true, {
    prereleaseTypes: parsePrereleaseTypes(process.env.RANKING_PRERELEASE_TYPES),
    leadDays: Number(process.env.RANKING_PRERELEASE_LEAD_DAYS ?? DEFAULT_PRERELEASE_OPTIONS.leadDays),
  });
  const rows: { results: EventResults | null; roster: EventRoster | null }[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A partially written last line is expected while a sample is still running.
    }
  }
  const revive = <T extends { eventStartDate: unknown }>(fact: T): T =>
    ({ ...fact, eventStartDate: new Date(fact.eventStartDate as string) });
  rows.sort((a, b) => {
    const left = a.results?.eventStartDate ?? a.roster?.eventStartDate ?? '';
    const right = b.results?.eventStartDate ?? b.roster?.eventStartDate ?? '';
    return String(left) < String(right) ? -1 : 1;
  });
  for (const row of rows) {
    if (row.results && row.results.status !== 'none') builder.addResults(revive(row.results));
    if (row.roster) builder.addRoster(revive(row.roster));
  }
  return builder.finish();
}

function printConnectivity(report: ConnectivityReport): void {
  console.log('\n=== CO-PLAY GRAPH ===\n');
  console.log(table([{
    players: report.players,
    'with matches': report.playersWithMatches,
    matches: report.matches,
    games: report.games,
    venues: report.venues,
  }]));

  console.log('\nComponents');
  console.log(table([{
    components: report.componentCount,
    'giant size': report.giantComponentSize,
    'giant share': percent(report.giantComponentShare),
  }]));
  console.log('\nComponent size distribution (smallest first)');
  console.log(table(report.componentSizeHistogram.slice(0, 15).map(row => ({
    size: row.size,
    components: row.components,
    players: row.players,
    'share of rated pool': percent(report.playersWithMatches > 0 ? row.players / report.playersWithMatches : 0),
  }))));

  console.log('\nVenues per player');
  console.log(table(report.playersByVenueCount.slice(0, 10).map(row => ({
    venues: row.venues,
    players: row.players,
    share: percent(report.playersWithMatches > 0 ? row.players / report.playersWithMatches : 0),
  }))));
  console.log(table([{
    'players at >1 venue': report.multiVenuePlayers,
    share: percent(report.multiVenueShare),
    'median venues/player': report.medianVenuesPerPlayer,
  }]));

  console.log('\nVenue graph (venues linked when a player played at both)');
  console.log(table([{
    venues: report.venues,
    components: report.venueComponentCount,
    'giant size': report.venueGiantComponentSize,
    'giant share': percent(report.venueGiantComponentShare),
  }]));

  console.log('\n=== WHICH EVENTS BRIDGE VENUES ===\n');
  console.log(`cross-venue matches: ${report.crossVenueMatches} of ${report.matches} (${percent(report.crossVenueShare)})`);
  console.log(table(report.bridgingByType.map(row => ({
    'tournament type': row.tournamentType,
    matches: row.matches,
    'cross-venue': row.crossVenueMatches,
    'share of all cross-venue': percent(row.shareOfCrossVenue),
    'cross-venue rate': percent(row.crossVenueRate),
    'venue pairs only it supplies': row.uniqueVenuePairs,
  }))));

  console.log('\nLeave-one-type-out: remove a whole tier and refit the components');
  console.log(table(report.leaveOneTypeOut.map(row => ({
    removed: row.removedType,
    'matches removed': row.matchesRemoved,
    components: row.componentCount,
    'giant share': percent(row.giantShare),
    'delta (pp)': (row.giantShareDelta * 100).toFixed(1),
  }))));

  console.log('\nMatches per player');
  console.log(table(report.matchesPerPlayer.map(row => ({ percentile: `p${row.percentile}`, matches: row.matches }))));
  console.log(table(report.playersWithAtLeast.map(row => ({
    'at least': `${row.matches} matches`,
    players: row.players,
    share: percent(report.playersWithMatches > 0 ? row.players / report.playersWithMatches : 0),
  }))));
}


function printCommunities(report: CommunityReport): void {
  console.log('\n=== COMMUNITIES (Louvain on the weighted co-play graph) ===\n');
  console.log(table([{
    'players with matches': report.playersWithMatches,
    edges: report.edges,
    resolution: report.resolution,
    communities: report.communityCount,
    modularity: report.modularity.toFixed(4),
    levels: report.levels,
    'largest community': percent(report.largestCommunityShare),
  }]));
  console.log(table([{
    'components (incumbent)': report.componentCount,
    'giant component': percent(report.giantComponentShare),
    'louvain ms': report.elapsedMs.louvain,
    'components ms': report.elapsedMs.components,
  }]));

  console.log('\nCommunity size distribution');
  console.log(table(report.communitySizes.map(row => ({ percentile: `p${row.percentile}`, size: row.size }))));
  console.log(table(report.communitiesOverSize.map(row => ({
    'at least': `${row.size} players`,
    communities: row.communities,
    players: row.players,
    share: percent(report.playersWithMatches > 0 ? row.players / report.playersWithMatches : 0),
  }))));

  console.log('\nLargest communities (does one look like a scene?)');
  console.log(table(report.topCommunities.map(row => ({
    id: row.id,
    players: row.size,
    matches: row.matches,
    venues: row.venues,
    'top venue share': percent(row.dominantVenueShare),
    'mean venue spread (km)': row.spreadKm.toFixed(1),
    'dominant metro purity': percent(row.metroPurity),
  }))));

  console.log(`\nAgreement with geography (metros = venues single-linked within ${report.metroRadiusKm}km)`);
  console.log(table([
    {
      compared: `metro (${report.metroCount} of them)`,
      ARI: report.vsMetro.adjustedRand.toFixed(4),
      NMI: report.vsMetro.normalisedMutualInformation.toFixed(4),
      'label churn': percent(report.vsMetro.churn),
    },
    {
      compared: 'home venue',
      ARI: report.vsHomeVenue.adjustedRand.toFixed(4),
      NMI: report.vsHomeVenue.normalisedMutualInformation.toFixed(4),
      'label churn': percent(report.vsHomeVenue.churn),
    },
  ]));
  console.log(table([{
    'communities spanning >1 metro': report.communitiesSpanningMetros,
    'metros split across >1 community': report.metrosSplitAcrossCommunities,
  }]));

  console.log('\n=== HOW THE PARTITION MOVES AS COVERAGE GROWS ===');
  console.log('(a random share of events, which is what an incomplete backfill looks like)');
  console.log(table(report.coverage.map(row => ({
    coverage: percent(row.coverage),
    events: row.events,
    matches: row.matches,
    players: row.playersWithMatches,
    components: row.components,
    'giant share': percent(row.giantShare),
    communities: row.communities,
    'largest community': percent(row.largestCommunityShare),
    modularity: row.modularity.toFixed(4),
  }))));

  console.log('\nThe same, with only the earliest X% of the window captured');
  console.log('(what a backfill walking the calendar actually produces)');
  console.log(table(report.coverageByDate.map(row => ({
    coverage: percent(row.coverage),
    events: row.events,
    matches: row.matches,
    players: row.playersWithMatches,
    components: row.components,
    'giant share': percent(row.giantShare),
    communities: row.communities,
    'largest community': percent(row.largestCommunityShare),
    modularity: row.modularity.toFixed(4),
  }))));

  console.log('\n=== RESOLUTION SWEEP (how coarse should a scene be?) ===\n');
  console.log(table(report.resolutionSweep.map(row => ({
    resolution: row.resolution,
    communities: row.communities,
    modularity: row.modularity.toFixed(4),
    'largest community': percent(row.largestShare),
    'metro ARI': row.metroAdjustedRand.toFixed(4),
    'metro NMI': row.metroNormalisedMutualInformation.toFixed(4),
    'churn on 90% subsample': percent(row.churn90),
  }))));

  console.log('\n=== STABILITY (relabel a subsample, compare to the full one) ===');
  console.log('(churn = share of players who would see a different scene label)');
  console.log(table(report.stability.flatMap(row => [
    {
      subsample: row.label,
      primitive: 'community',
      churn: percent(row.community.churn),
      ARI: row.community.adjustedRand.toFixed(4),
      NMI: row.community.normalisedMutualInformation.toFixed(4),
    },
    {
      subsample: row.label,
      primitive: `community (>= ${report.largeCommunityThreshold})`,
      churn: percent(row.communityLargeOnly.churn),
      ARI: row.communityLargeOnly.adjustedRand.toFixed(4),
      NMI: row.communityLargeOnly.normalisedMutualInformation.toFixed(4),
    },
    {
      subsample: row.label,
      primitive: 'component',
      churn: percent(row.component.churn),
      ARI: row.component.adjustedRand.toFixed(4),
      NMI: row.component.normalisedMutualInformation.toFixed(4),
    },
  ])));
}

async function loadObservations(args: Record<string, string>): Promise<ObservationSet> {
  const { table: setTable } = parseSetTable(args.setTable ?? process.env.RANKING_SET_TABLE);
  const eras = buildEras(setTable);

  if (args.file) {
    console.log(`Reading captured facts from ${args.file}`);
    return loadNdjson(args.file, eras);
  }

  const historyDays = Number(args.days ?? '400');
  console.log(`Replaying ${historyDays} days of stored facts from DB_TYPE=${process.env.DB_TYPE ?? 'sqlite'}`);
  const eventNames = await loadEventNames(historyDays, 2).catch(() => new Map<string, string>());
  const { observations } = await replayFacts({
    dates: replayDates(new Date(), historyDays, 2),
    eras,
    eventNames,
    maxMatches: Number.POSITIVE_INFINITY,
    collectStandings: true,
    prerelease: {
      prereleaseTypes: parsePrereleaseTypes(process.env.RANKING_PRERELEASE_TYPES),
      leadDays: Number(process.env.RANKING_PRERELEASE_LEAD_DAYS ?? DEFAULT_PRERELEASE_OPTIONS.leadDays),
    },
  });
  return observations;
}

function lastDay(observations: ObservationSet): number {
  let max = -Infinity;
  for (const event of observations.events) if (event.day > max) max = event.day;
  return Number.isFinite(max) ? max : dayNumber(new Date());
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv.find(argument => !argument.startsWith('--')) ?? 'connectivity';
  const args: Record<string, string> = {};
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue;
    const [key, value = 'true'] = argument.slice(2).split('=');
    args[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }

  if (command === 'fit') {
    const summary = await runRankingPass({
      historyDays: Number(args.days ?? '400'),
      dryRun: true,
      setTable: args.setTable ?? process.env.RANKING_SET_TABLE,
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const observations = await loadObservations(args);
  if (observations.stats.matchesUsed === 0) {
    console.log('\nNo match facts available yet - nothing to measure.');
    console.log(`(events seen: ${observations.stats.eventsSeen}, rosters: ${observations.stats.rostersSeen}, ` +
      `players: ${observations.players.length})`);
    return;
  }

  console.log('\nObservation extraction');
  console.log(table([{
    events: observations.stats.eventsWithMatches,
    matches: observations.stats.matchesUsed,
    games: observations.stats.gamesUsed,
    draws: observations.stats.drawsSeen,
    byes: observations.stats.byeMatchesSkipped,
    'bye leaks': observations.stats.byeLeaks,
    unmapped: observations.stats.unmappedTeamSkipped,
    undecided: observations.stats.undecidedSkipped,
  }]));

  if (command === 'connectivity' || command === 'all') {
    printConnectivity(connectivityReport(observations));
  }

  if (command === 'communities' || command === 'all') {
    printCommunities(communityReport(observations, {
      resolution: Number(args.resolution ?? '1'),
      metroRadiusKm: Number(args.metroRadiusKm ?? '25'),
    }));
  }

  if (command === 'venues' || command === 'all') {
    const venues = venueAggregates(observations);
    console.log('\n=== VENUES (what a map view would aggregate) ===\n');
    const withCoordinates = venues.filter(venue => venue.latitude !== null).length;
    console.log(table([{
      venues: venues.length,
      'with coordinates': withCoordinates,
      'with a shop id': venues.filter(venue => venue.shopExternalId !== null).length,
      'median players/venue': venues.length > 0
        ? [...venues].map(v => v.players).sort((a, b) => a - b)[Math.floor(venues.length / 2)]
        : 0,
    }]));
    console.log('\nBusiest venues');
    console.log(table(venues.slice(0, 15).map(venue => ({
      venue: venue.venue,
      players: venue.players,
      matches: venue.matches,
      events: venue.events,
      latitude: venue.latitude?.toFixed(4) ?? '-',
      longitude: venue.longitude?.toFixed(4) ?? '-',
    }))));
  }

  if (command === 'validate' || command === 'all') {
    const holdoutDays = Number(args.holdoutDays ?? '7');
    const cutoff = lastDay(observations) - holdoutDays + 1;
    console.log(`\n=== HELD-OUT ACCURACY (last ${holdoutDays} days held out) ===\n`);
    const base = validate(observations, cutoff);
    console.log(table([{
      'train matches': base.trainMatches,
      'test matches': base.testMatches,
      'both players seen in train': base.evaluable,
      'cold-start share': percent(base.coldStartShare),
    }]));
    console.log(table(base.scores.map(score => ({
      predictor: score.name,
      scored: score.covered,
      accuracy: percent(score.accuracy),
      'log loss': score.logLoss.toFixed(4),
      brier: score.brier.toFixed(4),
    }))));

    console.log('\nPrior SD sweep (picked on held-out log loss)');
    console.log(table(sweepPriorSigma(observations, cutoff, [75, 100, 150, 200, 300, 450]).map(row => {
      const whr = row.result.scores[0];
      return {
        'prior SD (Elo)': row.priorSigmaElo,
        accuracy: percent(whr.accuracy),
        'log loss': whr.logLoss.toFixed(4),
        brier: whr.brier.toFixed(4),
      };
    })));

    console.log('\nGames recorded per match, by tournament type');
    console.log('(strongly type-dependent; the pooled figure is an artefact of the window\'s event mix)');
    console.log(table(gamesPerMatchByType(observations).map(row => ({
      'tournament type': row.tournamentType,
      matches: row.matches,
      games: row.games,
      'games/match': row.gamesPerMatch.toFixed(2),
      // Not '0'/'1'/'2' - integer-like object keys are reordered ahead of the
      // others by JS property ordering, which scrambles the column headers.
      'none recorded': row.histogram[0],
      'one game': row.histogram[1],
      'two games': row.histogram[2],
      'three games': row.histogram[3],
    }))));

    console.log('\nPooled vs per-type fit, on the same held-out matches');
    console.log('(does one rating across sealed and constructed events cost anything?)');
    const typeRows = validateByType(observations, cutoff);
    if (typeRows.length === 0) console.log('  (no type has enough training matches)');
    else console.log(table(typeRows.map(row => ({
      'tournament type': row.tournamentType,
      'held-out': row.heldOut,
      'type-only train': row.restrictedTrainMatches,
      'pooled acc': percent(row.pooled.accuracy),
      'pooled loss': row.pooled.logLoss.toFixed(4),
      'type-only acc': percent(row.restricted.accuracy),
      'type-only loss': row.restricted.logLoss.toFixed(4),
      'pooled - type (loss)': row.logLossDelta.toFixed(4),
    }))));

    console.log('\nObservation level sweep');
    console.log(table(sweepObservationLevel(observations, cutoff).map(row => {
      const whr = row.result.scores[0];
      return {
        variant: row.label,
        accuracy: percent(whr.accuracy),
        'log loss': whr.logLoss.toFixed(4),
        brier: whr.brier.toFixed(4),
      };
    })));
  }

  if (command === 'bar' || command === 'all') {
    console.log('\n=== WHAT THE PUBLISHING BAR ADMITS ===\n');
    const venueLabels = args.file ? new Map<string, string>() : await resolveVenueLabels(observations);
    const { table: setTable } = parseSetTable(args.setTable ?? process.env.RANKING_SET_TABLE);
    const rows: Record<string, string | number>[] = [];
    for (const minGames of [0, 5, 6, 8, 10, 12]) {
      for (const maxUncertaintyElo of [100, 120, 150]) {
        const { diagnostics } = buildSnapshot(observations, {
          ...DEFAULT_SNAPSHOT_OPTIONS,
          minGames,
          maxUncertaintyElo,
          eras: buildEras(setTable),
          setTable,
          venueLabels,
          matchLogEvents: new Set(),
          whr: {},
        });
        rows.push({
          'min games': minGames,
          'max SD (Elo)': maxUncertaintyElo,
          rated: diagnostics.ratedPlayers,
          'of players': diagnostics.playersWithMatches,
          share: percent(
            diagnostics.playersWithMatches > 0 ? diagnostics.ratedPlayers / diagnostics.playersWithMatches : 0
          ),
        });
      }
    }
    console.log(table(rows));
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
