import { describe, it, expect } from 'vitest';
import type { ComponentSummary, PlayerMatch, RatingPoint, SetInfo } from '../../types/ranking';
import {
  ALL_SETS,
  ALL_SETS_LABEL,
  BACKFILL_DAYS,
  MIN_Y_SPAN,
  RATING_ANCHOR,
  UNRANKED_LABEL,
  buildRatingChartGeometry,
  buildScope,
  componentLabel,
  filterSceneOptions,
  findSceneOption,
  formatRating,
  formatRecord,
  formatUncertainty,
  formatWinRate,
  gameScore,
  gateProgress,
  hasNoRecord,
  marginBar,
  marginScale,
  outcomeLetter,
  outcomeWord,
  recentForm,
  matchRecord,
  nearestPointIndex,
  niceTicks,
  parseChartDate,
  parseScope,
  pickDefaultComponent,
  shouldUseSetPills,
  SET_PILL_LIMIT,
  sceneOptions,
  selectableSets,
  provisionalExplanation,
  provisionalShortReason,
  setBoundaryNote,
  setLabel,
  splitByConfidence,
  winRate,
} from '../ranking';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const DAY = 86_400_000;

function point(date: string, rating: number, uncertainty: number | null = 100, games = 4): RatingPoint {
  return { date, rating, uncertainty, gamesPlayed: games };
}

function entry(overrides: Partial<Parameters<typeof splitByConfidence>[0][number]>) {
  return {
    rank: null,
    playerId: 'p',
    displayName: 'P',
    tagLine: 'NA1',
    rating: 1240,
    uncertainty: 90,
    gamesPlayed: 10,
    matchesPlayed: 5,
    componentId: 'c',
    componentSize: 20,
    regionLabel: 'Region',
    provisional: false,
    provisionalReason: null,
    gamesUntilRated: 0,
    ...overrides,
  };
}

describe('scope round-tripping', () => {
  it('builds the scope strings the API expects', () => {
    expect(buildScope(null, null)).toBe(ALL_SETS);
    expect(buildScope(ALL_SETS, null)).toBe(ALL_SETS);
    expect(buildScope('radiance', null)).toBe('set:radiance');
    expect(buildScope(null, 'c-bay')).toBe('component:c-bay');
    expect(buildScope('radiance', 'c-bay')).toBe('set:radiance#component:c-bay');
  });

  it('parses them back', () => {
    expect(parseScope('set:radiance#component:c-bay')).toEqual({ setId: 'radiance', componentId: 'c-bay' });
    expect(parseScope('all')).toEqual({ setId: null, componentId: null });
    expect(parseScope(null)).toEqual({ setId: null, componentId: null });
  });
});

describe('pickDefaultComponent', () => {
  const comp = (id: string, size: number, rated: number, comparable: boolean): ComponentSummary => ({
    componentId: id,
    regionLabel: id,
    componentSize: size,
    ratedPlayers: rated,
    comparable,
  });

  it('prefers a comparable scene with the most rated players', () => {
    expect(pickDefaultComponent([comp('a', 30, 2, true), comp('b', 20, 9, true)])).toBe('b');
  });

  it('falls back to the biggest scene when none is comparable', () => {
    expect(pickDefaultComponent([comp('a', 3, 0, false), comp('b', 6, 0, false)])).toBe('b');
  });

  it('has nothing to pick when there are no scenes - the launch-day case', () => {
    expect(pickDefaultComponent([])).toBeNull();
  });
});

describe('set labels with unknown boundaries', () => {
  const set = (overrides: Partial<SetInfo>): SetInfo => ({
    setId: 's',
    name: null,
    releaseDate: null,
    endDate: null,
    hasRatingData: true,
    ...overrides,
  });

  it('keeps the set scope as pills while the list is short', () => {
    // Today: Radiance+ plus Radiance plus Vendetta.
    expect(shouldUseSetPills(0)).toBe(true);
    expect(shouldUseSetPills(2)).toBe(true);
    expect(shouldUseSetPills(SET_PILL_LIMIT - 1)).toBe(true);
  });

  it('switches to a dropdown once the sets outgrow one line', () => {
    // Sets are append-only at roughly four a year, so this is reached, not
    // hypothetical - and a segmented row that overflows hides a scope.
    expect(shouldUseSetPills(SET_PILL_LIMIT)).toBe(false);
    expect(shouldUseSetPills(12)).toBe(false);
  });

  it('offers only released sets the engine has data for, newest first', () => {
    const now = new Date('2026-10-25T00:00:00Z');
    const offered = selectableSets(
      [
        set({ setId: 's7', name: 'The Reckoning', releaseDate: '2027-04-30', hasRatingData: false }),
        set({ setId: 's6', name: 'Legacy', releaseDate: '2027-01-29', hasRatingData: false }),
        set({ setId: 's5', name: 'Radiance', releaseDate: '2026-10-23', hasRatingData: true }),
        set({ setId: 's4', name: 'Vendetta', releaseDate: '2026-07-31', hasRatingData: true }),
        set({ setId: 's1', name: 'Origins', releaseDate: '2025-10-31', hasRatingData: false }),
      ],
      now
    );
    // Order is the API's (newest first) and is preserved by the filter.
    expect(offered.map((entry) => entry.name)).toEqual(['Radiance', 'Vendetta']);
  });

  it('drops a set released in the future even when it somehow has data', () => {
    const now = new Date('2026-10-25T00:00:00Z');
    expect(selectableSets([set({ setId: 's6', releaseDate: '2027-01-29', hasRatingData: true })], now)).toEqual([]);
  });

  it('keeps a set released today', () => {
    const now = new Date('2026-10-23T18:00:00Z');
    expect(selectableSets([set({ setId: 's5', releaseDate: '2026-10-23' })], now)).toHaveLength(1);
  });

  it('does not call the all-time scope "all sets", which would overstate it', () => {
    // Results only exist for events the backfill has reached.
    expect(ALL_SETS_LABEL).toBe('Radiance+');
    expect(ALL_SETS_LABEL.toLowerCase()).not.toContain('all sets');
  });

  it('falls back to the id when a set has no name', () => {
    expect(setLabel(set({ setId: 'set-2' }))).toBe('set-2');
    expect(setLabel(set({ setId: 'rad', name: 'Radiance' }))).toBe('Radiance');
  });

  it('says so when the release date was never published, instead of leaving a gap', () => {
    expect(setBoundaryNote(set({}))).toBe('release date not published');
    expect(setBoundaryNote(set({ releaseDate: '2026-10-23' }))).toMatch(/^released /);
    expect(setBoundaryNote(set({ releaseDate: '2026-10-23', endDate: '2027-01-15' }))).toMatch(/ - /);
  });
});

describe('formatting', () => {
  it('shows a dash rather than a zero for a missing rating', () => {
    expect(formatRating(null)).toBe('--');
    expect(formatRating(undefined)).toBe('--');
    expect(formatRating(1287.6)).toBe('1,288');
  });

  it('renders uncertainty as a margin, and nothing when unknown', () => {
    expect(formatUncertainty(86)).toBe('±86');
    expect(formatUncertainty(null)).toBe('');
  });

  it('labels a scope with no component as not region-specific', () => {
    expect(componentLabel(null)).toBe('Everywhere');
    expect(componentLabel({ componentId: 'c', regionLabel: null })).toBe('Scene c');
    expect(componentLabel({ componentId: 'c', regionLabel: 'Puget Sound' })).toBe('Puget Sound');
  });
});

describe('the unranked wording', () => {
  it('prints one word, not a reason, wherever a rating is withheld', () => {
    // The page used to say "too few games · 4 games · 4 to go" inline. It
    // says "Unranked" now; the reason is a tooltip.
    expect(UNRANKED_LABEL).toBe('Unranked');
  });

  it('starts the scale at the engine anchor', () => {
    expect(RATING_ANCHOR).toBe(1200);
  });

  it('keeps the reason available as tooltip text, headed by the word', () => {
    for (const reason of ['no-rating', 'too-few-games', 'uncertainty-too-wide'] as const) {
      expect(provisionalExplanation(reason, 4, 8)).toMatch(/^Unranked/);
    }
    expect(provisionalExplanation('no-rating', 8, 8)).toMatch(/no games recorded yet/);
    expect(provisionalExplanation('too-few-games', 1, 8)).toMatch(/one more recorded game/);
    expect(provisionalExplanation('too-few-games', 6, 8)).toMatch(/6 more recorded games/);
    expect(provisionalExplanation('uncertainty-too-wide', 0, 8)).toMatch(/margin is still too wide/);
  });

  it('says nothing when the rating is fit to show', () => {
    expect(provisionalExplanation(null, 0, 8)).toBe('');
  });

  it('sentence-cases the short reason for a table cell tooltip', () => {
    expect(provisionalShortReason('too-few-games')).toBe('Too few games');
    expect(provisionalShortReason('uncertainty-too-wide')).toBe('Margin too wide');
    expect(provisionalShortReason('no-rating')).toBe('No games yet');
    expect(provisionalShortReason(null)).toBe('--');
  });
});

describe('the searchable scene picker', () => {
  const comp = (id: string, label: string | null, rated: number, comparable = true): ComponentSummary => ({
    componentId: id,
    regionLabel: label,
    componentSize: 30,
    ratedPlayers: rated,
    comparable,
  });

  const components = [
    comp('a', 'Puget Sound', 12),
    comp('b', 'Bay Area', 9),
    comp('c', 'Montréal', 2, false),
    comp('d', null, 0, false),
  ];

  it('leads with Everywhere, then one row per scene', () => {
    const options = sceneOptions(components);
    expect(options[0]).toEqual({ id: null, label: 'Everywhere', meta: 'not comparable', comparable: false });
    expect(options.map((option) => option.label)).toEqual([
      'Everywhere',
      'Puget Sound',
      'Bay Area',
      'Montréal',
      'Scene d',
    ]);
    expect(options[1].meta).toBe('12 rated');
    expect(options[3].meta).toBe('2 rated · too small');
  });

  it('filters by what you type, ignoring case and accents', () => {
    const options = sceneOptions(components);
    expect(filterSceneOptions(options, 'puget').map((o) => o.label)).toEqual(['Puget Sound']);
    expect(filterSceneOptions(options, 'AREA').map((o) => o.label)).toEqual(['Bay Area']);
    expect(filterSceneOptions(options, 'montreal').map((o) => o.label)).toEqual(['Montréal']);
    expect(filterSceneOptions(options, 'sound').map((o) => o.label)).toEqual(['Puget Sound']);
  });

  it('treats an empty query as no filter, and an unmatched one as no rows', () => {
    const options = sceneOptions(components);
    expect(filterSceneOptions(options, '')).toHaveLength(options.length);
    expect(filterSceneOptions(options, '   ')).toHaveLength(options.length);
    expect(filterSceneOptions(options, 'zzz')).toEqual([]);
  });

  it('finds the row for the current selection, including Everywhere', () => {
    const options = sceneOptions(components);
    expect(findSceneOption(options, 'b')?.label).toBe('Bay Area');
    expect(findSceneOption(options, null)?.label).toBe('Everywhere');
    expect(findSceneOption(options, 'missing')).toBeNull();
  });
});

describe('splitByConfidence', () => {
  it('keeps provisional players out of the ladder', () => {
    const { rated, provisional } = splitByConfidence([
      entry({ playerId: 'a', rank: 1 }),
      entry({ playerId: 'b', provisional: true, provisionalReason: 'too-few-games' }),
    ]);
    expect(rated.map((e) => e.playerId)).toEqual(['a']);
    expect(provisional.map((e) => e.playerId)).toEqual(['b']);
  });

  it('handles an entirely provisional page - the normal state at launch', () => {
    const all = [1, 2, 3].map((n) =>
      entry({ playerId: `p${n}`, provisional: true, provisionalReason: 'too-few-games' })
    );
    const { rated, provisional } = splitByConfidence(all);
    expect(rated).toEqual([]);
    expect(provisional).toHaveLength(3);
  });
});

describe('match helpers', () => {
  const match = (outcome: PlayerMatch['outcome'], games: PlayerMatch['games']): PlayerMatch => ({
    matchId: 'm',
    playedAt: '2026-10-22T19:00:00.000Z',
    opponentId: 'o',
    opponentDisplayName: 'Opponent',
    outcome,
    games,
    eventExternalId: 'e',
    eventName: 'Event',
    shopId: '1',
    latitude: null,
    longitude: null,
    eventDate: '2026-10-22',
    tournamentType: 'Nexus Night',
    setId: 'radiance',
  });

  it('scores a Bo3 from its per-game outcomes', () => {
    expect(
      gameScore(
        match('win', [
          { gameNumber: 1, outcome: 'win' },
          { gameNumber: 2, outcome: 'loss' },
          { gameNumber: 3, outcome: 'win' },
        ])
      )
    ).toBe('2-1');
    expect(gameScore(match('loss', []))).toBe('0-0');
  });

  it('counts a record, draws only when there are any', () => {
    const record = matchRecord([
      match('win', []),
      match('loss', []),
      match('win', []),
      match('unknown', []),
    ]);
    expect(record).toEqual({ wins: 2, losses: 1, draws: 0 });
    expect(formatRecord(record)).toBe('2-1');
    expect(formatRecord({ wins: 1, losses: 1, draws: 1 })).toBe('1-1-1');
  });

  it('reports an empty record for a player with no games', () => {
    expect(formatRecord(matchRecord([]))).toBe('0-0');
  });
});

describe('the record bar', () => {
  it('rates only decided matches, and counts draws as decided', () => {
    expect(winRate({ wins: 3, losses: 1, draws: 0 })).toBe(75);
    expect(winRate({ wins: 1, losses: 1, draws: 2 })).toBe(25);
  });

  it('refuses a percentage when nothing is decided', () => {
    // A player whose only match is unrecorded has not won 0% - there is
    // simply no evidence, and the bar has to say so rather than print a
    // confident zero.
    expect(winRate({ wins: 0, losses: 0, draws: 0 })).toBeNull();
    expect(formatWinRate(null)).toBe('--');
    expect(formatWinRate(66.6)).toBe('67%');
  });
});

describe('results carry a letter as well as a colour', () => {
  it('letters every outcome, including the unrecorded one', () => {
    expect(outcomeLetter('win')).toBe('W');
    expect(outcomeLetter('loss')).toBe('L');
    expect(outcomeLetter('draw')).toBe('D');
    expect(outcomeLetter('unknown')).toBe('?');
  });

  it('words the same outcomes for the row label and screen readers', () => {
    expect(outcomeWord('win')).toBe('Win');
    expect(outcomeWord('unknown')).toBe('Unrecorded');
  });
});

describe('the form strip', () => {
  const stub = (id: string): PlayerMatch => ({
    matchId: id,
    playedAt: `2026-10-${id}T19:00:00.000Z`,
    opponentId: 'o',
    opponentDisplayName: 'Opponent',
    outcome: 'win',
    games: [],
    eventExternalId: 'e',
    eventName: 'Event',
    shopId: '1',
    latitude: null,
    longitude: null,
    eventDate: `2026-10-${id}`,
    tournamentType: 'Nexus Night',
    setId: 'radiance',
  });

  it('takes the newest matches in the order the API returns them', () => {
    const matches = ['24', '23', '22', '21'].map(stub);
    expect(recentForm(matches, 2).map((match) => match.matchId)).toEqual(['24', '23']);
  });

  it('shows what there is when there is less than a full strip', () => {
    // Three matches is the normal case at launch. Three pips, not ten with
    // seven empty sockets - an empty socket implies something is missing.
    expect(recentForm([stub('24'), stub('23'), stub('22')], 10)).toHaveLength(3);
    expect(recentForm([], 10)).toEqual([]);
  });
});

describe('the games gate', () => {
  it('counts evidence against the published threshold', () => {
    expect(gateProgress(3, 8)).toEqual({ filled: 3, total: 8 });
    expect(gateProgress(null, 8)).toEqual({ filled: 0, total: 8 });
  });

  it('never overfills, and gives up on an implausible threshold', () => {
    expect(gateProgress(40, 8)).toEqual({ filled: 8, total: 8 });
    expect(gateProgress(1, 0)).toBeNull();
    expect(gateProgress(1, 500)).toBeNull();
  });

  it('stays away when the games are not what is missing', () => {
    // A player with twelve games held back by a wide margin has cleared this
    // bar already; a full meter beside "Unranked" reads as a contradiction.
    expect(gateProgress(12, 8, 'uncertainty-too-wide')).toBeNull();
    expect(gateProgress(0, 8, 'no-rating')).toEqual({ filled: 0, total: 8 });
    expect(gateProgress(3, 8, 'too-few-games')).toEqual({ filled: 3, total: 8 });
  });
});

describe('margin bars', () => {
  const entry = (rating: number | null, uncertainty: number | null, provisional = false) => ({
    rank: null,
    playerId: `p${rating}`,
    displayName: 'P',
    tagLine: null,
    rating,
    uncertainty,
    gamesPlayed: 10,
    matchesPlayed: 4,
    componentId: 'c',
    componentSize: 12,
    regionLabel: 'Scene',
    provisional,
    provisionalReason: null,
    gamesUntilRated: 0,
  });

  it('spans every rated rating plus and minus its margin', () => {
    const scale = marginScale([entry(1200, 100), entry(1300, 50), entry(1250, 20)]);
    expect(scale).toEqual({ min: 1100, max: 1350 });
  });

  it('draws no bars at all when there is nothing to compare', () => {
    // Sparse is the normal case: a bar with nothing beside it is decoration,
    // so one or two rated players get the number and no axis.
    expect(marginScale([entry(1200, 100)])).toBeNull();
    expect(marginScale([entry(1200, 100), entry(1300, 50)])).toBeNull();
    expect(marginScale([entry(1200, 0), entry(1200, 0), entry(1200, 0)])).toBeNull();
    expect(marginScale([entry(1200, 100, true), entry(1300, 50, true), entry(1250, 20, true)])).toBeNull();
  });

  it('places a span and its marker on the shared axis', () => {
    const scale = { min: 1100, max: 1300 };
    expect(marginBar({ rating: 1200, uncertainty: 50 }, scale)).toEqual({
      leftPercent: 25,
      widthPercent: 50,
      markerPercent: 50,
    });
  });

  it('still shows a mark for a rating with no recorded margin', () => {
    const bar = marginBar({ rating: 1200, uncertainty: null }, { min: 1100, max: 1300 });
    expect(bar?.widthPercent).toBeGreaterThan(0);
    expect(bar?.markerPercent).toBe(50);
  });

  it('clamps a span that runs past the axis, and skips an unrated row', () => {
    const bar = marginBar({ rating: 1150, uncertainty: 400 }, { min: 1100, max: 1300 });
    expect(bar).toEqual({ leftPercent: 0, widthPercent: 100, markerPercent: 25 });
    expect(marginBar({ rating: null, uncertainty: 40 }, { min: 1100, max: 1300 })).toBeNull();
    expect(marginBar({ rating: 1200, uncertainty: 40 }, null)).toBeNull();
  });
});

describe('niceTicks', () => {
  it('rounds to readable steps', () => {
    expect(niceTicks(1100, 1300)).toEqual([1100, 1150, 1200, 1250, 1300]);
  });

  it('degenerates safely when there is no span', () => {
    expect(niceTicks(1200, 1200)).toEqual([1200]);
  });
});

describe('buildRatingChartGeometry', () => {
  const options = { width: 720, height: 300, now: NOW };

  it('returns nothing to draw for an empty series', () => {
    expect(buildRatingChartGeometry([], options)).toBeNull();
  });

  it('draws no line for a one-point series - one point is not a trend', () => {
    const geometry = buildRatingChartGeometry([point('2026-10-24', 1176, 259, 2)], options)!;
    expect(geometry.points).toHaveLength(1);
    expect(geometry.linePath).toBeNull();
    expect(geometry.bandPath).toBeNull();
    // The band becomes an error bar, so the point still carries its margin.
    expect(geometry.points[0].hasBand).toBe(true);
    expect(geometry.points[0].hiY).toBeLessThan(geometry.points[0].loY);
  });

  it('keeps a two-point series honest: it spans the backfill window, not the chart', () => {
    const geometry = buildRatingChartGeometry(
      [point('2026-10-23', 1200, 240, 2), point('2026-10-24', 1220, 230, 4)],
      options
    )!;

    const [xMin, xMax] = geometry.xDomain;
    expect(xMin).toBeLessThanOrEqual(NOW - BACKFILL_DAYS * DAY);
    expect(xMax).toBeGreaterThanOrEqual(NOW);

    // The two points sit in the right-hand sliver, not edge to edge.
    const used = geometry.points[geometry.points.length - 1].x - geometry.points[0].x;
    expect(used).toBeLessThan(geometry.plot.width * 0.25);
    expect(geometry.linePath).toBeTruthy();
    expect(geometry.bandPath).toBeTruthy();
  });

  it('never magnifies a small move into a cliff', () => {
    // Two points eight rating points apart, with no uncertainty at all.
    const geometry = buildRatingChartGeometry(
      [point('2026-10-23', 1200, null, 2), point('2026-10-24', 1208, null, 4)],
      options
    )!;
    const [yMin, yMax] = geometry.yDomain;
    expect(yMax - yMin).toBeGreaterThanOrEqual(MIN_Y_SPAN);

    // 8 points of movement across a >=200 point axis is a gentle slope.
    const rise = Math.abs(geometry.points[1].y - geometry.points[0].y);
    expect(rise).toBeLessThan(geometry.plot.height * 0.1);
  });

  it('fits the y-axis around the band, not just the line', () => {
    const geometry = buildRatingChartGeometry(
      [point('2026-10-10', 1200, 300, 2), point('2026-10-24', 1220, 260, 4)],
      options
    )!;
    const [yMin, yMax] = geometry.yDomain;
    expect(yMin).toBeLessThan(1200 - 300);
    expect(yMax).toBeGreaterThan(1220 + 260);
  });

  it('skips the band when no point carries an uncertainty', () => {
    const geometry = buildRatingChartGeometry(
      [point('2026-10-20', 1200, null), point('2026-10-22', 1210, null), point('2026-10-24', 1205, null)],
      options
    )!;
    expect(geometry.bandPath).toBeNull();
    expect(geometry.points.every((placed) => !placed.hasBand)).toBe(true);
  });

  it('keeps every mark inside the plot area', () => {
    const geometry = buildRatingChartGeometry(
      [point('2026-10-06', 1100, 200), point('2026-10-18', 1300, 120), point('2026-10-24', 1288, 86)],
      options
    )!;
    for (const placed of geometry.points) {
      expect(placed.x).toBeGreaterThanOrEqual(geometry.plot.left - 0.5);
      expect(placed.x).toBeLessThanOrEqual(geometry.plot.left + geometry.plot.width + 0.5);
      expect(placed.y).toBeGreaterThanOrEqual(geometry.plot.top);
      expect(placed.y).toBeLessThanOrEqual(geometry.plot.top + geometry.plot.height);
    }
  });

  it('reads a date-only string as a calendar date, not a local instant', () => {
    expect(new Date(parseChartDate('2026-10-23')).toISOString()).toBe('2026-10-23T12:00:00.000Z');
  });

  it('snaps the crosshair to the nearest point', () => {
    const geometry = buildRatingChartGeometry(
      [point('2026-10-06', 1100), point('2026-10-18', 1200), point('2026-10-24', 1288)],
      options
    )!;
    expect(nearestPointIndex(geometry, geometry.points[1].x + 3)).toBe(1);
    expect(nearestPointIndex(geometry, -1000)).toBe(0);
    expect(nearestPointIndex(geometry, 99_999)).toBe(2);
  });

  it('survives a narrow phone-width container', () => {
    const geometry = buildRatingChartGeometry(
      [point('2026-10-20', 1200, 200), point('2026-10-24', 1210, 180)],
      { width: 320, height: 260, now: NOW }
    )!;
    expect(geometry.plot.width).toBeGreaterThan(0);
    expect(geometry.plot.height).toBeGreaterThan(0);
    expect(geometry.yTicks.length).toBeGreaterThan(1);
  });
});

describe('hasNoRecord', () => {
  // `/api/players/:id` 404s today for a player the engine has never seen, and
  // the event page renders those names as plain text for that reason. The
  // endpoint may start answering with an all-null profile instead, so the
  // player page must be able to tell "never seen" from "not yet rated"
  // without waiting for a flag to be added to the wire.
  it('reads a profile the engine has never seen', () => {
    expect(hasNoRecord({ rating: null, gamesPlayed: 0, matchesPlayed: 0 })).toBe(true);
    expect(hasNoRecord({ rating: null, gamesPlayed: null, matchesPlayed: null })).toBe(true);
    expect(hasNoRecord({})).toBe(true);
    expect(hasNoRecord(null)).toBe(true);
    expect(hasNoRecord(undefined)).toBe(true);
  });

  it('does not mistake an unranked player for an unseen one', () => {
    // Below the gate, so the rating is nulled out on the wire - but the games
    // are there, and "No record yet" would be a lie.
    expect(hasNoRecord({ rating: null, gamesPlayed: 3, matchesPlayed: 2 })).toBe(false);
    expect(hasNoRecord({ rating: 1219, gamesPlayed: 12, matchesPlayed: 6 })).toBe(false);
  });
});
