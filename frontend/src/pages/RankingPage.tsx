import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getRankings, getSets, searchPlayers } from '../services/api';
import SceneSelect from '../components/SceneSelect';
import SetScope from '../components/SetScope';
import type {
  ComponentSummary,
  LeaderboardEntry,
  PlayerSearchHit,
  RankingCoverage,
  SetInfo,
} from '../types/ranking';
import {
  ALL_SETS,
  ALL_SETS_LABEL,
  buildScope,
  formatDate,
  formatRating,
  formatUncertainty,
  gateProgress,
  marginBar,
  marginScale,
  pickDefaultComponent,
  provisionalExplanation,
  setLabel,
  splitByConfidence,
  UNRANKED_LABEL,
} from '../lib/ranking';

/**
 * The Rankings section.
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
 *    the player simply reads "Unranked". The reason is a tooltip, and the
 *    general explanation lives in "How rankings work" at the foot of the page -
 *    not in prose beside every row.
 *
 * The density is borrowed from op.gg and lolchess: one summary block instead of
 * a row of equal-weight tiles, a filled meter instead of a bare count, and a
 * ladder whose position, player, number and volume all sit on one line. What is
 * *not* borrowed is their tier furniture. They have Iron through Challenger; we
 * have a rating with a real margin, and the margin is drawn rather than hidden
 * behind a badge.
 */

/** Hover/focus copy for the concepts the page cannot avoid naming. */
const HINTS = {
  scene:
    'A scene is a group of players who have played each other. Ratings only compare inside one, so a ranking is always scoped to a scene.',
  rating:
    'Worked out from games recorded at events. The ± is the margin of uncertainty around the number.',
  margin:
    'Each bar is one rating plus and minus its margin, drawn on one scale. Where two bars overlap, the order between those two players is not settled yet.',
} as const;

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
  const scopeLabel = activeSet ? setLabel(activeSet) : ALL_SETS_LABEL;
  // One shared axis for the margin bars, or none at all when there is too
  // little to compare. Three rows is the floor: two bars are a comparison, one
  // is a decoration.
  const scale = useMemo(() => marginScale(rated), [rated]);

  return (
    <div className="ranking-page">
      <div className="ranking-head">
        <h1>Rankings</h1>
        <p className="ranking-head-sub">
          {selectedComponent?.regionLabel ?? 'All scenes'} &middot; {scopeLabel}
        </p>
      </div>

      {/* One filter row, above everything it scopes. */}
      <div className="ranking-filters">
        <SetScope
          sets={sets}
          value={setId}
          name="ranking-set"
          onChange={(next) => updateParam(URL_PARAMS.SET, next === ALL_SETS ? null : next)}
        />

        <SceneSelect
          components={state.components}
          value={regionParam}
          onChange={(componentId) => updateParam(URL_PARAMS.REGION, componentId)}
          hint={HINTS.scene}
        />

        <PlayerSearch />
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && state.entries.length === 0 ? (
        <p className="muted">Loading rankings...</p>
      ) : (
        <div className={loading ? 'is-refreshing' : undefined}>
          <SceneSummary
            coverage={coverage}
            component={selectedComponent}
            scopeLabel={scopeLabel}
          />

          {!laddered && (rated.length > 0 || provisional.length > 0) && (
            <div className="notice-banner">
              {selectedComponent
                ? `This scene has only ${selectedComponent.componentSize ?? 'a few'} players in its co-play graph - fewer than the ${coverage?.minComponentSize ?? 8} needed for positions to mean anything. Ratings are listed without places.`
                : 'Everywhere mixes scenes that have never played each other, so there are no positions here. Pick a scene above for a ranking that can be compared.'}
            </div>
          )}

          {rated.length === 0 ? (
            <NobodyRatedYet hasPlayers={provisional.length > 0} />
          ) : (
            <section className="ranking-section">
              <div className="section-head">
                <h2>{laddered ? 'Ranked' : 'Rated players'}</h2>
                <span className="section-count">{rated.length}</span>
              </div>
              <div className="panel table-scroll">
                <table className="data-table ladder-table">
                  <thead>
                    <tr>
                      {laddered && <th scope="col" className="numeric">#</th>}
                      <th scope="col">Player</th>
                      <th scope="col" className="numeric">
                        <abbr className="col-hint" title={HINTS.rating}>Rating</abbr>
                      </th>
                      {scale && (
                        <th scope="col" className="margin-col">
                          <abbr className="col-hint" title={HINTS.margin}>Margin</abbr>
                        </th>
                      )}
                      <th scope="col" className="numeric">Games</th>
                      <th scope="col" className="numeric">Matches</th>
                      {!laddered && <th scope="col">Scene</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rated.map((entry) => {
                      const bar = marginBar(entry, scale);
                      return (
                        <tr key={entry.playerId}>
                          {laddered && (
                            <td className="numeric rank-cell">
                              <span className={`rank-badge${(entry.rank ?? 99) <= 3 ? ' is-top' : ''}`}>
                                {entry.rank ?? '--'}
                              </span>
                            </td>
                          )}
                          <td>
                            <PlayerLink entry={entry} />
                          </td>
                          <td className="numeric">
                            <span className="rating-value">{formatRating(entry.rating)}</span>
                            <span className="rating-margin">{formatUncertainty(entry.uncertainty)}</span>
                          </td>
                          {scale && (
                            <td className="margin-col">
                              {bar && (
                                <span
                                  className="margin-track"
                                  role="img"
                                  aria-label={`Rating ${formatRating(entry.rating)} ${formatUncertainty(entry.uncertainty) || 'with no recorded margin'}`}
                                >
                                  <span
                                    className="margin-span"
                                    style={{ left: `${bar.leftPercent}%`, width: `${bar.widthPercent}%` }}
                                  />
                                  <span className="margin-mark" style={{ left: `${bar.markerPercent}%` }} />
                                </span>
                              )}
                            </td>
                          )}
                          <td className="numeric">{entry.gamesPlayed ?? '--'}</td>
                          <td className="numeric">{entry.matchesPlayed ?? '--'}</td>
                          {!laddered && <td className="muted">{entry.regionLabel ?? '--'}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {provisional.length > 0 && (
            <section className="ranking-section">
              <div className="section-head">
                <h2>Unranked</h2>
                <span className="section-count">{provisional.length}</span>
              </div>
              <ul className="panel provisional-list">
                {provisional.map((entry) => {
                  const gate = gateProgress(entry.gamesPlayed, coverage?.minGamesForRating ?? 8, entry.provisionalReason);
                  const why = provisionalExplanation(
                    entry.provisionalReason,
                    entry.gamesUntilRated,
                    coverage?.minGamesForRating ?? 8
                  );
                  return (
                    <li key={entry.playerId}>
                      <PlayerLink entry={entry} />
                      {/* The word, and nothing else. The reason is the tooltip;
                          the general rule is in "How rankings work" below. */}
                      <span className="unranked" title={why}>
                        {UNRANKED_LABEL}
                      </span>
                      {/* Games against the published threshold - a count of
                          evidence, never the withheld rating. */}
                      {gate && (
                        <span className="gate" title={why}>
                          <span className="gate-pips" aria-hidden="true">
                            {Array.from({ length: gate.total }, (_, index) => (
                              <span
                                key={index}
                                className={`gate-pip${index < gate.filled ? ' is-filled' : ''}`}
                              />
                            ))}
                          </span>
                          <span className="gate-count">
                            {gate.filled}/{gate.total} games
                          </span>
                        </span>
                      )}
                    </li>
                  );
                })}
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

      {/* The exposition, at the foot: after the numbers, not before them. */}
    </div>
  );
}

function PlayerLink({ entry }: { entry: LeaderboardEntry | PlayerSearchHit }) {
  return (
    <Link to={`/rankings/players/${encodeURIComponent(entry.playerId)}`} className="player-link">
      {entry.displayName ?? 'Unknown player'}
      {entry.tagLine && <span className="player-tag">#{entry.tagLine}</span>}
    </Link>
  );
}

/**
 * The scene, as one block: who it is, how much of it is rated, and how much
 * play that rests on.
 *
 * This replaces a row of four equal-weight tiles. The references both do the
 * same thing - op.gg's "Ranked Solo/Duo" card, lolchess's "Ranked Game" panel -
 * and the reason is that four tiles claim four headlines. There is only one
 * headline here, and it is coverage: how many of the players we have seen have
 * played enough for a number. The rest is supporting detail at label size.
 */
function SceneSummary({
  coverage,
  component,
  scopeLabel,
}: {
  coverage: RankingCoverage | null;
  component: { componentSize: number | null; regionLabel: string | null; comparable: boolean } | null;
  scopeLabel: string;
}) {
  if (!coverage) return null;

  const where = component?.regionLabel ?? 'Everywhere';
  const seen = coverage.totalPlayers;
  const ratedPercent = seen > 0 ? (coverage.ratedPlayers / seen) * 100 : 0;

  return (
    <section className="panel scene-summary" aria-label="Rating coverage">
      <div className="scene-identity">
        <h2 className="scene-name">{where}</h2>
        <p className="scene-meta">
          <span className="scope-chip">{scopeLabel}</span>
          {component?.componentSize !== null && component?.componentSize !== undefined && (
            <span>{component.componentSize} players in the co-play graph</span>
          )}
          {component && !component.comparable && <span>too small for places</span>}
        </p>
      </div>

      <div className="scene-coverage">
        <span className="stat-label">Rated</span>
        <p className="coverage-headline">
          <strong>{coverage.ratedPlayers}</strong>
          <span className="coverage-of"> of {seen} players seen</span>
        </p>
        <div
          className="coverage-track"
          role="img"
          aria-label={`${coverage.ratedPlayers} of ${seen} players seen here have enough recorded games to be rated`}
        >
          <span className="coverage-fill" style={{ width: `${ratedPercent}%` }} />
        </div>
      </div>

      <dl className="scene-figures">
        <div>
          <dt>Games recorded</dt>
          <dd>{coverage.totalGames ?? '--'}</dd>
        </div>
        <div>
          <dt>Unranked</dt>
          <dd>{coverage.provisionalPlayers}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd className="scene-figure-text">
            {coverage.lastUpdated ? formatDate(coverage.lastUpdated) : '--'}
          </dd>
        </div>
      </dl>

      {/* Provenance only. The gate thresholds moved to "How rankings work". */}
      <p className="coverage-note">
        {!coverage.coverageComplete &&
          'Counts are a floor: this scope has more players than one page of coverage. '}
      </p>
    </section>
  );
}

function NobodyRatedYet({ hasPlayers }: { hasPlayers: boolean }) {
  return (
    <section className="ranking-section">
      <div className="panel empty-state">
        <h2>No ratings yet</h2>
        {hasPlayers ? (
          <p>
            Players have been recorded here, but none has enough games for a rating yet. They are
            listed below as <strong>Unranked</strong>.
          </p>
        ) : (
          <p>No games have been recorded for this slice yet - there is simply nothing to rank.</p>
        )}
        <p className="muted">
          Competitive Riftbound is days old, so a near-empty ranking is the honest picture for now.
          It fills in as events are played.
        </p>
        <p>
          <Link to="/">Find an event to play in &rarr;</Link>
        </p>
      </div>
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
              to={`/rankings/players/${encodeURIComponent(hit.playerId)}`}
              className="search-result"
              role="option"
              aria-selected={false}
            >
              <span>
                {hit.displayName ?? 'Unknown player'}
                {hit.tagLine && <span className="player-tag">#{hit.tagLine}</span>}
              </span>
              <span className={hit.provisional ? 'unranked' : 'muted'}>
                {hit.provisional ? UNRANKED_LABEL : formatRating(hit.rating)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default RankingPage;
