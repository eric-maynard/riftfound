import type {
  ComponentSummary,
  GameOutcome,
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

/**
 * Total set-scope options (the all-time scope plus each set) that still fit on
 * one line as segmented pills. Above this the control becomes a dropdown.
 */
export const SET_PILL_LIMIT = 5;

/**
 * Whether the set scope should render as pills rather than a dropdown.
 *
 * Sets are an unbounded, append-only list - roughly four a year, and a set
 * with rating data never loses it - so a control sized for today silently
 * stops fitting. Crossing this threshold is a one-way door about a year out,
 * not a flicker.
 */
export function shouldUseSetPills(setCount: number): boolean {
  return setCount + 1 <= SET_PILL_LIMIT;
}

/** Build the scope string the API expects from the two selectors. */
export function buildScope(setId: string | null, componentId: string | null): string {
  const parts = [
    setId && setId !== ALL_SETS ? `set:${setId}` : null,
    componentId ? `component:${componentId}` : null,
  ].filter(Boolean);
  return parts.length === 0 ? ALL_SETS : parts.join('#');
}

/**
 * The ladder path for one scene. The preview flag is added by the caller.
 *
 * This and `sceneMapPath` below are the two links into a scene, and they live
 * here rather than in `lib/sceneMap.ts` - which is the page that uses them
 * most - for a bundling reason worth stating. `lib/sceneMap.ts` is reached
 * only from `/rankings/map`, the app's one `React.lazy` route, and Rollup
 * hoists a module shared between an eager and a lazy chunk into the eager one
 * *whole*. The event page's scene line is eager, so importing one path builder
 * from there put that entire module - its copy, its geometry, its coverage
 * sentences - into the bundle every calendar visitor downloads. Measured: with
 * the import, 152.59KB gzipped against a 151.88KB base; with the builders
 * here, the whole scene line costs **0.71KB** and `lib/sceneMap.ts` stays in
 * the lazy chunk (47.20KB, where it was). They are scope plumbing and this
 * module already owns scopes, so they belong here.
 */
export function scenePath(componentId: string): string {
  return `/rankings?region=${encodeURIComponent(componentId)}`;
}

/**
 * The query parameter the scene map keeps its selection in.
 *
 * Named here rather than only in `ScenesPage` because that page is no longer
 * the only writer: an event page links *into* the map with one scene already
 * selected, and two spellings of `scene` would be a link that quietly selects
 * nothing. `ScenesPage`'s own `URL_PARAMS` reads this.
 */
export const SCENE_MAP_PARAM = 'scene';

/**
 * The map path with one scene selected.
 *
 * The map's selection lives in its URL precisely so a view of one scene is
 * shareable, so linking to it from elsewhere is reuse rather than a second
 * mechanism.
 */
export function sceneMapPath(componentId: string): string {
  return `/rankings/map?${SCENE_MAP_PARAM}=${encodeURIComponent(componentId)}`;
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
 * The scope that mixes every scene together.
 *
 * It is the landing state: a reader arriving at /rankings sees Global, and
 * picks a scene when they want positions. One name for it, used by the scene
 * picker, the page heading and the coverage block alike - two names for one
 * scope is the confusion this replaced ("Everywhere" beside "All scenes").
 *
 * It **carries positions**, and used not to. The old rule was that Global is
 * never `comparable` - true, in the narrow sense that a rating is only
 * identified against the players it was earned among - so the ladder dropped
 * its `#` column entirely. That withheld an order that exists rather than
 * reporting it with its caveat, and it did so on the page a reader lands on.
 * `GLOBAL_POSITION_HINT` and `GLOBAL_POSITION_NOTICE` carry the caveat now.
 */
export const GLOBAL_SCENE_LABEL = 'Global';

/**
 * One row of the scene picker. Kept as data rather than JSX so the filtering a
 * searchable picker needs is a pure function - there are ~194 scenes already
 * and the list only grows.
 */
export interface SceneOption {
  /** null is the Global pseudo-scene: every scene at once, and never `comparable`. */
  id: string | null;
  label: string;
  /** Secondary line: rated count, and whether the scene is big enough to order. */
  meta: string;
  comparable: boolean;
}

/**
 * The first row of the picker, and the scope the page opens on.
 *
 * `meta` used to read `not comparable`, and it was the first explanation a
 * reader got of why the ladder had no numbers down its left edge. It has
 * numbers now, so that line would be describing a page that no longer exists -
 * and it was always the wrong place for the caveat, because a reader meets it
 * before they have seen anything it qualifies. It says what the scope *is*;
 * `GLOBAL_POSITION_HINT` on the `#` column says what its order rests on,
 * beside the thing being qualified.
 *
 * `comparable` stays **false**, and is not a contradiction: it is the narrow
 * statistical claim - a rating is only identified against the players it was
 * earned among - and it is still true. What changed is that the page no longer
 * reads it as "print nothing".
 */
export const GLOBAL_OPTION: SceneOption = {
  id: null,
  label: GLOBAL_SCENE_LABEL,
  meta: 'every scene at once',
  comparable: false,
};

export function sceneOptions(components: ComponentSummary[]): SceneOption[] {
  return [
    GLOBAL_OPTION,
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
 * How a rating is allowed to be shown. Three states, decided in one place so
 * the ladder, the event page and the player page cannot drift apart.
 *
 *  `rated`     - a settled number with a position behind it.
 *  `unsettled` - a real number, printed muted and with **no position**. It has
 *                enough games to describe the player but not enough to be
 *                placed against others.
 *  `none`      - no number at all.
 *
 * **The page used to print `Unranked` for everything but the first.** A column
 * of that word reads as a broken page rather than an honest one, and it threw
 * away a figure the engine was perfectly willing to stand behind. The honesty
 * now rides on the **margin**: a `±156` beside a `±95` says "not settled"
 * better than the word did, and the margin bar makes it something a reader
 * *sees* rather than reads.
 *
 * The floor is the API's to decide, not ours: below about three recorded games
 * the estimate has barely moved off the 1,200 prior, so it would echo the
 * prior rather than describe the player, and the API sends `rating: null`.
 * That is why this reads the number and not a game count - the one rule is
 * "is there a number", and whoever owns the floor can move it without this
 * changing.
 */
export type RatingDisplay = 'rated' | 'unsettled' | 'none';

export function ratingDisplay(
  subject: { rating?: number | null; provisional?: boolean } | null | undefined
): RatingDisplay {
  if ((subject?.rating ?? null) === null) return 'none';
  return subject?.provisional ? 'unsettled' : 'rated';
}

/**
 * Why there is no number yet - the hover hint on `Unranked`.
 *
 * Not prose on the page: the page reports, and a reader who wants the reason
 * hovers. The figure quoted is `RATING_ANCHOR`, so this cannot drift from the
 * engine's own origin.
 */
export const UNRANKED_NO_GAMES_EXPLANATION =
  `Unranked - too few recorded games for a rating. With one or two games the estimate barely moves ` +
  `off the ${RATING_ANCHOR.toLocaleString()} starting average, so it would describe the average rather ` +
  `than the player.`;

/**
 * The caveat on a global position, as the `#` column's hover hint.
 *
 * It names the specific weakness, which is **not** the one the `±` beside each
 * rating already carries. The margin is the posterior SD of a comparison
 * *inside* a scene. Across scenes there is no comparison to have a margin
 * about: a scene is a group of players who have played each other, so a game
 * between two scenes would merge them, and measured on the live corpus
 * **0 of 56,257 recorded games cross one** - 1,235 scenes, 369 of them on the
 * global ladder, 15 of them in its top 25. Every scene's level therefore rests
 * on the 1,200 starting rating and nothing else.
 *
 * Why this is copy and not a number: the engine does publish a cross-scene
 * sigma (`crossComponentUncertainty`), and it is useless here. It widens the
 * margin by a median of 1.2 rating points on the live board, because the model
 * pins a 4,654-player scene's mean level to ±2.2 off the prior. That is right
 * given the prior, and the prior - every scene averages 1,200 - is exactly the
 * part nothing has tested. A ±96 beside a ±95 would read as "a cross-scene
 * comparison is 1% less certain", which is the opposite of what is true.
 *
 * It is also why there is no per-player "how connected is your scene" figure:
 * that quantity was measured and it is zero for every player in the corpus, so
 * a column of it would be furniture. What varies, and what a reader actually
 * needs, is the size of the scene a position was earned in - which the Scene
 * column carries.
 */
export const GLOBAL_POSITION_HINT =
  `Global positions order every scene at once. Scenes are groups of players who have played each other, ` +
  `and no recorded game crosses one - so each scene's level rests on the ${RATING_ANCHOR.toLocaleString()} starting ` +
  `rating, and only the order within a scene is earned. Pick a scene for places that are.`;

/**
 * The same fact as the page's one banner line.
 *
 * It replaces "No positions in Global - pick a scene", which was true of the
 * old behaviour and is now wrong. One line, like every other notice here: it
 * reports, and the reason is the hover hint. No paragraph.
 */
export const GLOBAL_POSITION_NOTICE = 'Global places every scene on one ladder — no recorded game crosses a scene.';

/**
 * Why a settled rating still has no position: its scene is too small for an
 * order inside it to mean anything. The row's hover hint on the `--`.
 *
 * Distinct from `ratingExplanation`'s cases, which are all about evidence - a
 * player here has plenty. On the live board 29 of 6,117 rated players are in
 * this state, and the Global ladder is where they are visible, so the page
 * needs a sentence for it rather than an unexplained dash.
 */
export function sceneTooSmallExplanation(componentSize: number | null | undefined, minSceneSize: number): string {
  const size = componentSize ?? null;
  const scene = size === null ? 'this scene' : `a scene of ${size.toLocaleString()}`;
  return `No position - ${scene} is too small to order anyone (${minSceneSize} players needed). The rating itself stands.`;
}

/**
 * Does this row hold a position?
 *
 * One rule, read off the API's own answer rather than re-derived: a rank is a
 * number or it is not. `ratingDisplay` says why a row has none when the reason
 * is evidence; `sceneComparable` says so when the reason is the scene.
 */
export function hasPosition(entry: { rank: number | null }): boolean {
  return entry.rank !== null;
}

/**
 * Should the ladder draw a `#` column at all?
 *
 * Data-driven, not scope-driven, which is the change: the old rule was "only
 * when the scope is one comparable scene", and it is what kept Global
 * positionless. A column of nothing but dashes is furniture, so the question is
 * simply whether any loaded row earns a place - true on Global, true on a real
 * scene, false on a four-player one, where the banner says why.
 */
export function hasPositions(entries: { rank: number | null }[]): boolean {
  return entries.some(hasPosition);
}

/**
 * The Scene cell's hover hint: how deep the field behind this position is.
 *
 * This is the per-row measure that replaced the idea of a cross-scene
 * connectivity figure. Cross-scene play is zero everywhere, so it cannot
 * separate one row from another; scene size can, and it is the thing the
 * model's own cross-scene term is a function of. A first place among 4,654
 * players and a first place among 9 are both real and are not the same claim.
 */
export function sceneSizeHint(entry: { componentSize: number | null }): string {
  if (entry.componentSize === null) return 'Scene size not recorded.';
  if (entry.componentSize === 1) return 'Scene of 1 player.';
  return `Scene of ${entry.componentSize.toLocaleString()} players who have played each other.`;
}

/**
 * The comparable component with the most rated players, or failing that the
 * biggest one.
 *
 * No longer the landing scope - the page opens on Global and lets the reader
 * choose - but kept because it is the answer to "which scene would you show
 * if you had to show one", and a shared `?region=` link always outranks any
 * default anyway.
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
  if (!component || !component.componentId) return GLOBAL_SCENE_LABEL;
  return component.regionLabel ?? `Scene ${component.componentId}`;
}


/**
 * Why a rating is where it is - as a *tooltip*, never as inline prose.
 *
 * The page used to print this sentence beside the player, which read as the
 * site explaining itself rather than reporting a fact. It is the hover text
 * now, and it says three different things because there are three states: a
 * settled rating needs no explanation, an unsettled one is still earning its
 * position, and no number at all is a different thing again.
 *
 * **Defensive about `reason` on purpose.** The API has sent `no-rating` for
 * players who plainly have games - a mapping bug - so this trusts the display
 * state and the game counts over the reason string, and only lets the string
 * pick the wording when it says something the numbers cannot: that the margin,
 * rather than the volume, is what is holding the rating back.
 */
export function ratingExplanation(
  display: RatingDisplay,
  reason: ProvisionalReason | null,
  gamesUntilRated: number,
  minGames: number
): string {
  if (display === 'rated') return '';
  if (display === 'none') return UNRANKED_NO_GAMES_EXPLANATION;
  if (reason === 'uncertainty-too-wide') {
    return 'Still settling - the margin is too wide to place this player against others yet.';
  }
  const togo = Math.max(0, gamesUntilRated);
  if (togo === 0) {
    return `Still settling - not enough recorded games yet to place this player against others (${minGames} needed).`;
  }
  return togo === 1
    ? `Still settling - one more recorded game before this rating earns a position (${minGames} needed).`
    : `Still settling - ${togo} more recorded games before this rating earns a position (${minGames} needed).`;
}

/** The reason as a lower-case fragment, for a tooltip or an aria label. */
export function provisionalShortLabel(reason: ProvisionalReason | null): string {
  switch (reason) {
    case 'no-rating':
      return 'no rating yet';
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

/**
 * Splits a leaderboard page into the rows that carry a number and the rows
 * that do not.
 *
 * It used to split on `provisional`, which put every unsettled player into a
 * second list with the word `Unranked` and no figure. The table now holds
 * everyone the engine will quote a rating for, settled or not - the position
 * is what `provisional` withholds, not the number - and the tail is only the
 * players with no number yet, which after the engine refit is a short list.
 */
export function splitByRating(entries: LeaderboardEntry[]): {
  scored: LeaderboardEntry[];
  unscored: LeaderboardEntry[];
} {
  return {
    scored: entries.filter((entry) => ratingDisplay(entry) !== 'none'),
    unscored: entries.filter((entry) => ratingDisplay(entry) === 'none'),
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

/**
 * A record in the notation a card player already reads: `2-1`, or `2-1-1`
 * when a draw actually happened.
 *
 * Win-loss-draw order, and the trailing `-0` is dropped rather than printed on
 * every row - draws are rare (72 against 1,372 decisive sides on the live
 * corpus), so a universal `-0` would be noise carrying no information.
 */
export function formatRecord(record: Record_): string {
  return record.draws > 0
    ? `${record.wins}-${record.losses}-${record.draws}`
    : `${record.wins}-${record.losses}`;
}

/**
 * The same record spelled out, for an accessible name.
 *
 * `2-1-1` survives greyscale on its own - it is numerals, not colour - so the
 * visible W/L/D letters it replaced are not needed for that rule. But a screen
 * reader announces the notation as "two dash one dash one", so the spoken form
 * says what it means instead. The visible figure is `aria-hidden` wherever
 * this is used beside it.
 */
export function recordSpoken(record: Record_): string {
  const parts = [
    `${record.wins} ${record.wins === 1 ? 'win' : 'wins'}`,
    `${record.losses} ${record.losses === 1 ? 'loss' : 'losses'}`,
  ];
  if (record.draws > 0) {
    parts.push(`${record.draws} ${record.draws === 1 ? 'draw' : 'draws'}`);
  }
  return parts.join(', ');
}

/**
 * Win rate over the matches we actually have, as a percentage of *decided*
 * matches. Draws count in the denominator - they are a result - but an
 * unrecorded match is not evidence either way and is excluded.
 *
 * null when nothing is decided, so the bar renders as "no results yet" rather
 * than as a confident 0%.
 */
export function winRate(record: Record_): number | null {
  const decided = record.wins + record.losses + record.draws;
  if (decided === 0) return null;
  return (record.wins / decided) * 100;
}

export function formatWinRate(value: number | null): string {
  return value === null ? '--' : `${Math.round(value)}%`;
}

/**
 * The letter a result is read by.
 *
 * Every place this UI colours a result it also prints this letter: colour is
 * never the only signal, because red and green are the pair most readers with
 * a colour vision deficiency cannot separate.
 */
export function outcomeLetter(outcome: GameOutcome): string {
  switch (outcome) {
    case 'win':
      return 'W';
    case 'loss':
      return 'L';
    case 'draw':
      return 'D';
    default:
      return '?';
  }
}

/** The same result as a word, for the row's own label and for screen readers. */
export function outcomeWord(outcome: GameOutcome): string {
  switch (outcome) {
    case 'win':
      return 'Win';
    case 'loss':
      return 'Loss';
    case 'draw':
      return 'Draw';
    default:
      return 'Unrecorded';
  }
}

/**
 * The form strip's data: the most recent `count` matches, newest first.
 *
 * The match log already arrives newest-first from the API (the DynamoDB query
 * runs `ScanIndexForward: false` over `MATCH#<iso>` sort keys), so this is a
 * slice rather than a sort - but it is a named function so the ordering
 * assumption is stated once and tested once.
 */
export function recentForm(matches: PlayerMatch[], count = 10): PlayerMatch[] {
  return matches.slice(0, Math.max(0, count));
}

/**
 * How far a player is through the games gate - recorded games against the
 * published threshold.
 *
 * It answers the one question an unsettled rating leaves open: how close am I.
 *
 * **Read off the evidence, not off the reason string.** The API has sent
 * `provisionalReason: 'no-rating'` for players who plainly have games, and a
 * meter that vanishes because a label was mis-set is worse than one that is
 * occasionally redundant. So the games decide: anyone short of the threshold
 * gets a meter.
 *
 * Two suppressions, both because a meter would be saying something false. A
 * player who has already played enough games is not waiting on volume - a full
 * meter beside an unsettled rating reads as a contradiction - and neither is
 * one the API explicitly says is held back by its margin.
 */
export function gateProgress(
  gamesPlayed: number | null | undefined,
  minGames: number,
  reason: ProvisionalReason | null = 'too-few-games'
): { filled: number; total: number } | null {
  if (!Number.isFinite(minGames) || minGames <= 0 || minGames > 20) return null;
  if (reason === 'uncertainty-too-wide') return null;
  const played = Math.max(0, gamesPlayed ?? 0);
  if (played >= minGames) return null;
  return { filled: played, total: minGames };
}

// ---------------------------------------------------------------------------
// Margin bars
// ---------------------------------------------------------------------------

/**
 * The shared scale behind the ladder's margin bars.
 *
 * Every row with a number draws its rating ± its uncertainty as a span on one
 * common axis, so two players whose spans overlap can be seen to be
 * inseparable - the honest reading of two ratings a few points apart with a
 * ±90 margin each. The bar is the uncertainty made visible; it invents no tier
 * and no precision.
 *
 * **Unsettled rows are in the scale now, and that is the point.** They used to
 * be excluded because they printed no number at all. Now that they print one,
 * the bar is the thing carrying the honesty the word `Unranked` used to carry:
 * a ±156 span beside a ±95 span is visibly unsettled without anyone having to
 * read a label. Their wide spans stretch the axis, which is what makes the
 * contrast legible rather than something that has to be squinted at.
 *
 * The floor dropped from three rows to two for the same reason. Three was
 * right when only settled rows drew bars and a sparse scene would have shown
 * one or two lonely spans; now the bars are doing work on every row that has a
 * number, and two spans are already a comparison. One is still decoration, and
 * so is a degenerate range.
 */
export interface MarginScale {
  min: number;
  max: number;
}

export function marginScale(entries: LeaderboardEntry[], minimumRows = 2): MarginScale | null {
  const usable = entries.filter(
    (entry) => entry.rating !== null && entry.rating !== undefined
  );
  if (usable.length < minimumRows) return null;

  let min = Infinity;
  let max = -Infinity;
  for (const entry of usable) {
    const margin = entry.uncertainty ?? 0;
    min = Math.min(min, (entry.rating as number) - margin);
    max = Math.max(max, (entry.rating as number) + margin);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return null;
  return { min, max };
}

export interface MarginBar {
  /** Percentages along the shared axis: the span, and the rating within it. */
  leftPercent: number;
  widthPercent: number;
  markerPercent: number;
}

export function marginBar(
  entry: { rating: number | null; uncertainty: number | null },
  scale: MarginScale | null
): MarginBar | null {
  if (!scale || entry.rating === null || entry.rating === undefined) return null;
  const span = scale.max - scale.min;
  if (!(span > 0)) return null;

  const clamp = (value: number) => Math.max(0, Math.min(100, value));
  const margin = entry.uncertainty ?? 0;
  const left = clamp(((entry.rating - margin - scale.min) / span) * 100);
  const right = clamp(((entry.rating + margin - scale.min) / span) * 100);

  return {
    leftPercent: left,
    // A zero-margin rating still needs to be visible as a mark.
    widthPercent: Math.max(right - left, 1.5),
    markerPercent: clamp(((entry.rating - scale.min) / span) * 100),
  };
}

/** "2-0", "1-2" etc. from the per-game outcomes of one Bo3. */
export function gameScore(match: PlayerMatch): string {
  const won = match.games.filter((game) => game.outcome === 'win').length;
  const lost = match.games.filter((game) => game.outcome === 'loss').length;
  return `${won}-${lost}`;
}

// ---------------------------------------------------------------------------
// Rating movement: what the match log can honestly say about a day's play
// ---------------------------------------------------------------------------

/**
 * **There is no per-match rating delta, anywhere, and there cannot be one.**
 *
 * This section exists because "+18 for this win" is the obvious thing to want
 * beside a match, and the engine behind this page is not the kind that
 * produces it. Writing down why, once, so nobody re-derives a number the model
 * never computed:
 *
 *  - The engine is **Whole-History Rating** (`scraper/src/ranking/whr.ts`), not
 *    Elo. Elo is an update rule, so a per-match delta is the only thing it
 *    *has*. WHR is a single global fit over every recorded match at once: it
 *    maximises one posterior and reports where each player's curve ended up.
 *    No match is credited with a share of the result.
 *  - **The fit's time axis is the day.** A player gets one rating per *day they
 *    played* (`fit.days[p]`), tied to the next by a Wiener prior. Four matches
 *    at one event move one curve point between them, and the model holds no
 *    opinion about how to split that movement across them. So the finest grain
 *    an honest figure can have is a **day**, and that is the grain used here.
 *  - It is **retroactive**. A refit can move the rating for a day months past,
 *    because beating someone who later turns out to be strong improves your
 *    rating *at the time*. The figure is therefore "what the latest fit says
 *    about that day", never "what was awarded on the day".
 *
 * What is left that is real: both endpoints of the movement are **published,
 * dated ratings** - the very points `/api/players/:id/ratings` draws the chart
 * from - so the difference between them is arithmetic on two numbers this page
 * already prints, and the match log cannot disagree with the chart above it.
 * The engine rounds each point to a whole rating before storing it, so the
 * difference is exact with respect to what the reader sees rather than a
 * rounding of some finer truth.
 *
 * Three factors a reader might expect are deliberately **not** offered, each
 * for a measured reason rather than a stylistic one:
 *
 *  - **An event-tier multiplier.** The mechanism exists (`WhrOptions.tierWeights`)
 *    and ships *neutral*: every tier counts 1, because zero matches exist in
 *    any tier above Nexus Night and the one weighting that moved held-out log
 *    loss turned out to be the global `weightScale` under another name. A line
 *    reading "x1.00" on every row of every match is furniture.
 *  - **A cross-scene adjustment.** A scene is a connected component of the
 *    co-play graph, so a game across two of them would merge them: measured on
 *    production, **0 of 56,257 recorded games cross a scene**. The term would
 *    be zero on every match on the site. The engine's `crossComponentUncertainty`
 *    widens a margin by a median of 1.2 points (ratio 1.011), which is not a
 *    factor, it is a rounding error.
 *  - **The drift allowance** between two play days. It is a real term
 *    (`driftEloPerSqrtDay`), but the knob is *not identifiable from the data* -
 *    held-out log loss is flat to four decimal places from 0.5 to 16 - so it is
 *    a prior belief, and publishing `±11 of allowed drift` would dress one up
 *    as a measurement.
 */
export interface RatingMove {
  /** `YYYY-MM-DD` UTC - the engine's own time axis, and the match log's. */
  date: string;
  /** The fit's rating for this day, as published. */
  rating: number;
  /** Its margin. Never dropped: see `publishableRating` on the API side. */
  uncertainty: number | null;
  /** The previous day this player played, or null on their first one. */
  previousDate: string | null;
  previousRating: number;
  previousUncertainty: number | null;
  /** `rating - previousRating`: a difference of two published numbers. */
  delta: number;
  /**
   * True when the comparison is against the starting anchor rather than a day
   * that was played. Everyone starts at `RATING_ANCHOR`, so the first recorded
   * day's movement is real and has to be labelled as what it is.
   */
  fromAnchor: boolean;
  /**
   * Is the movement smaller than the day's own margin?
   *
   * The house rule is that a rating is published with its uncertainty, and a
   * *movement* has to answer to it too: a +18 under a ±98 has not separated
   * anything, and that is the single most useful thing to say about it. null
   * when no margin was recorded, because "false" would be a claim.
   */
  withinMargin: boolean | null;
}

/**
 * The movement for each day of a rating series, keyed on its date.
 *
 * Takes the series exactly as the chart gets it. Sorted defensively - the API
 * queries the `RATING#<scope>#<date>` sort key ascending, so it already
 * arrives in order, but the whole point of this function is that consecutive
 * points are what a movement is *between*.
 *
 * Note the ceiling the series brings with it: the endpoint serves the first
 * `limit` (default 100) play days, which is also what the chart draws. A day
 * past that has no point and therefore no movement, and the match log says
 * nothing rather than guessing - the same answer the chart gives by not
 * plotting it.
 */
export function ratingMoves(
  points: RatingPoint[],
  anchor: number = RATING_ANCHOR
): Map<string, RatingMove> {
  const ordered = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const moves = new Map<string, RatingMove>();

  ordered.forEach((point, index) => {
    const previous = index > 0 ? ordered[index - 1] : null;
    const previousRating = previous ? previous.rating : anchor;
    const delta = point.rating - previousRating;
    moves.set(point.date, {
      date: point.date,
      rating: point.rating,
      uncertainty: point.uncertainty,
      previousDate: previous ? previous.date : null,
      previousRating,
      previousUncertainty: previous ? previous.uncertainty : null,
      delta,
      fromAnchor: previous === null,
      withinMargin:
        point.uncertainty === null || point.uncertainty === undefined
          ? null
          : Math.abs(delta) <= point.uncertainty,
    });
  });

  return moves;
}

/** `+18`, `-7`, `0`. The sign is the signal, so zero carries none. */
export function formatRatingDelta(delta: number): string {
  const rounded = Math.round(delta);
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toLocaleString()}`;
}

/** `up`, `down` or `flat` - for the class name and for the spoken form. */
export function ratingMoveDirection(delta: number): 'up' | 'down' | 'flat' {
  const rounded = Math.round(delta);
  if (rounded > 0) return 'up';
  if (rounded < 0) return 'down';
  return 'flat';
}

/**
 * The whole movement as one sentence, for a screen reader.
 *
 * The visible chip is a figure plus an arrow, and an arrow announces as
 * nothing. This is the accessible name, so it carries the margin too - a bare
 * "up 18" is exactly the unqualified number the margin exists to qualify.
 */
export function ratingMoveSummary(move: RatingMove): string {
  const margin = formatUncertainty(move.uncertainty);
  const to = `${formatRating(move.rating)}${margin ? ` plus or minus ${Math.round(move.uncertainty as number)}` : ''}`;
  const direction = ratingMoveDirection(move.delta);
  const movement =
    direction === 'flat'
      ? 'unchanged'
      : `${direction} ${Math.abs(Math.round(move.delta)).toLocaleString()}`;
  const from = move.fromAnchor
    ? `the ${formatRating(move.previousRating)} starting rating`
    : `${formatRating(move.previousRating)} on ${formatDate(move.previousDate)}`;
  const caveat =
    move.withinMargin === true ? ' The movement is smaller than that margin.' : '';
  return `Rating ${to} after this day, ${movement} from ${from}.${caveat}`;
}

/**
 * The three short line items the breakdown prints, plus their labels.
 *
 * Kept as data rather than JSX so the wording is testable without a DOM, which
 * is how every other claim on these pages is pinned.
 */
export const RATING_MOVE_GRAIN_NOTE =
  'One rating per day played, not per match - the fit has no per-match figure.';

export const RATING_MOVE_REFIT_NOTE =
  'Fitted over the whole history, so a later refit can move it.';

/** The hover/focus hint on the affordance itself. */
export const RATING_MOVE_HINT =
  'The rating this day left the player on, with its margin, and how far it moved from the day before.';

/**
 * One day of the match log: the matches played on it, and whether we have all
 * of them.
 *
 * The day is the unit because the fit's time axis is (see `RatingMove`), and
 * grouping is what keeps the movement from being printed once per match - four
 * rows each reading `+18` over a day that moved 18 in total is a four-fold
 * overstatement a reader has no way to see through.
 */
export interface MatchDay {
  /** `YYYY-MM-DD` UTC, joining exactly to a rating point's `date`. */
  date: string;
  matches: PlayerMatch[];
  record: Record_;
  /** Games recorded across the day's matches. */
  games: number;
  /**
   * False when the match log is paginated mid-day, so these are *some* of the
   * day's matches. The movement is still the day's movement; the record beside
   * it would not be the day's record, so it is not presented as one.
   */
  complete: boolean;
}

/**
 * Group the loaded match log into days, newest first.
 *
 * Order is preserved rather than sorted: the API returns the log newest-first
 * off the `MATCH#<iso>` sort key, the same assumption `recentForm` states.
 *
 * `eventDate` is the engine's own UTC day (`utcDate(event.startDate)` in
 * `scraper/src/ranking/snapshot.ts`), which is the same value its rating points
 * are keyed on, so the join needs no date arithmetic. `playedAt` is the same
 * instant in ISO form, so its first ten characters are the identical day - a
 * fallback for a log entry served without the field rather than a conversion.
 */
export function matchDays(matches: PlayerMatch[], moreToLoad = false): MatchDay[] {
  const days: MatchDay[] = [];
  const byDate = new Map<string, MatchDay>();

  for (const match of matches) {
    const date = match.eventDate ?? match.playedAt.slice(0, 10);
    let day = byDate.get(date);
    if (!day) {
      day = { date, matches: [], record: { wins: 0, losses: 0, draws: 0 }, games: 0, complete: true };
      byDate.set(date, day);
      days.push(day);
    }
    day.matches.push(match);
    day.games += match.games.length;
    if (match.outcome === 'win') day.record.wins += 1;
    else if (match.outcome === 'loss') day.record.losses += 1;
    else if (match.outcome === 'draw') day.record.draws += 1;
  }

  // Only the oldest loaded day can be cut in half by the page boundary.
  if (moreToLoad && days.length > 0) days[days.length - 1].complete = false;

  return days;
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
