import {
  loadEventFactCandidates,
  saveEventResults,
  saveEventRoster,
  supportsEventFacts,
  type EventFactCandidate,
  type EventFactContext,
  type EventResults,
  type EventResultsStatus,
  type EventRoster,
  type ResultGame,
  type ResultMatch,
  type ResultMatchSide,
  type ResultPlayer,
  type ResultRound,
  type ResultStanding,
  type RosterEntry,
} from '../database.js';
import { sanitizeEventResults, sanitizeEventRoster, sanitizeText } from '../sanitize.js';
import { PLAYRIFTBOUND_ID_PREFIX } from './playriftbound.js';

/**
 * Third pass over Riot's playriftbound source: who signed up for an event, and
 * what happened when it was played.
 *
 * It writes two kinds of immutable, timestamped fact per event:
 *
 * - a **roster** (who registered, and the moment each of them did), captured
 *   once while the event is still upcoming, and
 * - **results** (standings, pairings, per-game outcomes), captured once the
 *   event is over.
 *
 * Both are keyed on Riot's stable player UUID, never on a display name, and both
 * are append-only: a future rating pass has to be able to replay the entire
 * history from scratch and get the same answer, so nothing here stores a
 * derived rating and nothing here rewrites a fact once it is recorded.
 *
 * Unlike the other two sources this is not a discovery sweep. The events table
 * already holds every Riot tournament id we care about, so the pass is simply
 * "stored Riot events that are due a roster snapshot or a results capture", one
 * page fetch each, at the same polite ~1 req/sec.
 *
 * Which stored rows those are is `resultsCandidateTournamentId` (in
 * playriftbound.ts), and it is two shapes rather than one: a `prb-` externalId,
 * and a **merged** row whose id is parsed out of its `url`. That second shape
 * was missing until 2026-10-27 and it was the largest gap in this pipeline -
 * the merge keeps the UVS identity, so a matched event had no prefix to select
 * on and was never queued at all (4,052 such rows in the window, 3,424 of them
 * results-due). The candidate loaders resolve the id, so nothing in this module
 * can tell the two apart; see scraper/CLAUDE.md, "Which rows are results
 * candidates".
 *
 * Five things shape this module:
 *
 * 1. **Page HTML, not GraphQL.** Both facts are embedded, public and
 *    unauthenticated, in the Next.js RSC flight payload of
 *    https://playriftbound.com/en-US/events/<tournamentId>. There is no bulk
 *    endpoint - `CompeteTournamentSearch` is upcoming-only and its selection set
 *    carries neither results nor registrants - so one GET per tournament is the
 *    only route. Reading the page also means this pass needs *no* persisted
 *    query hash, and therefore no dependency on the self-heal in
 *    playriftbound.ts.
 * 2. **Two fetches per event, ever.** One near the start (ROSTER_LEAD_MS, so the
 *    roster is close to final) and one after it is over. Nothing is polled:
 *    every registrant carries its own `acceptedTermsAt`, so a single snapshot
 *    reconstructs the whole signup curve retroactively, and results are
 *    immutable once an organizer finalises them. Re-fetching what we already
 *    have is the one thing that would make this pass expensive.
 * 3. **An empty capture is normal.** 71% of finished events have real results;
 *    the rest are listing-only, because the organizer never ran pairings through
 *    Riot's software. An upcoming event nobody has signed up for simply has no
 *    registrants. Both are recorded as facts rather than retried forever.
 * 4. **Organizers do not always close everything out.** An event whose last
 *    round was still live when we looked is captured as `partial` and gets one
 *    re-check a day later (MAX_ATTEMPTS), then is accepted as-is. Note that
 *    *match* status is not a finality signal: Riot's software leaves matches
 *    reading IN_PROGRESS inside rounds it has FINALIZED, so round status decides
 *    (see normalizeResults).
 * 5. **Per-event failures are non-fatal.** One unparseable page must not abort
 *    the pass, and a rate limit or a 5xx stops the run cleanly rather than
 *    hammering Riot. Whatever is left rolls over to the next run.
 *
 * Personal data: this stores named individuals' event attendance and match
 * history. See the privacy note in scraper/CLAUDE.md. Nothing player-identifying
 * is ever logged - the logs here are counts only.
 */

const EVENT_PAGE_BASE = 'https://playriftbound.com/en-US/events';

/** Identify ourselves honestly - never as Riot's own web client. */
const USER_AGENT = 'Riftfound/1.0 (+https://riftfound.com)';

/** Per-request timeout, so one hung connection can't eat the Lambda's budget. */
const REQUEST_TIMEOUT_MS = 20_000;

const DEFAULT_REQUEST_DELAY_MS = 1000; // ~1 req/sec: polite by default
const DEFAULT_MAX_EVENTS_PER_RUN = 250; // ~0.8s/page + 1s delay => ~8 minutes
/**
 * How far back a finished event may be and still be a results candidate.
 *
 * A capture needs an **event row** to be a candidate, so this is bounded above
 * by `deleteOldEvents(60)` and below by when `prb-` rows started existing at
 * all. Both were measured against production on 2026-10-26 rather than assumed:
 *
 * | bound | measurement |
 * |---|---|
 * | event-row retention | `DATE#` partitions hold rows back to 2026-08-28 (-59d) and **zero** at -60d and beyond |
 * | earliest `prb-` row | **2026-10-01** (227 rows); September holds 4 rows in total (09-25, 09-26, 09-28) and nothing before 09-25 |
 * | Riot still serving old pages | 5 of 6 spot-checked 2026-09-25..10-03 pages returned HTTP 200 with the `esportsTournamentId` marker, 3 of them with FINALIZED rounds; the sixth 500s on every attempt (see the 5xx note below) |
 *
 * And the effect of the knob itself, `loadEventFactCandidates` against
 * production on 2026-10-26:
 *
 * | lookback | candidates | results-due | candidate load |
 * |---|---|---|---|
 * | 21 (the old default) | 21,426 | 15,208 | 27.5s |
 * | 26 | 22,842 | **16,383** | 26.4s |
 * | 45 | 22,846 | 16,387 | 29.7s |
 * | 58 | 22,846 | 16,387 | 28.9s |
 *
 * So the whole recoverable gain is 21 -> 26 days: **+1,179 events** whose
 * results were otherwise unreachable for good, because they aged out of the
 * window before the oldest-first queue reached them (2026-10-01..03 had 983
 * `prb-` events and 0 captures). Past 26 days the gain is 4 events, because the
 * history simply does not go back further - no lookback recovers the bulk of
 * the Vendetta era (2026-07-31..10-23), which was over before this scraper ever
 * saw a `prb-` event.
 *
 * 45 is therefore chosen for headroom rather than for today's data: it reaches
 * everything that exists, stays 14 days inside the measured 59-day retention
 * floor, costs ~3s of extra candidate load out of an ~840s budget, and needs no
 * further change as the history lengthens over the next two months.
 */
export const DEFAULT_LOOKBACK_DAYS = 45;
/** How far ahead to look for events needing a roster snapshot (see ROSTER_LEAD_MS). */
const DEFAULT_LOOKAHEAD_DAYS = 2;

/**
 * How close to the start an event's roster is captured.
 *
 * Late enough that almost everyone who is going to register has, early enough
 * that the page still shows registrants rather than pairings. Signups made
 * after this point are still recovered by the post-event capture.
 */
export const ROSTER_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * How long after an event's start time its results are worth reading.
 * Organizers finalise rounds while the event is still running, so there is
 * nothing to collect until it is plausibly over.
 */
export const RESULTS_SETTLE_MS = 6 * 60 * 60 * 1000;

/** Minimum gap before an incomplete results capture is re-checked. */
export const RESULTS_RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Total successful results fetches allowed per event: the first capture plus one
 * re-check. After that the event is done whatever state it is in, which is what
 * keeps this pass cheap.
 */
export const MAX_ATTEMPTS = 2;

/** Consecutive per-event failures before the pass gives up for the run. */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Soft cap on one event's normalized results. DynamoDB items stop at 400KB and a
 * huge tournament (hundreds of players over many rounds) could approach it, so
 * the pairings are dropped before the item can get there - the standings are
 * what a reader wants and the item stays inside the limit.
 */
const MAX_RESULT_BYTES = 300_000;

/**
 * Riot's synthetic ids for the empty half of a bye pairing: `bye-<...>` match,
 * team and player ids, the player showing up as `displayName: "BYE"`. These must
 * never become a rated player, so every id is checked against this prefix.
 */
const BYE_ID_PREFIX = 'bye-';

// ---------------------------------------------------------------------------
// Riot's response types (their own fragment shapes, as served in the page)
// ---------------------------------------------------------------------------

interface PrbPlayer {
  id?: string | null;
  displayName?: string | null;
  tagLine?: string | null;
}

interface PrbTeamOutcome {
  outcome?: string | null;
  esportsTeamId?: string | null;
}

interface PrbGame {
  esportsGameId?: string | null;
  number?: number | null;
  /**
   * Entries are usually objects, but React's flight encoding replaces an object
   * it has already serialised with a `"$<path>"` reference string. That only
   * happens for byes, whose synthetic games reuse the match-level outcome
   * object, so unresolvable entries are ignored (a bye has no real games).
   */
  teamOutcomes?: (PrbTeamOutcome | string)[] | null;
}

interface PrbMatchTeam {
  esportsTeamId?: string | null;
  players?: PrbPlayer[] | null;
}

interface PrbMatch {
  esportsMatchId?: string | null;
  tableNumber?: number | null;
  status?: string | null;
  teamOutcomes?: (PrbTeamOutcome | string)[] | null;
  games?: PrbGame[] | null;
  teams?: PrbMatchTeam[] | null;
}

interface PrbStandingEntry {
  rank?: number | null;
  esportsTeamId?: string | null;
  matchPoints?: number | null;
  opponentMatchWinPercentage?: string | number | null;
  gameWinPercentage?: string | number | null;
  opponentGameWinPercentage?: string | number | null;
  matchWins?: number | null;
  matchLosses?: number | null;
  matchDraws?: number | null;
}

interface PrbRound {
  roundNumber?: number | null;
  status?: string | null;
  byeTeamIds?: string[] | null;
  matches?: PrbMatch[] | null;
  endOfRoundStandings?: PrbStandingEntry[] | null;
}

interface PrbSection {
  rounds?: PrbRound[] | null;
}

interface PrbStage {
  sections?: PrbSection[] | null;
}

interface PrbParticipant {
  esportsTeamId?: string | null;
  status?: string | null;
  player?: PrbPlayer | null;
}

/** `TournamentRegistrant`: one signup, with the moment it happened. */
export interface PrbRegistrant {
  id?: string | null;
  status?: string | null;
  checkedIn?: boolean | null;
  acceptedTermsAt?: string | null;
  waitlistPosition?: number | null;
  player?: PrbPlayer | null;
}

/** The `CompeteTournament` object embedded in a played event's flight payload. */
export interface PrbTournamentDetail {
  id?: string | null;
  updatedAt?: string | null;
  stages?: PrbStage[] | null;
  tournamentParticipants?: PrbParticipant[] | string | null;
}

/** A page that could not be read. Never permanent: the event stays due. */
export class ResultsFetchError extends Error {}

/** Rate limited, blocked, or Riot having a bad time: stop the whole pass. */
export class ResultsBackoffError extends ResultsFetchError {}

// ---------------------------------------------------------------------------
// Flight payload extraction
// ---------------------------------------------------------------------------

/**
 * Pull the RSC flight payload out of an event page.
 *
 * Next.js streams it as `self.__next_f.push([1,"<escaped payload>"])`, so the
 * payload is a JavaScript string literal inside the HTML - every quote in the
 * data arrives as `\"`. Reading the literal with JSON.parse is exactly the
 * un-escaping it needs, and it also handles `\\`, `\n` and `\uXXXX`, which a
 * naive replace of `\"` would corrupt.
 */
export function extractFlightPayload(html: string): string {
  const chunks: string[] = [];
  const pushRe = /__next_f\.push\(\[\s*1\s*,/g;

  for (let match = pushRe.exec(html); match !== null; match = pushRe.exec(html)) {
    const open = html.indexOf('"', match.index + match[0].length);
    if (open === -1) continue;

    const close = endOfStringLiteral(html, open);
    if (close === -1) continue;

    try {
      chunks.push(JSON.parse(html.slice(open, close + 1)) as string);
    } catch {
      // A truncated response can cut a literal in half; keep what parsed.
    }
    pushRe.lastIndex = close + 1;
  }

  return chunks.join('');
}

/** Index of the closing quote of the string literal that starts at `open`. */
function endOfStringLiteral(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '"') return i;
  }
  return -1;
}

/**
 * Brace/bracket-match one JSON value out of the middle of the flight payload.
 *
 * The payload as a whole is not JSON (it is a stream of numbered rows holding a
 * React tree), so values are located by a marker and matched out of the text.
 * Returns null when the value is unterminated, i.e. the response was truncated.
 */
function matchJsonValue(text: string, start: number): string | null {
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const TOURNAMENT_MARKER = '"__typename":"CompeteTournament"';
const REGISTRANT_MARKER = '[{"__typename":"TournamentRegistrant"';

/**
 * Extract the one `CompeteTournament` object from a flight payload, or null when
 * the page carries none - the normal shape of an event whose organizer never ran
 * pairings through Riot's software, and of every event that has not happened yet.
 */
export function extractTournamentJson(flight: string): string | null {
  const marker = flight.indexOf(TOURNAMENT_MARKER);
  if (marker === -1) return null;
  // `__typename` is the object's first key, so the brace before it is its own.
  const start = flight.lastIndexOf('{', marker);
  if (start === -1) throw new ResultsFetchError('tournament object has no opening brace');

  const json = matchJsonValue(flight, start);
  // The marker is there but the value never closes: the payload was cut short.
  // Returning null here would record the event as having no results.
  if (!json) throw new ResultsFetchError('tournament object is unterminated (truncated payload)');
  return json;
}

/**
 * Extract every `TournamentRegistrant` array in the payload.
 *
 * The "Registered Players" section passes one array as a component prop, and a
 * waitlisted section would pass a second, so all of them are collected and
 * merged by the pass below.
 */
export function extractRegistrantArrays(flight: string): string[] {
  const arrays: string[] = [];
  let from = flight.indexOf(REGISTRANT_MARKER);
  while (from !== -1) {
    const value = matchJsonValue(flight, from);
    if (!value) throw new ResultsFetchError('registrant list is unterminated (truncated payload)');
    arrays.push(value);
    from = flight.indexOf(REGISTRANT_MARKER, from + value.length);
  }
  return arrays;
}

export interface ParsedEventPage {
  /** Present once an organizer has run rounds; null for upcoming or listing-only events. */
  detail: PrbTournamentDetail | null;
  /** Registration facts. Present on upcoming pages and on finished pages with no rounds. */
  registrants: PrbRegistrant[];
}

/**
 * Parse an event page.
 *
 * Throws when the page does not look like a readable event page at all, and
 * returns empty fields when it reads fine but holds nothing. Keeping those two
 * apart matters: a truncated response must not be recorded as "this event has no
 * results", or a bad minute at Riot would permanently blank an event.
 */
export function parseEventPage(html: string, tournamentId: string): ParsedEventPage {
  // A short read gives a page that parses but is missing the half we want, and
  // "no results" is a conclusion we never want to draw from a partial response.
  // The closing tag is the cheap proof the whole document arrived.
  if (!html.includes('</html>')) {
    throw new ResultsFetchError('page is incomplete (no closing </html>)');
  }

  const flight = extractFlightPayload(html);
  if (!flight) {
    throw new ResultsFetchError('no RSC flight payload in page');
  }

  // Riot's own id for this tournament, present on every real event page whether
  // or not it has results. Its absence means we are not looking at a whole page.
  if (!flight.includes(`"esportsTournamentId":"${tournamentId}"`)) {
    throw new ResultsFetchError('page does not identify the tournament (truncated or unexpected markup)');
  }

  const registrants: PrbRegistrant[] = [];
  const seenRegistrants = new Set<string>();
  for (const json of extractRegistrantArrays(flight)) {
    let parsed: PrbRegistrant[];
    try {
      parsed = JSON.parse(json) as PrbRegistrant[];
    } catch (error) {
      throw new ResultsFetchError(
        `registrant list did not parse (${error instanceof Error ? error.message : String(error)})`
      );
    }
    for (const registrant of parsed) {
      const key = registrant?.id ?? registrant?.player?.id;
      if (!key || seenRegistrants.has(key)) continue;
      seenRegistrants.add(key);
      registrants.push(registrant);
    }
  }

  const json = extractTournamentJson(flight);
  if (!json) return { detail: null, registrants };

  let detail: PrbTournamentDetail;
  try {
    detail = JSON.parse(json) as PrbTournamentDetail;
  } catch (error) {
    throw new ResultsFetchError(
      `tournament object did not parse (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (!Array.isArray(detail.stages)) {
    throw new ResultsFetchError('tournament object carries no stages array');
  }

  return { detail, registrants };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Riot's synthetic bye ids, which must never reach a rated player or team. */
function isByeId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(BYE_ID_PREFIX);
}

/** Riot sends tiebreakers as decimal strings; keep 4 places so items stay small. */
function toPercentage(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 10_000) / 10_000;
}

function toCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function outcomeObjects(entries: (PrbTeamOutcome | string)[] | null | undefined): PrbTeamOutcome[] {
  return (entries ?? []).filter((entry): entry is PrbTeamOutcome => typeof entry === 'object' && entry !== null);
}

/** Every round across every stage and section, flattened in document order. */
function flattenRounds(stages: PrbStage[]): { section: number; round: PrbRound }[] {
  const flat: { section: number; round: PrbRound }[] = [];
  let section = 0;
  for (const stage of stages) {
    for (const sec of stage?.sections ?? []) {
      for (const round of sec?.rounds ?? []) {
        flat.push({ section, round });
      }
      section++;
    }
  }
  return flat;
}

/**
 * Normalize one pairing.
 *
 * `teamId` is the join key the rating engine needs: it ties a side to its
 * standings row and, via the players list, to a stable player UUID.
 */
function normalizeMatch(match: PrbMatch): ResultMatch | null {
  const matchId = match?.esportsMatchId;
  if (!matchId) return null;

  const games: ResultGame[] = [];
  const gameWins = new Map<string, number>();
  let gameNumber = 0;
  for (const game of match.games ?? []) {
    gameNumber++;
    const winner = outcomeObjects(game?.teamOutcomes).find(outcome => outcome.outcome === 'WIN');
    const winnerTeamId = winner?.esportsTeamId ?? null;
    if (winnerTeamId) gameWins.set(winnerTeamId, (gameWins.get(winnerTeamId) ?? 0) + 1);
    games.push({ number: toCount(game?.number) ?? gameNumber, winnerTeamId });
  }

  const sides: ResultMatchSide[] = [];
  for (const outcome of outcomeObjects(match.teamOutcomes)) {
    const teamId = outcome.esportsTeamId;
    if (!teamId) continue;
    sides.push({ teamId, outcome: outcome.outcome ?? null, gameWins: gameWins.get(teamId) ?? 0 });
  }

  return {
    matchId,
    tableNumber: toCount(match.tableNumber),
    status: match.status ?? null,
    bye: isByeId(matchId) || sides.some(side => isByeId(side.teamId)),
    sides,
    games,
  };
}

function normalizeStanding(entry: PrbStandingEntry): ResultStanding | null {
  if (!entry?.esportsTeamId || typeof entry.rank !== 'number') return null;
  return {
    rank: entry.rank,
    teamId: entry.esportsTeamId,
    matchPoints: toCount(entry.matchPoints),
    matchWins: toCount(entry.matchWins),
    matchLosses: toCount(entry.matchLosses),
    matchDraws: toCount(entry.matchDraws),
    opponentMatchWinPct: toPercentage(entry.opponentMatchWinPercentage),
    gameWinPct: toPercentage(entry.gameWinPercentage),
    opponentGameWinPct: toPercentage(entry.opponentGameWinPercentage),
  };
}

/**
 * Collect one entry per team: `esportsTeamId` -> stable player UUID (+ the
 * mutable display name that goes with it).
 *
 * `tournamentParticipants` is the authoritative list - it is the only place with
 * a tagLine - but it is not always complete, so the pairings' own
 * `teams[].players[]` fill the gaps. Riot's bye pseudo-players are dropped here,
 * which is the single place they could otherwise leak into rated data.
 */
function collectPlayers(detail: PrbTournamentDetail, rounds: { round: PrbRound }[]): ResultPlayer[] {
  const byTeam = new Map<string, ResultPlayer>();

  const add = (teamId: string | null | undefined, player: PrbPlayer | null | undefined) => {
    if (!teamId || isByeId(teamId) || byTeam.has(teamId)) return;
    if (isByeId(player?.id)) return;
    byTeam.set(teamId, {
      teamId,
      playerId: player?.id ?? null,
      name: sanitizeText(player?.displayName),
      tagLine: sanitizeText(player?.tagLine),
    });
  };

  const participants = Array.isArray(detail.tournamentParticipants) ? detail.tournamentParticipants : [];
  for (const participant of participants) {
    add(participant?.esportsTeamId, participant?.player);
  }
  for (const { round } of rounds) {
    for (const match of round?.matches ?? []) {
      for (const team of match?.teams ?? []) {
        add(team?.esportsTeamId, team?.players?.[0]);
      }
    }
  }

  return [...byTeam.values()];
}

/**
 * Turn Riot's tournament detail into the results fact we store.
 *
 * Only the *final* standings are kept. Riot publishes `endOfRoundStandings` on
 * every round, but the intermediate tables are reconstructible from the pairings
 * and would multiply the stored personal data by the round count for no reader
 * benefit.
 */
export function normalizeResults(context: EventFactContext, detail: PrbTournamentDetail): EventResults {
  const flat = flattenRounds(detail.stages ?? []);

  const rounds: ResultRound[] = flat.map(({ section, round }) => ({
    section,
    roundNumber: toCount(round?.roundNumber) ?? 0,
    status: round?.status ?? null,
    byeTeamIds: (round?.byeTeamIds ?? []).filter((id): id is string => typeof id === 'string'),
    matches: (round?.matches ?? [])
      .map(normalizeMatch)
      .filter((match): match is ResultMatch => match !== null),
  }));

  // The last round that actually produced a standings table - the final round
  // can be empty when an organizer cut the event short.
  let standings: ResultStanding[] = [];
  for (let i = flat.length - 1; i >= 0; i--) {
    const entries = (flat[i].round?.endOfRoundStandings ?? [])
      .map(normalizeStanding)
      .filter((entry): entry is ResultStanding => entry !== null);
    if (entries.length > 0) {
      standings = entries.sort((a, b) => a.rank - b.rank);
      break;
    }
  }

  const players = collectPlayers(detail, flat);
  const openMatches = rounds.reduce(
    (total, round) => total + round.matches.filter(match => match.status !== 'COMPLETED').length,
    0
  );
  // Round status is the authority on finality, not match status. Riot's
  // tournament software routinely leaves matches reading IN_PROGRESS in a round
  // it has FINALIZED - 21 of 22 matches in one verified event, all 23 in
  // another - while the round's standings are complete and correct. Gating
  // `final` on match status would therefore mark almost every event `partial`
  // and double the fetches for no new data. `openMatches` is still recorded, as
  // a data-quality signal rather than a gate.
  const roundsFinalized = rounds.length > 0 && rounds.every(round => round.status === 'FINALIZED');
  const hasResults = rounds.some(round => round.matches.length > 0) || standings.length > 0;

  let status: EventResultsStatus;
  if (!hasResults) status = 'none';
  else if (roundsFinalized) status = 'final';
  else status = 'partial';

  return sanitizeEventResults(
    trimToItemLimit({
      ...context,
      status,
      roundCount: rounds.length,
      playerCount: status === 'none' ? 0 : players.length,
      openMatches,
      players: status === 'none' ? [] : players,
      standings,
      rounds: status === 'none' ? [] : rounds,
      sourceUpdatedAt: toTimestamp(detail.updatedAt),
      capturedAt: new Date().toISOString(),
    })
  );
}

/** An event page that read fine but holds no results at all. */
export function emptyResults(context: EventFactContext): EventResults {
  return {
    ...context,
    status: 'none',
    roundCount: 0,
    playerCount: 0,
    openMatches: 0,
    players: [],
    standings: [],
    rounds: [],
    sourceUpdatedAt: null,
    capturedAt: new Date().toISOString(),
  };
}

/** Drop the pairings if an outsized tournament would push the item near DynamoDB's 400KB cap. */
function trimToItemLimit(results: EventResults): EventResults {
  if (JSON.stringify(results).length <= MAX_RESULT_BYTES) return results;
  console.warn(
    `[prb-results] ${results.externalId}: ${results.roundCount} rounds exceed the item budget - ` +
      'keeping standings only'
  );
  return { ...results, rounds: [], trimmed: true };
}

/**
 * Turn the "Registered Players" list into the roster fact we store.
 *
 * `acceptedTermsAt` is the reason one snapshot is enough: it dates every signup,
 * so the whole registration curve is reconstructible after the fact and nothing
 * has to be polled. Returns null when nobody has signed up - normal for a new
 * event, and not a fact worth a row.
 */
export function normalizeRosterFromRegistrants(
  context: EventFactContext,
  registrants: PrbRegistrant[]
): EventRoster | null {
  const entries: RosterEntry[] = [];
  const seen = new Set<string>();

  for (const registrant of registrants) {
    const playerId = registrant?.player?.id;
    // Identity is the stable UUID; display names are user-editable and churn.
    if (!playerId || isByeId(playerId) || seen.has(playerId)) continue;
    seen.add(playerId);
    entries.push({
      playerId,
      name: sanitizeText(registrant.player?.displayName),
      tagLine: sanitizeText(registrant.player?.tagLine),
      teamId: null, // registrants carry a per-tournament team UUID, not an esportsTeamId
      status: registrant.status ?? null,
      checkedIn: typeof registrant.checkedIn === 'boolean' ? registrant.checkedIn : null,
      waitlistPosition: toCount(registrant.waitlistPosition),
      registeredAt: toTimestamp(registrant.acceptedTermsAt),
    });
  }

  if (entries.length === 0) return null;
  return sanitizeEventRoster({
    ...context,
    source: 'registrants',
    playerCount: entries.length,
    entries,
    capturedAt: new Date().toISOString(),
  });
}

/**
 * Roster from a played event's participant list.
 *
 * The fallback for an event we never caught while it was upcoming. It has no
 * signup timestamps, but it does carry the `esportsTeamId` that joins each
 * player to their standings and pairings - so a roster recovered this way is
 * still enough to know who was in the field.
 */
export function normalizeRosterFromResults(
  context: EventFactContext,
  results: EventResults
): EventRoster | null {
  const entries: RosterEntry[] = results.players
    .filter(player => player.playerId !== null && !isByeId(player.playerId))
    .map(player => ({
      playerId: player.playerId as string,
      name: player.name,
      tagLine: player.tagLine,
      teamId: player.teamId,
      status: 'PLAYED',
      checkedIn: null,
      waitlistPosition: null,
      registeredAt: null,
    }));

  if (entries.length === 0) return null;
  return sanitizeEventRoster({
    ...context,
    source: 'participants',
    playerCount: entries.length,
    entries,
    capturedAt: new Date().toISOString(),
  });
}

/**
 * `prb-117209411862156256` -> `117209411862156256`.
 *
 * **Not the candidate loader's rule, and not a substitute for it.** On a merged
 * row this returns the UVS id unchanged, which is not a tournament id at all.
 * Anything deciding "which Riot tournament is this row" wants
 * `resultsCandidateTournamentId` in playriftbound.ts; this is only the prefix
 * strip, for a caller that already knows it holds a `prb-` id.
 */
export function tournamentIdFromExternalId(externalId: string): string {
  return externalId.startsWith(PLAYRIFTBOUND_ID_PREFIX)
    ? externalId.slice(PLAYRIFTBOUND_ID_PREFIX.length)
    : externalId;
}

export function eventPageUrl(tournamentId: string): string {
  return `${EVENT_PAGE_BASE}/${tournamentId}`;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface EventFacts {
  /** Null when the page was read for a roster only (an event that has not happened). */
  results: EventResults | null;
  roster: EventRoster | null;
}

/**
 * Fetch one event page and normalize whatever facts it holds.
 *
 * `wantResults` is false for a pre-event roster snapshot: an upcoming event has
 * no results, and recording an empty results capture for it would burn the
 * event's attempt budget before it had even been played.
 */
export async function fetchEventFacts(
  context: EventFactContext,
  options: { wantResults: boolean; fetchImpl?: typeof fetch }
): Promise<EventFacts> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { tournamentId } = context;
  if (!/^\d+$/.test(tournamentId)) {
    throw new ResultsFetchError(`unexpected tournament id ${tournamentId}`);
  }

  let response: Response;
  try {
    response = await fetchImpl(eventPageUrl(tournamentId), {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ResultsFetchError(error instanceof Error ? error.message : String(error));
  }

  // Riot took the tournament down: record it as resultless so we stop asking.
  if (response.status === 404 || response.status === 410) {
    return { results: options.wantResults ? emptyResults(context) : null, roster: null };
  }
  // 429/403 is Riot talking about *us* - rate limited or blocked - so the whole
  // pass stands down.
  if (response.status === 429 || response.status === 403) {
    const retryAfter = response.headers.get('retry-after');
    throw new ResultsBackoffError(`HTTP ${response.status}${retryAfter ? ` (retry-after ${retryAfter})` : ''}`);
  }
  // A 5xx is usually about *one event*, not about us, and must not stop the run.
  // Measured: prb-117243252865991615 returns 500 on every attempt - three in a
  // row, byte-identical 154,608-byte error pages - while control events return
  // 200. Treating that as a backoff signal aborted a backfill run after 84 of
  // 250 items, and because the queue is deterministic and oldest-first, a
  // permanently broken page would eventually sit at the head of it and reduce
  // every subsequent run to zero progress. So this is a per-event failure: the
  // event stays due and costs one wasted request per run (1 of 250, negligible),
  // while MAX_CONSECUTIVE_FAILURES still stops the pass when Riot is genuinely
  // down and the 5xxs arrive in a row rather than one at a time.
  if (response.status >= 500) {
    throw new ResultsFetchError(`HTTP ${response.status}: ${response.statusText || 'server error'}`);
  }
  if (!response.ok) {
    throw new ResultsFetchError(`HTTP ${response.status}: ${response.statusText}`);
  }

  const page = parseEventPage(await response.text(), tournamentId);

  const results = page.detail
    ? normalizeResults(context, page.detail)
    : options.wantResults
      ? emptyResults(context)
      : null;

  // Registrations are the richer fact (they are dated), so they win when both
  // are on the page; a played event with no registrant list falls back to who
  // actually turned up.
  const roster =
    normalizeRosterFromRegistrants(context, page.registrants) ??
    (results ? normalizeRosterFromResults(context, results) : null);

  return { results, roster };
}

// ---------------------------------------------------------------------------
// Selecting the work for this run
// ---------------------------------------------------------------------------

/** The two kinds of fact this pass captures; one page fetch satisfies either. */
export type FactKind = 'roster' | 'results';

export interface FactWorkItem {
  candidate: EventFactCandidate;
  kind: FactKind;
}

export interface DueSelectionOptions {
  now?: Date;
  /** Hard cap for one run; the remainder rolls over to the next. */
  max?: number;
  rosterLeadMs?: number;
  settleMs?: number;
  recheckAfterMs?: number;
  maxAttempts?: number;
}

/**
 * Pick the event pages worth fetching this run.
 *
 * Roster work comes first and is ordered by start time, because its window
 * closes the moment the event begins - a missed roster can only be recovered as
 * the thinner participants list afterwards. Results work is never urgent, so it
 * is queued oldest-first: the longer an event has been over, the more likely its
 * organizer has finished closing it out.
 *
 * Anything already captured is never fetched again, which is what keeps the pass
 * at two requests per event for its whole life.
 */
export function selectDueEventFacts(
  candidates: EventFactCandidate[],
  options: DueSelectionOptions = {}
): FactWorkItem[] {
  const now = (options.now ?? new Date()).getTime();
  const rosterLeadMs = options.rosterLeadMs ?? ROSTER_LEAD_MS;
  const settleMs = options.settleMs ?? RESULTS_SETTLE_MS;
  const recheckAfterMs = options.recheckAfterMs ?? RESULTS_RECHECK_AFTER_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const max = options.max ?? DEFAULT_MAX_EVENTS_PER_RUN;

  const rosterDue: EventFactCandidate[] = [];
  const resultsDue: EventFactCandidate[] = [];

  for (const candidate of candidates) {
    const start = candidate.eventStartDate?.getTime();
    if (start === undefined || !Number.isFinite(start)) continue;

    if (now < start) {
      // Upcoming: one roster snapshot, taken close enough to the start that the
      // field is nearly final.
      if (!candidate.hasRoster && start - now <= rosterLeadMs) rosterDue.push(candidate);
      continue;
    }

    if (now - start < settleMs) continue; // still running

    const results = candidate.results;
    if (results === null) {
      resultsDue.push(candidate);
      continue;
    }
    if (results.status === 'final') continue; // immutable, done
    if (results.attempts >= maxAttempts) continue; // out of re-checks

    const lastChecked = results.lastCheckedAt?.getTime();
    if (lastChecked === undefined || !Number.isFinite(lastChecked) || now - lastChecked >= recheckAfterMs) {
      resultsDue.push(candidate);
    }
  }

  rosterDue.sort((a, b) => a.eventStartDate.getTime() - b.eventStartDate.getTime());
  resultsDue.sort((a, b) => a.eventStartDate.getTime() - b.eventStartDate.getTime());

  const work: FactWorkItem[] = [
    ...rosterDue.map(candidate => ({ candidate, kind: 'roster' as const })),
    ...resultsDue.map(candidate => ({ candidate, kind: 'results' as const })),
  ];
  return max > 0 ? work.slice(0, max) : work;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface ResultsPassOptions {
  /** Delay between page fetches (env: PLAYRIFTBOUND_REQUEST_DELAY_MS). */
  requestDelayMs?: number;
  /** Pages fetched per run; the rest roll over to the next run. */
  maxEvents?: number;
  /** How far back in the events table to look for finished events. */
  lookbackDays?: number;
  /** How far ahead to look for events needing a roster snapshot. */
  lookaheadDays?: number;
  /** Epoch ms after which no new request is started (Lambda time budget). */
  deadline?: number;
  /** Injectable for tests. */
  now?: Date;
  fetchImpl?: typeof fetch;
}

export interface ResultsPassSummary {
  /** Stored `prb-` events inside the lookback/lookahead window. */
  candidates: number;
  due: number;
  rosterDue: number;
  resultsDue: number;
  fetched: number;
  /** Captures that held real pairings and standings. */
  withResults: number;
  /** Finished events the organizer never ran pairings for. */
  withoutResults: number;
  rostersWritten: number;
  resultsWritten: number;
  /** Re-checks that found nothing new, so only the attempt counter was written. */
  unchanged: number;
  failed: number;
  /** Due pages the deadline or the per-run cap left for the next run. */
  notFetched: number;
  requests: number;
  /** True when the pass stopped early (deadline, backoff or repeated failures). */
  partial: boolean;
  durationMs: number;
  skippedReason?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run the pass: select due events, fetch one page each at the polite rate, and
 * store the facts that come back.
 *
 * Never throws for a single bad event, and stops cleanly on a deadline or a
 * backoff signal so the remainder simply rolls over to the next run.
 *
 * Logging is deliberately counts-only - no player names, no event names - because
 * these rows are individuals' attendance and match histories (see
 * scraper/CLAUDE.md).
 */
export async function runPlayriftboundResultsPass(
  options: ResultsPassOptions = {}
): Promise<ResultsPassSummary> {
  const startedAt = Date.now();
  const summary: ResultsPassSummary = {
    candidates: 0,
    due: 0,
    rosterDue: 0,
    resultsDue: 0,
    fetched: 0,
    withResults: 0,
    withoutResults: 0,
    rostersWritten: 0,
    resultsWritten: 0,
    unchanged: 0,
    failed: 0,
    notFetched: 0,
    requests: 0,
    partial: false,
    durationMs: 0,
  };

  if (!supportsEventFacts()) {
    summary.skippedReason = 'results storage requires SQLite or DynamoDB';
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const requestDelayMs = Math.max(0, options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS);
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const lookaheadDays = options.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const candidates = await loadEventFactCandidates({ daysBack: lookbackDays, daysForward: lookaheadDays });
  summary.candidates = candidates.length;

  const work = selectDueEventFacts(candidates, {
    now: options.now,
    max: options.maxEvents ?? DEFAULT_MAX_EVENTS_PER_RUN,
  });
  summary.due = work.length;
  summary.notFetched = work.length;
  summary.rosterDue = work.filter(item => item.kind === 'roster').length;
  summary.resultsDue = work.length - summary.rosterDue;

  console.log(
    `[prb-results] ${work.length} of ${candidates.length} playriftbound events due ` +
      `(${summary.rosterDue} rosters, ${summary.resultsDue} results; ` +
      `-${lookbackDays}/+${lookaheadDays} day window, ${requestDelayMs}ms between requests)`
  );
  if (work.length === 0) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  let consecutiveFailures = 0;

  for (const { candidate, kind } of work) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      console.warn(
        `[prb-results] time budget reached after ${summary.fetched} pages - ` +
          `${summary.notFetched} roll over to the next run`
      );
      summary.partial = true;
      break;
    }

    if (summary.requests > 0) await sleep(requestDelayMs);

    summary.requests++;
    let facts: EventFacts;
    try {
      facts = await fetchEventFacts(candidate, { wantResults: kind === 'results', fetchImpl });
      consecutiveFailures = 0;
    } catch (error) {
      summary.failed++;
      consecutiveFailures++;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ResultsBackoffError || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`[prb-results] ${candidate.externalId}: ${message} - backing off, stopping this run`);
        summary.partial = true;
        break;
      }
      // Nothing is recorded, so the event stays due and is retried next run.
      console.error(`[prb-results] ${candidate.externalId}: ${message} - continuing`);
      continue;
    }

    summary.fetched++;
    summary.notFetched--;

    try {
      // A roster already on file is the dated one; never overwrite it with the
      // thinner participants list a later fetch would produce.
      if (facts.roster && !candidate.hasRoster) {
        await saveEventRoster(facts.roster);
        summary.rostersWritten++;
      }
      if (facts.results) {
        if (facts.results.status === 'none') summary.withoutResults++;
        else summary.withResults++;
        const saved = await saveEventResults(facts.results);
        if (saved.skipped) summary.unchanged++;
        else summary.resultsWritten++;
      }
    } catch (error) {
      summary.failed++;
      console.error(
        `[prb-results] ${candidate.externalId}: storing facts failed ` +
          `(${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  summary.durationMs = Date.now() - startedAt;
  console.log(
    `[prb-results] fetched ${summary.fetched} pages in ${summary.requests} requests: ` +
      `${summary.rostersWritten} rosters, ${summary.resultsWritten} results written ` +
      `(${summary.withResults} with pairings, ${summary.withoutResults} listing-only, ` +
      `${summary.unchanged} unchanged), ${summary.failed} failed, ${summary.notFetched} left for later`
  );
  return summary;
}
