import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { getPlayer, getPlayerMatches, getPlayerRatings, getSets } from '../services/api';
import type { PlayerMatch, PlayerProfile, RatingPoint, SetInfo } from '../types/ranking';
import RatingChart from '../components/RatingChart';
import RecordBar from '../components/RecordBar';
import FormStrip from '../components/FormStrip';
import SetScope from '../components/SetScope';
import {
  ALL_SETS,
  ALL_SETS_LABEL,
  buildScope,
  formatDate,
  formatRating,
  formatUncertainty,
  gameScore,
  gateProgress,
  hasNoRecord,
  matchRecord,
  outcomeLetter,
  outcomeWord,
  provisionalExplanation,
  provisionalShortReason,
  setLabel,
  NO_RECORD_EXPLANATION,
  NO_RECORD_LABEL,
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
        <Link to="/rankings" className="back-link">&larr; Back to rankings</Link>
        <p>No player with that id. They may not have appeared at a recorded event yet.</p>
      </div>
    );
  }

  if (loading && !profile) {
    return (
      <div className="player-page">
        <Link to="/rankings" className="back-link">&larr; Back to rankings</Link>
        <p className="muted">Loading player...</p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="player-page">
        <Link to="/rankings" className="back-link">&larr; Back to rankings</Link>
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

  // Three rating states here as on the event page, not two. `/api/players/:id`
  // currently 404s for a player the engine has never seen, so this branch is
  // unreachable today - but it must not be a dead end if the endpoint starts
  // answering with a profile whose numbers are all null. "Unranked" would tell
  // a first-time player they failed a bar they never stood at, and a 0/8 games
  // meter is not evidence of anything.
  // Read off the whole profile, not the scoped slice: a known player who did
  // not play a particular set is still "Unranked" in that set, not unseen.
  const noRecord = hasNoRecord(profile) && matches.length === 0;

  const minGames = seriesProvisional?.minGames ?? 8;
  // The reason, for the tooltip on the withheld word - never as inline prose.
  const unrankedWhy = noRecord
    ? NO_RECORD_EXPLANATION
    : scoped
      ? provisionalExplanation(scoped.provisionalReason, profile.gamesUntilRated, minGames)
      : '';
  const gate = scoped?.provisional && !noRecord
    ? gateProgress(scoped.gamesPlayed, minGames, scoped.provisionalReason)
    : null;
  // The record only covers matches we have actually loaded, so say which.
  const recordCaption = hasMore
    ? `First ${matches.length} of ${scoped?.matchesPlayed ?? matches.length} matches`
    : `All ${matches.length} loaded ${matches.length === 1 ? 'match' : 'matches'}`;

  return (
    <div className="player-page">
      <Link to="/rankings" className="back-link">&larr; Back to rankings</Link>

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
          {scoped && !scoped.provisional ? (
            <p className="headline-value">
              {formatRating(scoped.rating)}
              <span className="headline-margin">{formatUncertainty(scoped.uncertainty)}</span>
            </p>
          ) : (
            <p className="headline-value is-withheld">
              <span className="unranked" title={unrankedWhy || undefined}>
                {noRecord ? NO_RECORD_LABEL : UNRANKED_LABEL}
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
                  <td className="numeric">
                    {profile.provisional ? (
                      <span className="unranked" title={unrankedWhy || undefined}>{UNRANKED_LABEL}</span>
                    ) : (
                      <span className="rating-value">{formatRating(profile.rating)}</span>
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
                          title={provisionalExplanation(setRating.provisionalReason, setRating.gamesUntilRated, minGames) || undefined}
                        >
                          {UNRANKED_LABEL}
                        </span>
                      ) : (
                        <>
                          <span className="rating-value">{formatRating(setRating.rating)}</span>
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
            <ol className="match-list">
              {matches.map((match) => (
                <MatchRow key={match.matchId} match={match} />
              ))}
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
 * One match, read left to right off a result stripe on the leading edge.
 *
 * The order is op.gg's - verdict, then what was played, then against whom,
 * then where and when - because that is the order the question is usually
 * asked in. The Bo3 game chips sit next to the match score rather than in
 * their own column: "2-1" and "W L W" are the same fact at two resolutions,
 * and splitting them made the eye travel twice.
 *
 * The venue keeps its shop id on the element. A map of the 390 known venues is
 * the next thing this section wants, and it will want to address these rows.
 */
function MatchRow({ match }: { match: PlayerMatch }) {
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
          <Link to={`/rankings/players/${encodeURIComponent(match.opponentId)}`} className="player-link">
            {match.opponentDisplayName ?? 'Unknown player'}
          </Link>
        ) : (
          <span className="muted">{match.opponentDisplayName ?? 'Unknown'}</span>
        )}
      </span>

      <span className="match-event">
        <span className="event-name">{match.eventName ?? 'Unnamed event'}</span>
        <span className="event-meta">
          {match.tournamentType && <span className="meta-chip">{match.tournamentType}</span>}
          {match.shopId && <span className="meta-venue">Venue {match.shopId}</span>}
        </span>
      </span>

      <span className="match-when">{formatDate(match.eventDate ?? match.playedAt)}</span>
    </li>
  );
}

export default PlayerPage;
