import { describe, it, expect } from 'vitest';
import type { ComponentSummary, PlayerMatch, RatingPoint, SetInfo } from '../../types/ranking';
import {
  ALL_SETS,
  BACKFILL_DAYS,
  MIN_Y_SPAN,
  buildRatingChartGeometry,
  buildScope,
  componentLabel,
  formatRating,
  formatRecord,
  formatUncertainty,
  gameScore,
  matchRecord,
  nearestPointIndex,
  niceTicks,
  parseChartDate,
  parseScope,
  pickDefaultComponent,
  provisionalExplanation,
  setBoundaryNote,
  setLabel,
  splitByConfidence,
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
    rating: 1500,
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
    expect(formatRating(1587.6)).toBe('1,588');
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

describe('provisionalExplanation', () => {
  it('says why a rating is withheld and what would change it', () => {
    expect(provisionalExplanation('no-rating', 8, 8)).toMatch(/no games have been recorded/);
    expect(provisionalExplanation('too-few-games', 1, 8)).toMatch(/one more recorded game/);
    expect(provisionalExplanation('too-few-games', 6, 8)).toMatch(/6 more recorded games/);
    expect(provisionalExplanation('uncertainty-too-wide', 0, 8)).toMatch(/margin is still too wide/);
  });

  it('says nothing when the rating is fit to show', () => {
    expect(provisionalExplanation(null, 0, 8)).toBe('');
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

describe('niceTicks', () => {
  it('rounds to readable steps', () => {
    expect(niceTicks(1400, 1600)).toEqual([1400, 1450, 1500, 1550, 1600]);
  });

  it('degenerates safely when there is no span', () => {
    expect(niceTicks(1500, 1500)).toEqual([1500]);
  });
});

describe('buildRatingChartGeometry', () => {
  const options = { width: 720, height: 300, now: NOW };

  it('returns nothing to draw for an empty series', () => {
    expect(buildRatingChartGeometry([], options)).toBeNull();
  });

  it('draws no line for a one-point series - one point is not a trend', () => {
    const geometry = buildRatingChartGeometry([point('2026-10-24', 1476, 259, 2)], options)!;
    expect(geometry.points).toHaveLength(1);
    expect(geometry.linePath).toBeNull();
    expect(geometry.bandPath).toBeNull();
    // The band becomes an error bar, so the point still carries its margin.
    expect(geometry.points[0].hasBand).toBe(true);
    expect(geometry.points[0].hiY).toBeLessThan(geometry.points[0].loY);
  });

  it('keeps a two-point series honest: it spans the backfill window, not the chart', () => {
    const geometry = buildRatingChartGeometry(
      [point('2026-10-23', 1500, 240, 2), point('2026-10-24', 1520, 230, 4)],
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
      [point('2026-10-23', 1500, null, 2), point('2026-10-24', 1508, null, 4)],
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
      [point('2026-10-10', 1500, 300, 2), point('2026-10-24', 1520, 260, 4)],
      options
    )!;
    const [yMin, yMax] = geometry.yDomain;
    expect(yMin).toBeLessThan(1500 - 300);
    expect(yMax).toBeGreaterThan(1520 + 260);
  });

  it('skips the band when no point carries an uncertainty', () => {
    const geometry = buildRatingChartGeometry(
      [point('2026-10-20', 1500, null), point('2026-10-22', 1510, null), point('2026-10-24', 1505, null)],
      options
    )!;
    expect(geometry.bandPath).toBeNull();
    expect(geometry.points.every((placed) => !placed.hasBand)).toBe(true);
  });

  it('keeps every mark inside the plot area', () => {
    const geometry = buildRatingChartGeometry(
      [point('2026-10-06', 1400, 200), point('2026-10-18', 1600, 120), point('2026-10-24', 1588, 86)],
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
      [point('2026-10-06', 1400), point('2026-10-18', 1500), point('2026-10-24', 1588)],
      options
    )!;
    expect(nearestPointIndex(geometry, geometry.points[1].x + 3)).toBe(1);
    expect(nearestPointIndex(geometry, -1000)).toBe(0);
    expect(nearestPointIndex(geometry, 99_999)).toBe(2);
  });

  it('survives a narrow phone-width container', () => {
    const geometry = buildRatingChartGeometry(
      [point('2026-10-20', 1500, 200), point('2026-10-24', 1510, 180)],
      { width: 320, height: 260, now: NOW }
    )!;
    expect(geometry.plot.width).toBeGreaterThan(0);
    expect(geometry.plot.height).toBeGreaterThan(0);
    expect(geometry.yTicks.length).toBeGreaterThan(1);
  });
});
