import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getRankings, getSets, searchPlayers } from '../services/api';
import type {
  ComponentSummary,
  LeaderboardEntry,
  PlayerSearchHit,
  RankingCoverage,
  SetInfo,
} from '../types/ranking';
import {
  ALL_SETS,
  buildScope,
  componentLabel,
  formatDate,
  formatRating,
  formatUncertainty,
  pickDefaultComponent,
  provisionalShortLabel,
  setBoundaryNote,
  setLabel,
  splitByConfidence,
} from '../lib/ranking';

/**
 * The ranking section.
 *
 * At launch this page's normal state is nearly empty: Radiance shipped
 * 2026-10-23, the backfill reaches about three weeks, and most players have
 * one to three recorded games. So the page leads with what the data actually
 * supports - how many players are rated out of how many were seen - and never
 * fills space with placeholder rows.
 *
 * Two honesty rules shape the layout:
 *
 *  - A rating is only comparable inside a connected component of the co-play
 *    graph, so the page defaults to a scene rather than a global ladder, and
 *    refuses to print positions when the selected scope mixes scenes or is too
 *    small to order anyone.
 *  - A rating that has not cleared the confidence gate is not printed at all;
 *    the player is listed with the reason it is being withheld.
 */

const PAGE_SIZE = 25;
const URL_PARAMS = { SET: 'set', REGION: 'region' } as const;

interface RankingState {
  entries: LeaderboardEntry[];
  coverage: RankingCoverage | null;
  components: ComponentSummary[];
  component: { componentId: string | null; componentSize: number | null; regionLabel: string | null; comparable: boolean } | null;
  cursor: string | null;
  hasMore: boolean;
}

const EMPTY_STATE: RankingState = {
  entries: [],
  coverage: null,
  components: [],
  component: null,
  cursor: null,
  hasMore: false,
};

function RankingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const setId = searchParams.get(URL_PARAMS.SET) ?? ALL_SETS;
  const regionParam = searchParams.get(URL_PARAMS.REGION);

  const [state, setState] = useState<RankingState>(EMPTY_STATE);
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultedRegion = useRef(false);

  const scope = useMemo(() => buildScope(setId, regionParam), [setId, regionParam]);

  useEffect(() => {
    let cancelled = false;
    getSets()
      .then((response) => {
        if (!cancelled) setSets(response.data);
      })
      .catch(() => {
        // The set selector degrades to all-sets only; not worth an error banner.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getRankings({ scope, limit: PAGE_SIZE })
      .then((response) => {
        if (cancelled) return;
        setState({
          entries: response.data.entries,
          coverage: response.data.coverage,
          components: response.data.components,
          component: response.data.component,
          cursor: response.pagination.cursor,
          hasMore: response.pagination.hasMore,
        });

        // Default to a scene rather than a global ladder, once we know which
        // scenes exist. Done by rewriting the URL so the choice is shareable.
        if (!regionParam && !defaultedRegion.current) {
          defaultedRegion.current = true;
          const fallback = pickDefaultComponent(response.data.components);
          if (fallback) {
            const next = new URLSearchParams(searchParams);
            next.set(URL_PARAMS.REGION, fallback);
            setSearchParams(next, { replace: true });
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError('Could not load rankings. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // searchParams/setSearchParams are only read inside the defaulting branch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, regionParam]);

  const loadMore = useCallback(() => {
    if (!state.cursor) return;
    setLoadingMore(true);
    getRankings({ scope, limit: PAGE_SIZE, cursor: state.cursor })
      .then((response) => {
        setState((previous) => ({
          ...previous,
          entries: [...previous.entries, ...response.data.entries],
          cursor: response.pagination.cursor,
          hasMore: response.pagination.hasMore,
        }));
      })
      .catch(() => setError('Could not load more players.'))
      .finally(() => setLoadingMore(false));
  }, [scope, state.cursor]);

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  };

  const { rated, provisional } = splitByConfidence(state.entries);
  const coverage = state.coverage;
  const selectedComponent = state.component;
  // Positions only mean something inside one big-enough scene.
  const laddered = Boolean(selectedComponent?.comparable);
  const activeSet = sets.find((set) => set.setId === setId) ?? null;

  return (
    <div className="ranking-page">
      <div className="ranking-head">
        <h1>Ranking</h1>
        <p className="ranking-lede">
          Ratings are worked out from games recorded at events, so they only compare players who have
          actually played each other. Pick a scene to see a ranking that means something.
        </p>
      </div>

      {/* One filter row, above everything it scopes. */}
      <div className="ranking-filters">
        <div className="filter-group">
          <label className="filter-label" htmlFor="ranking-set">Set</label>
          <select
            id="ranking-set"
            value={setId}
            onChange={(event) => updateParam(URL_PARAMS.SET, event.target.value === ALL_SETS ? null : event.target.value)}
          >
            <option value={ALL_SETS}>All sets</option>
            {sets.map((set) => (
              <option key={set.setId} value={set.setId}>
                {setLabel(set)}
              </option>
            ))}
          </select>
          {activeSet?.releaseDate && <span className="filter-note">{setBoundaryNote(activeSet)}</span>}
        </div>

        <div className="filter-group">
          <label className="filter-label" htmlFor="ranking-region">Scene</label>
          <select
            id="ranking-region"
            value={regionParam ?? ''}
            onChange={(event) => updateParam(URL_PARAMS.REGION, event.target.value || null)}
          >
            <option value="">Everywhere (not comparable)</option>
            {state.components.map((component) => (
              <option key={component.componentId} value={component.componentId}>
                {componentLabel(component)} &middot; {component.ratedPlayers} rated
                {component.comparable ? '' : ' · too small'}
              </option>
            ))}
          </select>
        </div>

        <PlayerSearch />
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && state.entries.length === 0 ? (
        <p className="muted">Loading rankings...</p>
      ) : (
        <div className={loading ? 'is-refreshing' : undefined}>
          <CoveragePanel
            coverage={coverage}
            component={selectedComponent}
            scopeLabel={activeSet ? setLabel(activeSet) : 'all sets'}
          />

          {!laddered && (rated.length > 0 || provisional.length > 0) && (
            <div className="notice-banner">
              {selectedComponent
                ? `This scene has only ${selectedComponent.componentSize ?? 'a few'} players in its co-play graph - fewer than the ${coverage?.minComponentSize ?? 8} needed for positions to mean anything. Ratings are listed without places.`
                : 'Everywhere mixes scenes that have never played each other, so there are no positions here. Pick a scene above for a ranking that can be compared.'}
            </div>
          )}

          {rated.length === 0 ? (
            <NobodyRatedYet coverage={coverage} hasPlayers={provisional.length > 0} />
          ) : (
            <section className="ranking-section">
              <h2>{laddered ? 'Ranked' : 'Rated players'}</h2>
              <div className="table-scroll">
                <table className="data-table ranking-table">
                  <thead>
                    <tr>
                      {laddered && <th scope="col" className="numeric">#</th>}
                      <th scope="col">Player</th>
                      <th scope="col" className="numeric">Rating</th>
                      <th scope="col" className="numeric">Games</th>
                      {!laddered && <th scope="col">Scene</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rated.map((entry) => (
                      <tr key={entry.playerId}>
                        {laddered && <td className="numeric rank-cell">{entry.rank ?? '--'}</td>}
                        <td>
                          <PlayerLink entry={entry} />
                        </td>
                        <td className="numeric">
                          <span className="rating-value">{formatRating(entry.rating)}</span>
                          <span className="rating-margin">{formatUncertainty(entry.uncertainty)}</span>
                        </td>
                        <td className="numeric">{entry.gamesPlayed ?? '--'}</td>
                        {!laddered && <td className="muted">{entry.regionLabel ?? '--'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {provisional.length > 0 && (
            <section className="ranking-section">
              <h2>Not yet rated</h2>
              <p className="muted">
                These players have been seen at events but have not played enough recorded games for a
                rating. No number is shown rather than a number that would mislead.
              </p>
              <ul className="provisional-list">
                {provisional.map((entry) => (
                  <li key={entry.playerId}>
                    <PlayerLink entry={entry} />
                    <span className="provisional-reason">
                      {provisionalShortLabel(entry.provisionalReason)}
                      {entry.gamesPlayed !== null && ` · ${entry.gamesPlayed} game${entry.gamesPlayed === 1 ? '' : 's'}`}
                      {entry.gamesUntilRated > 0 && ` · ${entry.gamesUntilRated} to go`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {state.hasMore && (
            <button type="button" className="load-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading...' : 'Show more players'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PlayerLink({ entry }: { entry: LeaderboardEntry | PlayerSearchHit }) {
  return (
    <Link to={`/ranking/players/${encodeURIComponent(entry.playerId)}`} className="player-link">
      {entry.displayName ?? 'Unknown player'}
      {entry.tagLine && <span className="player-tag">#{entry.tagLine}</span>}
    </Link>
  );
}

function CoveragePanel({
  coverage,
  component,
  scopeLabel,
}: {
  coverage: RankingCoverage | null;
  component: { componentSize: number | null; regionLabel: string | null; comparable: boolean } | null;
  scopeLabel: string;
}) {
  if (!coverage) return null;

  const where = component?.regionLabel ?? 'all scenes';

  return (
    <section className="coverage-panel" aria-label="Rating coverage">
      <p className="coverage-headline">
        <strong>{coverage.ratedPlayers}</strong> of <strong>{coverage.totalPlayers}</strong> players seen
        in {where} ({scopeLabel}) have enough recorded games to be rated.
      </p>
      <dl className="stat-row">
        <div className="stat-tile">
          <dt>Rated</dt>
          <dd>{coverage.ratedPlayers}</dd>
        </div>
        <div className="stat-tile">
          <dt>Players seen</dt>
          <dd>{coverage.totalPlayers}</dd>
        </div>
        <div className="stat-tile">
          <dt>Games recorded</dt>
          <dd>{coverage.totalGames ?? '--'}</dd>
        </div>
        <div className="stat-tile">
          <dt>Scene size</dt>
          <dd>{component?.componentSize ?? '--'}</dd>
        </div>
      </dl>
      <p className="coverage-note">
        A rating needs {coverage.minGamesForRating} recorded games and a margin under{' '}
        {coverage.maxUncertaintyForRating} points. Positions need a scene of at least{' '}
        {coverage.minComponentSize} players who have played each other.
        {coverage.lastUpdated && ` Last updated ${formatDate(coverage.lastUpdated)}.`}
        {!coverage.coverageComplete && ' Counts are a floor: this scope has more players than one page of coverage.'}
      </p>
    </section>
  );
}

function NobodyRatedYet({ coverage, hasPlayers }: { coverage: RankingCoverage | null; hasPlayers: boolean }) {
  return (
    <section className="ranking-section empty-state">
      <h2>No ratings yet</h2>
      {hasPlayers ? (
        <p>
          Players have been recorded here, but none has played the{' '}
          {coverage?.minGamesForRating ?? 8} games a rating needs. They are listed below with how far
          off they are.
        </p>
      ) : (
        <p>
          No games have been recorded for this slice yet. Nothing is hidden - there is simply nothing
          to rank.
        </p>
      )}
      <p className="muted">
        Competitive Riftbound is days old: Radiance released on 23 October 2026 and results only reach
        back about three weeks, so a near-empty ranking is the honest picture for now. It fills in as
        events are played.
      </p>
      <p>
        <Link to="/">Find an event to play in &rarr;</Link>
      </p>
    </section>
  );
}

/** Search by display name. There is no browsable list of players by design. */
function PlayerSearch() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PlayerSearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchPlayers(term)
        .then((response) => {
          if (!cancelled) setHits(response.data);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="filter-group player-search">
      <label className="filter-label" htmlFor="player-search">Find a player</label>
      <input
        id="player-search"
        type="search"
        value={query}
        placeholder="Display name"
        autoComplete="off"
        onChange={(event) => setQuery(event.target.value)}
      />
      {query.trim().length >= 2 && (
        <div className="search-results" role="listbox" aria-label="Player search results">
          {searching && hits.length === 0 && <div className="search-empty">Searching...</div>}
          {!searching && hits.length === 0 && <div className="search-empty">No player by that name.</div>}
          {hits.map((hit) => (
            <Link
              key={hit.playerId}
              to={`/ranking/players/${encodeURIComponent(hit.playerId)}`}
              className="search-result"
              role="option"
              aria-selected={false}
            >
              <span>
                {hit.displayName ?? 'Unknown player'}
                {hit.tagLine && <span className="player-tag">#{hit.tagLine}</span>}
              </span>
              <span className="muted">
                {hit.provisional ? 'not yet rated' : formatRating(hit.rating)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default RankingPage;
