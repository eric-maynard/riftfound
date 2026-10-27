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
  searchPlayers(query: string, limit: number): Promise<PlayerRecord[]>;

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
