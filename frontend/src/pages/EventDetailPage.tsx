import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import type { Event } from '../types/event';
import type {
  TournamentDetail,
  TournamentMatch,
  TournamentPlayer,
  TournamentResults,
  TournamentRoster,
  TournamentRound,
  TournamentScene,
  TournamentSidePlayer,
} from '../types/tournament';
import { ApiError, getEvent, getEventTournament } from '../services/api';
import {
  formatRating,
  formatUncertainty,
  gateProgress,
  outcomeLetter,
  outcomeWord,
  ratingDisplay,
  ratingExplanation,
  recordSpoken,
  sceneMapPath,
  scenePath,
  UNRANKED_LABEL,
} from '../lib/ranking';
import {
  fieldBand,
  fieldComposition,
  fieldSegmentHint,
  formatClock,
  formatPercent,
  gameOutcomeForTeam,
  matchDecided,
  matchHasPlay,
  matchScore,
  orderedMatches,
  playedGames,
  NOT_FINAL_REASON,
  rosterColumns,
  rosterNote,
  roundIsFinal,
  roundStatusLabel,
  sceneLine,
  sectionLabel,
  sideOutcome,
  standingRecord,
  titleCaseEnum,
  TRIMMED_LABEL,
  unlistedByes,
  trimmedReason,
} from '../lib/tournament';
import { carryPreview, isRankingsPreview } from '../lib/preview';

/**
 * One event: what it is, who is in it, and what happened.
 *
 * The reference is UVS's own event page - event info, then tournament details,
 * then standings, pairings and roster. The difference is that theirs renders
 * "No standings available" for events we have the standings to. So this page is
 * built around the states that page gets wrong:
 *
 *  - **Upcoming, roster only.** `results: null` with a roster is not an error
 *    and not an empty page: it is the strength-of-field preview, and the most
 *    interesting thing about an event that has not happened yet. It gets the
 *    same summary block a played event gets.
 *  - **Pairings trimmed.** `trimmed: true` means `rounds: []` with the
 *    standings intact, because the round-by-round detail was too large to
 *    store. Saying nothing there would read as "nothing happened".
 *  - **Results captured with nothing in them.** `status: 'none'` is the ~29% of
 *    finished events whose organiser never ran pairings through Riot's
 *    software. A fact, not a failure.
 *
 * Two honesty rules carried over from the Rankings section:
 *
 *  - A rating below the confidence gate is never printed. The player reads
 *    `Unranked`, with the reason as the tooltip on that word.
 *  - A player the engine has never seen is **not** the same thing. They read
 *    "No record yet", because telling someone at their first event that they
 *    are "unranked" claims they failed a bar they never stood at.
 */

function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  /*
   * The back-link, once, for all of this page's states.
   *
   * This page is reached from the trophy, which only exists inside the
   * Rankings preview, so its own query string carries the flag - and has to
   * hand it back. The calendar's filters ride along in the same string
   * (`linkSearch` on the hover card), so returning here restores the view the
   * reader left, flag included. One link that dropped it would put them on a
   * calendar with the preview silently off (lib/preview.ts).
   */
  const { search } = useLocation();
  const backToEvents = carryPreview('/', search);
  // Two independent fetches. The calendar row carries the name, venue and
  // price; the facts carry everything else and outlive the row, so either can
  // be missing and the page still renders what it has.
  const [event, setEvent] = useState<Event | null>(null);
  const [detail, setDetail] = useState<TournamentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [factsError, setFactsError] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setFactsError(false);

    const eventRow = getEvent(id)
      .then((response) => (cancelled ? null : response.data))
      .catch(() => null);

    // 404 here is the normal case, not an error: most events never have a
    // tournament fact at all.
    const facts = getEventTournament(id)
      .then((response) => (cancelled ? null : response.data))
      .catch((caught: unknown) => {
        const missing = caught instanceof ApiError && caught.status === 404;
        if (!cancelled && !missing) setFactsError(true);
        return null;
      });

    Promise.all([eventRow, facts])
      .then(([row, data]) => {
        if (cancelled) return;
        setEvent(row);
        setDetail(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="event-page">
        <Link to={backToEvents} className="back-link">&larr; Back to events</Link>
        <p className="muted">Loading event...</p>
      </div>
    );
  }

  if (!event && !detail) {
    return (
      <div className="event-page">
        <Link to={backToEvents} className="back-link">&larr; Back to events</Link>
        <section className="panel empty-state">
          <h2>No event here</h2>
          <p>
            <Link to={backToEvents}>Find an event near you &rarr;</Link>
          </p>
        </section>
      </div>
    );
  }

  const context = detail?.event ?? null;
  // Events age off the calendar after a couple of months while the facts stay,
  // so the name can be gone. Falling back to the type alone beats pasting an
  // id into a heading: the id is provenance, and it goes in the footer row.
  const name = event?.name ?? context?.eventType ?? 'Event';
  const startDate = event?.startDate ?? context?.startDate ?? null;
  const eventType = event?.eventType ?? context?.eventType ?? null;
  const results = detail?.results ?? null;
  const roster = detail?.roster ?? null;

  return (
    <div className="event-page">
      <Link to={backToEvents} className="back-link">&larr; Back to events</Link>

      {factsError && (
        <div className="error-banner">
          Could not load this event&apos;s standings. The event details below are unaffected.
        </div>
      )}

      <header className="panel event-summary">
        <div className="event-identity">
          <h1>{name}</h1>
          <p className="event-meta">
            {eventType && <span className="scope-chip">{eventType}</span>}
            {context?.playFormat && <span>{titleCaseEnum(context.playFormat)}</span>}
            <span>{formatDateTime(startDate)}</span>
          </p>
          <EventWhere event={event} />
          {detail && <EventScene scene={detail.scene} minComponentSize={detail.field.minComponentSize} />}
        </div>

        {/* With no facts at all there is no field block: the panel below
            already says so, and saying it twice reads as a bug. */}
        {detail && <FieldStrengthBlock detail={detail} />}

        {/* Only the figures this event actually has. An upcoming event has no
            round count, and a column of em-dashes reads as missing data. */}
        <dl className="event-figures">
          <div>
            <dt>{results ? 'Players' : 'Signed up'}</dt>
            <dd>{detail ? detail.field.totalPlayers : event?.playerCount ?? '--'}</dd>
          </div>
          {results ? (
            <div>
              <dt>Rounds</dt>
              <dd>{results.roundCount}</dd>
            </div>
          ) : (
            event?.capacity != null && (
              <div>
                <dt>Capacity</dt>
                <dd>{event.capacity}</dd>
              </div>
            )
          )}
          {event?.price && (
            <div>
              <dt>Entry</dt>
              <dd className="event-figure-text">{event.price}</dd>
            </div>
          )}
        </dl>

        <div className="event-links">
          {event && (
            <a
              href={`/api/events/${encodeURIComponent(event.id)}/visit`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Event page and sign-up &rarr;
            </a>
          )}
          <CaptureProvenance results={results} roster={roster} />
          {!event && context && (
            <span className="muted">Event {context.externalId}</span>
          )}
        </div>
      </header>

      {/* The four shapes this page comes in. */}
      {!detail ? (
        <NoFacts />
      ) : results && results.status === 'none' ? (
        <NoPairingsRun />
      ) : null}

      {results && results.status !== 'none' && (
        <StandingsSection results={results} minGames={detail?.field.minGamesForRating ?? 8} />
      )}

      {results && results.status !== 'none' && (
        <PairingsSection results={results} />
      )}

      {roster && (
        <RosterSection
          roster={roster}
          results={results}
          minGames={detail?.field.minGamesForRating ?? 8}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

function formatDateTime(iso: string | null): string {
  if (!iso) return 'Date unknown';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return 'Date unknown';
  return value.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function EventWhere({ event }: { event: Event | null }) {
  if (!event) {
    return <p className="event-where muted">Venue not recorded.</p>;
  }
  const place = [event.city, event.state, event.country].filter(Boolean).join(', ');
  return (
    <p className="event-where">
      {event.location ?? event.organizer ?? 'Venue unknown'}
      {event.address && <span className="event-address">{event.address}</span>}
      {!event.address && place && <span className="event-address">{place}</span>}
    </p>
  );
}

/**
 * Which scene this event belongs to, and the way into that scene's ladder.
 *
 * ## Why this line can exist at all
 *
 * A scene is a connected component of the co-play graph, so "which scene is
 * this event in" is normally a question about *people*, answered per player.
 * It is answerable about an **event** because the event's own matches are
 * edges in that graph: every player a chain of this event's pairings links is
 * in the same component by construction. The API does that counting (it holds
 * the profiles) and publishes the dominant scene with the counts it rests on,
 * so nothing here votes, infers or geocodes.
 *
 * ## The gating, which is not optional
 *
 * **Rankings is unlisted, and this event page is reachable without the flag.**
 * The trophy that leads here is already gated on `isRankingsPreview`
 * (CalendarPage, DayEventsModal), so a reader who arrives *without* the
 * parameter did not come through Rankings - from a shared link, say - and must
 * see no trace of the section. Hence the predicate, and hence `carryPreview`
 * on both links: the flag is not persisted anywhere, so a link that dropped it
 * would land on a ladder with no mode switch and no way back (lib/preview.ts).
 *
 * Note this is a *stricter* rule than the player links on this page follow -
 * those render for everyone, because a name with no link reads as missing data
 * where an absent line reads as nothing at all. A whole labelled row called
 * "Scene" is an advertisement for the section in a way a player's name is not.
 *
 * ## Two links, because they answer different questions
 *
 * The name goes to the scene's ladder (`component:<id>`, via `scenePath`) -
 * "who is good here". `Map` goes to `/rankings/map` with this scene already
 * selected, which is "where is this scene", and is a link rather than a second
 * ladder because the map's selection lives in its URL precisely so one scene
 * is shareable. Both paths are the ones those pages already define.
 */
function EventScene({
  scene,
  minComponentSize,
}: {
  scene: TournamentScene;
  /** The published scene-size gate, so the caveat quotes the real number. */
  minComponentSize: number;
}) {
  const { search } = useLocation();
  // Read before anything else: an unflagged reader gets no line, no request
  // and no mention of Rankings.
  if (!isRankingsPreview(search)) return null;

  const line = sceneLine(scene, minComponentSize);

  // Nothing was ever paired here - an upcoming event, or one of the ~29% whose
  // organiser never ran pairings. The page already says the event has no
  // standings; a line saying it has no scene either would be the same absence
  // twice, and the honest thing to do with a question that has no answer is
  // not to pose it.
  if (line.kind === 'none') return null;

  // Games were played and nobody in them is placed yet. Worth one muted line,
  // because "this event has no scene" and "the ladder has not caught up with
  // this event" are different claims and only the second is true.
  if (line.kind === 'pending') {
    return (
      <p className="event-scene">
        <span className="event-scene-label">Scene</span>
        <span className="event-scene-pending" title={line.hint}>
          Not placed yet
        </span>
      </p>
    );
  }

  // The scene is named from the event's **store**; the links are scoped to the
  // rating pool those players share, because a ladder is only meaningful over
  // one scale and a scene does not define one (see `sceneLine`). When the
  // engine has placed nobody who played here there is no pool to link at, so
  // the name is plain text rather than a link to nowhere - the scene is still
  // a fact about the store and is still worth printing.
  const componentId = line.componentId;

  return (
    <p className="event-scene">
      <span className="event-scene-label">Scene</span>
      {componentId === null ? (
        <span className="event-scene-name" title={line.hint}>
          {line.name}
        </span>
      ) : (
        <Link
          className="event-scene-name"
          to={carryPreview(scenePath(componentId), search)}
          title={line.hint}
        >
          {line.name}
        </Link>
      )}
      {line.summary && <span className="event-scene-summary">{line.summary}</span>}
      {/* The caveat is a word, not a colour, and it carries its own reason -
          the same rule the result pips and the map's flags follow. */}
      {line.partial && (
        <span className="event-scene-partial" title={line.hint}>
          mostly
        </span>
      )}
      {componentId !== null && (
        <Link className="event-scene-map" to={carryPreview(sceneMapPath(componentId), search)}>
          Map
        </Link>
      )}
    </p>
  );
}

/**
 * Strength of field: **one word, and the field counted in three groups.**
 *
 * ## What left, and why
 *
 * A mean at display size, a line of prose naming the players it was taken
 * over, a coverage meter, and a median-and-top line. All four are gone, and
 * the measurement is the reason rather than taste: over 11,946 production
 * events with a captured field, the between-event SD of the mean rating is
 * **0.0** against a within-event SD of 84.2 (ICC 0.000). Events do not
 * measurably differ in strength, so four surfaces were spent on a figure whose
 * variation is sampling noise. `fieldBand` keeps the one grain the data
 * supports - a quartile of that distribution, as a word - with the caveat on
 * hover.
 *
 * ## The counter said three where the table showed six
 *
 * This block read "3 Rated &middot; 10 Unranked" over a roster printing **six**
 * rating numbers, because one word covered two different thresholds: the
 * display floor (3 recorded games, whether a number appears) and the rank gate
 * (8 games, margin, scene size - whether a position is held). Three of the ten
 * were between them and had their rating printed beside the word denying it.
 *
 * So the legend counts three groups, through the very `ratingDisplay` the
 * table cells branch on, which is what makes the two agree by construction
 * rather than by arithmetic that has to be kept in step. The reason for each
 * group is its hover hint, never prose on the page - the rule the whole
 * Rankings section follows.
 */
function FieldStrengthBlock({ detail }: { detail: TournamentDetail }) {
  const field = detail.field;

  // Nothing was ever recorded about who was here. Three zeroes in a legend is
  // furniture, not information.
  if (field.totalPlayers === 0) {
    return (
      <div className="event-strength">
        <span className="stat-label">Field</span>
        <p className="field-unmeasured">No field recorded</p>
      </div>
    );
  }

  const band = fieldBand(field);
  // From the players, not from `field`: the same function the table cells use,
  // so a reader counting rating numbers in the table gets the legend's answer.
  const segments = fieldComposition(detail.players);

  return (
    <div className="event-strength">
      <span className="stat-label">Strength of field</span>
      {band.kind === 'band' ? (
        // A word, so it is set as one - not in the display face at
        // `--t-display` pretending to be a figure, which is the rule the
        // player page's own withheld headline already follows. The dotted
        // underline is this page's existing "there is a hint here" mark.
        <p className="field-band">
          <abbr className="col-hint" title={band.hint}>{band.label}</abbr>
        </p>
      ) : (
        // Set as a sentence rather than at display size pretending to be a
        // verdict. Deliberately not a band and deliberately not "Unranked":
        // that word belongs to a player, and this is about the field.
        <p className="field-unmeasured" title={band.hint}>
          {band.label}
        </p>
      )}

      <ul className="field-legend">
        {segments.map((segment) => (
          <li key={segment.key} title={fieldSegmentHint(segment.key, field)}>
            <span className="field-legend-count">{segment.count}</span>
            <span className="field-legend-label">{segment.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Where these numbers came from and when. Provenance, not commentary. */
function CaptureProvenance({
  results,
  roster,
}: {
  results: TournamentResults | null;
  roster: TournamentRoster | null;
}) {
  const captured = results?.capturedAt ?? roster?.capturedAt ?? null;
  if (!captured) return null;
  return (
    <span className="event-captured muted">Recorded {formatClock(captured)}</span>
  );
}

// ---------------------------------------------------------------------------
// Empty and sparse states - the primary design, not a fallback
// ---------------------------------------------------------------------------

/**
 * The states this page comes in when there is nothing to table.
 *
 * One line each. Why our scraper has nothing - whether anyone signed up
 * through Riot's software, whether an organiser ran pairings through it - is
 * our plumbing, and a reader who wanted to see who won is not here for it.
 */
function NoFacts() {
  return (
    <section className="panel empty-state">
      <p>No sign-ups or standings have been recorded for this event.</p>
    </section>
  );
}

function NoPairingsRun() {
  return (
    <section className="panel empty-state">
      <p>No pairings or standings were recorded for this event.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// A player, and what we are allowed to say about their rating
// ---------------------------------------------------------------------------

/**
 * A player's name, linked to their ranking page **when there is one**.
 *
 * A player the engine has never seen has no profile, so `/api/players/:id`
 * 404s and the link would be a dead end - which is worse than no link. Known
 * players always link.
 */
function PlayerName({
  player,
  fallbackName,
}: {
  player: TournamentPlayer | TournamentSidePlayer | null;
  fallbackName?: string;
}) {
  const { search } = useLocation();
  const name = player?.displayName ?? fallbackName ?? 'Unknown player';
  const tag = player?.tagLine ?? null;
  const linkable = Boolean(player?.playerId) && isKnown(player);

  const inner = (
    <>
      {name}
      {tag && <span className="player-tag">#{tag}</span>}
    </>
  );

  if (!linkable || !player?.playerId) {
    return <span className="player-name-plain">{inner}</span>;
  }

  return (
    // Four call sites, three of them nested two components deep, so the flag
    // is read off the URL here rather than threaded through the tables. A
    // player link that lost it would land on a page with no mode switch.
    <Link
      to={carryPreview(`/rankings/players/${encodeURIComponent(player.playerId)}`, search)}
      className="player-link"
    >
      {inner}
    </Link>
  );
}

/**
 * The scene a player plays in - **their scene, never their city**.
 *
 * Both tables on this page used to print `player.regionLabel`, which is the
 * player's own home city, so one field read `Redwood City, CA`,
 * `San Carlos, California` and `Sunnyvale, California` where there are two
 * scenes. `sceneLabel` is the engine's own cluster of stores and is the same
 * kind of thing for every row.
 *
 * **A player in no scene reads so, and never falls back to the city.** That is
 * 2.6% of sampled production profiles, and 99.9% of them carry a region - so a
 * `??` here would put a city back in a column headed Scene, silently, on
 * exactly the rows the column was wrong about.
 *
 * The absence is this page's `--` with the reason on hover, not a word.
 * A word would be right for the 2.6%, and wrong for the case that dominates an
 * upcoming event's roster: most of that field is unknown to the engine, so a
 * phrase in every one of those cells would be the column of repeated words
 * this section has already been caught printing once.
 */
function PlayerScene({ player }: { player: TournamentPlayer | null }) {
  if (!player?.sceneLabel) {
    return (
      <span
        className="player-scene-absent"
        title={player?.known ? NO_SCENE_HINT : NO_HOME_STORE_HINT}
      >
        --
      </span>
    );
  }
  return <>{player.sceneLabel}</>;
}

/**
 * A side player on a pairing carries no `known` flag, only `rating` and
 * `provisional`. A non-null rating proves the engine knows them; otherwise we
 * cannot tell from the pairing alone, so a name on a pairing links only when
 * it carries a rating. The standings and roster, which do carry `known`, are
 * where the rest of the field's links come from.
 */
function isKnown(player: TournamentPlayer | TournamentSidePlayer | null): boolean {
  if (!player) return false;
  if ('known' in player) return player.known;
  return player.rating !== null;
}

/**
 * A field player's rating, by the site's one rule (`ratingDisplay`).
 *
 * A number whenever the engine will quote one, muted when it is unsettled,
 * with the margin beside it doing the work the word `Unranked` used to do -
 * a ±156 next to a ±95 says "not settled" without anyone reading a label.
 * The word is left for the one case that has no number at all.
 *
 * This used to have a third branch printing "No record yet" for `known:
 * false`. That distinction was collapsed: a stale engine reported `known:
 * false` for 22 players whose games were rendered on this very page, so the
 * phrase was lying more often than it was informing.
 */
function PlayerRating({
  player,
  minGames,
  showGate = false,
}: {
  player: TournamentPlayer | null;
  minGames: number;
  showGate?: boolean;
}) {
  const display = ratingDisplay(player);
  const why = ratingExplanation(
    display,
    player?.provisionalReason ?? null,
    player?.gamesUntilRated ?? 0,
    minGames
  );

  if (display !== 'none') {
    return (
      <span
        className={display === 'unsettled' ? 'rating-cell-unsettled' : undefined}
        title={why || undefined}
      >
        <span className="rating-value">{formatRating(player?.rating ?? null)}</span>
        <span className="rating-margin">{formatUncertainty(player?.uncertainty ?? null)}</span>
      </span>
    );
  }

  const gate = showGate && player
    ? gateProgress(player.gamesPlayed, minGames, player.provisionalReason)
    : null;

  return (
    <>
      <span className="unranked" title={why || undefined}>
        {UNRANKED_LABEL}
      </span>
      {gate && (
        <span className="gate" title={why || undefined}>
          <span className="gate-pips" aria-hidden="true">
            {Array.from({ length: gate.total }, (_, index) => (
              <span key={index} className={`gate-pip${index < gate.filled ? ' is-filled' : ''}`} />
            ))}
          </span>
          <span className="gate-count">
            {gate.filled}/{gate.total} games
          </span>
        </span>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

const TIEBREAK_HINT =
  "Riot's Swiss tiebreakers, in order: opponents' match win percentage, then game win percentage, then opponents' game win percentage.";

function StandingsSection({
  results,
  minGames,
}: {
  results: TournamentResults;
  /** The published games gate, so "Unranked" and its meter agree with it. */
  minGames: number;
}) {
  return (
    <section className="event-section">
      <div className="section-head">
        <h2>Standings</h2>
        <span className="section-count">{results.standings.length}</span>
        {results.status !== 'final' && (
          <span className="status-chip" title={NOT_FINAL_REASON}>Not final</span>
        )}
      </div>

      {results.standings.length === 0 ? (
        <div className="panel empty-state">
          <p className="muted">
            This event&apos;s results carry no final table - the rounds were recorded but never
            scored.
          </p>
        </div>
      ) : (
        <div className="panel table-scroll">
          <table className="data-table standings-table">
            <thead>
              <tr>
                <th scope="col" className="numeric">#</th>
                <th scope="col">Player</th>
                <th scope="col">Rating</th>
                <th scope="col" className="numeric">Record</th>
                <th scope="col" className="numeric">Pts</th>
                <th scope="col" className="numeric">
                  <abbr className="col-hint" title={TIEBREAK_HINT}>OMW%</abbr>
                </th>
                <th scope="col" className="numeric">
                  <abbr className="col-hint" title={TIEBREAK_HINT}>GW%</abbr>
                </th>
                <th scope="col" className="numeric">
                  <abbr className="col-hint" title={TIEBREAK_HINT}>OGW%</abbr>
                </th>
              </tr>
            </thead>
            <tbody>
              {results.standings.map((standing) => (
                <tr key={standing.teamId}>
                  <td className="numeric rank-cell">
                    <span className={`rank-badge${standing.rank <= 3 ? ' is-top' : ''}`}>
                      {standing.rank}
                    </span>
                  </td>
                  <td>
                    <PlayerName player={standing.player} />
                    {/* The scene, for the reason the roster's column is the
                        scene: this sat under the name as the player's home
                        city, which is a different place for members of one
                        scene. A standings row has no header to hang a hint
                        off, so a player in no scene simply has no line here -
                        an absent sub-label reads as nothing, where a `--`
                        under a name reads as missing data. */}
                    {standing.player?.sceneLabel && (
                      <span className="player-scene" title={SCENE_HINT}>
                        {standing.player.sceneLabel}
                      </span>
                    )}
                  </td>
                  <td className="rating-cell">
                    <PlayerRating player={standing.player} minGames={minGames} />
                  </td>
                  <td className="numeric">{standingRecordCell(standing)}</td>
                  <td className="numeric">{standing.matchPoints ?? '--'}</td>
                  <td className="numeric">{formatPercent(standing.opponentMatchWinPct)}</td>
                  <td className="numeric">{formatPercent(standing.gameWinPct)}</td>
                  <td className="numeric">{formatPercent(standing.opponentGameWinPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The record as `4-0` or `3-1-1` - the notation a card player reads - under a
 * column headed "Record" and beside one headed "Pts", so there is nothing for
 * it to be mistaken for. It survives greyscale by being numerals; the spoken
 * name spells it out, because "three dash one dash one" does not.
 */
function standingRecordCell(standing: {
  matchWins: number | null;
  matchLosses: number | null;
  matchDraws: number | null;
}) {
  const record = {
    wins: standing.matchWins ?? 0,
    losses: standing.matchLosses ?? 0,
    draws: standing.matchDraws ?? 0,
  };
  return (
    <span className="record-counts">
      <span className="record-value" aria-hidden="true">{standingRecord(standing)}</span>
      <span className="sr-only">{recordSpoken(record)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Pairings
// ---------------------------------------------------------------------------

function PairingsSection({ results }: { results: TournamentResults }) {
  // trimmed means rounds were dropped to fit the stored item, with the
  // standings left whole. The banner at the top of the page has already said
  // so; this section must not also render as if nothing happened.
  if (results.trimmed) {
    return (
      <section className="event-section">
        <div className="section-head">
          <h2>Pairings</h2>
        </div>
        <div className="panel empty-state">
          {/* The fact, once. The reason is the hint on it. */}
          <p>
            <span className="col-hint" title={trimmedReason(results)}>{TRIMMED_LABEL}</span>
          </p>
        </div>
      </section>
    );
  }

  if (results.rounds.length === 0) {
    return (
      <section className="event-section">
        <div className="section-head">
          <h2>Pairings</h2>
        </div>
        <div className="panel empty-state">
          <p className="muted">
            No rounds were recorded for this event, although its standings were.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="event-section">
      <div className="section-head">
        <h2>Pairings</h2>
        <span className="section-count">
          {results.rounds.length} {results.rounds.length === 1 ? 'round' : 'rounds'}
        </span>
      </div>
      {results.rounds.map((round) => (
        <RoundBlock
          key={`${round.section}-${round.roundNumber}`}
          round={round}
          results={results}
        />
      ))}
    </section>
  );
}

function RoundBlock({ round, results }: { round: TournamentRound; results: TournamentResults }) {
  const status = roundStatusLabel(round, results);
  const stage = sectionLabel(round.section);

  return (
    <div className="round-block">
      <div className="round-head">
        <h3>
          {stage && <span className="round-stage">{stage}</span>}
          Round {round.roundNumber}
        </h3>
        {/* Finality is read off the round - or off the capture - never off a
            match, whose status routinely still says IN_PROGRESS inside a
            round Riot has marked FINALIZED. */}
        {status && <span className="status-chip">{status}</span>}
        {!roundIsFinal(round, results) && <span className="sr-only">Round not finalised</span>}
      </div>

      <ol className="pairing-list panel">
        {orderedMatches(round).map((match) => (
          <PairingRow key={match.matchId} match={match} />
        ))}
        {/* Only the byes the capture did not already synthesise a row for. */}
        {unlistedByes(round).map((bye, index) => (
          <ByeRow key={bye.playerId ?? `bye-${index}`} player={bye} />
        ))}
      </ol>
    </div>
  );
}

function PairingRow({ match }: { match: TournamentMatch }) {
  const decided = matchDecided(match);
  const games = playedGames(match);

  if (match.bye) {
    return <ByeRow player={match.sides[0]?.player ?? null} />;
  }

  return (
    <li className={`pairing-row${decided ? '' : ' is-open'}`}>
      <span className="pairing-stripe" aria-hidden="true" />
      <span className="pairing-table">
        {match.tableNumber ? `Table ${match.tableNumber}` : '--'}
      </span>

      <PairingSide match={match} index={0} games={games} />

      {/* Games played but no verdict is still a score worth showing; the note
          is about the verdict, not about whether anyone turned up. */}
      <span className="pairing-score">
        <span className="pairing-score-value">
          {decided || matchHasPlay(match) ? matchScore(match) : 'vs'}
        </span>
        {!decided && <span className="pairing-open-note">No result</span>}
      </span>

      <PairingSide match={match} index={1} games={games} away />
    </li>
  );
}

/**
 * A bye. Said once: the slot is labelled "Bye", the player carries a B badge,
 * and the opposite side is empty because there was no opponent - rather than
 * three different sentences all meaning the same thing.
 */
function ByeRow({ player }: { player: TournamentSidePlayer | null }) {
  return (
    <li className="pairing-row is-bye">
      <span className="pairing-stripe" aria-hidden="true" />
      <span className="pairing-table">Bye</span>
      <span className="pairing-side">
        <span className="result-badge result-draw" aria-hidden="true">B</span>
        <span className="sr-only">Bye: </span>
        <span className="pairing-player">
          <PlayerName player={player} />
        </span>
      </span>
      <span className="pairing-score muted">&mdash;</span>
      <span className="pairing-side pairing-side-away muted">no opponent</span>
    </li>
  );
}

function PairingSide({
  match,
  index,
  games,
  away = false,
}: {
  match: TournamentMatch;
  index: number;
  games: TournamentMatch['games'];
  away?: boolean;
}) {
  const side = match.sides[index] ?? null;
  if (!side) {
    return (
      <span className={`pairing-side${away ? ' pairing-side-away' : ''} muted`}>
        No opponent recorded
      </span>
    );
  }

  const outcome = sideOutcome(side);

  return (
    <span className={`pairing-side${away ? ' pairing-side-away' : ''} pairing-${outcome}`}>
      <span className={`result-badge result-${outcome}`} aria-hidden="true">
        {outcomeLetter(outcome)}
      </span>
      <span className="sr-only">{outcomeWord(outcome)}: </span>
      <span className="pairing-player">
        <PlayerName player={side.player} />
        {/* Same rule as everywhere else: the number when there is one,
            muted when it is unsettled, the word only when there is none. */}
        {side.player && ratingDisplay(side.player) !== 'none' && (
          <span
            className={`pairing-rating${
              ratingDisplay(side.player) === 'unsettled' ? ' pairing-rating-unsettled' : ''
            }`}
          >
            {formatRating(side.player.rating)}
          </span>
        )}
        {side.player && ratingDisplay(side.player) === 'none' && (
          <span className="pairing-rating pairing-rating-withheld">{UNRANKED_LABEL}</span>
        )}
      </span>
      {games.length > 0 && (
        <span className="game-chips">
          {games.map((game) => {
            const gameOutcome = gameOutcomeForTeam(game.winnerTeamId, side.teamId);
            return (
              <span
                key={game.number}
                className={`game-chip game-${gameOutcome}`}
                title={`Game ${game.number}: ${outcomeWord(gameOutcome).toLowerCase()}`}
              >
                {outcomeLetter(gameOutcome)}
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/**
 * The hint on the `Scene` column.
 *
 * The column was `Scene` once, was renamed to `Region` because its cells were
 * each player's own `regionLabel`, and is `Scene` again now that the cells are
 * `sceneLabel`. The rename back is the fix, not a revert: a scene is the
 * engine's cluster of stores whose players really play each other, so it is
 * the same kind of thing for every row and the same kind of thing as the scene
 * named in the header above. A home city is not - on the reported page six
 * known players carried `Redwood City, CA`, `San Carlos, California` and
 * `Sunnyvale, California`, where the scene answer is `Peninsula` five times
 * and `South Bay` once.
 */
const SCENE_HINT =
  'The scene this player plays in - the group of stores near enough to each other that their ' +
  "players really play each other. Not the same thing as their home store's city: several " +
  'cities make one scene.';

/**
 * A cell with no scene in it, and **two different reasons** for that.
 *
 * Worth keeping apart, because they are not the same claim and the second is
 * most of an upcoming event's roster: a player the engine has never seen has
 * no home store to place at all, while a known player's home store can be in
 * no rankable scene. Both print the page's `--`, and the hint says which.
 */
const NO_SCENE_HINT =
  "This player's home store is not in a rankable scene yet. A scene is only drawn where its " +
  'stores play each other enough to rank anybody, so some stores will not be in one.';

const NO_HOME_STORE_HINT =
  'No recorded games for this player yet, so there is no home store to read a scene off.';

function RosterSection({
  roster,
  results,
  minGames,
}: {
  roster: TournamentRoster;
  /** Decides the heading and whether these ratings were earned here. */
  results: TournamentResults | null;
  minGames: number;
}) {
  const columns = rosterColumns(roster);
  const heading = roster.source === 'registrants' ? 'Who is signed up' : 'Who played';

  return (
    <section className="event-section">
      <div className="section-head">
        <h2>{heading}</h2>
        <span className="section-count">{roster.playerCount}</span>
      </div>
      <p className="section-note">{rosterNote(roster, results)}</p>

      {roster.entries.length === 0 ? (
        <div className="panel empty-state">
          <p className="muted">The roster was captured but holds no entries.</p>
        </div>
      ) : (
        <div className="panel table-scroll">
          <table className="data-table roster-table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col">Rating</th>
                <th scope="col" className="numeric">Games</th>
                {/* `Scene`, from `player.sceneLabel`. See SCENE_HINT for why
                    this is the header *and* the cell again. */}
                <th scope="col">
                  <abbr className="col-hint" title={SCENE_HINT}>Scene</abbr>
                </th>
                {columns.waitlist && <th scope="col" className="numeric">Waitlist</th>}
              </tr>
            </thead>
            <tbody>
              {roster.entries.map((entry) => (
                <tr key={entry.playerId}>
                  <td>
                    <PlayerName player={entry.player} fallbackName={entry.displayName ?? undefined} />
                  </td>
                  <td className="rating-cell">
                    <PlayerRating player={entry.player} minGames={minGames} showGate />
                  </td>
                  <td className="numeric">{entry.player.gamesPlayed ?? '--'}</td>
                  <td className="muted">
                    <PlayerScene player={entry.player} />
                  </td>
                  {columns.waitlist && (
                    <td className="numeric">{entry.waitlistPosition ?? '--'}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </section>
  );
}

export default EventDetailPage;
