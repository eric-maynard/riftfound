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
 * Everything the ranking API needs from storage. The DynamoDB adapter and the
 * fixture adapter implement it identically, so the app behaves the same before
 * and after the rating engine has written any data.
 */
export interface RankingStore {
  readonly kind: 'dynamodb' | 'fixture';

  getLeaderboard(scope: Scope, limit: number, cursor?: string): Promise<LeaderboardPage>;

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

/** One `SCENE#<sceneId>` item: the scene directory's own row. */
export interface SceneDirectoryEntry {
  sceneId: string;
  label: string | null;
  venueCount: number | null;
  /** Players whose **home** venue is in this scene, so scenes partition them. */
  playerCount: number | null;
  ratedCount: number | null;
  matchCount: number | null;
  medianPurity: number | null;
  /** When the **assignment** was made, which is not the refit time. */
  assignedAt: string | null;
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
