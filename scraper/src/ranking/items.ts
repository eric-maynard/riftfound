/**
 * The derived items the rating pass writes.
 *
 * This is the **output contract** the backend API and the ranking UI are built
 * against. Changing a field name here breaks a reader this repository does not
 * contain, so additions are safe and renames are not. The attribute spellings
 * below are the ones the API adapter looks for first:
 *
 * | item | PK | SK |
 * |---|---|---|
 * | player profile | `PLAYER#<uuid>` | `PROFILE` |
 * | rating history point | `PLAYER#<uuid>` | `RATING#<scope>#<YYYY-MM-DD>` |
 * | match log entry | `PLAYER#<uuid>` | `MATCH#<iso>#<matchId>` |
 * | leaderboard row | `RANKING#<scope>` | `RANK#<rank, 6 digits>#<playerId>` |
 * | leaderboard header | `RANKING_META#<scope>` | `PROFILE` |
 * | component profile | `COMPONENT#<id>` | `PROFILE` |
 * | set profile | `SET#<id>` | `PROFILE` |
 * | venue profile | `VENUE#<shopExternalId>` | `PROFILE` |
 * | scene profile | `SCENE#<sceneId>` | `PROFILE` |
 *
 * A leaderboard is **one item per player**, not a page of entries, so an
 * SK-ascending Query on `RANKING#<scope>` returns rank order directly with no
 * client-side sort. The rank is zero-padded to six digits for exactly that
 * reason - lexicographic ordering would otherwise put rank 10 before rank 2.
 * The board's header lives under its own partition (`RANKING_META#<scope>`)
 * rather than as a `META` row inside the board, so a reader Querying the board
 * never has to filter a non-player item out of the results.
 *
 * Every rating in these items is on the published Elo-like scale (prior mean
 * `RANKING_ELO_ORIGIN`, 1200 by default, 400/ln 10 points per logistic unit -
 * the anchor is a display offset and a stored item carries whatever anchor the
 * refit that wrote it used), never in the solver's natural
 * units, and `uncertainty` is on that same scale so it renders as `+/- N`. The
 * solver's native log-odds SD is kept alongside as `uncertaintyLogOdds` for
 * anyone who needs it.
 *
 * Types live here rather than in database.ts so that `ranking/` depends on the
 * storage layer and not the other way round: database.ts and dynamodb.ts
 * `import type` from this module, which imports nothing from them.
 */

/**
 * Bumped when the *shape* of a per-player match log entry changes.
 *
 * The match log is written once per event and then never revisited, so the
 * version is what forces a rewrite: a stored marker carrying an older version
 * makes the pass re-emit that event's entries.
 */
export const MATCH_LOG_VERSION = 2;

/** Bumped when the model changes enough that stored ratings are not comparable. */
export const MODEL_VERSION = 'whr-1';

export type MatchOutcome = 'win' | 'loss' | 'draw';
export type GameOutcome = 'win' | 'loss';

/**
 * Why a rating is not published.
 *
 * Reported in priority order, most actionable first: a player short of games
 * can act on it (`gamesUntilRated` says how many), one whose record is
 * uninformative cannot, and one in a tiny isolated scene has a *comparison*
 * problem rather than an evidence problem.
 */
export type ProvisionalReason = 'too-few-games' | 'too-uncertain' | 'component-too-small';

/** One scope's rating for a player. Used for the per-set map. */
export interface ScopedRating {
  /** `all`, or `set:<eraId>`. */
  scope: string;
  /** Set era id, or null for the all-time scope. */
  setEraId: string | null;
  label: string;
  /** Null when this scope's evidence is below the publishing bar. */
  rating: number | null;
  /** Posterior SD in rating points. Always present, even when `rating` is null. */
  uncertainty: number;
  /** Uncertainty that applies when comparing across components. See the profile. */
  crossComponentUncertainty: number;
  gamesPlayed: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  /** True when `rating` is published. */
  rated: boolean;
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  gamesUntilRated: number | null;
  /** Rating the fit actually produced, published or not. */
  provisionalRating: number;
}

export interface PlayerProfile {
  /** Riot's stable account UUID. The only identity key. */
  playerId: string;
  /** Mutable presentation data, most recent value seen. Never an identity key. */
  displayName: string | null;
  tagLine: string | null;

  /** All-time rating in rating points, or null when below the publishing bar. */
  rating: number | null;
  provisionalRating: number;
  /**
   * Posterior SD in rating points, from the fit's own Hessian.
   *
   * This is the uncertainty of a comparison *inside* the player's component. It
   * conditions on opponents' ratings being known, so it is a lower bound.
   */
  uncertainty: number;
  /** The same quantity in the solver's native log-odds units. */
  uncertaintyLogOdds: number;
  /**
   * Uncertainty of a comparison *across* components.
   *
   * A component's overall level is only known to about priorSigma/sqrt(size),
   * because nothing ties it to the rest of the population. Combined in
   * quadrature with `uncertainty`, this is the number a cross-region comparison
   * has to live with - and for a small isolated scene it is large on purpose.
   */
  crossComponentUncertainty: number;
  rated: boolean;

  /**
   * The confidence verdict, decided here rather than in the UI.
   *
   * The thresholds that produce it are measured from the posterior SD
   * distribution (see ranking/snapshot.ts) and travel with the item, so the
   * ranking UX is governed by the data rather than by a constant guessed in the
   * frontend.
   */
  provisional: boolean;
  provisionalReason: ProvisionalReason | null;
  /** Games still needed to clear the game-count bar, or null if that is not what blocks it. */
  gamesUntilRated: number | null;

  gamesPlayed: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  draws: number;

  /** Earliest evidence (a dated registration, else the first event). ISO. */
  firstSeen: string;
  lastSeen: string;

  /**
   * Connected component of the all-time co-play graph.
   *
   * Always present on a stored profile: a profile is only written for a player
   * with at least one match, and a match puts them in a component.
   */
  componentId: string;
  componentSize: number;
  /** This component's share of all players with matches - the connectivity signal. */
  componentShare: number;
  /** True when the player sits in the largest component. */
  inGiantComponent: boolean;

  /** Human-readable home region, from the venue they play at most. */
  regionLabel: string | null;
  venueCount: number;
  homeVenueId: number | null;

  /**
   * The scene their home venue belongs to, or null until an operator has run a
   * re-clustering (see ranking/scenes.ts).
   *
   * **Not** `componentId` under another name. A component answers "are these
   * two ratings on the same scale" and is 97.4% one blob; a scene is a Louvain
   * community of the co-play graph, persisted between deliberate
   * re-clusterings so the label does not move under a reader. A player's scene
   * is their home venue's scene, which is well defined because venue -> scene
   * is nearly a function (median 99.3% of a venue's play in one scene).
   */
  sceneId: string | null;
  sceneLabel: string | null;

  /** Per-set ratings, keyed by set era id (the `<id>` in `set:<id>`). */
  setRatings: Record<string, ScopedRating>;

  generatedAt: string;
  modelVersion: string;
  /** The bar this verdict was produced with, so a reader can explain it. */
  thresholds: RatingThresholds;
}

/** The publishing bar, carried on the items it decided. */
export interface RatingThresholds {
  minGames: number;
  maxUncertainty: number;
  minComponentSize: number;
}

export interface PlayerRatingPoint {
  playerId: string;
  /** `all` or `set:<eraId>`. */
  scope: string;
  /** `YYYY-MM-DD`, the UTC day of the events that produced this point. */
  date: string;
  rating: number;
  uncertainty: number;
  /** Cumulative within the scope, up to and including this day. */
  matchesPlayed: number;
  gamesPlayed: number;
}

export interface PlayerMatchLogEntry {
  playerId: string;
  matchId: string;
  /** Event start, ISO. Part of the sort key, so the log reads chronologically. */
  playedAt: string;
  opponentId: string;
  /** Denormalised on purpose: the per-player page must not fan out to profiles. */
  opponentDisplayName: string | null;
  opponentTagLine: string | null;
  result: MatchOutcome;
  /** Per-game outcomes from this player's point of view. */
  gameOutcomes: GameOutcome[];
  gameWins: number;
  gameLosses: number;
  eventExternalId: string;
  eventName: string | null;
  /** Riot's `tournamentType`. */
  tournamentType: string | null;
  shopExternalId: number | null;
  latitude: number | null;
  longitude: number | null;
  /** `YYYY-MM-DD` UTC. */
  eventDate: string;
  /** Set era id this event falls in, or null when the set table has no boundary. */
  setId: string | null;
}

/** One player's row on one leaderboard. */
export interface RankingRow {
  scope: string;
  /** 1-based, within the scope. */
  rank: number;
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  rating: number;
  uncertainty: number;
  crossComponentUncertainty: number;
  gamesPlayed: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  componentId: string;
  componentSize: number;
  regionLabel: string | null;
  /** The player's scene, denormalised so a board can be filtered without profile fetches. */
  sceneId: string | null;
  sceneLabel: string | null;
  /**
   * True when this row's rank should not be shown as a position.
   *
   * Set for a component too small for a position to mean anything. The row is
   * still published - the player exists and has a rating - but the UI is told
   * not to present it as "Nth in the world".
   */
  suppressPosition: boolean;
}

export type RankingScopeKind = 'all' | 'set' | 'component' | 'set-component';

/**
 * The header item for a scope: what the ladder is, how big, and how much it can
 * be trusted.
 *
 * The quality fields are not decoration. A `component` ladder with
 * `componentShare` of 0.4% is a local scene's internal order and nothing more,
 * and the UI needs to be able to say so.
 */
export interface RankingMeta {
  scope: string;
  label: string;
  kind: RankingScopeKind;
  setEraId: string | null;
  /** True when the set era covers more than one set because Riot never published the boundary. */
  setAmbiguous: boolean;
  componentId: string | null;
  ratedPlayers: number;
  /** Players with at least one match in this scope, rated or not. */
  totalPlayers: number;
  /** Share of all players-with-matches sitting in the largest component. */
  giantComponentShare: number;
  componentSize: number | null;
  componentShare: number | null;
  regionLabel: string | null;
  /** True when ranks on this board are not meaningful as global positions. */
  positionsSuppressed: boolean;
  thresholds: RatingThresholds;
  generatedAt: string;
  modelVersion: string;
}

/**
 * One venue as a map pin: a position and a weight, and no free text.
 *
 * Deliberately carries **no name**. The scene's `regionLabel` is the label a
 * map draws, and a venue name here would add a second free-text surface to an
 * item that currently has exactly one - for a string no pin shows.
 */
export interface SceneMapVenue {
  /** Null for a Riot organizer that never resolved to a shop row. */
  shopExternalId: number | null;
  latitude: number;
  longitude: number;
  /** Matches of this scene played at this venue. */
  matchCount: number;
}

/**
 * Where a scene is.
 *
 * A component has no coordinates of its own - it is a set of players, and a
 * player is not a location - so this is derived from the venues its matches
 * were played at, weighted by how much play each carries. The derivation, and
 * the three cases in which it publishes nothing rather than guessing, are in
 * `ranking/sceneMap.ts`.
 *
 * **Null is the normal value, not a failure.** Every one of these fields is
 * absent on an item written before this shipped, and a scene whose venues
 * carry no geocode is unlocated for good. Nothing may treat that as an error
 * and nothing may fall back to a region label's city, to the first venue with
 * a geocode, or to `0, 0`.
 */
export interface ScenePlace {
  /** Match-weighted spherical centroid of the located venues, or null. */
  latitude: number | null;
  longitude: number | null;
  /**
   * Match-weighted mean great-circle distance from the centroid, km, to one
   * decimal. 0 for a single-venue scene; null when there is no centroid.
   *
   * It is what keeps a single pin honest. On the complete California sample
   * the largest community had a 133km mean venue spread - a corridor, not a
   * city - and a map that drew that as a dot would be asserting a precision
   * the scene does not have.
   *
   * A mean and not a maximum, so one travelling player's away-game cannot
   * inflate a city scene into a region.
   */
  spreadKm: number | null;
  /** Venues with coordinates. Read against `venueCount`: the ratio is the caveat. */
  locatedVenues: number;
  /** Matches played at a located venue. Read against `matchCount`. */
  locatedMatches: number;
  /** The busiest venues, descending, capped at `RANKING_SCENE_MAP_TOP_VENUES`. */
  topVenues: SceneMapVenue[];
}

/**
 * One connected component of the co-play graph, as its own item.
 *
 * Exists so the region selector is one Query instead of a scan over the global
 * board. `componentSize` and `playerCount` are the same number - the count of
 * players with at least one match in the component - under both names the API
 * looks for.
 *
 * **It also carries the component's place**, via `ScenePlace`, which is what
 * makes a map of scenes one Query rather than an unaffordable join. The
 * reasoning is in `ranking/sceneMap.ts`; the short version is that a component
 * has no coordinates of its own, the coordinates live on the match facts
 * keyed by *player*, and the only place the two are in the same hand is the
 * replay that produced this item. Published as part of this item rather than
 * as a new one because a map's first render is "every scene with a pin", and
 * this catalogue is already the one Query that answers "every scene".
 */
export interface ComponentProfile extends ScenePlace {
  componentId: string;
  componentSize: number;
  playerCount: number;
  ratedCount: number;
  regionLabel: string | null;
  /** Share of all players-with-matches in this component. */
  componentShare: number;
  matchCount: number;
  venueCount: number;
  isGiant: boolean;
  /** True when ranks inside this component are not published as positions. */
  positionsSuppressed: boolean;
  generatedAt: string;
}

/**
 * One set era, as its own item, so `/api/sets` does not have to infer the set
 * list from players' rating maps.
 *
 * `releaseDate` is nullable because Riot never published English street dates
 * for sets 2 and 3 - see ranking/sets.ts. An era that covers more than one set
 * because of that says so (`ambiguous`, `setIds`) rather than claiming to be a
 * single set.
 */
export interface SetProfile {
  setId: string;
  name: string;
  /** `YYYY-MM-DD`, or null when Riot never published one. */
  releaseDate: string | null;
  /** Exclusive end of the era, or null for the current one. */
  endDate: string | null;
  ambiguous: boolean;
  /** Riot set numbers this era covers. More than one means the boundary is unknown. */
  setIds: string[];
  /** Citation for the release date. An uncited date would be a guess. */
  source: string;
  matchCount: number;
  ratedCount: number;
  /** False when the era had too little data to fit at all. */
  fitted: boolean;
  generatedAt: string;
}

/** One player on a venue's denormalised roster. */
export interface VenueRosterEntry {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  /** Matches this player has played at this venue. The ordering key. */
  matches: number;
  /** Published rating, or null when the player is below the publishing bar. */
  rating: number | null;
  rated: boolean;
}

/**
 * One store, as its own item: what a per-venue page and a map pin need.
 *
 * Keyed on `shopExternalId` and nothing else. `venueKey`'s `geo:` fallback -
 * coordinates rounded to ~1km for an organizer that never resolved to a shop -
 * is right for a graph node and wrong for a durable key, because the id would
 * move if the geocode moved. So a venue item exists only for a real shop id,
 * and unresolved organizers stay off the map until `shopMatch.ts` resolves
 * them. Measured on the California sample: 390 of 390 venues had both a shop
 * id and coordinates, so this excludes nothing real.
 *
 * `GSI1PK: 'VENUE'` makes the whole catalogue one Query, which is the first
 * thing a map renders. That key is the lesson `SET#` and `COMPONENT#` had to
 * learn the hard way: without it the items can only be fetched by an id the
 * reader already has, and `/api/sets` was caught inferring set ids from player
 * profiles because of it.
 */
export interface VenueProfile {
  /** `shop:<externalId>`, the graph's own key, for joining to other reports. */
  venue: string;
  shopExternalId: number;
  /** From the shops table: the city label, or null until reverse geocoding lands. */
  name: string | null;
  /**
   * Mean of the coordinates of this venue's events.
   *
   * A store does not move, but the two sources geocode it ~20m apart, so the
   * mean is the stable answer rather than whichever event was read last.
   */
  latitude: number | null;
  longitude: number | null;

  /** Distinct players with at least one match here. */
  players: number;
  /** Of those, how many clear the publishing bar. */
  ratedPlayers: number;
  matches: number;
  events: number;
  /** ISO, from the earliest and latest event played here. */
  firstSeen: string;
  lastSeen: string;

  /**
   * The scene this store belongs to, from the persisted assignment, and how
   * true that is.
   *
   * `scenePurity` is the share of the venue's player-match participations that
   * sat in the scene's community at clustering time - median 99.3% on the
   * California sample, p10 76%. A single dominant id plus a purity number is
   * an honest summary of a store's scene, not a lossy one. Both are null until
   * an operator has run a re-clustering.
   */
  sceneId: string | null;
  sceneLabel: string | null;
  scenePurity: number | null;

  /**
   * Who plays here, capped and ordered by matches played at this venue.
   *
   * Denormalised deliberately. The alternative - one `VENUE#<id>` /
   * `PLAYER#<id>` row per pair - is 12,885 items regionally and would be the
   * first per-relationship item this pass writes, for a list a map drill-down
   * truncates anyway. A venue has 22 players at the median and 209 at the
   * maximum, so a cap of `RANKING_VENUE_TOP_PLAYERS` covers the median venue
   * outright and the rest are the long tail of one-night attendees.
   */
  topPlayers: VenueRosterEntry[];
  /** True when `topPlayers` was cut short, so a reader can say "and N others". */
  topPlayersTruncated: boolean;

  generatedAt: string;
}

/**
 * One scene, as its own item, so a scene selector is one Query.
 *
 * A scene is a Louvain community of the co-play graph, **persisted** between
 * deliberate re-clusterings rather than recomputed every refit - see
 * ranking/scenes.ts for why that is the only shippable form. The counts here
 * are recomputed on every refit from the stored assignment; the membership is
 * not.
 */
export interface SceneProfile {
  sceneId: string;
  /** Modal city label of its venues, or null when none is geocoded yet. */
  label: string | null;
  venueCount: number;
  /** Distinct players whose home venue is in this scene. */
  playerCount: number;
  ratedCount: number;
  matchCount: number;
  /** Median purity of this scene's venue assignments. */
  medianPurity: number;
  /** When the assignment that defines this scene was made. Not the refit time. */
  assignedAt: string;
  generatedAt: string;
}

/** Bookkeeping for one event's match-log emission. Makes the log idempotent. */
export interface MatchLogMarker {
  eventExternalId: string;
  version: number;
  entries: number;
  writtenAt: string;
}

/** Everything one refit produced, ready to be stored. */
export interface RankingSnapshot {
  profiles: PlayerProfile[];
  history: PlayerRatingPoint[];
  matchLog: PlayerMatchLogEntry[];
  matchLogEvents: string[];
  rankings: RankingRow[];
  metas: RankingMeta[];
  components: ComponentProfile[];
  sets: SetProfile[];
  venues: VenueProfile[];
  scenes: SceneProfile[];
}
