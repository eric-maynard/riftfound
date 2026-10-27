import { env } from '../config/env.js';
import { useDynamoDB } from '../config/database.js';
import { dynamoTournamentStore } from '../adapters/tournamentDynamoAdapter.js';
import { fixtureTournamentStore } from '../adapters/tournamentFixtureAdapter.js';
import type {
  EventResultsRecord,
  EventRosterRecord,
  TournamentStore,
} from '../adapters/tournamentStore.js';
import type { PlayerRecord } from '../adapters/rankingStore.js';
import { getRankingStore, minGamesToPublish, publishableRating } from './rankingService.js';
import { resolveVerdict, isComparable, normaliseOutcome, CONFIDENCE } from '../models/ranking.js';
import {
  isSyntheticByeId,
  tournamentIdFromExternalId,
  type TournamentAvailability,
  type TournamentDetail,
  type TournamentEventContext,
  type TournamentField,
  type TournamentMatch,
  type TournamentPlayer,
  type TournamentResults,
  type TournamentRoster,
  type TournamentRound,
  type TournamentSidePlayer,
  type TournamentStanding,
} from '../models/tournament.js';

/**
 * Reads the scraper's tournament facts and joins them to the rating engine's
 * player profiles.
 *
 * Everything here is read-only. The facts are immutable captures and the
 * profiles are derived items; this service owns neither.
 *
 * Two rules it exists to enforce in one place:
 *
 * 1. **The confidence gate.** A provisional player's rating number is never
 *    returned - `rating` comes back null with `provisional: true`, so a page
 *    prints "Unranked" instead of a number nobody should act on. The ranking
 *    endpoints now hold the same line (`services/rankingService.ts`), so the
 *    two cannot disagree about one player.
 * 2. **Honest aggregates.** The strength-of-field figures are computed over the
 *    rated players only and always travel with the count they were computed
 *    from, so "1,540 average" can never be read as describing a field of 24
 *    when it describes 3 of them.
 * 3. **One shape per fact.** Riot's capture carries a drawn match as `TIE` and
 *    publishes a bye twice (as a synthesised match *and* in `byeTeamIds`), and
 *    returns the pairings in capture order. Each of those cost a consumer a
 *    bug: a draw rendered as "no result", a bye printed twice, a table list
 *    scanned out of order. So the outcome is normalised to this API's one
 *    vocabulary, a bye leaves only as a bye, and the pairings leave sorted -
 *    decided once here rather than re-learned by every reader.
 */

let override: TournamentStore | null = null;

/** Swap the store, for tests. Pass null to go back to the configured one. */
export function setTournamentStore(store: TournamentStore | null): void {
  override = store;
}

/**
 * Same selection rule as `getRankingStore()`, and for the same reason: the real
 * items only exist in DynamoDB.
 *
 * PostgreSQL is deliberately absent rather than half-supported - the scraper's
 * `supportsEventFacts()` leaves it out on the same grounds, since its schema
 * (`infrastructure/init.sql`) is not managed from either side. SQLite *does*
 * hold facts on the scraper side (`event_results` / `event_rosters`), but the
 * API has no SQLite reader for them, so dev falls to the fixture - exactly as
 * the ranking endpoints already do.
 */
export function getTournamentStore(): TournamentStore {
  if (override) return override;
  if (env.RANKING_SOURCE === 'fixture') return fixtureTournamentStore;
  if (env.RANKING_SOURCE === 'dynamodb') return dynamoTournamentStore;
  return useDynamoDB() ? dynamoTournamentStore : fixtureTournamentStore;
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/**
 * Build the enriched player for one identity.
 *
 * `profile` is undefined for a player the rating engine has never seen, which
 * is the majority of most fields at launch. That is reported as
 * `known: false` + `provisionalReason: 'no-rating'` rather than as an absence,
 * so a page can show the name with "Unranked" beside it.
 */
function enrich(
  identity: { playerId: string; teamId: string | null; displayName: string | null; tagLine: string | null },
  profile: PlayerRecord | undefined
): TournamentPlayer {
  // The engine's own verdict off the profile when it carries one; derived from
  // the numbers only when it does not.
  const verdict = resolveVerdict({
    rating: profile?.rating ?? null,
    uncertainty: profile?.uncertainty ?? null,
    gamesPlayed: profile?.gamesPlayed ?? null,
    provisional: profile?.provisional,
    provisionalReason: profile?.provisionalReason,
    gamesUntilRated: profile?.gamesUntilRated,
  });

  return {
    playerId: identity.playerId,
    teamId: identity.teamId,
    // The fact's own name is what the event showed on the day; fall back to the
    // profile when a capture never carried one.
    displayName: identity.displayName ?? profile?.displayName ?? null,
    tagLine: identity.tagLine ?? profile?.tagLine ?? null,
    known: profile !== undefined,
    // The number with its margin once there is a little evidence, null below
    // the display floor. `uncertainty` below is what qualifies it.
    rating: publishableRating(
      profile?.rating ?? null,
      profile?.gamesPlayed ?? null,
      profile?.uncertainty ?? null
    ),
    uncertainty: profile?.uncertainty ?? null,
    gamesPlayed: profile?.gamesPlayed ?? null,
    matchesPlayed: profile?.matchesPlayed ?? null,
    provisional: verdict.provisional,
    provisionalReason: verdict.provisionalReason,
    gamesUntilRated: verdict.gamesUntilRated,
    componentId: profile?.componentId ?? null,
    componentSize: profile?.componentSize ?? null,
    regionLabel: profile?.regionLabel ?? null,
    comparable: isComparable(profile?.componentSize ?? null),
  };
}

function toSidePlayer(player: TournamentPlayer | null): TournamentSidePlayer | null {
  if (!player) return null;
  return {
    playerId: player.playerId,
    displayName: player.displayName,
    tagLine: player.tagLine,
    rating: player.rating,
    // Carried on the compact form too: a rating is never published without its
    // margin, and a pairing row is a place a bare number would have appeared.
    uncertainty: player.uncertainty,
    provisional: player.provisional,
  };
}

/** The event context, taken off whichever fact we have. */
function toEventContext(
  externalId: string,
  fact: EventResultsRecord | EventRosterRecord
): TournamentEventContext {
  return {
    externalId: fact.externalId || externalId,
    tournamentId: fact.tournamentId ?? tournamentIdFromExternalId(externalId),
    startDate: fact.eventStartDate,
    eventType: fact.eventType,
    playFormat: fact.playFormat,
    shopExternalId: fact.shopExternalId,
    latitude: fact.latitude,
    longitude: fact.longitude,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Strength of field over the rated players only.
 *
 * Both averages are null when nothing cleared the bar, which is the common case
 * for a small local event, and `ratedSample` / `ratedShare` always travel with
 * them. A page that wants to print "average 1,540" has to print "over 3 of 24"
 * beside it, because that is the only reading the payload supports.
 */
function summariseField(players: TournamentPlayer[]): TournamentField {
  const ratings = players
    .filter((player) => !player.provisional && player.rating !== null)
    .map((player) => player.rating as number);

  const knownPlayers = players.filter((player) => player.known).length;
  const ratedPlayers = ratings.length;
  const mean = ratedPlayers === 0 ? null : ratings.reduce((sum, value) => sum + value, 0) / ratedPlayers;

  return {
    totalPlayers: players.length,
    knownPlayers,
    ratedPlayers,
    provisionalPlayers: knownPlayers - ratedPlayers,
    unknownPlayers: players.length - knownPlayers,
    ratedSample: ratedPlayers,
    ratedShare: players.length === 0 ? 0 : Math.round((ratedPlayers / players.length) * 1000) / 1000,
    meanRating: mean === null ? null : round1(mean),
    medianRating: ratedPlayers === 0 ? null : round1(median(ratings) as number),
    topRating: ratedPlayers === 0 ? null : Math.max(...ratings),
    minGamesForRating: CONFIDENCE.minGames,
    maxUncertaintyForRating: CONFIDENCE.maxUncertainty,
    minComponentSize: CONFIDENCE.minComponentSize,
    minGamesToPublishRating: minGamesToPublish(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/events/:externalId/tournament
// ---------------------------------------------------------------------------

/**
 * Everything known about one event's play.
 *
 * Null when the event has neither fact - the caller answers 404. A roster with
 * no results is normal and common: every upcoming event looks like that, and it
 * is the strength-of-field preview the page is most useful for.
 */
export async function getTournament(externalId: string): Promise<TournamentDetail | null> {
  const store = getTournamentStore();
  const [results, roster] = await Promise.all([
    store.getResults(externalId),
    store.getRoster(externalId),
  ]);

  if (!results && !roster) return null;

  // Identity is the stable UUID, never a display name. The roster is the better
  // source when both exist (it is the whole field, including anyone who signed
  // up and did not play), and the results capture fills in team ids.
  const identities = new Map<
    string,
    { playerId: string; teamId: string | null; displayName: string | null; tagLine: string | null }
  >();

  const remember = (
    playerId: string | null,
    teamId: string | null,
    displayName: string | null,
    tagLine: string | null
  ) => {
    if (!playerId) return;
    const existing = identities.get(playerId);
    if (!existing) {
      identities.set(playerId, { playerId, teamId, displayName, tagLine });
      return;
    }
    existing.teamId ??= teamId;
    existing.displayName ??= displayName;
    existing.tagLine ??= tagLine;
  };

  for (const entry of roster?.entries ?? []) {
    remember(entry.playerId, entry.teamId, entry.displayName, entry.tagLine);
  }
  for (const player of results?.players ?? []) {
    remember(player.playerId, player.teamId, player.displayName, player.tagLine);
  }

  // One BatchGet for the whole field, never a GetItem per player.
  const profiles =
    identities.size > 0
      ? await getRankingStore().getPlayers([...identities.keys()])
      : new Map<string, PlayerRecord>();

  const byPlayerId = new Map<string, TournamentPlayer>();
  for (const identity of identities.values()) {
    byPlayerId.set(identity.playerId, enrich(identity, profiles.get(identity.playerId)));
  }

  // teamId -> player, the join the standings and pairings need. Built from the
  // results capture's own map, which is the only authority on it.
  const byTeamId = new Map<string, TournamentPlayer>();
  for (const player of results?.players ?? []) {
    if (!player.playerId) continue;
    const enriched = byPlayerId.get(player.playerId);
    if (enriched) byTeamId.set(player.teamId, enriched);
  }

  const detail: TournamentDetail = {
    event: toEventContext(externalId, roster ?? (results as EventResultsRecord)),
    results: results ? toResults(results, byTeamId) : null,
    roster: roster ? toRoster(roster, byPlayerId) : null,
    // Standings order when we have it, otherwise registration order: both are
    // orders a page can render straight down without sorting anything.
    players: orderPlayers([...byPlayerId.values()], results, roster),
    field: summariseField([...byPlayerId.values()]),
  };

  return detail;
}

function orderPlayers(
  players: TournamentPlayer[],
  results: EventResultsRecord | null,
  roster: EventRosterRecord | null
): TournamentPlayer[] {
  const rank = new Map<string, number>();

  if (results) {
    const teamToPlayer = new Map(
      results.players.filter((player) => player.playerId).map((player) => [player.teamId, player.playerId as string])
    );
    for (const standing of results.standings) {
      const playerId = teamToPlayer.get(standing.teamId);
      if (playerId !== undefined && !rank.has(playerId)) rank.set(playerId, standing.rank);
    }
  }
  if (roster) {
    let next = rank.size + 1;
    for (const entry of roster.entries) {
      if (!rank.has(entry.playerId)) rank.set(entry.playerId, 1_000_000 + next++);
    }
  }

  return [...players].sort(
    (a, b) =>
      (rank.get(a.playerId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.playerId) ?? Number.MAX_SAFE_INTEGER) ||
      a.playerId.localeCompare(b.playerId)
  );
}

/**
 * Is this one of Riot's synthesised bye pairings?
 *
 * The capture's own `bye` flag is the primary test (the scraper sets it from the
 * `bye-` prefix on the match id or on either team id). The id test is repeated
 * here so a capture written before that flag existed, or one whose flag never
 * got set, still cannot leak a bye into the pairings.
 */
function isByeMatch(match: { matchId: string; bye: boolean; sides: { teamId: string }[] }): boolean {
  return (
    match.bye ||
    isSyntheticByeId(match.matchId) ||
    match.sides.some((side) => isSyntheticByeId(side.teamId))
  );
}

/**
 * The teams that sat the round out - one list, built so dropping the bye
 * matches cannot lose a bye.
 *
 * `byeTeamIds` is the authority and comes first. Across 87 live rounds (42 of
 * them with a bye) the two shapes agreed on every single one, so in practice
 * this is `round.byeTeamIds`; the fold is here because a bye that arrived only
 * as a match would otherwise vanish the moment the match stopped being
 * published, and silently losing a bye is worse than the duplicate was.
 */
function resolveByeTeamIds(round: {
  byeTeamIds: string[];
  matches: { matchId: string; bye: boolean; sides: { teamId: string }[] }[];
}): string[] {
  const out = [...new Set(round.byeTeamIds)];
  const seen = new Set(out);
  for (const match of round.matches) {
    if (!isByeMatch(match)) continue;
    for (const side of match.sides) {
      // The placeholder half of a bye is not a team that got one.
      if (isSyntheticByeId(side.teamId) || seen.has(side.teamId)) continue;
      seen.add(side.teamId);
      out.push(side.teamId);
    }
  }
  return out;
}

/** Table order, with anything untabled last and the match id as the tiebreak. */
function byTableNumber(a: TournamentMatch, b: TournamentMatch): number {
  const left = a.tableNumber ?? Number.MAX_SAFE_INTEGER;
  const right = b.tableNumber ?? Number.MAX_SAFE_INTEGER;
  return left - right || a.matchId.localeCompare(b.matchId);
}

function toResults(
  record: EventResultsRecord,
  byTeamId: Map<string, TournamentPlayer>
): TournamentResults {
  const standings: TournamentStanding[] = record.standings.map((standing) => ({
    rank: standing.rank,
    teamId: standing.teamId,
    matchPoints: standing.matchPoints,
    matchWins: standing.matchWins,
    matchLosses: standing.matchLosses,
    matchDraws: standing.matchDraws,
    opponentMatchWinPct: standing.opponentMatchWinPct,
    gameWinPct: standing.gameWinPct,
    opponentGameWinPct: standing.opponentGameWinPct,
    player: byTeamId.get(standing.teamId) ?? null,
  }));

  const rounds: TournamentRound[] = record.rounds.map((round) => {
    const byeTeamIds = resolveByeTeamIds(round);
    return {
      section: round.section,
      roundNumber: round.roundNumber,
      status: round.status,
      byeTeamIds,
      byes: byeTeamIds
        .map((teamId) => toSidePlayer(byTeamId.get(teamId) ?? null))
        .filter((player): player is TournamentSidePlayer => player !== null),
      // Played pairings only, in table order. The synthesised bye matches are
      // dropped here: a bye leaves in `byes` and nowhere else.
      matches: round.matches
        .filter((match) => !isByeMatch(match))
        .map(
          (match): TournamentMatch => ({
            matchId: match.matchId,
            tableNumber: match.tableNumber,
            status: match.status,
            bye: false,
            sides: match.sides.map((side) => ({
              teamId: side.teamId,
              // One vocabulary at the boundary; the upstream word travels beside
              // it. Riot says TIE, not DRAW.
              outcome: side.outcome === null ? null : normaliseOutcome(side.outcome),
              rawOutcome: side.outcome,
              gameWins: side.gameWins,
              player: toSidePlayer(byTeamId.get(side.teamId) ?? null),
            })),
            games: match.games.map((game) => ({ number: game.number, winnerTeamId: game.winnerTeamId })),
          })
        )
        .sort(byTableNumber),
    };
  });

  return {
    status: record.status,
    roundCount: record.roundCount,
    playerCount: record.playerCount,
    openMatches: record.openMatches,
    trimmed: record.trimmed,
    sourceUpdatedAt: record.sourceUpdatedAt,
    capturedAt: record.capturedAt,
    standings,
    rounds,
  };
}

function toRoster(
  record: EventRosterRecord,
  byPlayerId: Map<string, TournamentPlayer>
): TournamentRoster {
  return {
    source: record.source,
    playerCount: record.playerCount,
    capturedAt: record.capturedAt,
    entries: record.entries.flatMap((entry) => {
      const player = byPlayerId.get(entry.playerId);
      if (!player) return [];
      return [
        {
          playerId: entry.playerId,
          displayName: entry.displayName ?? player.displayName,
          tagLine: entry.tagLine ?? player.tagLine,
          teamId: entry.teamId,
          status: entry.status,
          checkedIn: entry.checkedIn,
          waitlistPosition: entry.waitlistPosition,
          registeredAt: entry.registeredAt,
          player,
        },
      ];
    }),
  };
}

// ---------------------------------------------------------------------------
// GET /api/events/tournament-availability
// ---------------------------------------------------------------------------

/**
 * Which of these events have anything to show.
 *
 * Called on every day-list open, so it is one BatchGet over the fact keys with
 * a metadata-only projection. Every requested id comes back, so the caller
 * never has to tell "absent" from "nothing there".
 */
export async function getTournamentAvailability(
  externalIds: string[]
): Promise<Record<string, TournamentAvailability>> {
  const found = await getTournamentStore().getAvailability(externalIds);

  const out: Record<string, TournamentAvailability> = {};
  for (const externalId of new Set(externalIds)) {
    const record =
      found.get(externalId) ?? { hasResults: false, resultsStatus: null, hasRoster: false, playerCount: null };
    out[externalId] = {
      hasResults: record.hasResults,
      resultsStatus: record.resultsStatus,
      hasRoster: record.hasRoster,
      hasTournament: record.hasResults || record.hasRoster,
      playerCount: record.playerCount,
    };
  }
  return out;
}
