import type {
  ComponentSummary,
  LeaderboardEntry,
  PlayerMatch,
  ProvisionalReason,
  RatingPoint,
  SetInfo,
} from '../types/ranking';

/**
 * Pure helpers behind the ranking UI. Everything here is side-effect free so
 * the sparse and empty cases - which are the *normal* cases at launch - can be
 * tested without a DOM.
 */

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export const ALL_SETS = 'all';

/**
 * Label for the all-time scope.
 *
 * Deliberately not "All sets": results only exist for events the backfill has
 * reached, so the scope covers a recent window rather than the game's whole
 * history, and claiming otherwise overstates what the number is built from.
 */
export const ALL_SETS_LABEL = 'Radiance+';

/**
 * The sets worth offering in a picker: ones that have actually released, and
 * that the engine has rating data for.
 *
 * A future set is noise - nobody has played it. A released set with no data
 * yet would select a scope that can only render an empty board, which reads as
 * a broken page rather than an honest one. Both are still carried by
 * `/api/sets`, which reports the whole catalogue; this is a presentation rule.
 */
export function selectableSets(sets: SetInfo[], now: Date = new Date()): SetInfo[] {
  const today = now.toISOString().slice(0, 10);
  return sets.filter((set) => {
    if (!set.hasRatingData) return false;
    if (set.releaseDate && set.releaseDate > today) return false;
    return true;
  });
}

/** Build the scope string the API expects from the two selectors. */
export function buildScope(setId: string | null, componentId: string | null): string {
  const parts = [
    setId && setId !== ALL_SETS ? `set:${setId}` : null,
    componentId ? `component:${componentId}` : null,
  ].filter(Boolean);
  return parts.length === 0 ? ALL_SETS : parts.join('#');
}

export function parseScope(raw: string | null | undefined): { setId: string | null; componentId: string | null } {
  const out: { setId: string | null; componentId: string | null } = { setId: null, componentId: null };
  if (!raw || raw === ALL_SETS) return out;
  for (const part of raw.split('#')) {
    const [kind, ...rest] = part.split(':');
    const value = rest.join(':');
    if (!value) continue;
    if (kind === 'set') out.setId = value;
    if (kind === 'component') out.componentId = value;
  }
  return out;
}

/**
 * Ratings only compare inside a connected component of the co-play graph, so
 * the page defaults to a region rather than a global ladder: the comparable
 * component with the most rated players, or failing that the biggest one.
 */
export function pickDefaultComponent(components: ComponentSummary[]): string | null {
  if (components.length === 0) return null;
  const comparable = components.filter((component) => component.comparable);
  const pool = comparable.length > 0 ? comparable : components;
  return [...pool].sort(
    (a, b) => b.ratedPlayers - a.ratedPlayers || (b.componentSize ?? 0) - (a.componentSize ?? 0)
  )[0].componentId;
}

export function componentLabel(component: ComponentSummary | { componentId: string | null; regionLabel: string | null } | null): string {
  if (!component || !component.componentId) return 'Everywhere';
  return component.regionLabel ?? `Scene ${component.componentId}`;
}

/**
 * One row of the scene picker. Kept as data rather than JSX so the filtering a
 * searchable picker needs is a pure function - there are ~194 scenes already
 * and the list only grows.
 */
export interface SceneOption {
  /** null is the "Everywhere" pseudo-scene, which is never comparable. */
  id: string | null;
  label: string;
  /** Secondary line: rated count, and whether the scene can carry positions. */
  meta: string;
  comparable: boolean;
}

export const EVERYWHERE_OPTION: SceneOption = {
  id: null,
  label: 'Everywhere',
  meta: 'not comparable',
  comparable: false,
};

export function sceneOptions(components: ComponentSummary[]): SceneOption[] {
  return [
    EVERYWHERE_OPTION,
    ...components.map((component) => ({
      id: component.componentId,
      label: componentLabel(component),
      meta: `${component.ratedPlayers} rated${component.comparable ? '' : ' · too small'}`,
      comparable: component.comparable,
    })),
  ];
}

/**
 * Substring match on the region label, case- and accent-insensitive, so
 * "puget" finds "Puget Sound" and "seattle" finds nothing rather than
 * everything. An empty query is not a filter.
 */
export function filterSceneOptions(options: SceneOption[], query: string): SceneOption[] {
  const needle = normalizeForSearch(query);
  if (!needle) return options;
  return options.filter((option) => normalizeForSearch(option.label).includes(needle));
}

function normalizeForSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

/** The option matching the current selection, for the closed picker's label. */
export function findSceneOption(options: SceneOption[], id: string | null): SceneOption | null {
  return options.find((option) => option.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

export function setLabel(set: SetInfo): string {
  return set.name ?? set.setId;
}

/** Sets 1-3 have no published release date, so say so instead of leaving a gap. */
export function setBoundaryNote(set: SetInfo): string {
  if (!set.releaseDate) return 'release date not published';
  const released = formatDate(set.releaseDate);
  return set.endDate ? `${released} - ${formatDate(set.endDate)}` : `released ${released}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatRating(rating: number | null | undefined): string {
  if (rating === null || rating === undefined) return '--';
  return Math.round(rating).toLocaleString();
}

export function formatUncertainty(uncertainty: number | null | undefined): string {
  if (uncertainty === null || uncertainty === undefined) return '';
  return `±${Math.round(uncertainty).toLocaleString()}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown date';
  // Date-only strings are calendar dates, not instants: read them as UTC so
  // they do not slide a day in a western timezone.
  const value = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  if (Number.isNaN(value.getTime())) return 'unknown date';
  return value.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatShortDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The word the UI prints in place of a rating that has not cleared the
 * confidence gate. One word, everywhere: the leaderboard, the player page and
 * the per-set table all say the same thing, and the *reason* lives in a
 * tooltip rather than in prose beside it.
 */
export const UNRANKED_LABEL = 'Unranked';

/**
 * Where the rating scale starts. A player with no games sits here, so the
 * number is the one to quote when explaining what a rating means.
 *
 * Tracks the engine's anchor (`DEFAULT_ELO_ORIGIN` in `scraper/src/ranking/whr.ts`).
 */
export const RATING_ANCHOR = 1200;

/**
 * Why a rating is being withheld - as a *tooltip*, never as inline prose.
 *
 * The page used to print this sentence next to the player, which read as the
 * site explaining itself rather than reporting a fact. Now the page says
 * "Unranked" and this is the hover/focus text on that word.
 */
export function provisionalExplanation(
  reason: ProvisionalReason | null,
  gamesUntilRated: number,
  minGames: number
): string {
  switch (reason) {
    case 'no-rating':
      return `Unranked - no games recorded yet. A rating appears after ${minGames} games.`;
    case 'too-few-games':
      return gamesUntilRated === 1
        ? `Unranked - one more recorded game to go (${minGames} needed).`
        : `Unranked - ${gamesUntilRated} more recorded games to go (${minGames} needed).`;
    case 'uncertainty-too-wide':
      return 'Unranked - the margin is still too wide to place this player against others.';
    default:
      return '';
  }
}

/** The reason as a lower-case fragment, for a tooltip or an aria label. */
export function provisionalShortLabel(reason: ProvisionalReason | null): string {
  switch (reason) {
    case 'no-rating':
      return 'no games yet';
    case 'too-few-games':
      return 'too few games';
    case 'uncertainty-too-wide':
      return 'margin too wide';
    default:
      return '';
  }
}

/**
 * The reason capitalised, for a table cell's tooltip. Same wording as
 * `provisionalShortLabel`, sentence-cased - kept here rather than in a page so
 * the two surfaces cannot drift apart.
 */
export function provisionalShortReason(reason: ProvisionalReason | null): string {
  const label = provisionalShortLabel(reason);
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : '--';
}

/** Splits a leaderboard page into the part that is a ladder and the part that is not. */
export function splitByConfidence(entries: LeaderboardEntry[]): {
  rated: LeaderboardEntry[];
  provisional: LeaderboardEntry[];
} {
  return {
    rated: entries.filter((entry) => !entry.provisional),
    provisional: entries.filter((entry) => entry.provisional),
  };
}

export interface Record_ {
  wins: number;
  losses: number;
  draws: number;
}

export function matchRecord(matches: PlayerMatch[]): Record_ {
  return matches.reduce<Record_>(
    (record, match) => {
      if (match.outcome === 'win') record.wins += 1;
      else if (match.outcome === 'loss') record.losses += 1;
      else if (match.outcome === 'draw') record.draws += 1;
      return record;
    },
    { wins: 0, losses: 0, draws: 0 }
  );
}

export function formatRecord(record: Record_): string {
  return record.draws > 0
    ? `${record.wins}-${record.losses}-${record.draws}`
    : `${record.wins}-${record.losses}`;
}

/** "2-0", "1-2" etc. from the per-game outcomes of one Bo3. */
export function gameScore(match: PlayerMatch): string {
  const won = match.games.filter((game) => game.outcome === 'win').length;
  const lost = match.games.filter((game) => game.outcome === 'loss').length;
  return `${won}-${lost}`;
}

// ---------------------------------------------------------------------------
// Rating chart geometry
// ---------------------------------------------------------------------------

/**
 * The series colour. Dark slot 7 (violet) of the validated data-viz palette -
 * the closest documented step to the app's Dracula purple that sits inside the
 * dark lightness band and clears 3:1 on the card surface (#21222c, 5.05:1).
 */
export const RATING_SERIES_COLOR = '#9085e9';

/**
 * How far back the backfill reaches. The x-axis always spans at least this
 * window, so two points two days apart read as "two days of data in three
 * weeks" rather than filling the chart edge to edge.
 */
export const BACKFILL_DAYS = 21;

/**
 * Smallest y-axis span, in rating points. Without a floor, a four-point series
 * that moved twenty points would be auto-fitted into a cliff.
 */
export const MIN_Y_SPAN = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseChartDate(date: string): number {
  return new Date(date.length === 10 ? `${date}T12:00:00Z` : date).getTime();
}

export interface ChartMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface GeometryOptions {
  width: number;
  height: number;
  margins?: ChartMargins;
  /** Overridable so tests do not depend on the clock. */
  now?: number;
}

export interface PlacedPoint {
  point: RatingPoint;
  x: number;
  y: number;
  /** Band edges; equal to `y` when the point carries no uncertainty. */
  loY: number;
  hiY: number;
  hasBand: boolean;
}

export interface ChartGeometry {
  width: number;
  height: number;
  plot: { left: number; top: number; width: number; height: number };
  xDomain: [number, number];
  yDomain: [number, number];
  points: PlacedPoint[];
  /** null for a one-point series - a single point is not a trend. */
  linePath: string | null;
  bandPath: string | null;
  yTicks: { value: number; y: number; label: string }[];
  xTicks: { value: number; x: number; label: string }[];
}

const DEFAULT_MARGINS: ChartMargins = { left: 48, right: 56, top: 16, bottom: 32 };

export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!(max > min)) return [min];
  const rawStep = (max - min) / target;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rawStep)
    ?? 10 * magnitude;
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= max + step / 1000; value += step) {
    ticks.push(Math.round(value * 1000) / 1000);
  }
  return ticks;
}

/**
 * Lay a rating series out in SVG space. Pure, so the one- and two-point cases
 * are unit-testable: those are what almost every player has at launch.
 */
export function buildRatingChartGeometry(
  points: RatingPoint[],
  options: GeometryOptions
): ChartGeometry | null {
  if (points.length === 0) return null;

  const margins = options.margins ?? DEFAULT_MARGINS;
  const plot = {
    left: margins.left,
    top: margins.top,
    width: Math.max(1, options.width - margins.left - margins.right),
    height: Math.max(1, options.height - margins.top - margins.bottom),
  };

  const now = options.now ?? Date.now();
  const stamps = points.map((point) => parseChartDate(point.date));
  const firstStamp = Math.min(...stamps);
  const lastStamp = Math.max(...stamps);

  // Always show the whole window the data could have come from, so a short
  // series looks short.
  const xMin = Math.min(firstStamp, now - BACKFILL_DAYS * DAY_MS);
  const xMax = Math.max(lastStamp, now);
  const xSpan = Math.max(DAY_MS, xMax - xMin);

  const lows = points.map((point) => point.rating - (point.uncertainty ?? 0));
  const highs = points.map((point) => point.rating + (point.uncertainty ?? 0));
  let yMin = Math.min(...lows);
  let yMax = Math.max(...highs);

  // Pad, then enforce the minimum span around the midpoint.
  const pad = Math.max(10, (yMax - yMin) * 0.08);
  yMin -= pad;
  yMax += pad;
  if (yMax - yMin < MIN_Y_SPAN) {
    const mid = (yMax + yMin) / 2;
    yMin = mid - MIN_Y_SPAN / 2;
    yMax = mid + MIN_Y_SPAN / 2;
  }

  const xScale = (stamp: number) => plot.left + ((stamp - xMin) / xSpan) * plot.width;
  const yScale = (value: number) => plot.top + (1 - (value - yMin) / (yMax - yMin)) * plot.height;

  const placed: PlacedPoint[] = points.map((point, index) => {
    const hasBand = point.uncertainty !== null && point.uncertainty > 0;
    return {
      point,
      x: xScale(stamps[index]),
      y: yScale(point.rating),
      loY: yScale(point.rating - (point.uncertainty ?? 0)),
      hiY: yScale(point.rating + (point.uncertainty ?? 0)),
      hasBand,
    };
  });

  const round = (value: number) => Math.round(value * 100) / 100;

  const linePath =
    placed.length < 2
      ? null
      : placed.map((entry, index) => `${index === 0 ? 'M' : 'L'}${round(entry.x)},${round(entry.y)}`).join(' ');

  const banded = placed.filter((entry) => entry.hasBand);
  const bandPath =
    banded.length < 2
      ? null
      : [
          ...banded.map((entry, index) => `${index === 0 ? 'M' : 'L'}${round(entry.x)},${round(entry.hiY)}`),
          ...[...banded].reverse().map((entry) => `L${round(entry.x)},${round(entry.loY)}`),
          'Z',
        ].join(' ');

  return {
    width: options.width,
    height: options.height,
    plot,
    xDomain: [xMin, xMax],
    yDomain: [yMin, yMax],
    points: placed,
    linePath,
    bandPath,
    yTicks: niceTicks(yMin, yMax).map((value) => ({
      value,
      y: yScale(value),
      label: Math.round(value).toLocaleString(),
    })),
    xTicks: xAxisTicks(xMin, xMax).map((value) => ({
      value,
      x: xScale(value),
      label: formatShortDate(value),
    })),
  };
}

function xAxisTicks(xMin: number, xMax: number, target = 4): number[] {
  const span = xMax - xMin;
  const ticks: number[] = [];
  for (let i = 0; i <= target; i++) ticks.push(xMin + (span * i) / target);
  return ticks;
}

/** Index of the point nearest an x position - the crosshair's snap. */
export function nearestPointIndex(geometry: ChartGeometry, x: number): number {
  let best = 0;
  let bestDistance = Infinity;
  geometry.points.forEach((entry, index) => {
    const distance = Math.abs(entry.x - x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}
