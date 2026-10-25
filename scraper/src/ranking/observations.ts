/**
 * Stored tournament facts -> paired comparisons.
 *
 * This is the only place that interprets Riot's result shape, and it is
 * deliberately paranoid about three things:
 *
 * 1. **Byes never become games.** `playriftboundResults.ts` already filters
 *    Riot's synthetic `bye-` ids on the way in, but that is an upstream promise,
 *    not a property of the data in the table, and a rated player called "BYE"
 *    with a 40-0 record would be the most visible possible failure. So every
 *    match and every team id is re-checked here and the count of anything that
 *    slipped through is reported (`byeLeaks`) rather than quietly dropped.
 * 2. **Identity is `player.id`.** `displayName`/`tagLine` are carried along for
 *    presentation only; the index is keyed on the UUID. A `teamId` with no
 *    player behind it is skipped, not invented.
 * 3. **Compactness.** The full history is held in memory inside a Lambda, so
 *    matches live in flat typed arrays with integer player/event indices rather
 *    than as objects. ~600k matches is ~50MB this way.
 *
 * Observation level is configurable. A Bo3 match yields 2-3 games, so games give
 * roughly 2-3x the observations - but games inside one match share the players,
 * the decks and the hour, so they are *not* independent. Treating them as such
 * would overstate confidence. The compromise, measured rather than assumed (see
 * the accuracy numbers in scraper/CLAUDE.md), is to use game-level observations
 * at a weight below 1 so one match contributes about one match's worth of
 * information while still carrying the margin.
 */

import type { EventResults, EventRoster, ResultMatch } from '../database.js';
import { DEFAULT_PRERELEASE_OPTIONS, eraForEvent, utcDate, type PrereleaseOptions, type SetEra } from './sets.js';

/** Riot's synthetic bye prefix. Mirrors BYE_ID_PREFIX in the results source. */
const BYE_ID_PREFIX = 'bye-';

/** Outcome of a match from side A's point of view. */
export const enum MatchResult {
  Draw = 0,
  AWin = 1,
  BWin = 2,
}

/** Per-event context the match log needs, stored once per event. */
export interface ObservedEvent {
  externalId: string;
  /** Resolved from the events table when the row still exists; facts carry no name. */
  name: string | null;
  startDate: Date;
  /** Riot's `tournamentType`, as stored on the fact row. */
  tournamentType: string | null;
  shopExternalId: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Set era id this event falls in; null when the set table has no boundaries. */
  eraId: string | null;
  /** Whole days since the epoch - the WHR time axis. */
  day: number;
}

/**
 * Every match in the history, in flat parallel arrays.
 *
 * Index `i` identifies one match everywhere; `playerA[i]`/`playerB[i]` index
 * into `players`, `event[i]` indexes into `events`.
 */
export interface ObservationSet {
  /** Stable Riot UUIDs, in first-seen order. */
  players: string[];
  /** Mutable presentation data, latest value seen for each player. */
  displayNames: (string | null)[];
  tagLines: (string | null)[];
  /** Earliest and latest evidence of the player, as epoch ms. */
  firstSeen: number[];
  lastSeen: number[];
  events: ObservedEvent[];

  matchIds: string[];
  playerA: number[];
  playerB: number[];
  event: number[];
  result: number[];
  /** Per-game winners: 1 = A, 2 = B. Games with no recorded winner are dropped. */
  gameWinners: number[][];

  /**
   * Riot's own Swiss tiebreakers per player per event, ascending by day.
   *
   * Collected only when asked for (`collectStandings`), because it is pure
   * validation material: these numbers are *independent* of the fit, so they
   * are the baseline the model has to beat on held-out matches. Nothing in the
   * published output depends on them.
   */
  standings: StandingSample[];

  stats: ObservationStats;
}

/** One player's end-of-event tiebreakers - the baseline predictor. */
export interface StandingSample {
  player: number;
  day: number;
  rank: number;
  matchPoints: number | null;
  gameWinPct: number | null;
  opponentMatchWinPct: number | null;
  opponentGameWinPct: number | null;
}

export interface ObservationStats {
  eventsSeen: number;
  eventsWithMatches: number;
  matchesSeen: number;
  matchesUsed: number;
  byeMatchesSkipped: number;
  /** Bye ids that reached the table despite the upstream filter. Expect 0. */
  byeLeaks: number;
  unmappedTeamSkipped: number;
  selfMatchSkipped: number;
  undecidedSkipped: number;
  duplicateMatchSkipped: number;
  gamesUsed: number;
  drawsSeen: number;
  rostersSeen: number;
  rosterOnlyPlayers: number;
}

function isByeId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(BYE_ID_PREFIX);
}

function emptyStats(): ObservationStats {
  return {
    eventsSeen: 0,
    eventsWithMatches: 0,
    matchesSeen: 0,
    matchesUsed: 0,
    byeMatchesSkipped: 0,
    byeLeaks: 0,
    unmappedTeamSkipped: 0,
    selfMatchSkipped: 0,
    undecidedSkipped: 0,
    duplicateMatchSkipped: 0,
    gamesUsed: 0,
    drawsSeen: 0,
    rostersSeen: 0,
    rosterOnlyPlayers: 0,
  };
}

const MS_PER_DAY = 86_400_000;

/** Whole days since the Unix epoch. Day granularity: an event is one time point. */
export function dayNumber(at: Date): number {
  return Math.floor(at.getTime() / MS_PER_DAY);
}

/**
 * Incrementally builds an ObservationSet as fact rows are streamed in.
 *
 * Streaming matters: the replay reads one day's facts at a time and throws the
 * payloads away, so the whole history never exists in memory at once.
 */
export class ObservationBuilder {
  readonly players: string[] = [];
  readonly displayNames: (string | null)[] = [];
  readonly tagLines: (string | null)[] = [];
  readonly firstSeen: number[] = [];
  readonly lastSeen: number[] = [];
  readonly events: ObservedEvent[] = [];

  readonly matchIds: string[] = [];
  readonly playerA: number[] = [];
  readonly playerB: number[] = [];
  readonly event: number[] = [];
  readonly result: number[] = [];
  readonly gameWinners: number[][] = [];
  readonly standings: StandingSample[] = [];

  readonly stats = emptyStats();

  private readonly playerIndex = new Map<string, number>();
  private readonly seenMatchIds = new Set<string>();
  private readonly seenEventIds = new Set<string>();
  /** Players known only from a roster, until a match promotes them. */
  private readonly rosterOnly = new Set<string>();

  constructor(
    private readonly eras: readonly SetEra[],
    /** Event names from the still-live event rows; facts do not carry a name. */
    private readonly eventNames: Map<string, string> = new Map(),
    private readonly maxMatches = Number.POSITIVE_INFINITY,
    /** Collect Riot's tiebreakers too. Validation only; off in production. */
    private readonly collectStandings = false,
    /** How prerelease events are attributed to a set. See sets.ts. */
    private readonly prerelease: PrereleaseOptions = DEFAULT_PRERELEASE_OPTIONS
  ) {}

  /** Index of a player, creating it on first sight. */
  private indexPlayer(playerId: string, name: string | null, tagLine: string | null, at: number): number {
    let index = this.playerIndex.get(playerId);
    if (index === undefined) {
      index = this.players.length;
      this.playerIndex.set(playerId, index);
      this.players.push(playerId);
      this.displayNames.push(name);
      this.tagLines.push(tagLine);
      this.firstSeen.push(at);
      this.lastSeen.push(at);
      return index;
    }
    // Presentation data churns; keep the most recent non-empty value.
    if (at >= this.lastSeen[index]) {
      if (name) this.displayNames[index] = name;
      if (tagLine) this.tagLines[index] = tagLine;
      this.lastSeen[index] = at;
    }
    if (at < this.firstSeen[index]) this.firstSeen[index] = at;
    return index;
  }

  /**
   * Fold in a roster.
   *
   * Rosters contribute no games - they are attendance - but they do give the
   * earliest evidence of a player (a dated signup) and a display name for
   * someone whose results row lacked one.
   */
  addRoster(roster: EventRoster): void {
    this.stats.rostersSeen++;
    const eventAt = roster.eventStartDate.getTime();
    for (const entry of roster.entries) {
      if (!entry.playerId || isByeId(entry.playerId)) {
        if (isByeId(entry.playerId)) this.stats.byeLeaks++;
        continue;
      }
      const registeredAt = entry.registeredAt ? Date.parse(entry.registeredAt) : NaN;
      const at = Number.isFinite(registeredAt) ? Math.min(registeredAt, eventAt) : eventAt;
      const index = this.indexPlayer(entry.playerId, entry.name, entry.tagLine, eventAt);
      if (at < this.firstSeen[index]) this.firstSeen[index] = at;
      if (!this.playedMatch.has(index)) this.rosterOnly.add(entry.playerId);
    }
  }

  private readonly playedMatch = new Set<number>();

  /** Fold in one event's results. */
  addResults(results: EventResults): void {
    if (this.seenEventIds.has(results.externalId)) return;
    this.seenEventIds.add(results.externalId);
    this.stats.eventsSeen++;

    const era = eraForEvent(this.eras, results.eventStartDate, results.eventType, this.prerelease);
    const eventIndex = this.events.length;
    this.events.push({
      externalId: results.externalId,
      name: this.eventNames.get(results.externalId) ?? null,
      startDate: results.eventStartDate,
      tournamentType: results.eventType,
      shopExternalId: results.shopExternalId,
      latitude: results.latitude,
      longitude: results.longitude,
      eraId: era?.id ?? null,
      day: dayNumber(results.eventStartDate),
    });

    // teamId -> player index. Byes are re-filtered here; see the header.
    const teamToPlayer = new Map<string, number>();
    const at = results.eventStartDate.getTime();
    for (const player of results.players) {
      if (!player.playerId) continue;
      if (isByeId(player.teamId) || isByeId(player.playerId)) {
        this.stats.byeLeaks++;
        continue;
      }
      teamToPlayer.set(player.teamId, this.indexPlayer(player.playerId, player.name, player.tagLine, at));
    }

    let used = 0;
    for (const round of results.rounds) {
      for (const match of round.matches) {
        this.stats.matchesSeen++;
        if (this.addMatch(match, eventIndex, teamToPlayer)) used++;
      }
    }
    if (used > 0) this.stats.eventsWithMatches++;
    // An event whose matches were all byes or all unmapped keeps its entry: it
    // is cheap, and the connectivity report counts attended venues from it.

    if (this.collectStandings) {
      const day = dayNumber(results.eventStartDate);
      for (const standing of results.standings) {
        const player = teamToPlayer.get(standing.teamId);
        if (player === undefined) continue;
        this.standings.push({
          player,
          day,
          rank: standing.rank,
          matchPoints: standing.matchPoints,
          gameWinPct: standing.gameWinPct,
          opponentMatchWinPct: standing.opponentMatchWinPct,
          opponentGameWinPct: standing.opponentGameWinPct,
        });
      }
    }
  }

  private addMatch(match: ResultMatch, eventIndex: number, teamToPlayer: Map<string, number>): boolean {
    if (this.matchIds.length >= this.maxMatches) return false;

    if (match.bye || isByeId(match.matchId) || match.sides.some(side => isByeId(side.teamId))) {
      this.stats.byeMatchesSkipped++;
      if (!match.bye && (isByeId(match.matchId) || match.sides.some(side => isByeId(side.teamId)))) {
        // The stored row says this is a real match but carries a bye id.
        this.stats.byeLeaks++;
      }
      return false;
    }
    if (match.sides.length !== 2) {
      this.stats.undecidedSkipped++;
      return false;
    }
    if (this.seenMatchIds.has(match.matchId)) {
      this.stats.duplicateMatchSkipped++;
      return false;
    }

    const [sideA, sideB] = match.sides;
    const a = teamToPlayer.get(sideA.teamId);
    const b = teamToPlayer.get(sideB.teamId);
    if (a === undefined || b === undefined) {
      this.stats.unmappedTeamSkipped++;
      return false;
    }
    if (a === b) {
      // One account on both sides of a pairing is corrupt data, not a game.
      this.stats.selfMatchSkipped++;
      return false;
    }

    const result = resolveMatchResult(sideA.outcome, sideB.outcome, sideA.gameWins, sideB.gameWins);
    if (result === null) {
      this.stats.undecidedSkipped++;
      return false;
    }

    const winners: number[] = [];
    for (const game of match.games) {
      if (game.winnerTeamId === sideA.teamId) winners.push(MatchResult.AWin);
      else if (game.winnerTeamId === sideB.teamId) winners.push(MatchResult.BWin);
    }

    this.seenMatchIds.add(match.matchId);
    this.matchIds.push(match.matchId);
    this.playerA.push(a);
    this.playerB.push(b);
    this.event.push(eventIndex);
    this.result.push(result);
    this.gameWinners.push(winners);
    this.playedMatch.add(a);
    this.playedMatch.add(b);
    this.rosterOnly.delete(this.players[a]);
    this.rosterOnly.delete(this.players[b]);
    this.stats.matchesUsed++;
    this.stats.gamesUsed += winners.length;
    if (result === MatchResult.Draw) this.stats.drawsSeen++;
    return true;
  }

  finish(): ObservationSet {
    this.stats.rosterOnlyPlayers = this.rosterOnly.size;
    return {
      players: this.players,
      displayNames: this.displayNames,
      tagLines: this.tagLines,
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      events: this.events,
      matchIds: this.matchIds,
      playerA: this.playerA,
      playerB: this.playerB,
      event: this.event,
      result: this.result,
      gameWinners: this.gameWinners,
      standings: this.standings.sort((a, b) => a.day - b.day),
      stats: this.stats,
    };
  }
}

/**
 * A view of the same history holding only the matches a predicate keeps.
 *
 * Players, events and standings are shared, not copied: a slice is only ever
 * read, and the per-player arrays are indexed by the same player numbers, so a
 * per-set fit and the all-time fit can be compared index for index.
 */
export function sliceMatches(
  observations: ObservationSet,
  keepMatch: (matchIndex: number) => boolean
): ObservationSet {
  const keep: number[] = [];
  for (let i = 0; i < observations.playerA.length; i++) if (keepMatch(i)) keep.push(i);
  return {
    ...observations,
    matchIds: keep.map(i => observations.matchIds[i]),
    playerA: keep.map(i => observations.playerA[i]),
    playerB: keep.map(i => observations.playerB[i]),
    event: keep.map(i => observations.event[i]),
    result: keep.map(i => observations.result[i]),
    gameWinners: keep.map(i => observations.gameWinners[i]),
  };
}

/**
 * Who won, from the two sides' recorded outcome, falling back to game wins.
 *
 * Riot leaves matches reading `IN_PROGRESS` inside finalised rounds (see
 * scraper/CLAUDE.md), so the outcome strings are not always present even for a
 * decided match - the game tally settles those. Returns null when neither
 * source decides it, and those matches are counted, not guessed.
 */
export function resolveMatchResult(
  outcomeA: string | null,
  outcomeB: string | null,
  gameWinsA: number,
  gameWinsB: number
): number | null {
  const a = outcomeA?.toUpperCase() ?? null;
  const b = outcomeB?.toUpperCase() ?? null;
  if (a === 'WIN' && b !== 'WIN') return MatchResult.AWin;
  if (b === 'WIN' && a !== 'WIN') return MatchResult.BWin;
  if (a === 'DRAW' || b === 'DRAW' || (a === 'TIE' || b === 'TIE')) return MatchResult.Draw;
  if (gameWinsA > gameWinsB) return MatchResult.AWin;
  if (gameWinsB > gameWinsA) return MatchResult.BWin;
  if (gameWinsA > 0 && gameWinsA === gameWinsB) return MatchResult.Draw;
  return null;
}

/** Day key for a match, for the rating history and the match log sort key. */
export function matchDay(observations: ObservationSet, index: number): string {
  return utcDate(observations.events[observations.event[index]].startDate);
}
