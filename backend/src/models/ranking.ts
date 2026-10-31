import { z } from 'zod';

/**
 * Ranking / rating domain model.
 *
 * The rating engine (in the scraper) writes derived items into the same
 * DynamoDB table the calendar uses:
 *
 *   PLAYER#<uuid> / PROFILE                        - one per player
 *   PLAYER#<uuid> / RATING#<scope>#<iso-date>      - rating history points
 *   PLAYER#<uuid> / MATCH#<iso-timestamp>#<matchId> - match log
 *   RANKING#<scope>                                - leaderboard pages
 *
 * `scope` is one of: `all`, `set:<id>`, `component:<id>`, `set:<id>#component:<id>`,
 * plus `scene:<id>` and `set:<id>#scene:<id>`, which are **not** stored keys -
 * see `Scope.sceneId` and `isStoredScope` below.
 *
 * Nothing in this file writes those items - the API only reads them.
 */

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface Scope {
  /**
   * Canonical string form.
   *
   * For every scope the engine writes, this is exactly the string in the item
   * key (`RANKING#<raw>`, `RATING#<raw>#<date>`). For a **scene** scope it is
   * not a key at all and must never be used as one: see `sceneId`.
   */
  raw: string;
  setId: string | null;
  componentId: string | null;
  /**
   * The scene a board is filtered down to, or null.
   *
   * **A scene scope is a filter, not a fit, and that distinction is the whole
   * design.** `component:<id>` names a rating *scale* - a connected component
   * of the co-play graph, the only group inside which two of this engine's
   * ratings are comparable - so the engine fits one and writes a board for it.
   * A scene is a cluster of **stores** within 30km of each other, and it is
   * additive: it does not define a scale, nothing about
   * `crossComponentUncertainty` changes, and the engine writes no
   * `RANKING#scene:<id>` item.
   *
   * What makes it serviceable anyway is the storage contract: every ladder row
   * already carries `sceneId` (scraper `items.ts`, `RankingRow.sceneId`,
   * "denormalised so a board can be filtered without profile fetches"). So a
   * scene board is the scene's rows **out of one pool's board**, re-ranked
   * densely among themselves - statistically sound in a way a cross-component
   * board is not, because the scene's players sit (almost entirely) in one
   * component and are therefore already on one scale.
   *
   * Mutually exclusive with `componentId`: a scene resolves its own pool off
   * the engine's `SCENE#<sceneId>` item, so naming both would be either
   * redundant or a contradiction, and `parseScope` rejects the pair rather
   * than silently preferring one.
   */
  sceneId: string | null;
}

/** Set / component / scene ids are opaque to us; keep them to a safe key-ish charset. */
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Parse a scope string into its parts. Returns null when the string is not a
 * shape the contract defines, so callers can answer 400 rather than query a
 * key that cannot exist.
 *
 * Six shapes: `all`, `set:<id>`, `component:<id>`, `scene:<id>`,
 * `set:<id>#component:<id>`, `set:<id>#scene:<id>`. `component:` and `scene:`
 * together is rejected - see `Scope.sceneId`.
 */
export function parseScope(input: string | undefined | null): Scope | null {
  const raw = (input ?? 'all').trim();
  if (raw === '' || raw === 'all') {
    return { raw: 'all', setId: null, componentId: null, sceneId: null };
  }

  let setId: string | null = null;
  let componentId: string | null = null;
  let sceneId: string | null = null;

  for (const part of raw.split('#')) {
    const [kind, ...rest] = part.split(':');
    const value = rest.join(':');
    if (!SCOPE_ID.test(value)) return null;
    if (kind === 'set' && setId === null) setId = value;
    else if (kind === 'component' && componentId === null) componentId = value;
    else if (kind === 'scene' && sceneId === null) sceneId = value;
    else return null;
  }

  if (setId === null && componentId === null && sceneId === null) return null;
  // A pool and a place are not two coordinates of one selection: the scene
  // names its own pool, so a caller offering both is either repeating itself
  // or disagreeing with the engine, and neither is a scope we can serve.
  if (componentId !== null && sceneId !== null) return null;

  // Rebuild rather than trusting the input's ordering: `set:` always first,
  // so one logical scope only ever has one key.
  const canonical = [
    setId !== null ? `set:${setId}` : null,
    componentId !== null ? `component:${componentId}` : null,
    sceneId !== null ? `scene:${sceneId}` : null,
  ].filter(Boolean).join('#');

  return { raw: canonical, setId, componentId, sceneId };
}

/**
 * Is this scope a partition the engine actually wrote?
 *
 * The guard that keeps `Scope.raw` honest. Everything but a scene scope is a
 * stored key, and a scene scope's `raw` is a request shape rather than an item
 * id - so a reader that hands it to `RANKING#<raw>` or `RATING#<raw>#<date>`
 * gets an empty answer that looks like "nobody plays there" instead of
 * "nothing writes that". Call this before using `raw` as a key.
 */
export function isStoredScope(scope: Scope): boolean {
  return scope.sceneId === null;
}

/**
 * The stored board a scene scope's rows are read out of.
 *
 * A scene has no board of its own, so its rows come from the board of the pool
 * its home players sit on - `component:<poolId>` under the same set era, or
 * the set-wide board when the engine wrote no ladder for that pool (it writes
 * at most `RANKING_MAX_COMPONENT_LADDERS` of them, 50, and only for components
 * of at least `minComponentSize`, so for most of the 1,235 components there is
 * no component partition at all).
 *
 * `componentId: null` returns the set-wide scope, which always exists.
 */
export function poolScope(scope: Scope, componentId: string | null): Scope {
  return parseScope(
    [
      scope.setId !== null ? `set:${scope.setId}` : null,
      componentId !== null ? `component:${componentId}` : null,
    ]
      .filter(Boolean)
      .join('#') || 'all'
  ) as Scope;
}

/** The scope used for a player's rating history when none is given. */
export const DEFAULT_SCOPE: Scope = { raw: 'all', setId: null, componentId: null, sceneId: null };

/**
 * How many rows of a pool's board a scene board may read before it stops.
 *
 * A scene board is a filtered read, so its cost is the **pool's** board rather
 * than the scene's own size, and this is the bound on that. It is a safety
 * ceiling on one Lambda invocation, not a product decision - which is why it
 * is well clear of anything the corpus can produce rather than tuned to it.
 *
 * Derived, not measured, from two figures that were:
 *
 * - the live global board holds **6,117 rated rows** across 1,235 components,
 *   with a **97.4%** giant component share (scraper/CLAUDE.md, "the graph is
 *   far more connected than expected"), so the largest board a scene can send
 *   us to is ~5,960 rows and `RANKING#all` is 6,117;
 * - the one read-unit measurement on a comparable partition is **46 units for
 *   1,235 `COMPONENT#` items**, i.e. ~305 bytes an item, and a `RankingRow`
 *   carries the same order of short attributes.
 *
 * So a scene board today reads ~2MB over 2-3 Query pages, around **250
 * eventually-consistent read units**, against ~46 for the whole scene map and
 * ~2 for one 25-row page of a component board. 20,000 rows is 3.2x the current
 * board - a year or two of growth - and ~800 read units if it is ever reached.
 * Past it the answer is reported with `coverageComplete: false` rather than
 * silently truncated, because the partition is in rank order and a cap drops
 * the low-rated tail.
 *
 * If this ever binds, the fix is not a bigger number: it is a stored
 * `RANKING#scene:<id>` board in the engine. That was costed and declined for
 * now - see backend/CLAUDE.md, "A scene board is a filter, not a fit".
 */
export const SCENE_BOARD_MAX_ROWS = 20_000;

// ---------------------------------------------------------------------------
// Confidence: when is a rating fit to show?
// ---------------------------------------------------------------------------

/**
 * The publishing bar, as numbers this API can quote back to a caller.
 *
 * The engine now writes its own verdict onto each item and these match the
 * thresholds it used (8 / 120 / 8, measured from its posterior SD
 * distribution - see the scraper's "Publishing honestly"), so they are reported
 * in `coverage` and used by `assessConfidence` only as the fallback for an item
 * that carries no verdict. At launch (Radiance shipped 2026-10-23, the backfill
 * reaches ~21 days) almost every player sits below them, and that is the honest
 * answer rather than a defect.
 */
export const CONFIDENCE = {
  /** Fewer games than this and the rating is noise, whatever its sigma. */
  minGames: 8,
  /** A sigma this wide spans most of the ladder; the number says nothing. */
  maxUncertainty: 120,
  /**
   * Ratings are only comparable inside a connected component of the co-play
   * graph. A component this small has not mixed enough to order anyone.
   */
  minComponentSize: 8,
} as const;

/**
 * The display floor: how many recorded games before the rating *number* is
 * published at all. `RANKING_MIN_GAMES_TO_PUBLISH` overrides it.
 *
 * **This is not the rank gate.** `CONFIDENCE` above decides who gets a
 * *position* (8 games, sigma <= 120, component >= 8) and is unchanged. This is
 * the much lower bar for showing a figure at all, and between the two a player
 * shows a rating with its uncertainty and `rank: null`.
 *
 * Three is not arbitrary. Measured posterior SD by games played, against a
 * prior SD of 150:
 *
 * | games | median SD | share under 120 |
 * |---|---|---|
 * | 1-2 | 130 | 0.7% |
 * | 3-4 | 122 | 15.4% |
 * | 5-7 | 107 | 87.3% |
 * | 8-9 | 97 | 95.1% |
 *
 * At one or two games the posterior has barely moved off the prior, so the
 * number is 1200-with-noise wearing the word "rating". By three it has at least
 * responded to results. The floor is the point where the figure starts carrying
 * information instead of echoing the prior.
 */
export const DEFAULT_MIN_GAMES_TO_PUBLISH = 3;

/**
 * Is there enough evidence to show the number?
 *
 * The predicate is on recorded games alone, deliberately: `uncertainty` travels
 * with every published rating and is what tells a settled figure from an
 * unsettled one, so the floor only has to keep out the ratings that are still
 * the prior.
 */
export function publishesRating(gamesPlayed: number | null | undefined, floor: number): boolean {
  return (gamesPlayed ?? 0) >= floor;
}

export type ProvisionalReason = 'too-few-games' | 'uncertainty-too-wide' | 'no-rating';

/**
 * The verdict the rating engine writes onto its own items
 * (`scraper/src/ranking/items.ts`).
 *
 * It is the authority: the thresholds behind it are measured from the posterior
 * SD distribution the engine fitted, so re-deriving one here from `gamesPlayed`
 * and `uncertainty` can only ever agree by coincidence. Every field is optional
 * because an item written before the engine emitted them carries none of them,
 * and because the leaderboard rows carry none at all.
 *
 * Its reason vocabulary is the engine's, not ours: `too-uncertain` rather than
 * `uncertainty-too-wide`, plus `component-too-small`, which the engine reports
 * alongside a *published* rating (the internal order is real; only the position
 * is suppressed, which this API expresses as `comparable: false`).
 */
export interface EngineVerdict {
  provisional?: boolean | null;
  provisionalReason?: string | null;
  gamesUntilRated?: number | null;
}

/** The engine's reason names, mapped onto the ones this API publishes. */
const ENGINE_REASONS: Record<string, ProvisionalReason> = {
  'too-few-games': 'too-few-games',
  'too-uncertain': 'uncertainty-too-wide',
  'uncertainty-too-wide': 'uncertainty-too-wide',
  'no-rating': 'no-rating',
};

export interface ConfidenceVerdict {
  provisional: boolean;
  /** Why the rating is withheld; null when it is fit to show. */
  provisionalReason: ProvisionalReason | null;
  /** How many more games until this player clears the games gate. */
  gamesUntilRated: number;
}

/**
 * The fallback verdict, derived from the numbers alone. Prefer
 * `resolveVerdict`, which uses the engine's own verdict when the item has one.
 */
export function assessConfidence(input: {
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
}): ConfidenceVerdict {
  const games = input.gamesPlayed ?? 0;
  const gamesUntilRated = Math.max(0, CONFIDENCE.minGames - games);
  const hasRating = input.rating !== null && input.rating !== undefined;

  // `no-rating` means **no evidence**, and nothing else. It is the verdict for
  // an id the engine has never recorded a game for - and it used to be the
  // verdict for anyone whose rating happened to be absent, which was the bug:
  // a known player with 6 recorded games and a fitted sigma of 100 reported
  // `no-rating`, so a page drew no progress meter for someone two games off the
  // bar. Once there are games, the reason is about the evidence, not about
  // whether a number came back.
  if (games <= 0 && !hasRating) {
    return { provisional: true, provisionalReason: 'no-rating', gamesUntilRated };
  }
  if (games < CONFIDENCE.minGames) {
    return { provisional: true, provisionalReason: 'too-few-games', gamesUntilRated };
  }
  if (input.uncertainty !== null && input.uncertainty > CONFIDENCE.maxUncertainty) {
    return { provisional: true, provisionalReason: 'uncertainty-too-wide', gamesUntilRated };
  }
  // Past both gates with no number at all: there genuinely is no rating.
  if (!hasRating) {
    return { provisional: true, provisionalReason: 'no-rating', gamesUntilRated };
  }
  return { provisional: false, provisionalReason: null, gamesUntilRated: 0 };
}

/**
 * The verdict to publish for one rating: the engine's own when the item carries
 * it, `assessConfidence` only as a fallback.
 *
 * Two invariants hold whichever source wins, because both are about what may
 * leave this process rather than about statistics:
 *
 *  - a rating that does not exist is never publishable, however the item is
 *    flagged - that is `no-rating`, not "rated";
 *  - a provisional verdict always carries a reason, so a caller never has to
 *    render "withheld, no idea why". An unmapped engine reason (today only
 *    `component-too-small`, which the engine never pairs with
 *    `provisional: true`) falls back to the derived reason and then to
 *    `uncertainty-too-wide`: a comparison problem, which is what it is, rather
 *    than `too-few-games`, which would put a full progress meter beside the
 *    word "Unranked".
 */
export function resolveVerdict(input: {
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
} & EngineVerdict): ConfidenceVerdict {
  const derived = assessConfidence(input);
  if (typeof input.provisional !== 'boolean') return derived;

  if (input.rating === null || input.rating === undefined) {
    // Provisional either way, but the *reason* is the derived one, which knows
    // the difference between "never seen" and "seen, two games short". Forcing
    // `no-rating` here was half of the fall-through.
    return {
      provisional: true,
      provisionalReason: derived.provisionalReason ?? 'no-rating',
      gamesUntilRated: derived.gamesUntilRated,
    };
  }
  if (!input.provisional) {
    return { provisional: false, provisionalReason: null, gamesUntilRated: 0 };
  }

  const stated = input.provisionalReason ? ENGINE_REASONS[input.provisionalReason] ?? null : null;
  // The other half of the fall-through: the engine's own reason is authoritative
  // about *why* it withheld a rating, but it cannot be right that there is
  // "no rating" for a player whose rating we are holding - execution only
  // reaches here with a non-null one. So a stated `no-rating` is discarded in
  // favour of the derived reason, which reads the games and the sigma.
  const mapped = stated === 'no-rating' ? null : stated;
  const gamesUntilRated =
    typeof input.gamesUntilRated === 'number' && Number.isFinite(input.gamesUntilRated)
      ? Math.max(0, Math.round(input.gamesUntilRated))
      : derived.gamesUntilRated;

  return {
    provisional: true,
    provisionalReason: mapped ?? derived.provisionalReason ?? 'uncertainty-too-wide',
    gamesUntilRated,
  };
}

/**
 * A rating is only meaningful against the players it was earned among. A
 * component below `minComponentSize` is reported as not comparable so the UI
 * never presents it as a ladder.
 */
export function isComparable(componentSize: number | null | undefined): boolean {
  return (componentSize ?? 0) >= CONFIDENCE.minComponentSize;
}

/**
 * Does this rating earn a **position**?
 *
 * Three conditions, all of them about evidence rather than about display:
 *
 *  - the engine calls it settled (its own 8-games / sigma <= 120 verdict);
 *  - there is a number to order on at all;
 *  - the scene it was earned in is big enough for an order inside it to mean
 *    something (`isComparable`).
 *
 * The third used to be enforced one scope at a time - a whole ladder either
 * printed positions or did not - and that is what kept the Global scope
 * positionless. It is a **per-row** fact: a player in a 4-person scene has no
 * position to give, and a player in a 4,654-person one does, and mixing them
 * on one page does not change either answer. So the gate moved onto the row,
 * which is also what lets Global carry positions without handing one to a
 * player who would not get one in their own scene. Measured on the live board:
 * 29 of 6,117 rated players sit in a component below 8 and lose a position
 * they were previously given by the global board's own rank field.
 *
 * What it deliberately does *not* decide is whether the comparison between two
 * rows is well identified. Nothing between two scenes is - see
 * `LeaderboardEntry.sceneComparable`.
 */
export function earnsPosition(input: {
  provisional: boolean;
  rating: number | null;
  componentSize: number | null | undefined;
}): boolean {
  return !input.provisional && input.rating !== null && isComparable(input.componentSize);
}

// ---------------------------------------------------------------------------
// Shapes returned to the client
// ---------------------------------------------------------------------------

export interface PlayerIdentity {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
}

export interface ComponentInfo {
  componentId: string | null;
  componentSize: number | null;
  regionLabel: string | null;
  /** Derived: componentSize is large enough for the ordering to mean something. */
  comparable: boolean;
}

/**
 * One set era's rating for a player, with its **own** verdict: a player can be
 * rated all-time and provisional within a set, or the reverse (a set slice has
 * fewer games and so a wider sigma), so each entry is gated independently.
 *
 * `rating` is null whenever `provisional` is true - the number is withheld, not
 * shipped with a flag beside it.
 */
export interface SetRating {
  setId: string;
  setName: string | null;
  /** null when the set has no published release date (true of sets 1-3). */
  releaseDate: string | null;
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  /** Games still needed in this set's slice; 0 when it is not games that block it. */
  gamesUntilRated: number;
}

/**
 * A player's profile. `rating` is the **publishable** rating: null whenever
 * `provisional` is true, exactly as `TournamentPlayer.rating` is. `uncertainty`,
 * `gamesPlayed`, `matchesPlayed` and `gamesUntilRated` are always carried - a
 * margin and a game count are not a position, and they are what lets a page
 * explain the state instead of just asserting it.
 */
export interface PlayerProfile extends PlayerIdentity, ComponentInfo {
  /**
   * The rating engine has an item for this player.
   *
   * False means "we have never recorded a game for this id", which is **not**
   * the same as "no such player": most of a tournament field is in that state
   * (every one of 5 on one live upcoming event, 15 of 22 on another), and those
   * are real registrants on a real roster. Everything else on the profile is
   * null and the verdict is `no-rating`, so a page says "No record yet" rather
   * than "No player with that id".
   *
   * Same field, same meaning, as `TournamentPlayer.known`.
   */
  known: boolean;
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  gamesUntilRated: number;
  setRatings: SetRating[];
}

export interface LeaderboardEntry extends PlayerIdentity {
  /**
   * Dense position among the rows that earn one (`earnsPosition`); null for a
   * provisional player, and null for one whose scene is too small to order.
   *
   * **On a scene scope it is a position within the scene**, densely, 1..N over
   * the scene's own rows that earn one - not the pool board's rank with the
   * other scenes' rows cut out of it. See `poolRank` for that, and
   * `SceneBoardInfo` for why the re-rank is sound.
   *
   * **Assigned on every scope, Global included.** It used to be - in effect -
   * withheld there, because the client suppressed the whole column whenever
   * the scope mixed scenes. The suppression was honest about a real weakness
   * and dishonest about its own confidence: an order that exists is better
   * reported with its caveat than hidden, and the caveat is what
   * `sceneComparable` and the scene label are for.
   */
  rank: number | null;
  /**
   * The rating, published with its margin. Null only below the display floor.
   * A provisional player carries a number and `rank: null`.
   */
  rating: number | null;
  /** Always present when `rating` is: the margin is what qualifies the number. */
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  componentId: string | null;
  componentSize: number | null;
  regionLabel: string | null;
  /**
   * This player's position on the **pool's** board, or null.
   *
   * Only sent on a scene scope, where `rank` is the dense position inside the
   * scene and this is the one it was cut out of - "2nd in Peninsula, 37th in
   * the pool". Two numbers rather than one because they answer two questions
   * and a reader can check one against the other: the scene's order is a
   * restriction of the pool's, so these two columns can never disagree about
   * who is ahead of whom.
   *
   * It is the engine's own `rank` off the row it wrote, not a figure derived
   * here - the pool board is the thing it is a rank on, so re-deriving it from
   * a filtered read would be a second answer to a question already answered.
   * Null when the row earns no position, and null on every non-scene scope,
   * where `rank` already *is* the board's own position.
   */
  poolRank: number | null;
  /**
   * The scene this player's home store is in, denormalised onto the row by the
   * engine, and what a scene scope filters on.
   *
   * Null is the normal value, not a gap: a store that failed the engine's
   * intra-scene play-share gate is in no scene, and 2.6% of sampled production
   * profiles carry a region and no scene. A consumer must not fall back to
   * `regionLabel` here - that is a home city, a different one per member of
   * one scene, and the event page's roster column has already been caught
   * doing it.
   */
  sceneId: string | null;
  sceneLabel: string | null;
  /**
   * Is this row's scene big enough for a position inside it to mean anything?
   *
   * `isComparable(componentSize)`, decided here rather than in the UI, for the
   * same reason every other verdict is: the threshold is the engine's measured
   * one and a client re-deriving it would be guessing a constant.
   *
   * It is the field a mixed ladder needs, and it says less than its name
   * suggests, on purpose. It answers "is this player's own order real", not
   * "can this player be compared with the row above". **Nothing answers yes to
   * the second across two scenes.** A scene is a connected component of the
   * co-play graph, so a game between two scenes would merge them: measured on
   * the live corpus, **0 of 56,257 recorded games cross a scene** (800 of 800
   * same-scene in a stratified sample of 90 players' match logs, 777 opponents
   * resolved, zero exceptions), spread over 1,235 scenes. The engine's
   * `crossComponentUncertainty` is the model's own answer and it is not usable
   * as a caveat: it widens the margin by a median of **1.2 rating points**
   * (ratio 1.011), because the model pins a 4,654-player scene's mean level to
   * +-2.2 off the 1,200 prior. That is correct given the prior and the prior is
   * exactly the unverified part, so publishing it would read as "a cross-scene
   * comparison is 1% less certain", which is the opposite of true. The caveat
   * is therefore copy, said once, beside the scene label - not a number.
   */
  sceneComparable: boolean;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  gamesUntilRated: number;
}

export interface RankingCoverage {
  /** Players present in this scope, rated or not. */
  totalPlayers: number;
  ratedPlayers: number;
  provisionalPlayers: number;
  /** Games recorded across the players in this scope, when known. */
  totalGames: number | null;
  minGamesForRating: number;
  maxUncertaintyForRating: number;
  minComponentSize: number;
  /** Recorded games before a rating number is shown at all (the display floor). */
  minGamesToPublishRating: number;
  lastUpdated: string | null;
}

export interface ComponentSummary {
  componentId: string;
  regionLabel: string | null;
  componentSize: number | null;
  ratedPlayers: number;
  comparable: boolean;
}

/**
 * The header for a **scene** board: what the reader picked, and what the board
 * under it actually is.
 *
 * ## A scene board is a filter, not a fit
 *
 * Clicking `Peninsula` used to open `component:<the pool those players sit
 * in>`, and the pool's own `regionLabel` is a modal city name of a
 * reachability closure - so a San Francisco scene led to a board headed
 * `North West Community Development Council`, which is a Singapore CDC label.
 * Both halves were honest and the pair was indefensible.
 *
 * What makes the fix available without touching the model: every ladder row
 * already carries `sceneId`, so the scene's rows can be taken out of one
 * pool's board and re-ranked among themselves. Nothing is re-fitted, no
 * rating moves, `componentId` keeps its meaning exactly, and
 * `crossComponentUncertainty` is still only claimed for a connected component.
 * The scene's players are a **subset of one component**, so they were already
 * on one scale before the filter and still are after it - which is the
 * statistical difference between this and a cross-component board, where the
 * two scales are pinned only by the 1,200 prior.
 *
 * ## What is published, and why each field is here rather than derived
 *
 * `componentId` / `componentSize` / `componentCount` are the pool, read off the
 * engine's `SCENE#<sceneId>` item. They are **not** the scene's identity and a
 * caller must present them as a second fact, the way the event page's scene
 * line and the map's `sceneLadderNote` already do.
 */
export interface SceneBoardInfo {
  /** The id the request asked for, echoed even when nothing resolved. */
  sceneId: string;
  /**
   * The engine's own label for it - the match-weighted modal city of its
   * stores, or a curated override. Null when no store in it is geocoded yet,
   * in which case a caller falls back to `Scene <id>` rather than borrowing a
   * city from the pool.
   */
  label: string | null;
  /**
   * False when the engine has no `SCENE#<sceneId>` item for this id.
   *
   * **Not a 404**, on the same grounds as "Never seen is not absent" for a
   * player: this is also the state of every scene id for up to
   * `RANKING_REFIT_INTERVAL_HOURS` after a deploy whose engine has not
   * refitted, and of every id at all before an operator has accepted a
   * re-clustering. A shared `?scene=` link must not die for a deploy order.
   */
  known: boolean;
  /** Players whose **home** store is in this scene, rated or not, from the item. */
  playerCount: number | null;
  /** Of those, the ones the engine rated, from the item. */
  ratedPlayers: number | null;
  venueCount: number | null;
  /** The pool the board was filtered out of. Null when the scene has no pool. */
  componentId: string | null;
  componentSize: number | null;
  /**
   * Distinct pools this scene's home players sit in.
   *
   * 1 is the normal case and the one this board is clean for. **Over 1 means
   * the scene's players are not all on one rating scale**, which is a fact
   * about the pools rather than about the scene - an event's pairings connect
   * the players they pair rather than all of them, so a scene can straddle two
   * closures until a refit welds them. The board then holds the players in
   * `componentId` *only*, and `omittedPoolRows` says how many of the scene's
   * rated rows were left out of it. Comparability inside the board is
   * untouched; what is incomplete is its coverage of the scene, and those are
   * different claims.
   */
  componentCount: number;
  /** True when every one of the scene's players sits in `componentId`. */
  singlePool: boolean;
  /**
   * Rated rows of this scene that the board does **not** show, because they
   * sit in a different pool from `componentId`.
   *
   * 0 whenever `singlePool`. Published rather than merely implied by
   * `componentCount`, because "there are two pools" and "four players are
   * missing from this board" are what a reader needs in that order.
   */
  omittedPoolRows: number;
  /**
   * Whether a position on this board means anything: `isComparable` on the
   * **pool's** size, never on the scene's own `playerCount`.
   *
   * `CONFIDENCE.minComponentSize` measures the component and nothing here
   * changes that. A 3-store scene inside a 2,000-player pool orders fine; a
   * 40-player scene whose pool is 6 does not.
   */
  comparable: boolean;
  /** The stored board the rows came out of, for a caller that wants the pool. */
  poolScope: string | null;
  /** Rows of that board this request read, for the cost it reports. */
  poolRowsRead: number;
  /**
   * False when the pool's board was not read to its end
   * (`SCENE_BOARD_MAX_ROWS`), so rows below the cut are missing from the
   * scene board. `RankingCoverage.coverageComplete` carries the same verdict.
   */
  poolComplete: boolean;
}

// ---------------------------------------------------------------------------
// The scene map
// ---------------------------------------------------------------------------

/**
 * One venue pin under a scene.
 *
 * No name, deliberately: the engine's `COMPONENT#` item does not carry one
 * (see `ranking/items.ts`), and this API does not invent strings it was not
 * given. A reader zooming in gets the store's position and how much of the
 * scene's play happens there, which is what a pin is for.
 */
export interface SceneMapVenue {
  /** Null for a Riot organizer that never resolved to a shop row. */
  shopExternalId: number | null;
  latitude: number;
  longitude: number;
  matchCount: number;
}

/**
 * How far a scene's pin may sit from the nearest venue of that scene, km,
 * before this API stops publishing it as a location.
 *
 * **A centroid is arithmetic; a place is a claim.** Both are real, and for
 * most scenes they are the same thing - but for a scene spanning a continent
 * the match-weighted centre of its venues is open country or open sea, and
 * putting a pin there asserts that the scene is *somewhere it has never
 * played*. `spreadKm` does not separate those cases: a 448km spread centred on
 * Germany is a national scene whose centre has stores all around it, while a
 * 1,858km spread centred in the Gulf of Thailand is an Asia-Pacific scene
 * whose centre is water. The distance to the **nearest** venue does separate
 * them, and that is what this threshold is applied to.
 *
 * 100km is measured, not chosen. Distance from the centroid to the scene's own
 * nearest venue, over the 1,302 scenes of a 60-day production replay
 * (2026-10-27, 69,308 matches, 2,414 venues, every one of them geocoded):
 *
 * | pin to nearest venue | scenes | players | largest scene |
 * |---|---|---|---|
 * | 0-10 km | 1,211 | 15,168 | 191 |
 * | 10-25 km | 56 | 2,698 | 356 |
 * | 25-50 km | 11 | 892 | 259 |
 * | 50-100 km | 4 | 280 | 185 |
 * | **100-250 km** | 10 | 2,963 | 1,259 |
 * | **250-500 km** | 6 | 7,151 | 5,254 |
 * | **500+ km** | 4 | 2,741 | 2,138 |
 *
 * The gap is at 100: the band below it holds 4 scenes and the band above it
 * holds 10 with ten times the players. Below the line are scenes like a
 * 356-player one centred on Mannheim (65km spread, 13km to a store) and a
 * 259-player one centred near Roermond (131km spread, **26km** to a store) -
 * wide scenes whose centre is still a place. Above it are a 1,259-player scene
 * pinned 163km into central Germany, a 5,254-player one pinned 360km out in
 * the Gulf of Thailand, and a 2,138-player one pinned **2,080km** into the
 * Pacific.
 *
 * Note what the threshold costs, because it is not small: 20 scenes holding
 * **12,855 of 31,893 players (40%)** come off the map. They are not hidden -
 * they are listed, flagged, and their actual venues are drawn when one is
 * selected - but the map genuinely cannot show where they are, because there
 * is no one place where they are. That is the honest answer, and a pin in the
 * Pacific is not a better one.
 */
export const SCENE_CENTROID_MAX_KM = 100;

/**
 * Why the gate above still exists now that the map reads scenes.
 *
 * The whole distribution it was measured on is a distribution over **connected
 * components**, and the pathological entries in it - a pin 360km into the Gulf
 * of Thailand, one 2,080km into the Pacific - are pathological because a
 * component is a reachability closure with no geometric bound at all.
 *
 * A scene has one. The geographic clustering agglomerates only while a
 * cluster's **diameter** stays inside `--max-diameter` (30km), so every store in
 * a scene is within 30km of every other, and a weighted mean of points that are
 * all mutually within 30km lies within 30km of each of them. The centroid is
 * therefore at most ~30km from the scene's nearest own venue, against a 100km
 * gate: `dispersed` cannot be true for a scene produced at the default cap.
 * Measured on the 2026-10-31 production proposal, the largest scene extent in
 * the whole corpus is **29.9km**, and 0 of 1,432 scenes come anywhere near it.
 *
 * It is kept rather than deleted for two reasons. The cap is a **knob**
 * (`--max-diameter`), so an operator who raises it past 200km re-creates
 * exactly the failure the gate was measured for; and the Louvain method is
 * still the default for `--method`, and a Louvain community has no diameter
 * bound either. A gate that never fires is cheap; a pin in the Pacific is not.
 */
export const SCENE_CENTROID_GATE_NOTE =
  'A scene is diameter-capped, so its centroid is near its own stores by construction.';

/**
 * One scene on the map.
 *
 * **A scene, not a connected component.** It is a cluster of *stores* - close
 * enough together that their players really play each other - published by the
 * engine as `SCENE#<sceneId>` from an assignment an operator accepted. The
 * endpoint read the `COMPONENT#` catalogue before, which is a reachability
 * closure of the co-play graph: one travelling player welds two cities into one
 * permanently, so a Redwood City store sat in a 1,688-player component labelled
 * `New York, New York`. A scene is diameter-capped and cannot do that.
 *
 * A **located** scene (`latitude`/`longitude` non-null) is one whose venues
 * carried coordinates *and* whose centroid is near enough to one of them to be
 * a place (`SCENE_CENTROID_MAX_KM`). An **unlocated** one is not an error and
 * not a gap in the data model - it is a scene none of whose stores has been
 * geocoded, or one written by an engine that predates the place fields. The two
 * are served in separate lists (`SceneMapResult`) precisely so a caller cannot
 * render an unlocated scene by forgetting a null check.
 *
 * `dispersed` is kept and is expected to be **false for every scene** under the
 * default 30km diameter cap - see `SCENE_CENTROID_MAX_KM` for why the gate
 * cannot fire on a capped cluster, and why it stays anyway.
 *
 * Why there is no fallback coordinate: the honest answers available for an
 * unlocated scene are its label's city centre (a different and weaker precision
 * claim, and a Mapbox call per scene) or `0, 0` (a lie). Neither is published.
 * See `services/rankingService.ts`.
 */
export interface SceneMapEntry {
  /**
   * The engine's `sceneId`, and the id a `?scene=` link carries.
   *
   * **It is not a `componentId` and the two must never be swapped.** This
   * endpoint used to serve the component catalogue under this name, which is
   * why the map's list read `Karlsruhe, Deutschland` and `Paris, France` while
   * `Peninsula` and `South Bay` were not selectable anywhere on it.
   */
  sceneId: string;
  /**
   * What a local calls this scene, from the engine's assignment - the
   * match-weighted modal city of its stores, or a curated override. Null when
   * no store in it is geocoded yet.
   */
  label: string | null;
  /** Players whose **home** venue is in this scene, so scenes partition them. */
  playerCount: number;
  /** Of those, the ones whose rating clears the publishing bar. */
  ratedPlayers: number;
  matchCount: number;
  venueCount: number;
  /** How true "this store belongs to one scene" is, across the scene's stores. */
  medianPurity: number | null;
  /** True for the scene holding the most recorded players. */
  isGiant: boolean;

  /**
   * The rating pool this scene's players sit on, and nothing more.
   *
   * **`componentId` keeps its meaning permanently**, and that has not changed
   * now that a scene has a board: `crossComponentUncertainty` is only correct
   * for a connected component, so the pool is still the only thing that names
   * a rating scale. A `scene:<id>` scope is a **filter** over this pool's
   * board - the scene's own rows, re-ranked among themselves - not a fit of its
   * own, and nothing about the model moved to make it. See `SceneBoardInfo`.
   *
   * So this is the pool holding the largest share of the scene's home players,
   * and a caller names it as the pool rather than as the scene. The scene's pin
   * now links at the scene; this is the second link, "who else is on this
   * scale". The event page states the pair the same way: *this event was held
   * in the Peninsula scene*, and *these players' ratings are on one scale with
   * these others'*.
   *
   * Null for a scene none of whose home players has been replayed. That is a
   * normal state - the scene is still a fact about its stores, and its board
   * comes back named and empty rather than missing.
   */
  componentId: string | null;
  /** That pool's player count, which is what `comparable` is a statement about. */
  componentSize: number | null;
  /**
   * Distinct pools the scene's home players sit in. Over 1 means they are not
   * all on one rating scale, which is a fact about the pools, not the scene.
   */
  componentCount: number;
  /**
   * Whether a position on the **pool's** board means anything (`isComparable`).
   *
   * Read off `componentSize`, never off `playerCount`: it is the ladder's gate
   * and the ladder is the pool's. False with a null `componentId` as well -
   * there is no board at all then.
   */
  comparable: boolean;

  /** Match-weighted spherical centroid of the located venues, or null. */
  latitude: number | null;
  longitude: number | null;
  /**
   * Match-weighted mean distance from that centroid, km.
   *
   * Published beside the pin because a scene is not always a point: on the
   * measured California sample the largest community spread 133km, which is a
   * corridor. A map should draw this, not hide it.
   */
  spreadKm: number | null;
  /**
   * Distance from the centroid to this scene's nearest venue, km.
   *
   * Carried on a dispersed scene too - there it is the *reason* the scene has
   * no pin, and "the nearest store is 2,080 km away" is the one sentence that
   * explains it. Null only when there was no centroid to measure from.
   */
  nearestVenueKm: number | null;
  /**
   * True when a centroid exists but is too far from any of the scene's own
   * venues to be published as a location (`SCENE_CENTROID_MAX_KM`).
   *
   * Distinguishes the two reasons a scene is unlocated, which read completely
   * differently: `dispersed: false` means nothing about this scene has been
   * geocoded, and `dispersed: true` means the scene is real, well mapped, and
   * genuinely not in one place. A dispersed scene still carries `topVenues`,
   * so a map can draw where it actually plays.
   */
  dispersed: boolean;
  /** Venues the centroid was computed from, against `venueCount`. */
  locatedVenues: number;
  /** Matches at a located venue, against `matchCount`. */
  locatedMatches: number;
  topVenues: SceneMapVenue[];
}

/**
 * The whole map, in one answer.
 *
 * Split into located and unlocated rather than one list with nulls in it: the
 * map draws the first, the page accounts for the second, and neither has to
 * filter. `coverage` is what lets the page say *why* it is showing 40 pins for
 * 1,235 scenes instead of leaving the reader to infer it.
 */
export interface SceneMapResult {
  scenes: SceneMapEntry[];
  unlocated: SceneMapEntry[];
  coverage: SceneMapCoverage;
}

export interface SceneMapCoverage {
  /** Scenes in the engine's catalogue. */
  totalScenes: number;
  /**
   * Stores the engine replayed that are in **no** scene, and the players whose
   * home store is one of them.
   *
   * Not an error and not a rounding remainder: a geographic cluster is only
   * published as a scene when its players play each other enough to rank
   * anybody (the intra-scene play-share gate), and a store whose regulars only
   * ever play visitors fails it. Measured on the live assignment, 38 venues and
   * 172 of 39,390 players; on the 2026-10-31 proposal, 97 venues and 527 of
   * 63,951. They must **read**, not vanish: a reader who looks for Palo Alto
   * and finds nothing has been told the map lost it.
   *
   * Null when the reader cannot answer - an older engine that does not publish
   * the figure - which is a different thing from zero.
   */
  unassignedVenues: number | null;
  unassignedPlayers: number | null;
  /** Of those, the ones with a publishable pin. */
  locatedScenes: number;
  /**
   * Of the rest, the ones that have a centroid but are too dispersed to
   * publish it. Counted separately from the never-geocoded, because "we do not
   * know where this is" and "this is not in one place" are different answers.
   */
  dispersedScenes: number;
  /** Players and matches in located scenes, and in all of them. */
  locatedPlayers: number;
  totalPlayers: number;
  /** Scenes large enough for a position inside them to mean anything. */
  comparableScenes: number;
  minComponentSize: number;
  /** When the engine last wrote the catalogue, when it records it. */
  lastUpdated: string | null;
  /**
   * True when the catalogue could not be read at all - an engine that has
   * never refitted, or a store with no catalogue reader.
   *
   * Distinguishes "no scene is located" from "we cannot tell", which are
   * different answers and read differently on the page.
   */
  catalogueUnavailable: boolean;
}

/**
 * The one outcome vocabulary this API publishes, for a game or for a match.
 *
 * Lower case and English, deliberately not Riot's enum: upstream words are a
 * moving target and every endpoint that carries an outcome has to agree on one
 * of them. `/api/players/:id/matches` has always published these; since
 * `TournamentMatchSide.outcome` was normalised too (see
 * `models/tournament.ts`), there is exactly one spelling of a draw in this API.
 *
 * `unknown` means a word arrived that this list does not cover - never that
 * nothing arrived. An absent outcome is `null` at the field that carries it.
 */
export type GameOutcome = 'win' | 'loss' | 'draw' | 'unknown';
export type MatchOutcome = GameOutcome;

/**
 * Every upstream word measured or plausibly emitted, mapped onto the vocabulary
 * above. One table, consulted by both the ranking adapter and the tournament
 * service, so the two can never spell a draw differently.
 *
 * **Riot emits `TIE`, not `DRAW`.** Measured over 30 live captures
 * (722 matches / 1,444 sides): `WIN` 686, `LOSS` 686, `TIE` 72, `DRAW` **zero**.
 * Both are mapped, because the vocabulary that produced `TIE` can produce
 * `DRAW` next deploy and a renderer must not have to care.
 *
 * What is deliberately *not* here: `FORFEIT`, `DISQUALIFIED`, `NO_SHOW` and
 * friends. A forfeit is administratively a loss, but recording it as one would
 * be this API inventing a result it was not given - the same class of mistake
 * as mapping only `DRAW` was. Anything unlisted becomes `unknown` and travels
 * beside the verbatim upstream word, so it reads as "not recorded here" and is
 * diagnosable rather than silently wrong.
 */
const OUTCOME_WORDS: Record<string, GameOutcome> = {
  w: 'win', win: 'win', wins: 'win', won: 'win', victory: 'win', '1': 'win',
  l: 'loss', loss: 'loss', losses: 'loss', lose: 'loss', lost: 'loss', defeat: 'loss', '0': 'loss',
  d: 'draw', draw: 'draw', drawn: 'draw', tie: 'draw', tied: 'draw', ties: 'draw',
};

/**
 * One upstream outcome word (or flag, or 1/0) as this API's vocabulary.
 * Anything unrecognised is `unknown` - never guessed at, never dropped.
 */
export function normaliseOutcome(value: unknown): GameOutcome {
  if (typeof value === 'string') return OUTCOME_WORDS[value.trim().toLowerCase()] ?? 'unknown';
  if (typeof value === 'boolean') return value ? 'win' : 'loss';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return OUTCOME_WORDS[String(value)] ?? 'unknown';
  }
  return 'unknown';
}

export interface MatchGame {
  gameNumber: number;
  outcome: GameOutcome;
}

export interface PlayerMatch {
  matchId: string;
  /** Timestamp from the item's sort key - when the match was played. */
  playedAt: string;
  opponentId: string | null;
  opponentDisplayName: string | null;
  outcome: MatchOutcome;
  games: MatchGame[];
  eventExternalId: string | null;
  eventName: string | null;
  shopId: string | null;
  latitude: number | null;
  longitude: number | null;
  eventDate: string | null;
  tournamentType: string | null;
  setId: string | null;
}

export interface RatingPoint {
  date: string;
  rating: number;
  uncertainty: number | null;
  gamesPlayed: number | null;
}

export interface SetInfo {
  setId: string;
  name: string | null;
  /** null when no release date has been published for the set. */
  releaseDate: string | null;
  endDate: string | null;
  /** The rating engine has written at least one item under `set:<id>`. */
  hasRatingData: boolean;
}

// ---------------------------------------------------------------------------
// Query schemas (same Zod-validated pattern as EventQuerySchema)
// ---------------------------------------------------------------------------

const MAX_PAGE_LIMIT = 100;

const limitParam = (fallback: string) =>
  z
    .string()
    .transform(Number)
    .refine((n) => Number.isFinite(n) && n >= 1 && n <= MAX_PAGE_LIMIT, {
      message: `limit must be between 1 and ${MAX_PAGE_LIMIT}`,
    })
    .default(fallback);

/** Opaque, URL-safe pagination cursor. */
const cursorParam = z
  .string()
  .max(2048)
  .regex(/^[A-Za-z0-9+/=_.:#|-]*$/, 'malformed cursor')
  .optional();

const scopeParam = z.string().max(160).optional();

export const RankingQuerySchema = z.object({
  scope: scopeParam,
  limit: limitParam('25'),
  cursor: cursorParam,
});
export type RankingQuery = z.infer<typeof RankingQuerySchema>;

export const PlayerMatchesQuerySchema = z.object({
  limit: limitParam('25'),
  cursor: cursorParam,
  /** Optional: only matches from this set. */
  setId: z.string().max(64).optional(),
});
export type PlayerMatchesQuery = z.infer<typeof PlayerMatchesQuerySchema>;

export const PlayerRatingsQuerySchema = z.object({
  scope: scopeParam,
  limit: limitParam('100'),
});
export type PlayerRatingsQuery = z.infer<typeof PlayerRatingsQuerySchema>;

/**
 * The cap on one display-name search, and it is lower than every other
 * endpoint's on purpose.
 *
 * Search now compares the *whole* corpus instead of the 0.43% a capped Scan
 * reached, and that is a real change in what the endpoint exposes, so the
 * guard that was accidentally doing the work has to become a deliberate one.
 * The guard is this cap plus the **absence of a cursor**: there is no
 * pagination on this route, so the capped set is everything a caller can get
 * for a needle, however many times they ask.
 *
 * 25 rather than `MAX_PAGE_LIMIT`'s 100 because a person choosing a player
 * from a list does not scroll 100 names - and because with results now ranked
 * by match quality (`adapters/playerNameIndex.ts`) the best 25 are a better
 * answer than the arbitrary 100 the old cap would have allowed. `truncated`
 * and `matched` travel in the response, so a page says "showing 25 of 112,
 * keep typing" rather than silently cutting the list.
 *
 * Be clear about what this does and does not hold. It is not what keeps the
 * corpus from being enumerated - `/api/rankings` is cursor-paginated, and
 * 8,000 rated players' display names and tag lines came back from it in 80
 * public requests while this change was being measured. The rated half of the
 * corpus is already a bulk export and this cap was never the thing preventing
 * it. What the cap does hold is that *this* endpoint stays a lookup: it
 * answers "which players are called this", for a caller who already has a
 * name in mind, and it will not walk the corpus for one who does not.
 */
export const PLAYER_SEARCH_MAX_RESULTS = 25;

export const PlayerSearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'q must be at least 2 characters').max(64),
  limit: z
    .string()
    .transform(Number)
    .refine((n) => Number.isFinite(n) && n >= 1 && n <= PLAYER_SEARCH_MAX_RESULTS, {
      message: `limit must be between 1 and ${PLAYER_SEARCH_MAX_RESULTS}`,
    })
    .default('10'),
});
export type PlayerSearchQuery = z.infer<typeof PlayerSearchQuerySchema>;

/**
 * Player ids are Riot uuids in production. Accept the uuid shape plus the
 * fixture ids used in dev, but nothing that could escape a DynamoDB key.
 */
export const PLAYER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidPlayerId(id: string | undefined): boolean {
  return typeof id === 'string' && PLAYER_ID.test(id);
}
