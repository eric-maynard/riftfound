import type { EventResultsStatus, RosterSource } from '../models/tournament.js';

/**
 * The storage-facing shape of the scraper's tournament facts: exactly the
 * attributes the `RESULTS#<externalId>` and `ROSTER#<externalId>` items carry,
 * with nothing derived and nothing joined. The rating enrichment, the
 * team -> player join and the strength-of-field aggregate all happen in the
 * service layer, so both adapters stay dumb.
 *
 * Nothing here writes. These items are immutable captures owned by the
 * scraper; the API is a reader.
 */

/** Event context denormalised onto every fact (see `EventFactContext`). */
export interface FactContextRecord {
  externalId: string;
  tournamentId: string | null;
  eventStartDate: string | null;
  eventType: string | null;
  playFormat: string | null;
  shopExternalId: number | null;
  latitude: number | null;
  longitude: number | null;
}

/** `esportsTeamId` -> the player behind it. In 1v1 a "team" is one player. */
export interface ResultPlayerRecord {
  teamId: string;
  playerId: string | null;
  displayName: string | null;
  tagLine: string | null;
}

export interface ResultStandingRecord {
  rank: number;
  teamId: string;
  matchPoints: number | null;
  matchWins: number | null;
  matchLosses: number | null;
  matchDraws: number | null;
  opponentMatchWinPct: number | null;
  gameWinPct: number | null;
  opponentGameWinPct: number | null;
}

export interface ResultMatchSideRecord {
  teamId: string;
  outcome: string | null;
  gameWins: number;
}

export interface ResultGameRecord {
  number: number;
  winnerTeamId: string | null;
}

export interface ResultMatchRecord {
  matchId: string;
  tableNumber: number | null;
  status: string | null;
  bye: boolean;
  sides: ResultMatchSideRecord[];
  games: ResultGameRecord[];
}

export interface ResultRoundRecord {
  section: number;
  roundNumber: number;
  status: string | null;
  byeTeamIds: string[];
  matches: ResultMatchRecord[];
}

export interface EventResultsRecord extends FactContextRecord {
  status: EventResultsStatus;
  roundCount: number;
  playerCount: number;
  openMatches: number;
  trimmed: boolean;
  sourceUpdatedAt: string | null;
  capturedAt: string | null;
  players: ResultPlayerRecord[];
  standings: ResultStandingRecord[];
  rounds: ResultRoundRecord[];
}

export interface RosterEntryRecord {
  playerId: string;
  displayName: string | null;
  tagLine: string | null;
  teamId: string | null;
  status: string | null;
  checkedIn: boolean | null;
  waitlistPosition: number | null;
  registeredAt: string | null;
}

export interface EventRosterRecord extends FactContextRecord {
  source: RosterSource;
  playerCount: number;
  capturedAt: string | null;
  entries: RosterEntryRecord[];
}

/**
 * The metadata half of a fact row: what a day list needs to decide whether to
 * offer a trophy, and nothing else. The DynamoDB adapter reads it with a
 * projection, so answering for 50 events costs a few RCUs rather than
 * megabytes of standings.
 */
export interface FactAvailabilityRecord {
  hasResults: boolean;
  resultsStatus: EventResultsStatus | null;
  hasRoster: boolean;
  playerCount: number | null;
}

export interface TournamentStore {
  readonly kind: 'dynamodb' | 'fixture';

  /** One GetItem. Null when the event has no results capture. */
  getResults(externalId: string): Promise<EventResultsRecord | null>;

  /** One GetItem. Null when the event has no roster capture. */
  getRoster(externalId: string): Promise<EventRosterRecord | null>;

  /**
   * One BatchGet over both fact keys of every id, projected down to the
   * metadata. Every requested id comes back, so a caller never has to
   * distinguish "absent" from "nothing there".
   */
  getAvailability(externalIds: string[]): Promise<Map<string, FactAvailabilityRecord>>;
}
