import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { getPlayer, getPlayerMatches, getPlayerRatings, getSets } from '../services/api';
import type { PlayerMatch, PlayerProfile, RatingPoint, SetInfo } from '../types/ranking';
import RatingChart from '../components/RatingChart';
import {
  ALL_SETS,
  ALL_SETS_LABEL,
  buildScope,
  formatDate,
  formatRating,
  formatRecord,
  formatUncertainty,
  gameScore,
  matchRecord,
  provisionalExplanation,
  provisionalShortReason,
  setBoundaryNote,
  selectableSets,
  setLabel,
  UNRANKED_LABEL,
} from '../lib/ranking';

/**
 * One player: their rating over time, their per-set breakdown, and every game
 * they have played with who they played it against.
 *
 * The set selector scopes the chart and the match log together, so the numbers
 * on the page always describe the same slice.
 *
 * A rating below the confidence gate is never printed. The page says
 * "Unranked" - one word, with the reason as its tooltip - instead of the banner
 * of prose it used to carry; the general rule lives in "How ranking works" on
 * the ranking page.
 */

const MATCH_PAGE_SIZE = 25;

function PlayerPage() {
  const { playerId } = useParams<{ playerId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const setId = searchParams.get('set') ?? ALL_SETS;

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
        if (caught instanceof Error && /not found/i.test(caught.message)) setNotFound(true);
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
        <Link to="/ranking" className="back-link">&larr; Back to ranking</Link>
        <p>No player with that id. They may not have appeared at a recorded event yet.</p>
      </div>
    );
  }

  if (loading && !profile) {
    return (
      <div className="player-page">
        <Link to="/ranking" className="back-link">&larr; Back to ranking</Link>
        <p className="muted">Loading player...</p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="player-page">
        <Link to="/ranking" className="back-link">&larr; Back to ranking</Link>
        {error && <div className="error-banner">{error}</div>}
      </div>
    );
  }

  const activeSet = sets.find((set) => set.setId === setId) ?? null;
  const scopeLabel = activeSet ? setLabel(activeSet) : ALL_SETS_LABEL;
  // The scoped numbers: the per-set entry when a set is selected, else all-time.
  const scoped = setFilter
    ? profile.setRatings.find((entry) => entry.setId === setFilter) ?? null
    : {
        rating: profile.rating,
        uncertainty: profile.uncertainty,
        gamesPlayed: profile.gamesPlayed,
        matchesPlayed: profile.matchesPlayed,
        provisional: profile.provisional,
        provisionalReason: profile.provisionalReason,
      };
  const record = matchRecord(matches);

  const minGames = seriesProvisional?.minGames ?? 8;
  // The reason, for the tooltip on the word "Unranked" - never as inline prose.
  const unrankedWhy = scoped
    ? provisionalExplanation(scoped.provisionalReason, profile.gamesUntilRated, minGames)
    : '';

  return (
    <div className="player-page">
      <Link to="/ranking" className="back-link">&larr; Back to ranking</Link>

      <header className="player-head">
        <h1>
          {profile.displayName ?? 'Unknown player'}
          {profile.tagLine && <span className="player-tag">#{profile.tagLine}</span>}
        </h1>
        <p className="muted">
          {profile.regionLabel ?? 'Scene unknown'}
          {profile.componentSize !== null && ` · ${profile.componentSize} players in this scene`}
          {!profile.comparable && ' · too small to compare against others'}
          {profile.firstSeen && ` · first seen ${formatDate(profile.firstSeen)}`}
        </p>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {/* One filter row, scoping everything below it. */}
      <div className="ranking-filters">
        <div className="filter-group">
          <label className="filter-label" htmlFor="player-set">Set</label>
          <select
            id="player-set"
            value={setId}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams);
              if (event.target.value === ALL_SETS) next.delete('set');
              else next.set('set', event.target.value);
              setSearchParams(next);
            }}
          >
            <option value={ALL_SETS}>{ALL_SETS_LABEL}</option>
            {selectableSets(sets).map((set) => (
              <option key={set.setId} value={set.setId}>
                {setLabel(set)}
              </option>
            ))}
          </select>
          {activeSet?.releaseDate && <span className="filter-note">{setBoundaryNote(activeSet)}</span>}
        </div>
      </div>

      <dl className="stat-row">
        <div className="stat-tile">
          <dt>
            <abbr
              className="col-hint"
              title="Worked out from games recorded at events. The ± is the margin of uncertainty around the number."
            >
              Rating
            </abbr>{' '}
            ({scopeLabel})
          </dt>
          <dd>
            {scoped && !scoped.provisional ? (
              <>
                {formatRating(scoped.rating)}
                <span className="rating-margin">{formatUncertainty(scoped.uncertainty)}</span>
              </>
            ) : (
              <span className="unranked stat-withheld" title={unrankedWhy || undefined}>
                {UNRANKED_LABEL}
              </span>
            )}
          </dd>
        </div>
        <div className="stat-tile">
          <dt>Games</dt>
          <dd>{scoped?.gamesPlayed ?? 0}</dd>
        </div>
        <div className="stat-tile">
          <dt>Matches</dt>
          <dd>{scoped?.matchesPlayed ?? 0}</dd>
        </div>
        <div className="stat-tile">
          <dt>Record (loaded)</dt>
          <dd>{formatRecord(record)}</dd>
        </div>
      </dl>

      <section className="player-section">
        <RatingChart
          points={points}
          scopeLabel={scopeLabel}
          provisional={Boolean(seriesProvisional?.provisional)}
        />
      </section>

      <section className="player-section">
        <h2>By set</h2>
        {profile.setRatings.length === 0 ? (
          <p className="muted">No per-set numbers yet - no games have been attributed to a set.</p>
        ) : (
          <div className="table-scroll">
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
                  <td className="numeric">
                    {profile.provisional ? (
                      <span className="unranked" title={unrankedWhy || undefined}>{UNRANKED_LABEL}</span>
                    ) : (
                      formatRating(profile.rating)
                    )}
                    {!profile.provisional && <span className="rating-margin">{formatUncertainty(profile.uncertainty)}</span>}
                  </td>
                  <td className="numeric">{profile.gamesPlayed ?? 0}</td>
                  <td title={profile.provisional ? provisionalShortReason(profile.provisionalReason) : undefined}>
                    {profile.provisional ? UNRANKED_LABEL : 'Rated'}
                  </td>
                </tr>
                {profile.setRatings.map((setRating) => (
                  <tr key={setRating.setId}>
                    <th scope="row">{setRating.setName ?? setRating.setId}</th>
                    {/* An em-dash for an unknown boundary, matching the "All
                        sets" row above. The long "release date not published"
                        wording belongs to the selector note, not here - having
                        both print it put the same sentence on screen twice. */}
                    <td className="muted">
                      {setRating.releaseDate ? formatDate(setRating.releaseDate) : <>&mdash;</>}
                    </td>
                    <td className="numeric">
                      {setRating.provisional ? (
                        <span
                          className="unranked"
                          title={provisionalExplanation(setRating.provisionalReason, profile.gamesUntilRated, minGames) || undefined}
                        >
                          {UNRANKED_LABEL}
                        </span>
                      ) : (
                        <>
                          {formatRating(setRating.rating)}
                          <span className="rating-margin">{formatUncertainty(setRating.uncertainty)}</span>
                        </>
                      )}
                    </td>
                    <td className="numeric">{setRating.gamesPlayed ?? 0}</td>
                    <td title={setRating.provisional ? provisionalShortReason(setRating.provisionalReason) : undefined}>
                      {setRating.provisional ? UNRANKED_LABEL : 'Rated'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="player-section">
        <h2>Games played</h2>
        {matches.length === 0 ? (
          <p className="muted">
            No recorded games{setFilter ? ' in this set' : ''} yet. Results only appear once an event's
            pairings have been published.
          </p>
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table match-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Result</th>
                    <th scope="col">Games</th>
                    <th scope="col">Opponent</th>
                    <th scope="col">Event</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((match) => (
                    <tr key={match.matchId}>
                      <td>{formatDate(match.eventDate ?? match.playedAt)}</td>
                      <td>
                        <span className={`outcome outcome-${match.outcome}`}>
                          {match.outcome === 'unknown' ? 'Unrecorded' : match.outcome}
                        </span>
                        <span className="match-score">{gameScore(match)}</span>
                      </td>
                      <td>
                        <span className="game-chips">
                          {match.games.map((game) => (
                            <span
                              key={game.gameNumber}
                              className={`game-chip game-${game.outcome}`}
                              title={`Game ${game.gameNumber}: ${game.outcome}`}
                            >
                              {game.outcome === 'win' ? 'W' : game.outcome === 'loss' ? 'L' : '-'}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td>
                        {match.opponentId ? (
                          <Link to={`/ranking/players/${encodeURIComponent(match.opponentId)}`} className="player-link">
                            {match.opponentDisplayName ?? 'Unknown player'}
                          </Link>
                        ) : (
                          <span className="muted">{match.opponentDisplayName ?? 'Unknown'}</span>
                        )}
                      </td>
                      <td>
                        <span className="event-name">{match.eventName ?? 'Unnamed event'}</span>
                        <span className="event-meta">
                          {[match.tournamentType, match.shopId ? `venue ${match.shopId}` : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {hasMore && (
              <button type="button" className="load-more" onClick={loadMoreMatches} disabled={loadingMore}>
                {loadingMore ? 'Loading...' : 'Show more games'}
              </button>
            )}
          </>
        )}
      </section>

      {/* One line, not a lecture: the explanation lives on the ranking page. */}
      <p className="how-it-works-link">
        <Link to="/ranking#how-ranking-works">How ranking works &rarr;</Link>
      </p>
    </div>
  );
}

export default PlayerPage;
