import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, getPlayer, getPlayerMatches, getPlayerRatings, getSets } from '../services/api';
import type { PlayerMatch, PlayerProfile, RatingPoint, SetInfo } from '../types/ranking';
import RatingChart from '../components/RatingChart';
import RecordBar from '../components/RecordBar';
import FormStrip from '../components/FormStrip';
import SetScope from '../components/SetScope';
import RatingMoveNote from '../components/RatingMoveNote';
import {
  ALL_SETS,
  ALL_SETS_LABEL,
  buildScope,
  formatDate,
  formatRating,
  formatRecord,
  formatUncertainty,
  gameScore,
  gateProgress,
  matchDays,
  matchRecord,
  outcomeLetter,
  outcomeWord,
  provisionalShortReason,
  ratingDisplay,
  ratingExplanation,
  ratingMoves,
  recordSpoken,
  setLabel,
  UNRANKED_LABEL,
  UNRANKED_NO_GAMES_EXPLANATION,
} from '../lib/ranking';
import { carryPreview } from '../lib/preview';

/**
 * One player: their rating over time, their per-set breakdown, and every game
 * they have played with who they played it against.
 *
 * The set selector scopes the chart and the match log together, so the numbers
 * on the page always describe the same slice.
 *
 * A rating below the confidence gate is never printed. The page says
 * "Unranked" - one word, with the reason as its tooltip - instead of the banner
 * of prose it used to carry; the general rule lives in "How rankings work" at
 * the foot of the Rankings page.
 *
 * The shape is op.gg's: one summary block carrying identity, the headline
 * number, the record and recent form together, then a match list whose rows are
 * read left to right off a result stripe. Two deliberate departures:
 *
 *  - the headline number is a rating with a margin, not a tier, and when it has
 *    not been earned the block says "Unranked" rather than showing a
 *    provisional figure;
 *  - every result is carried by a letter as well as a colour, because this page
 *    has to survive being read in greyscale.
 */

const MATCH_PAGE_SIZE = 25;
/** How many results the form strip shows. Fewer when fewer have been played. */
const FORM_LENGTH = 10;

function PlayerPage() {
  const { playerId } = useParams<{ playerId: string }>();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const setId = searchParams.get('set') ?? ALL_SETS;
  /*
   * The back-link, once, for all five of this page's states.
   *
   * While Rankings is unlisted the preview flag has to ride every link inside
   * the section: it gates the mode switch, so the one link that drops it takes
   * the reader somewhere with no visible way back (lib/preview.ts). The
   * `setSearchParams` call below rewrites *this* URL and copies the existing
   * params, so the flag survives a set change by the same rule.
   */
  const backToRankings = carryPreview('/rankings', location.search);

  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [points, setPoints] = useState<RatingPoint[]>([]);
  const [seriesProvisional, setSeriesProvisional] = useState<{ provisional: boolean; reason: PlayerProfile['provisionalReason']; minGames: number } | null>(null);
  const [matches, setMatches] = useState<PlayerMatch[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const scope = useMemo(() => buildScope(setId, null), [setId]);
  const setFilter = setId === ALL_SETS ? null : setId;

  useEffect(() => {
    getSets()
      .then((response) => setSets(response.data))
      .catch(() => setSets([]));
  }, []);

  useEffect(() => {
    if (!playerId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);

    Promise.all([
      getPlayer(playerId),
      getPlayerRatings(playerId, scope),
      getPlayerMatches(playerId, { limit: MATCH_PAGE_SIZE, setId: setFilter }),
    ])
      .then(([profileResponse, ratingsResponse, matchesResponse]) => {
        if (cancelled) return;
        setProfile(profileResponse.data);
        setPoints(ratingsResponse.data.points);
        setSeriesProvisional({
          provisional: ratingsResponse.data.provisional,
          reason: ratingsResponse.data.provisionalReason,
          minGames: ratingsResponse.data.minGamesForRating,
        });
        setMatches(matchesResponse.data);
        setCursor(matchesResponse.pagination.cursor);
        setHasMore(matchesResponse.pagination.hasMore);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        // Absence is read off the profile now, not off a thrown error - see
        // the `unseen` branch below. A 404 is still honoured, because an
        // older API deploy answers that way for the same player, and a
        // malformed id is a 400 and a real error.
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else if (caught instanceof Error && /not found/i.test(caught.message)) setNotFound(true);
        else setError('Could not load this player.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [playerId, scope, setFilter]);

  const loadMoreMatches = useCallback(() => {
    if (!playerId || !cursor) return;
    setLoadingMore(true);
    getPlayerMatches(playerId, { limit: MATCH_PAGE_SIZE, cursor, setId: setFilter })
      .then((response) => {
        setMatches((previous) => [...previous, ...response.data]);
        setCursor(response.pagination.cursor);
        setHasMore(response.pagination.hasMore);
      })
      .catch(() => setError('Could not load more games.'))
      .finally(() => setLoadingMore(false));
  }, [playerId, cursor, setFilter]);

  if (notFound) {
    return (
      <div className="player-page">
        <Link to={backToRankings} className="back-link">&larr; Back to rankings</Link>
        <p>No player with that id. They may not have appeared at a recorded event yet.</p>
      </div>
    );
  }

  /*
   * A player the engine has never seen.
   *
   * `/api/players/:id` used to 404 for these, and the catch above turned that
   * into the message. It answers 200 now - every number null, `known: false` -
   * so without this branch a typed or bookmarked URL would render a shell of
   * dashes, an empty chart and an empty match list. The event page still links
   * only `known` players, so no normal navigation arrives here.
   *
   * One line, like the event page's empty states, with the reason as the hover
   * hint rather than prose. It says `Unranked`, not "No record yet": that
   * distinction was collapsed once a stale engine proved it could not be
   * trusted to be true.
   */
  if (profile && profile.known === false) {
    return (
      <div className="player-page">
        <Link to={backToRankings} className="back-link">&larr; Back to rankings</Link>
        <section className="panel empty-state">
          <p title={UNRANKED_NO_GAMES_EXPLANATION}>
            {UNRANKED_LABEL} &mdash; no games by {profile.displayName ?? 'this player'}
            {profile.tagLine ? `#${profile.tagLine}` : ''} have been recorded yet. A rating appears
            once they have played at an event whose organiser recorded it.
          </p>
        </section>
      </div>
    );
  }

  if (loading && !profile) {
    return (
      <div className="player-page">
        <Link to={backToRankings} className="back-link">&larr; Back to rankings</Link>
        <p className="muted">Loading player...</p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="player-page">
        <Link to={backToRankings} className="back-link">&larr; Back to rankings</Link>
        {error && <div className="error-banner">{error}</div>}
      </div>
    );
  }

  const activeSet = sets.find((set) => set.setId === setId) ?? null;
  const scopeLabel = activeSet ? setLabel(activeSet) : ALL_SETS_LABEL;
  // The scoped numbers: the per-set entry when a set is selected, else all-time.
  const scoped = setFilter
    ? (profile.setRatings ?? []).find((entry) => entry.setId === setFilter) ?? null
    : {
        rating: profile.rating,
        uncertainty: profile.uncertainty,
        gamesPlayed: profile.gamesPlayed,
        matchesPlayed: profile.matchesPlayed,
        provisional: profile.provisional,
        provisionalReason: profile.provisionalReason,
      };
  const record = matchRecord(matches);
  // The match log, grouped by the day played, and what the fit says each of
  // those days did to the rating. Both come from data already on the page -
  // `points` is the series the chart draws - so the two cannot disagree and no
  // extra request is made. `hasMore` is passed because the page boundary can
  // fall inside a day, and a part-loaded day must not report a day's record.
  const days = matchDays(matches, hasMore);
  const moves = ratingMoves(points);

  // The same three states as every other surface, from the same rule. The
  // headline prints the number whenever the engine will quote one - muted and
  // without a position when it is unsettled - and the word only when there is
  // no number at all. It reads `rating`, so an older API deploy that sends an
  // all-null profile lands in exactly the same branch.
  const display = ratingDisplay(scoped);
  const minGames = seriesProvisional?.minGames ?? 8;
  // The reason, as a tooltip - never as inline prose.
  const unrankedWhy = ratingExplanation(
    display,
    scoped?.provisionalReason ?? null,
    profile.gamesUntilRated,
    minGames
  );
  // How close they are, which is the one question an unsettled rating leaves
  // open. Driven by the game count rather than by the reason string.
  const gate = display === 'unsettled' || display === 'none'
    ? gateProgress(scoped?.gamesPlayed ?? profile.gamesPlayed, minGames, scoped?.provisionalReason ?? null)
    : null;
  // The record only covers matches we have actually loaded, so say which.
  const recordCaption = hasMore
    ? `First ${matches.length} of ${scoped?.matchesPlayed ?? matches.length} matches`
    : `All ${matches.length} loaded ${matches.length === 1 ? 'match' : 'matches'}`;

  return (
    <div className="player-page">
      <Link to={backToRankings} className="back-link">&larr; Back to rankings</Link>

      {error && <div className="error-banner">{error}</div>}

      {/* The summary block: identity, the headline number, the record and the
          recent form in one object, rather than a header plus a row of tiles. */}
      <header className="panel player-summary">
        <div className="player-identity">
          <h1>
            {profile.displayName ?? 'Unknown player'}
            {profile.tagLine && <span className="player-tag">#{profile.tagLine}</span>}
          </h1>
          <p className="player-meta">
            <span className="scope-chip">{profile.regionLabel ?? 'Scene unknown'}</span>
            {profile.componentSize !== null && <span>{profile.componentSize} players</span>}
            {!profile.comparable && <span>too small to compare</span>}
          </p>
          {/* The active range gets its own line rather than a fourth item in
              the list above. A wrapped inline list begins its second line with
              the separator that belonged to the end of the first. */}
          {profile.firstSeen && (
            <p className="player-dates">
              Seen {formatDate(profile.firstSeen)}
              {profile.lastSeen && profile.lastSeen !== profile.firstSeen
                ? ` - ${formatDate(profile.lastSeen)}`
                : ''}
            </p>
          )}
        </div>

        <div className="player-headline">
          <span className="stat-label">
            <abbr
              className="col-hint"
              title="Worked out from games recorded at events. The ± is the margin of uncertainty around the number."
            >
              Rating
            </abbr>{' '}
            &middot; {scopeLabel}
          </span>
          {display !== 'none' ? (
            // The margin is what carries the honesty: a wide ± beside a narrow
            // one says "not settled" without a label, and the muted treatment
            // says the same thing again for anyone scanning the page.
            <p className={`headline-value${display === 'unsettled' ? ' is-unsettled' : ''}`} title={unrankedWhy || undefined}>
              {formatRating(scoped?.rating ?? null)}
              <span className="headline-margin">{formatUncertainty(scoped?.uncertainty ?? null)}</span>
            </p>
          ) : (
            <p className="headline-value is-withheld">
              <span className="unranked" title={unrankedWhy || undefined}>
                {UNRANKED_LABEL}
              </span>
            </p>
          )}
          {/* Evidence so far against the published threshold. A count of
              games, never the withheld number. */}
          {gate && (
            <span className="gate" title={unrankedWhy || undefined}>
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
        </div>

        <div className="player-record">
          <span className="stat-label">Record</span>
          <RecordBar record={record} caption={recordCaption} />
        </div>

        <dl className="player-figures">
          <div>
            <dt>Games</dt>
            <dd>{scoped?.gamesPlayed ?? 0}</dd>
          </div>
          <div>
            <dt>Matches</dt>
            <dd>{scoped?.matchesPlayed ?? 0}</dd>
          </div>
        </dl>

        <FormStrip matches={matches} count={FORM_LENGTH} totalMatches={scoped?.matchesPlayed ?? null} />
      </header>

      {/* One filter row, scoping everything below it. */}
      <div className="ranking-filters">
        <SetScope
          sets={sets}
          value={setId}
          name="player-set"
          onChange={(next) => {
            const params = new URLSearchParams(searchParams);
            if (next === ALL_SETS) params.delete('set');
            else params.set('set', next);
            setSearchParams(params);
          }}
        />
      </div>

      <section className="player-section">
        <RatingChart
          points={points}
          scopeLabel={scopeLabel}
          provisional={Boolean(seriesProvisional?.provisional)}
        />
      </section>

      <section className="player-section">
        <div className="section-head">
          <h2>By set</h2>
        </div>
        {profile.setRatings.length === 0 ? (
          <p className="muted">No per-set numbers yet - no games have been attributed to a set.</p>
        ) : (
          <div className="panel table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Set</th>
                  <th scope="col">Boundary</th>
                  <th scope="col" className="numeric">Rating</th>
                  <th scope="col" className="numeric">Games</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                <tr className="row-emphasis">
                  <th scope="row">{ALL_SETS_LABEL}</th>
                  <td className="muted">&mdash;</td>
                  <SetRatingCells
                    rating={profile.rating}
                    uncertainty={profile.uncertainty}
                    gamesPlayed={profile.gamesPlayed}
                    provisional={profile.provisional}
                    provisionalReason={profile.provisionalReason}
                    gamesUntilRated={profile.gamesUntilRated}
                    minGames={minGames}
                  />
                </tr>
                {(profile.setRatings ?? []).map((setRating) => (
                  <tr key={setRating.setId}>
                    <th scope="row">{setRating.setName ?? setRating.setId}</th>
                    {/* An em-dash for an unknown boundary, matching the "All
                        sets" row above. The long "release date not published"
                        wording belongs to the selector note, not here - having
                        both print it put the same sentence on screen twice. */}
                    <td className="muted">
                      {setRating.releaseDate ? formatDate(setRating.releaseDate) : <>&mdash;</>}
                    </td>
                    <SetRatingCells
                      rating={setRating.rating}
                      uncertainty={setRating.uncertainty}
                      gamesPlayed={setRating.gamesPlayed}
                      provisional={setRating.provisional}
                      provisionalReason={setRating.provisionalReason}
                      gamesUntilRated={setRating.gamesUntilRated}
                      minGames={minGames}
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="player-section">
        <div className="section-head">
          <h2>Match history</h2>
          {matches.length > 0 && <span className="section-count">{matches.length}</span>}
        </div>
        {matches.length === 0 ? (
          <div className="panel empty-state">
            <p className="muted">
              No recorded games{setFilter ? ' in this set' : ''} yet. Results only appear once an
              event&apos;s pairings have been published.
            </p>
          </div>
        ) : (
          <>
            {/* Grouped by the day played, because that is the grain the rating
                engine works at - see `RatingMove` in lib/ranking.ts. The day
                header carries the date (so the rows no longer repeat it) and,
                where the series has a point for that day, what the rating did. */}
            <ol className="match-days">
              {days.map((day) => {
                const move = moves.get(day.date) ?? null;
                return (
                  <li key={day.date} className="match-day">
                    <div className="match-day-head">
                      <h3 className="match-day-date">{formatDate(day.date)}</h3>
                      {day.complete && (
                        <span className="match-day-record">
                          <span aria-hidden="true">{formatRecord(day.record)}</span>
                          <span className="sr-only">{recordSpoken(day.record)}</span>
                        </span>
                      )}
                      {/* Nothing at all when the series has no point for this
                          day: an unrated player has no published curve, and a
                          dash would invite the reading that the rating stood
                          still. The chart above says why in words. */}
                      {move && <RatingMoveNote move={move} day={day} />}
                    </div>
                    <ol className="match-list">
                      {day.matches.map((match) => (
                        <MatchRow key={match.matchId} match={match} />
                      ))}
                    </ol>
                  </li>
                );
              })}
            </ol>
            {hasMore && (
              <button type="button" className="load-more" onClick={loadMoreMatches} disabled={loadingMore}>
                {loadingMore ? 'Loading...' : 'Show more games'}
              </button>
            )}
          </>
        )}
      </section>

      {/* One line, not a lecture: the explanation lives on the Rankings page. */}
    </div>
  );
}

/**
 * The rating, games and status cells of one row of the per-set table.
 *
 * Shared by the "All sets" row and each set's row, because they are the same
 * three facts and used to be two copies of the same JSX carrying the same rule
 * written twice.
 *
 * Status is a *word*, so the table still says in text what the muted treatment
 * says in colour. This table is the one place on the page where a reader
 * compares a settled slice against an unsettled one side by side, and colour
 * is never the only signal here either.
 */
function SetRatingCells({
  rating,
  uncertainty,
  gamesPlayed,
  provisional,
  provisionalReason,
  gamesUntilRated,
  minGames,
}: {
  rating: number | null;
  uncertainty: number | null;
  gamesPlayed: number | null;
  provisional: boolean;
  provisionalReason: PlayerProfile['provisionalReason'];
  gamesUntilRated: number;
  minGames: number;
}) {
  const display = ratingDisplay({ rating, provisional });
  const why = ratingExplanation(display, provisionalReason, gamesUntilRated, minGames);
  return (
    <>
      <td
        className={`numeric${display === 'unsettled' ? ' is-unsettled' : ''}`}
        title={why || undefined}
      >
        {display === 'none' ? (
          <span className="unranked">{UNRANKED_LABEL}</span>
        ) : (
          <>
            <span className="rating-value">{formatRating(rating)}</span>
            <span className="rating-margin">{formatUncertainty(uncertainty)}</span>
          </>
        )}
      </td>
      <td className="numeric">{gamesPlayed ?? 0}</td>
      <td title={display === 'rated' ? undefined : provisionalShortReason(provisionalReason)}>
        {display === 'rated' ? 'Rated' : UNRANKED_LABEL}
      </td>
    </>
  );
}

/**
 * One match, read left to right off a result stripe on the leading edge.
 *
 * The order is op.gg's - verdict, then what was played, then against whom,
 * then where - because that is the order the question is usually asked in. The
 * Bo3 game chips sit next to the match score rather than in their own column:
 * "2-1" and "W L W" are the same fact at two resolutions, and splitting them
 * made the eye travel twice.
 *
 * **The date is the day header's, not the row's.** It used to sit on the right
 * of every row; now that the log is grouped by day, printing it again on each
 * of a day's four rows is the same figure four times.
 *
 * **The event name is a link to the event's page.** It is never a dead end,
 * and that is structural rather than lucky: this row exists because the rating
 * engine replayed a *results capture* for that event, which is exactly the
 * condition `hasTournament` tests before the calendar is allowed to show a
 * trophy. An event whose organiser never ran pairings (`status: 'none'`, ~29%
 * of finished events) produces no matches, so it can never appear here.
 *
 * The venue keeps its shop id on the element. A map of the 390 known venues is
 * the next thing this section wants, and it will want to address these rows.
 */
function MatchRow({ match }: { match: PlayerMatch }) {
  // The opponent link reads the query string here rather than taking it as a
  // prop: one row of many, and the only thing it wants is the preview flag.
  const { search } = useLocation();
  return (
    <li className={`match-row match-${match.outcome}`} data-shop-id={match.shopId ?? undefined}>
      <span className="match-stripe" aria-hidden="true" />

      <span className="match-verdict">
        <span className={`result-badge result-${match.outcome}`} aria-hidden="true">
          {outcomeLetter(match.outcome)}
        </span>
        <span className="result-word">{outcomeWord(match.outcome)}</span>
      </span>

      <span className="match-games">
        <span className="match-score">{gameScore(match)}</span>
        <span className="game-chips">
          {match.games.map((game) => (
            <span
              key={game.gameNumber}
              className={`game-chip game-${game.outcome}`}
              title={`Game ${game.gameNumber}: ${game.outcome}`}
            >
              {outcomeLetter(game.outcome)}
            </span>
          ))}
        </span>
      </span>

      <span className="match-opponent">
        <span className="versus" aria-hidden="true">vs</span>
        {match.opponentId ? (
          <Link
            to={carryPreview(`/rankings/players/${encodeURIComponent(match.opponentId)}`, search)}
            className="player-link"
          >
            {match.opponentDisplayName ?? 'Unknown player'}
          </Link>
        ) : (
          <span className="muted">{match.opponentDisplayName ?? 'Unknown'}</span>
        )}
      </span>

      <span className="match-event">
        {match.eventExternalId ? (
          <Link
            to={carryPreview(`/events/${encodeURIComponent(match.eventExternalId)}`, search)}
            className="event-name event-link"
          >
            {match.eventName ?? 'Unnamed event'}
          </Link>
        ) : (
          // No id to address: the engine keeps the event's own `external_id` on
          // every log entry, so this is the shape an older refit would send
          // rather than a state the data produces.
          <span className="event-name">{match.eventName ?? 'Unnamed event'}</span>
        )}
        <span className="event-meta">
          {match.tournamentType && <span className="meta-chip">{match.tournamentType}</span>}
          {match.shopId && <span className="meta-venue">Venue {match.shopId}</span>}
        </span>
      </span>
    </li>
  );
}

export default PlayerPage;
