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
  GLOBAL_POSITION_HINT,
  GLOBAL_POSITION_NOTICE,
  GLOBAL_SCENE_LABEL,
  hasPosition,
  hasPositions,
  marginBar,
  marginScale,
  outcomeLetter,
  outcomeWord,
  recentForm,
  recordSpoken,
  matchDays,
  matchRecord,
  formatRatingDelta,
  ratingMoveDirection,
  ratingMoves,
  ratingMoveSummary,
  RATING_MOVE_GRAIN_NOTE,
  RATING_MOVE_HINT,
  RATING_MOVE_REFIT_NOTE,
  nearestPointIndex,
  niceTicks,
  parseChartDate,
  parseScope,
  pickDefaultComponent,
  shouldUseSetPills,
  SET_PILL_LIMIT,
  sceneOptions,
  selectableSets,
  provisionalShortReason,
  ratingDisplay,
  ratingExplanation,
  sceneSizeHint,
  sceneTooSmallExplanation,
  setBoundaryNote,
  setLabel,
  splitByRating,
  UNRANKED_NO_GAMES_EXPLANATION,
  winRate,
} from '../ranking';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const DAY = 86_400_000;

function point(date: string, rating: number, uncertainty: number | null = 100, games = 4): RatingPoint {
  return { date, rating, uncertainty, gamesPlayed: games };
}

function entry(overrides: Partial<Parameters<typeof splitByRating>[0][number]>) {
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

// Kept, but no longer the landing scope: /rankings opens on Global and the
// reader picks a scene. A shared `?region=` link still wins, because the page
// reads the parameter straight into the scope and nothing rewrites it.
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
    // Renamed from "Everywhere" when Global became the landing scope: one
    // name for it, so the heading and the picker cannot disagree.
    expect(componentLabel(null)).toBe('Global');
    expect(componentLabel(null)).toBe(GLOBAL_SCENE_LABEL);
    expect(componentLabel({ componentId: 'c', regionLabel: null })).toBe('Scene c');
    expect(componentLabel({ componentId: 'c', regionLabel: 'Puget Sound' })).toBe('Puget Sound');
  });
});

describe('how a rating is allowed to be shown', () => {
  // The page used to print `Unranked` for everyone below the gate, which threw
  // away a figure the engine would stand behind and read as a broken page.
  // Three states now, and the margin carries what the word used to.
  it('prints a number whenever the API sends one', () => {
    expect(ratingDisplay({ rating: 1382, provisional: false })).toBe('rated');
    expect(ratingDisplay({ rating: 1204, provisional: true })).toBe('unsettled');
  });

  it('is `none` only when there is no number at all', () => {
    // The API nulls the rating below its own floor - about three games, where
    // the estimate is still echoing the 1,200 prior. We do not count games to
    // decide this, so the floor can move without this changing.
    expect(ratingDisplay({ rating: null, provisional: true })).toBe('none');
    expect(ratingDisplay({ rating: null, provisional: false })).toBe('none');
    expect(ratingDisplay(null)).toBe('none');
    expect(ratingDisplay(undefined)).toBe('none');
    expect(ratingDisplay({})).toBe('none');
  });

  it('keeps the word for the genuinely empty case', () => {
    expect(UNRANKED_LABEL).toBe('Unranked');
    expect(UNRANKED_NO_GAMES_EXPLANATION).toMatch(/^Unranked/);
    // Quotes the engine's own origin rather than a hardcoded figure.
    expect(UNRANKED_NO_GAMES_EXPLANATION).toMatch(/1,200/);
  });

  it('starts the scale at the engine anchor', () => {
    expect(RATING_ANCHOR).toBe(1200);
  });

  it('explains an unsettled rating without calling it unranked', () => {
    expect(ratingExplanation('unsettled', 'too-few-games', 1, 8)).toMatch(/one more recorded game/);
    expect(ratingExplanation('unsettled', 'too-few-games', 6, 8)).toMatch(/6 more recorded games/);
    expect(ratingExplanation('unsettled', 'uncertainty-too-wide', 0, 8)).toMatch(/margin is too wide/);
    for (const reason of ['no-rating', 'too-few-games', 'uncertainty-too-wide'] as const) {
      expect(ratingExplanation('unsettled', reason, 4, 8)).toMatch(/^Still settling/);
    }
  });

  it('survives the API mislabelling a player who plainly has games', () => {
    // Known-but-unrated players have come back as `no-rating`. A row with a
    // number is still settling whatever the reason string claims.
    expect(ratingExplanation('unsettled', 'no-rating', 3, 8)).toMatch(/3 more recorded games/);
    expect(ratingExplanation('unsettled', null, 2, 8)).toMatch(/2 more recorded games/);
  });

  it('says nothing when the rating is settled, and says why when there is none', () => {
    expect(ratingExplanation('rated', null, 0, 8)).toBe('');
    expect(ratingExplanation('rated', 'too-few-games', 4, 8)).toBe('');
    expect(ratingExplanation('none', null, 0, 8)).toBe(UNRANKED_NO_GAMES_EXPLANATION);
  });

  it('sentence-cases the short reason for a table cell tooltip', () => {
    expect(provisionalShortReason('too-few-games')).toBe('Too few games');
    expect(provisionalShortReason('uncertainty-too-wide')).toBe('Margin too wide');
    expect(provisionalShortReason('no-rating')).toBe('No rating yet');
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

  it('leads with Global, then one row per scene', () => {
    const options = sceneOptions(components);
    // `meta` says what the scope *is*. It used to read `not comparable`, as
    // the first explanation of a ladder with no positions; there are positions
    // now, and a caveat met before the thing it qualifies was the wrong place
    // for it anyway - it lives on the `#` column's hint. `comparable` stays
    // false: that is the narrow statistical claim, and it is still true.
    expect(options[0]).toEqual({ id: null, label: 'Global', meta: 'every scene at once', comparable: false });
    expect(options.map((option) => option.label)).toEqual([
      'Global',
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

  it('finds the row for the current selection, including Global', () => {
    const options = sceneOptions(components);
    expect(findSceneOption(options, 'b')?.label).toBe('Bay Area');
    expect(findSceneOption(options, null)?.label).toBe('Global');
    expect(findSceneOption(options, 'missing')).toBeNull();
  });
});

describe('splitByRating', () => {
  // It used to split on `provisional`, which banished every unsettled player
  // to a second list with no figure in it. The table holds everyone the engine
  // will quote a number for now; only the no-number rows fall out.
  it('keeps an unsettled player in the table, with their number', () => {
    const { scored, unscored } = splitByRating([
      entry({ playerId: 'a', rank: 1 }),
      entry({ playerId: 'b', rating: 1204, provisional: true, provisionalReason: 'too-few-games' }),
    ]);
    expect(scored.map((e) => e.playerId)).toEqual(['a', 'b']);
    expect(unscored).toEqual([]);
  });

  it('drops only the rows with no number at all', () => {
    const { scored, unscored } = splitByRating([
      entry({ playerId: 'a', rank: 1 }),
      entry({ playerId: 'b', rating: null, provisional: true, provisionalReason: 'no-rating' }),
    ]);
    expect(scored.map((e) => e.playerId)).toEqual(['a']);
    expect(unscored.map((e) => e.playerId)).toEqual(['b']);
  });

  it('handles a page with nothing rated yet', () => {
    const all = [1, 2, 3].map((n) =>
      entry({ playerId: `p${n}`, rating: null, provisional: true, provisionalReason: 'no-rating' })
    );
    const { scored, unscored } = splitByRating(all);
    expect(scored).toEqual([]);
    expect(unscored).toHaveLength(3);
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
    // Hyphenated numerals, win-loss-draw, and no trailing `-0`: this is what
    // the pages print now instead of "2W 1L" in coloured display type.
    expect(formatRecord(record)).toBe('2-1');
    expect(formatRecord({ wins: 1, losses: 1, draws: 1 })).toBe('1-1-1');
    expect(formatRecord({ wins: 2, losses: 1, draws: 1 })).toBe('2-1-1');
  });

  it('reports an empty record for a player with no games', () => {
    expect(formatRecord(matchRecord([]))).toBe('0-0');
  });

  it('spells the record out for a screen reader', () => {
    // The figure is aria-hidden wherever this is used, because "2-1-1"
    // announces as "two dash one dash one".
    expect(recordSpoken({ wins: 2, losses: 1, draws: 1 })).toBe('2 wins, 1 loss, 1 draw');
    expect(recordSpoken({ wins: 1, losses: 2, draws: 0 })).toBe('1 win, 2 losses');
    expect(recordSpoken({ wins: 0, losses: 0, draws: 0 })).toBe('0 wins, 0 losses');
    expect(recordSpoken({ wins: 3, losses: 0, draws: 2 })).toBe('3 wins, 0 losses, 2 draws');
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

  it('gives up on an implausible threshold', () => {
    expect(gateProgress(1, 0)).toBeNull();
    expect(gateProgress(1, 500)).toBeNull();
  });

  it('stays away when the games are not what is missing', () => {
    // A player who has already played enough games is not waiting on volume -
    // a full meter beside an unsettled rating reads as a contradiction. It
    // used to clamp to a full strip; it now says nothing at all.
    expect(gateProgress(40, 8)).toBeNull();
    expect(gateProgress(8, 8)).toBeNull();
    // Nor when the API says plainly that the margin is what is holding it.
    expect(gateProgress(12, 8, 'uncertainty-too-wide')).toBeNull();
    expect(gateProgress(3, 8, 'uncertainty-too-wide')).toBeNull();
  });

  it('draws anyway when the API mislabels a player who has games', () => {
    // Known-but-unrated players have come back as `no-rating`. The meter is
    // read off the evidence, not off the reason string, so it survives that:
    // a meter that vanishes because a label was mis-set is worse than one
    // that is occasionally redundant.
    expect(gateProgress(3, 8, 'no-rating')).toEqual({ filled: 3, total: 8 });
    expect(gateProgress(5, 8, null)).toEqual({ filled: 5, total: 8 });
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

  it('spans every rating plus and minus its margin', () => {
    const scale = marginScale([entry(1200, 100), entry(1300, 50), entry(1250, 20)]);
    expect(scale).toEqual({ min: 1100, max: 1350 });
  });

  it('includes the unsettled rows, whose wide spans are the point', () => {
    // They used to be excluded, because they printed no number at all. Now
    // they print one, and the bar is what carries the honesty the word
    // "Unranked" used to: a wide span beside a narrow one is visibly
    // unsettled. Their margins stretch the axis, which is what makes the
    // contrast legible.
    const scale = marginScale([entry(1382, 95), entry(1204, 156, true)]);
    expect(scale).toEqual({ min: 1048, max: 1477 });
  });

  it('draws no bars at all when there is nothing to compare', () => {
    // One span is still decoration, and so is a degenerate range. The floor
    // dropped from three rows to two because the bars now do work on every
    // row that has a number, and two spans are already a comparison.
    expect(marginScale([entry(1200, 100)])).toBeNull();
    expect(marginScale([entry(1200, 100, true)])).toBeNull();
    expect(marginScale([entry(1200, 0), entry(1200, 0), entry(1200, 0)])).toBeNull();
    expect(marginScale([entry(1200, 100), entry(1300, 50)])).not.toBeNull();
  });

  it('skips the rows with no number, which have nothing to span', () => {
    const noNumber = { ...entry(1200, 100, true), rating: null };
    expect(marginScale([noNumber, noNumber, noNumber])).toBeNull();
    expect(marginScale([entry(1200, 100), entry(1300, 50), noNumber])).toEqual({
      min: 1100,
      max: 1350,
    });
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


/**
 * Global carries positions.
 *
 * The measurement that shaped this: **0 of 56,257 recorded games cross a
 * scene**. A scene is a group of players who have played each other, so a game
 * between two of them would merge them - the cross-scene link is not thin, it
 * is empty, across 1,235 scenes, 369 of which reach the global ladder and 15 of
 * which reach its top 25. The order is still published, with the caveat on the
 * `#` column rather than in place of the column.
 */
describe('positions on a ladder that mixes scenes', () => {
  it('draws the column when any loaded row holds a place, not when the scope is one scene', () => {
    // The old rule was scope-shaped and it is what kept Global positionless.
    expect(hasPositions([entry({ rank: 1 }), entry({ rank: null })])).toBe(true);
    expect(hasPositions([entry({ rank: null }), entry({ rank: null })])).toBe(false);
    expect(hasPositions([])).toBe(false);
  });

  it('reads a position off the rank the API sent, never off the rating', () => {
    expect(hasPosition(entry({ rank: 3, rating: 1240 }))).toBe(true);
    // A settled rating with no place: the scene it was earned in is too small.
    expect(hasPosition(entry({ rank: null, rating: 1620, provisional: false, componentSize: 4 }))).toBe(false);
  });

  it('explains a withheld place as a comparison problem, not a lack of evidence', () => {
    const why = sceneTooSmallExplanation(4, 8);
    expect(why).toContain('too small to order anyone');
    expect(why).toContain('8 players needed');
    // The rating is not in question - 29 of the live board's 6,117 rated
    // players are in this state with perfectly good numbers.
    expect(why).toContain('The rating itself stands');
    expect(why).not.toMatch(/games/);
    // No size recorded is still a sentence rather than a dangling number.
    expect(sceneTooSmallExplanation(null, 8)).toContain('this scene is too small');
  });

  it('qualifies a global position with what it rests on, and quotes the anchor', () => {
    // The specific weakness the ± cannot carry: the margin is the posterior SD
    // of a comparison *inside* a scene, and across scenes there is no
    // comparison for it to be about.
    expect(GLOBAL_POSITION_HINT).toContain('no recorded game crosses one');
    expect(GLOBAL_POSITION_HINT).toContain(RATING_ANCHOR.toLocaleString());
    // One line, and it no longer claims there are no positions.
    expect(GLOBAL_POSITION_NOTICE).not.toMatch(/No positions/i);
    expect(GLOBAL_POSITION_NOTICE.split('\n')).toHaveLength(1);
    expect(GLOBAL_POSITION_NOTICE).toContain(GLOBAL_SCENE_LABEL);
  });

  it('shows the depth a place was earned among, because that is what varies', () => {
    // Cross-scene play is zero for every player, so it cannot separate two
    // rows. Scene size can, and it is what the model's own cross-scene term is
    // a function of: first among 4,654 and first among 9 are both real and are
    // not the same claim.
    expect(sceneSizeHint(entry({ componentSize: 4654 }))).toBe(
      'Scene of 4,654 players who have played each other.'
    );
    expect(sceneSizeHint(entry({ componentSize: 1 }))).toBe('Scene of 1 player.');
    expect(sceneSizeHint(entry({ componentSize: null }))).toBe('Scene size not recorded.');
  });
});

/*
 * Rating movement.
 *
 * The property under test is not a format, it is a *grain*: the engine is
 * Whole-History Rating, it fits one rating per day played, and there is no
 * per-match delta for anything to report. So these pin that a day of four
 * matches produces one movement rather than four, that both ends of it are
 * published numbers carrying their margins, and that the movement is measured
 * against the anchor on a player's first recorded day rather than against
 * nothing.
 */
describe('rating movement', () => {
  const log = (
    date: string,
    id: string,
    outcome: PlayerMatch['outcome'],
    games = 2
  ): PlayerMatch => ({
    matchId: id,
    playedAt: `${date}T19:00:00.000Z`,
    opponentId: 'o',
    opponentDisplayName: 'Opponent',
    outcome,
    games: Array.from({ length: games }, (_, index) => ({
      gameNumber: index + 1,
      outcome: index === 0 ? ('win' as const) : ('loss' as const),
    })),
    eventExternalId: 'e',
    eventName: 'Event',
    shopId: '1',
    latitude: null,
    longitude: null,
    eventDate: date,
    tournamentType: 'Nexus Night',
    setId: 'radiance',
  });

  it('measures the first recorded day against the anchor, and says so', () => {
    // Everyone starts at 1,200 - that is the prior mean, not a measurement -
    // so the first day's movement is real but is a movement off a starting
    // point rather than off a day that was played.
    const moves = ratingMoves([point('2026-10-11', 1218, 104)]);
    const first = moves.get('2026-10-11')!;
    expect(first.fromAnchor).toBe(true);
    expect(first.previousDate).toBeNull();
    expect(first.previousRating).toBe(RATING_ANCHOR);
    expect(first.delta).toBe(18);
  });

  it('is the difference between two published, dated ratings', () => {
    // Not a model output: arithmetic on the two numbers the chart draws, which
    // the engine has already rounded, so it is exact with respect to what the
    // reader sees.
    const moves = ratingMoves([point('2026-10-11', 1225, 104), point('2026-10-18', 1243, 98)]);
    const second = moves.get('2026-10-18')!;
    expect(second.fromAnchor).toBe(false);
    expect(second.previousDate).toBe('2026-10-11');
    expect(second.previousRating).toBe(1225);
    expect(second.previousUncertainty).toBe(104);
    expect(second.delta).toBe(18);
  });

  it('answers to the margin, because a movement inside it has separated nothing', () => {
    const settled = ratingMoves([point('2026-10-11', 1225, 104), point('2026-10-18', 1243, 98)]);
    expect(settled.get('2026-10-18')!.withinMargin).toBe(true);
    // A move larger than the margin is the interesting case and says so.
    const big = ratingMoves([point('2026-10-11', 1225, 40), point('2026-10-18', 1400, 38)]);
    expect(big.get('2026-10-18')!.withinMargin).toBe(false);
    // No margin recorded is not "outside the margin": it is unknown, and
    // `false` would be a claim this has no basis for.
    const bare = ratingMoves([point('2026-10-11', 1225, null)]);
    expect(bare.get('2026-10-11')!.withinMargin).toBeNull();
  });

  it('orders the series itself rather than trusting the order it arrived in', () => {
    const moves = ratingMoves([point('2026-10-18', 1243, 98), point('2026-10-11', 1225, 104)]);
    expect(moves.get('2026-10-18')!.previousDate).toBe('2026-10-11');
    expect(moves.get('2026-10-11')!.fromAnchor).toBe(true);
  });

  it('has nothing to say about a day the series has no point for', () => {
    // The series is capped at the endpoint's limit, which is also what the
    // chart draws, so the match log stays silent exactly where the chart does.
    expect(ratingMoves([]).size).toBe(0);
    expect(ratingMoves([point('2026-10-11', 1225)]).get('2026-10-18')).toBeUndefined();
  });

  it('formats the figure with its sign, and zero without one', () => {
    expect(formatRatingDelta(18)).toBe('+18');
    expect(formatRatingDelta(-7)).toBe('−7');
    expect(formatRatingDelta(0)).toBe('0');
    expect(ratingMoveDirection(18)).toBe('up');
    expect(ratingMoveDirection(-7)).toBe('down');
    expect(ratingMoveDirection(0)).toBe('flat');
  });

  it('never announces the movement without the margin', () => {
    // The house rule: a number published without its margin is the bare figure
    // the margin exists to qualify. The visible chip is a figure and an arrow,
    // so this string is the whole of what a screen reader gets.
    const moves = ratingMoves([point('2026-10-11', 1225, 104), point('2026-10-18', 1243, 98)]);
    const spoken = ratingMoveSummary(moves.get('2026-10-18')!);
    expect(spoken).toContain('1,243');
    expect(spoken).toContain('plus or minus 98');
    expect(spoken).toContain('up 18');
    expect(spoken).toContain('smaller than that margin');
    // And the first day names the anchor rather than implying a previous day.
    const firstDay = ratingMoves([point('2026-10-11', 1218, 104)]).get('2026-10-11')!;
    expect(ratingMoveSummary(firstDay)).toContain('1,200 starting rating');
  });

  it('says the grain out loud, and that the figure is revisable', () => {
    // The two things that stop a reader taking it for an Elo award.
    expect(RATING_MOVE_GRAIN_NOTE).toContain('per day played, not per match');
    expect(RATING_MOVE_REFIT_NOTE).toContain('whole history');
    expect(RATING_MOVE_HINT).toContain('margin');
    // And the factors that do not exist in this engine are not named anywhere:
    // no tier multiplier (the table ships neutral) and no cross-scene term
    // (0 of 56,257 recorded games cross a scene).
    const copy = [RATING_MOVE_GRAIN_NOTE, RATING_MOVE_REFIT_NOTE, RATING_MOVE_HINT].join(' ');
    expect(copy).not.toMatch(/multiplier|cross-scene|skirmish/i);
  });

  it('groups the log by the day played, so one day reports one movement', () => {
    // The overstatement this prevents: four rows each reading `+18` over a day
    // that moved 18 in total.
    const days = matchDays([
      log('2026-10-18', 'a', 'win'),
      log('2026-10-18', 'b', 'win'),
      log('2026-10-18', 'c', 'loss'),
      log('2026-10-11', 'd', 'draw'),
    ]);
    expect(days.map((day) => day.date)).toEqual(['2026-10-18', '2026-10-11']);
    expect(days[0].matches.map((entry) => entry.matchId)).toEqual(['a', 'b', 'c']);
    expect(days[0].record).toEqual({ wins: 2, losses: 1, draws: 0 });
    expect(days[0].games).toBe(6);
    expect(days[1].record).toEqual({ wins: 0, losses: 0, draws: 1 });
  });

  it('joins to a rating point with no date arithmetic at all', () => {
    // Both sides are the engine's own UTC day of the event's start, so the key
    // is shared by construction - which is the reason this needs no API change.
    const days = matchDays([log('2026-10-18', 'a', 'win')]);
    const moves = ratingMoves([point('2026-10-11', 1225), point('2026-10-18', 1243)]);
    expect(moves.has(days[0].date)).toBe(true);
  });

  it('marks only the oldest loaded day as possibly part-loaded', () => {
    // The page boundary can fall inside a day. The movement is still the
    // day's; its record would not be, so the day is flagged rather than
    // reporting a partial record as a whole one.
    const matches = [log('2026-10-18', 'a', 'win'), log('2026-10-11', 'b', 'loss')];
    expect(matchDays(matches, true).map((day) => day.complete)).toEqual([true, false]);
    expect(matchDays(matches, false).map((day) => day.complete)).toEqual([true, true]);
    expect(matchDays([], true)).toEqual([]);
  });

  it('falls back to the timestamp when a log entry carries no event date', () => {
    const undated = { ...log('2026-10-18', 'a', 'win'), eventDate: null };
    expect(matchDays([undated])[0].date).toBe('2026-10-18');
  });
});
