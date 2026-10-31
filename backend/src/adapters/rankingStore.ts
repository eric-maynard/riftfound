import type { EngineVerdict, PlayerMatch, RatingPoint, Scope } from '../models/ranking.js';

/**
 * The storage-facing shape of a player profile: exactly the fields the data
 * contract promises on `PLAYER#<uuid>` / `SK: PROFILE`, with nothing derived.
 * Ranks and comparability are computed in the service layer so both the
 * DynamoDB adapter and the fixture adapter stay dumb.
 *
 * The confidence *verdict* is not derived here either - it is read off the item
 * when the engine wrote one (`EngineVerdict`) and only fabricated in the
 * service layer, from the numbers, when it did not.
 */
/** One set era as the rating engine recorded it. */
export interface SetCatalogueEntry {
  setId: string;
  name: string | null;
  releaseDate: string | null;
  endDate: string | null;
  /** The engine fitted ratings for this era; false for an era with no play yet. */
  hasRatingData: boolean;
}

export interface PlayerRecord extends EngineVerdict {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  componentId: string | null;
  componentSize: number | null;
  regionLabel: string | null;
  /**
   * The scene their **home venue** belongs to, and its name.
   *
   * Not `componentId` under another name, and not `regionLabel` either. A
   * component is a connected component of the co-play graph - 97.4% of players
   * sit in one - and `regionLabel` is this player's own home city, which
   * differs between members of one scene: measured on production, the five
   * Peninsula players at one Redwood City event carry `Redwood City, CA`,
   * `San Carlos, California` and `Sunnyvale, California` between them. A scene
   * is the engine's geographic cluster of stores, so it is the one of the
   * three that answers "which local scene is this player in".
   *
   * Null until a re-clustering has been accepted, and null afterwards for a
   * player whose home venue is in no rankable scene - measured 196 of 7,411
   * sampled profiles (2.6%), against 99.9% that carry a `regionLabel`. So
   * "has a region but no scene" is a normal state, not a failure, and nothing
   * may fall back from one to the other.
   */
  sceneId: string | null;
  sceneLabel: string | null;
  /** Flattened from the profile's per-set ratings map. */
  setRatings: SetRatingRecord[];
  updatedAt: string | null;
}

/** One set era's numbers, with that era's own verdict when the item carries it. */
export interface SetRatingRecord extends EngineVerdict {
  setId: string;
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  matchesPlayed: number | null;
}

/**
 * One row of a `RANKING#<scope>` leaderboard page. The contract names the item
 * but not its fields, so an entry may carry only a player id; the service
 * hydrates anything missing from the player's PROFILE.
 */
export interface LeaderboardRecord extends EngineVerdict {
  playerId: string;
  rank?: number | null;
  rating?: number | null;
  uncertainty?: number | null;
  gamesPlayed?: number | null;
  matchesPlayed?: number | null;
  displayName?: string | null;
  tagLine?: string | null;
  componentId?: string | null;
  componentSize?: number | null;
  regionLabel?: string | null;
  /**
   * The player's scene, as the engine denormalised it onto the row.
   *
   * This is what makes a scene board possible without a new partition:
   * `RankingRow.sceneId` exists in the engine's contract precisely "so a board
   * can be filtered without profile fetches". It was not being read here, so
   * the only way to the scene was through the pool.
   */
  sceneId?: string | null;
  sceneLabel?: string | null;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when the page is the last. */
  cursor: string | null;
}

/**
 * One display-name search, with the honesty about its own reach that the old
 * shape could not carry.
 *
 * `searchPlayers` used to return a bare array, and that is how it managed to
 * answer "no player by that name" for a rated player on the public
 * leaderboard: a capped Scan that had examined 0.43% of the corpus and a
 * complete search that found nothing returned the identical value, so neither
 * the API nor the page could tell them apart. Both numbers travel now, for the
 * same reason `coverage` travels beside a ladder page: a filtered list cannot
 * be read honestly without knowing what it was filtered from.
 */
export interface PlayerSearchResult {
  records: PlayerRecord[];
  /**
   * True when every player in the store was compared against the query.
   *
   * False means the store could not read its published name index and fell
   * back to a bounded sample - the state between deploying this and the
   * engine's next refit, and the state if the index read fails. A page is
   * expected to say so rather than present a partial answer as a complete one.
   */
  complete: boolean;
  /** Players compared against the query, or null when the store cannot say. */
  searchedPlayers: number | null;
  /** Matches before the cap, so a page can say "showing 25 of 112". */
  matched: number;
}

export interface LeaderboardPage extends Page<LeaderboardRecord> {
  /** When the engine last wrote this scope, when the item records it. */
  updatedAt: string | null;
  /** Total players in the scope, when the engine records it. */
  totalPlayers: number | null;
}

/**
 * One scene's rows, taken out of one pool's board.
 *
 * Not a `Page`: there is no cursor, because the whole pool partition has to be
 * read to answer at all (see `getSceneBoard`). The service paginates the
 * result in memory.
 */
export interface SceneBoardRead {
  /** The scene's rows, in the pool board's own order (rating-descending). */
  items: LeaderboardRecord[];
  /** The stored scope the rows came out of. */
  poolScope: string;
  /** Rows of that partition examined, which is what this read cost. */
  poolRowsRead: number;
  /** False when the cap stopped the read before the partition ended. */
  complete: boolean;
  /**
   * Rated rows carrying this `sceneId` that were dropped because their
   * `componentId` is not the pool's.
   *
   * Only ever non-zero when the rows came from a set-wide or global partition,
   * which holds every component - and only then for a scene whose players
   * straddle two pools. It is the number behind `SceneBoardInfo.componentCount
   * > 1`, and it is counted here because here is where those rows are seen.
   */
  omittedPoolRows: number;
  updatedAt: string | null;
}

/**
 * Everything the ranking API needs from storage. The DynamoDB adapter and the
 * fixture adapter implement it identically, so the app behaves the same before
 * and after the rating engine has written any data.
 */
export interface RankingStore {
  readonly kind: 'dynamodb' | 'fixture';

  getLeaderboard(scope: Scope, limit: number, cursor?: string): Promise<LeaderboardPage>;

  /**
   * One scene's rows, read out of one pool's stored board.
   *
   * ## Why this is not `getLeaderboard` with a filter argument
   *
   * Because the read is a different shape. A scene board cannot be served by a
   * `Limit`-ed Query with a `FilterExpression`, and that is not a performance
   * note - it is the same correctness bug this API has already shipped once.
   * **`Limit` caps the items examined *before* the filter, not the matches**,
   * which is exactly how name search came to answer "no player by that name"
   * for players on the ladder beside it (see "Searching for a player"). On a
   * board of ~6,000 rows in rank order, a `Limit` of 25 would return only the
   * scene members who happen to sit in the pool's top 25 - a board that is
   * silently the scene's best players and nobody else.
   *
   * So the whole partition is read, up to `maxRows`, and filtered. Two
   * consequences the implementation has to own:
   *
   * - **A DynamoDB `FilterExpression` would not help and would break a
   *   shape.** It saves no read units (capacity is charged on items read, not
   *   items returned), and `RANKING#<scope>` is allowed to be either one item
   *   per player *or* a page item holding an `entries` array - the second has
   *   no top-level `sceneId`, so `sceneId = :id` would discard a whole board.
   *   The filter is therefore in memory, over the expanded records.
   * - **`componentId` is part of the filter, not just `sceneId`.** When the
   *   rows come from a set-wide or global partition (the usual case: the
   *   engine writes at most 50 component ladders, so most pools have none), a
   *   multi-pool scene's rows would otherwise arrive from two components at
   *   once, which is the cross-scale board this whole design exists to avoid.
   *   Rows in another pool are counted into `omittedPoolRows` and dropped.
   *
   * Optional, like the catalogue readers, so a store written before this
   * degrades to "no scene board" rather than to a 500.
   */
  getSceneBoard?(
    poolScope: Scope,
    sceneId: string,
    componentId: string,
    maxRows: number
  ): Promise<SceneBoardRead>;

  getPlayer(playerId: string): Promise<PlayerRecord | null>;

  /** Batch profile lookup, used to hydrate sparse leaderboard rows. */
  getPlayers(playerIds: string[]): Promise<Map<string, PlayerRecord>>;

  getMatches(
    playerId: string,
    limit: number,
    cursor?: string,
    setId?: string
  ): Promise<Page<PlayerMatch>>;

  getRatingHistory(playerId: string, scope: Scope, limit: number): Promise<RatingPoint[]>;

  /** Display-name search. Deliberately capped: no bulk player export. */
  searchPlayers(query: string, limit: number): Promise<PlayerSearchResult>;

  /** Set ids the engine has actually written rating data for. */
  listSetIds(): Promise<string[]>;

  /**
   * The engine's own set catalogue, read from its `SET#<id>` items.
   *
   * These are authoritative - the engine derives set eras from release dates
   * and emits an item per era, including empty ones - so they beat the
   * hand-maintained table in `models/sets.ts`, which keys on names (`radiance`)
   * while the engine emits era ids (`s4`, `s5`) and so never matches.
   *
   * Optional, and allowed to come back empty: the items only became
   * enumerable once they carried GSI1 keys, so a store that predates that, or
   * a deployment whose engine has not refitted yet, falls back to discovery.
   */
  listSetCatalogue?(): Promise<SetCatalogueEntry[]>;

  /**
   * Connected components with rated players in them, for the region selector.
   * Derived from the players on the global list - the contract has no
   * component index item.
   */
  listComponents(): Promise<Map<string, { regionLabel: string | null; componentSize: number | null; ratedPlayers: number; totalPlayers: number }>>;

  /**
   * The engine's `COMPONENT#<id>` catalogue, in full, for the scene map.
   *
   * Deliberately **not** `listComponents`, which answers a different question
   * at a different cost: that one summarises the scenes represented on the
   * global leaderboard's first page, which is what a picker beside a ladder
   * wants. This is the whole catalogue - one Query on GSI1's `COMPONENT`
   * partition, 1,235 items on production - which is what a map of every scene
   * needs and which no page of a board can supply.
   *
   * Optional, and allowed to come back empty, exactly like
   * `listSetCatalogue`: those items only became enumerable once they carried
   * GSI1 keys, and the place fields on them are newer still. The service
   * reports "catalogue unavailable" rather than "no scene is located", because
   * those are different answers.
   */
  listSceneCatalogue?(): Promise<SceneCatalogueEntry[]>;

  /**
   * The engine's `SCENE#<sceneId>` catalogue, in full, for the map of scenes
   * and the scene picker.
   *
   * One Query on GSI1's `SCENE` partition, exactly as `listSceneCatalogue` is
   * one Query on the `COMPONENT` one - the items were given GSI1 keys at the
   * same time and for the same reason. **This is the one the map reads**, and
   * `listSceneCatalogue` is kept because `getComponent` shares its mapping and
   * the ladder still scopes on a component.
   *
   * Why the map moved off the component catalogue: a component is a
   * reachability closure of the co-play graph, so one travelling player welds
   * two cities into one permanently, and the measured result was a map whose
   * list read `Karlsruhe, Deutschland` and `Paris, France` while `Peninsula`
   * and `South Bay` - the names a reader was looking for - were not selectable
   * anywhere on it. A scene is a cluster of stores, capped at 30km, and its
   * label is the thing a local would say.
   *
   * Optional and allowed to come back empty, on the same terms as every other
   * catalogue reader here: a `SCENE#` item exists only once an operator has
   * accepted a re-clustering *and* a refit has run since, so an empty answer is
   * "nothing assigned yet" and a thrown Query is "cannot tell". The service
   * tells those apart; neither is a 500.
   */
  listSceneDirectory?(): Promise<SceneDirectoryEntry[]>;

  /**
   * What the engine's last refit left out of every scene.
   *
   * One GetItem on the scope directory the refit already writes, ~1 read unit,
   * and it answers the one question the scene catalogue structurally cannot:
   * **how much is in no scene at all.** The catalogue is a list of scenes, so a
   * store that failed the rankability gate is simply absent from it, and an
   * absence cannot be rendered. 38 venues and 172 players on the live
   * assignment - small, real, and the kind of figure a map has to print rather
   * than let a reader discover by looking for Palo Alto and finding nothing.
   *
   * Optional, and null is a legitimate answer meaning "this engine does not
   * publish the figure". The service carries that through as null in
   * `coverage`, which is not the same claim as zero.
   */
  getSceneCoverage?(): Promise<SceneCoverageCounts | null>;

  /**
   * One scene's catalogue item, by id, or null when there is none.
   *
   * The same items `listSceneCatalogue` enumerates, read one at a time - and
   * it exists because a caller that already *has* a component id should not
   * pay for the catalogue to find its name. The event page's scene line is
   * that caller: it works out which component an event's players are in from
   * the profiles the tournament endpoint already fetched, and then needs
   * exactly one thing it does not have, the component's **own** `regionLabel`.
   *
   * That label cannot be taken off a player. `PlayerRecord.regionLabel` is the
   * *player's* home region, so two members of one component carry different
   * ones - measured on the live board, `c2e62a47563` holds players labelled
   * `North West Community Development Council, 03` and `Central Singapore
   * Community Development Council, 01`. Naming a scene from whichever of its
   * members turned up at one event would give the same scene a different name
   * on every event page, and a different name again from the heading of the
   * ladder the line links to - two names for one scope, which this codebase
   * has already paid for once (`Everywhere` beside `All scenes`).
   *
   * Optional for the same reason `listSceneCatalogue` is: the `COMPONENT#`
   * items only became readable as a catalogue once they carried GSI1 keys, and
   * a store without them - or a GetItem that fails - must report "no label"
   * rather than take a page down. A null here is never an error.
   */
  getComponent?(componentId: string): Promise<SceneCatalogueEntry | null>;

  /**
   * One store's `VENUE#<shopExternalId>` item, or null when there is none.
   *
   * This is how an event page learns **which scene it is in**. The engine
   * assigns a scene to a *venue* - see `scraper/src/ranking/scenes.ts`, "a
   * scene belongs to the venue, not the player" - so a store carries the
   * answer directly and an event carries a `shopExternalId`. One GetItem.
   *
   * It replaced inferring the scene from the components of the players who
   * attended, which was wrong in a way a reader could see: a component is a
   * connected component of the co-play graph, one travelling player welds two
   * cities into one permanently, and the measured result was a 1,688-player
   * component labelled `New York, New York` whose five busiest venues were all
   * in California - so a shop in Redwood City read "Scene: New York, New
   * York". The venue's own scene cannot do that.
   *
   * Optional and allowed to come back null, exactly like `getComponent`. Null
   * is the **normal** value today: `VENUE#` items only exist once a refit has
   * run with venue publishing deployed, and `sceneId` on one is null until an
   * operator has accepted a re-clustering. Neither is an error and neither may
   * take a page down.
   */
  getVenue?(shopExternalId: number): Promise<VenueCatalogueEntry | null>;

  /**
   * One scene's `SCENE#<sceneId>` item: the scene's own size, not this event's.
   *
   * Read for the same reason `getComponent` is - a caller that already has the
   * id should not pay for a catalogue to find the counts - and read off the
   * **scene** rather than off any member, because a scene's size is a property
   * of the scene. Optional and nullable on the same terms.
   */
  getScene?(sceneId: string): Promise<SceneDirectoryEntry | null>;
}

/**
 * One `VENUE#<shopExternalId>` item, with nothing derived.
 *
 * Every field is nullable because null is the normal value for most of them:
 * `name` is null until the shop is reverse-geocoded, and the three scene
 * fields are null until a re-clustering has been accepted.
 */
export interface VenueCatalogueEntry {
  shopExternalId: number;
  /** The shop's city label, or null until reverse geocoding lands. */
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  players: number | null;
  ratedPlayers: number | null;
  matches: number | null;
  events: number | null;
  /** The scene this store belongs to. Null until an operator re-clusters. */
  sceneId: string | null;
  sceneLabel: string | null;
  /**
   * How true "this store belongs to one scene" is, as a share of the store's
   * play. A low number is a genuinely split store, not an error.
   */
  scenePurity: number | null;
  generatedAt: string | null;
}

/**
 * One `SCENE#<sceneId>` item: the scene directory's own row.
 *
 * The place fields are the same five `SceneCatalogueEntry` carries, written by
 * the same `scenePlace` derivation in the engine - a scene and a component are
 * different partitions of the same venue tallies, and the arithmetic does not
 * care which. All of them are nullable because **null is the normal value**: a
 * scene whose stores have never been geocoded has no centroid, and an item
 * written by an engine that predates the fields carries none.
 *
 * `componentId` / `componentSize` / `componentCount` are the **rating pool**
 * this scene's players sit on. They are not the scene's identity and must never
 * be read as it: only a connected component names a rating scale, so a
 * `scene:<id>` board is this pool's board *filtered* to the scene, and this is
 * the field that says which pool that is.
 */
/**
 * The corpus-level figures the scene catalogue cannot carry, off the engine's
 * scope directory. Both null-safe: an older refit wrote neither.
 */
export interface SceneCoverageCounts {
  unassignedVenues: number | null;
  unassignedPlayers: number | null;
  generatedAt: string | null;
}

export interface SceneDirectoryEntry {
  sceneId: string;
  label: string | null;
  venueCount: number | null;
  /** Players whose **home** venue is in this scene, so scenes partition them. */
  playerCount: number | null;
  ratedCount: number | null;
  matchCount: number | null;
  medianPurity: number | null;
  /**
   * Share of the scene's players' matches that are against other players in the
   * same scene, and whether the engine's own bar says that makes its ladder
   * meaningful.
   *
   * **Both null is "not measured", never "failed".** The engine used to *delete*
   * a scene below the bar - its venues came back with no scene at all - and it
   * publishes the figure instead, because a scene is a hand-drawn region now and
   * a boundary must not disappear because of a match count. See scraper
   * `ranking/scenes.ts`. An engine that predates the change sends neither.
   */
  intraShare: number | null;
  ladderMeaningful: boolean | null;
  /** When the **assignment** was made, which is not the refit time. */
  assignedAt: string | null;

  /** Match-weighted spherical centroid of the scene's located venues, or null. */
  latitude: number | null;
  longitude: number | null;
  /** Match-weighted mean distance from that centroid, km. */
  spreadKm: number | null;
  /** Distance from the centroid to the scene's nearest own venue, km. */
  nearestVenueKm: number | null;
  locatedVenues: number | null;
  locatedMatches: number | null;
  topVenues: SceneCatalogueVenue[];

  /** The connected component holding most of this scene's home players. */
  componentId: string | null;
  /** That component's player count, so a caller can say whether it orders. */
  componentSize: number | null;
  /** Distinct components the scene's home players are spread over. */
  componentCount: number | null;

  /** When the engine last wrote this item. Not `assignedAt`. */
  generatedAt: string | null;
}

/**
 * One `COMPONENT#<id>` item as stored, with nothing derived.
 *
 * The place fields are all nullable because **null is the normal value**: a
 * scene whose stores have never been geocoded has no centroid, and an item
 * written by an engine that predates the fields carries none. Comparability
 * and the located/unlocated split are decided in the service layer, so this
 * adapter stays dumb like the others.
 */
export interface SceneCatalogueEntry {
  componentId: string;
  regionLabel: string | null;
  componentSize: number | null;
  playerCount: number | null;
  ratedCount: number | null;
  matchCount: number | null;
  venueCount: number | null;
  isGiant: boolean;
  latitude: number | null;
  longitude: number | null;
  spreadKm: number | null;
  /** Distance from the centroid to the scene's nearest venue, km. */
  nearestVenueKm: number | null;
  locatedVenues: number | null;
  locatedMatches: number | null;
  topVenues: SceneCatalogueVenue[];
  generatedAt: string | null;
}

export interface SceneCatalogueVenue {
  shopExternalId: number | null;
  latitude: number;
  longitude: number;
  matchCount: number;
}
