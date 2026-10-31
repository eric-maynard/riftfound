/**
 * Mirrors the ranking API's responses (see backend/src/models/ranking.ts).
 *
 * `provisional` / `provisionalReason` / `comparable` are derived by the API
 * from the contract's `gamesPlayed`, `uncertainty` and `componentSize`: the
 * rating engine stores no "publishable" flag, so the API works one out and
 * says why. The UI never shows a rating without showing that verdict.
 */

export type ProvisionalReason = 'too-few-games' | 'uncertainty-too-wide' | 'no-rating';

export type Scope = {
  raw: string;
  setId: string | null;
  componentId: string | null;
  /**
   * The scene a board is filtered down to, or null.
   *
   * Optional only for the deploy window: an API that predates the scene scope
   * does not send it, and a reader that treated its absence as a scope change
   * would be reading a field rather than the one it asked for.
   */
  sceneId?: string | null;
};

export interface SetRating {
  setId: string;
  setName: string | null;
  /** null when no release date has been published for the set (sets 1-3). */
  releaseDate: string | null;
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  /** This set's own figure - not the all-time one, which can differ. */
  gamesUntilRated: number;
}

export interface PlayerProfile {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  /**
   * Whether the rating engine has ever seen this player play.
   *
   * `/api/players/:id` used to 404 for `known: false` and now answers 200 with
   * every number null - a resource whose `/matches` and `/ratings` already
   * answered 200 is not absent, and such a player gets a real profile the
   * moment the engine sees them, so the 404 made a bookmarked URL dead and
   * then alive. This flag is how the page tells "never seen" from "not yet
   * rated"; it is optional only so the page still works if it is ever served
   * by an older deploy, where `hasNoRecord` reads the same fact off the
   * numbers.
   */
  known?: boolean;
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  componentId: string | null;
  componentSize: number | null;
  regionLabel: string | null;
  comparable: boolean;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  gamesUntilRated: number;
  setRatings: SetRating[];
}

export interface LeaderboardEntry {
  /**
   * Dense position among the rows that earn one, on **every** scope now -
   * Global included. The old rule suppressed the whole column whenever the
   * scope mixed scenes; see `GLOBAL_POSITION_HINT` in `lib/ranking.ts` for what
   * replaced it and why.
   */
  rank: number | null;
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  componentId: string | null;
  componentSize: number | null;
  regionLabel: string | null;
  /**
   * This player's position on the **pool's** board, on a scene scope only.
   *
   * `rank` there is the dense position inside the scene and this is the one it
   * was cut out of - "2nd in Peninsula, 37th in the pool". Two numbers rather
   * than one because the scene's order is a restriction of the pool's, so a
   * reader can check one against the other and they can never disagree about
   * who is ahead of whom. Null on every stored scope, where `rank` already
   * *is* the board's own position, and null for a row that holds no position.
   */
  poolRank?: number | null;
  /**
   * The scene this player's home store is in, from the engine's own row.
   *
   * Null is a normal value - a store in no rankable scene, or a player the
   * engine has never placed - and a consumer must **not** fall back to
   * `regionLabel`, which is a home city and a different one per member of one
   * scene. The event page's roster column has already been caught doing that.
   */
  sceneId?: string | null;
  sceneLabel?: string | null;
  /**
   * Is this row's scene big enough for a position inside it to mean anything?
   *
   * The API's verdict, not ours - the threshold is the engine's measured one.
   * Optional because an older API deploy does not send it, and a row without it
   * is read as comparable: the rank the same row carries is the stronger
   * signal, and inventing `false` would blank a column that deploy populates.
   *
   * It says only that the row's *own* order is real. It does not say the row
   * can be compared with the one above it in a mixed ladder - nothing does,
   * because no recorded game crosses a scene. See `GLOBAL_POSITION_HINT`.
   */
  sceneComparable?: boolean;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  gamesUntilRated: number;
}

export interface RankingCoverage {
  totalPlayers: number;
  ratedPlayers: number;
  provisionalPlayers: number;
  totalGames: number | null;
  minGamesForRating: number;
  maxUncertaintyForRating: number;
  minComponentSize: number;
  lastUpdated: string | null;
  coverageComplete: boolean;
}

export interface ComponentSummary {
  componentId: string;
  regionLabel: string | null;
  componentSize: number | null;
  ratedPlayers: number;
  comparable: boolean;
}

/**
 * The header of a **scene** board, on a `scene:<id>` scope only.
 *
 * It arrives beside `component` rather than instead of it, because the two are
 * the pair this section has always had to state as two facts: *this is the
 * Peninsula scene*, and *these players' ratings are on one scale with these
 * others'*. What changed is only which of the two a scene link lands on.
 *
 * The whole interface is optional on the response, because an API deployed
 * before it sends nothing - and a page that read a missing `scene` as "this
 * scene does not exist" would be worse than one that falls back to the pool.
 */
export interface SceneBoardInfo {
  sceneId: string;
  /** The engine's label, or null when no store in the scene is geocoded yet. */
  label: string | null;
  /**
   * False when the engine has no `SCENE#<id>` item for this id.
   *
   * Not an error: it is also the state of every scene id until a refit runs
   * with an accepted assignment, so a shared `?scene=` link survives a deploy
   * order rather than 404ing through it.
   */
  known: boolean;
  /** Players whose home store is in the scene, rated or not. */
  playerCount: number | null;
  ratedPlayers: number | null;
  venueCount: number | null;
  /** The pool the board was filtered out of. Null when the scene has none. */
  componentId: string | null;
  componentSize: number | null;
  /** Distinct pools the scene's players sit in; over 1 means the board is partial. */
  componentCount: number;
  singlePool: boolean;
  /** Rated rows of the scene that are in another pool and so not on this board. */
  omittedPoolRows: number;
  /** `isComparable` on the **pool's** size, never on the scene's own count. */
  comparable: boolean;
  poolScope: string | null;
  poolRowsRead: number;
  poolComplete: boolean;
}

export interface RankingsResponse {
  data: {
    scope: Scope;
    entries: LeaderboardEntry[];
    coverage: RankingCoverage;
    scene?: SceneBoardInfo | null;
    component: {
      componentId: string | null;
      componentSize: number | null;
      regionLabel: string | null;
      comparable: boolean;
    } | null;
    components: ComponentSummary[];
  };
  pagination: { limit: number; cursor: string | null; hasMore: boolean };
}

export type GameOutcome = 'win' | 'loss' | 'draw' | 'unknown';

export interface MatchGame {
  gameNumber: number;
  outcome: GameOutcome;
}

export interface PlayerMatch {
  matchId: string;
  playedAt: string;
  opponentId: string | null;
  opponentDisplayName: string | null;
  outcome: GameOutcome;
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

export interface PlayerMatchesResponse {
  data: PlayerMatch[];
  pagination: { limit: number; cursor: string | null; hasMore: boolean };
}

export interface RatingPoint {
  date: string;
  rating: number;
  uncertainty: number | null;
  gamesPlayed: number | null;
}

export interface RatingSeriesResponse {
  data: {
    scope: Scope;
    points: RatingPoint[];
    provisional: boolean;
    provisionalReason: ProvisionalReason | null;
    gamesUntilRated: number;
    /**
     * True when points were withheld because the rating is not published -
     * distinct from a player who simply has no history, which is identical on
     * the wire and wants different copy.
     */
    pointsWithheld: boolean;
    minGamesForRating: number;
    maxUncertaintyForRating: number;
  };
}

export interface PlayerProfileResponse {
  data: PlayerProfile;
}

export interface SetInfo {
  setId: string;
  name: string | null;
  releaseDate: string | null;
  endDate: string | null;
  hasRatingData: boolean;
}

export interface SetsResponse {
  data: SetInfo[];
}

export interface PlayerSearchHit {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  rating: number | null;
  gamesPlayed: number | null;
  regionLabel: string | null;
  provisional: boolean;
}

/**
 * What a search actually compared, so the page can tell "nobody by that name"
 * apart from "the index that would know is not published yet".
 *
 * The distinction is not hypothetical. Search was a capped table scan that
 * examined 0.43% of players, so this page printed "No player by that name."
 * over players it was simultaneously *listing on the ladder* - `illusionz` and
 * `tpcstld` both returned nothing while sitting on the live board. An empty
 * list had two meanings and the response carried no field that separated them.
 *
 * Optional because an older API deploy sends no `coverage` at all, and a
 * missing one is read as "complete" - the same deploy-order discipline as
 * `profile.known`.
 */
export interface PlayerSearchCoverage {
  complete: boolean;
  searchedPlayers: number | null;
  matched: number;
  truncated: boolean;
  maxResults: number;
}

export interface PlayerSearchResponse {
  data: PlayerSearchHit[];
  coverage?: PlayerSearchCoverage;
}

// --- The scene map ---------------------------------------------------------

/**
 * One venue pin under a scene. No name: the API does not carry one, because
 * the engine's `SCENE#` item does not (see scraper/src/ranking/items.ts).
 */
export interface SceneMapVenue {
  shopExternalId: number | null;
  latitude: number;
  longitude: number;
  matchCount: number;
}

/**
 * One scene on the map.
 *
 * **A scene, not a connected component.** It is a cluster of *stores* close
 * enough together that their players really play each other, named the way a
 * local names it - `Peninsula`, `South Bay`, `Nassau County`. The endpoint used
 * to serve connected components under these field names, which is why this page
 * listed `Karlsruhe, Deutschland` and `Paris, France` and could not select
 * `Peninsula` at all.
 *
 * A **located** scene has non-null coordinates derived from its own venues; an
 * unlocated one arrives in a separate list and is never drawn. Both are this
 * one type on purpose - the page lists both, and only the map cares which it
 * has - so the null coordinates stay typed rather than narrowed away.
 */
export interface SceneMapEntry {
  /** The engine's scene id. What `?scene=` carries. Never a `componentId`. */
  sceneId: string;
  /** What a local calls it. Null when no store in it is geocoded yet. */
  label: string | null;
  playerCount: number;
  ratedPlayers: number;
  matchCount: number;
  venueCount: number;
  /** How true "this store belongs to one scene" is, across the scene's stores. */
  medianPurity: number | null;
  /** True for the scene holding the most recorded players. */
  isGiant: boolean;
  /**
   * The rating **pool** this scene's players sit in - not the scene's board.
   *
   * `componentId` answers "are these two ratings on one scale" and nothing else
   * does. The scene's own board (`?scene=`, `scene:<id>`) is this pool's board
   * **filtered** to the scene and re-ranked, which is why the field keeps its
   * meaning exactly. The UI presents it as the pool - "see the whole rating
   * pool" - and never as the scene. Null when none of the scene's players has
   * been replayed; the scene's board is then named and empty.
   */
  componentId: string | null;
  /** That pool's player count - what `comparable` is a statement about. */
  componentSize: number | null;
  /** Pools the scene's players are spread over. Over 1 is not one scale. */
  componentCount: number;
  /** Whether a position on the **pool's** board means anything at all. */
  comparable: boolean;
  latitude: number | null;
  longitude: number | null;
  /** Match-weighted mean distance from the centroid, km. The pin's honesty. */
  spreadKm: number | null;
  /** Distance from the centroid to this scene's nearest venue, km. */
  nearestVenueKm: number | null;
  /**
   * True for a scene that has a centroid the API will not publish as a
   * location, because it is further from every one of the scene's own venues
   * than a place can be. It arrives in `unlocated` with null coordinates and
   * its `topVenues` intact, so the map can draw where it actually plays.
   */
  dispersed: boolean;
  locatedVenues: number;
  locatedMatches: number;
  topVenues: SceneMapVenue[];
}

export interface SceneMapCoverage {
  totalScenes: number;
  locatedScenes: number;
  /** Scenes with a centroid too far from their own venues to publish. */
  dispersedScenes: number;
  /**
   * Stores in no scene at all, and the players whose home store is one of
   * them. Null when the engine does not publish the figure, which is not zero.
   *
   * A list of scenes cannot express an absence: a store whose regulars only
   * ever play visitors fails the rankability gate and is simply not in the
   * directory. So the page prints the count rather than letting a reader
   * discover it by looking for their store and finding nothing.
   */
  unassignedVenues: number | null;
  unassignedPlayers: number | null;
  locatedPlayers: number;
  totalPlayers: number;
  comparableScenes: number;
  minComponentSize: number;
  lastUpdated: string | null;
  /**
   * True when the engine's catalogue could not be read at all, which is a
   * different thing from every scene being unlocated and reads as a different
   * sentence on the page.
   */
  catalogueUnavailable: boolean;
}

export interface SceneMapResponse {
  data: {
    scenes: SceneMapEntry[];
    unlocated: SceneMapEntry[];
    coverage: SceneMapCoverage;
  };
}
