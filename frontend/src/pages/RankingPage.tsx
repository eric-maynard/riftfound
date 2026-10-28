import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { getRankings, getSets, searchPlayers } from '../services/api';
import SceneSelect from '../components/SceneSelect';
import RankingViewSwitch from '../components/RankingViewSwitch';
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
  componentLabel,
  formatDate,
  formatRating,
  formatUncertainty,
  gateProgress,
  GLOBAL_POSITION_HINT,
  GLOBAL_POSITION_NOTICE,
  GLOBAL_SCENE_LABEL,
  hasPositions,
  marginBar,
  marginScale,
  ratingDisplay,
  ratingExplanation,
  sceneSizeHint,
  sceneTooSmallExplanation,
  setLabel,
  splitByRating,
  UNRANKED_LABEL,
  UNRANKED_NO_GAMES_EXPLANATION,
} from '../lib/ranking';
import { carryPreview } from '../lib/preview';

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
 *  - A position is a **per-row** fact, not a per-scope one. The page used to
 *    drop its `#` column whenever the scope mixed scenes, which meant Global -
 *    the landing scope - had no positions at all. It has them now: an order
 *    that exists is reported with its caveat rather than withheld, and the
 *    caveat is the `#` header's hint plus the Scene column beside it (see
 *    `GLOBAL_POSITION_HINT`). A row still gets no place when it has not
 *    cleared the gate, or when its own scene is too small to order anyone.
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
    'A scene is a group of players who have played each other. A rating is only really earned against them, so pick a scene for positions that are. Global ranks every scene at once.',
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
  const { search } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const setId = searchParams.get(URL_PARAMS.SET) ?? ALL_SETS;
  const regionParam = searchParams.get(URL_PARAMS.REGION);

  const [state, setState] = useState<RankingState>(EMPTY_STATE);
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, [scope]);

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

  // Everyone the engine will quote a number for is in the table - settled or
  // not. What `provisional` withholds is the *position*, not the figure.
  const { scored, unscored } = splitByRating(state.entries);
  const coverage = state.coverage;
  const selectedComponent = state.component;
  // Global is the scope that mixes scenes; a `?region=` scope is one scene.
  const mixesScenes = !selectedComponent;
  // Whether to draw the `#` column, asked of the data rather than of the
  // scope: a column of nothing but dashes is furniture, and anything else is
  // an order that exists and should be shown. See `hasPositions`.
  const laddered = hasPositions(scored);
  const activeSet = sets.find((set) => set.setId === setId) ?? null;
  const scopeLabel = activeSet ? setLabel(activeSet) : ALL_SETS_LABEL;
  // One shared axis for the margin bars, or none at all when there is too
  // little to compare. Three rows is the floor: two bars are a comparison, one
  // is a decoration.
  const scale = useMemo(() => marginScale(scored), [scored]);
  const minGames = coverage?.minGamesForRating ?? 8;
  // Published alongside, so the "too small to order" sentence quotes the
  // server's threshold rather than a constant guessed here.
  const minSceneSize = coverage?.minComponentSize ?? 8;

  return (
    <div className="ranking-page">
      <div className="ranking-head">
        <h1>Rankings</h1>
        <p className="ranking-head-sub">
          {componentLabel(selectedComponent)} &middot; {scopeLabel}
        </p>
      </div>

      <RankingViewSwitch active="ladder" search={search} />

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

          {/* One line. Why lives in the hover hint, like every other
              explanation on this page - the banner reports, it does not teach.
              Two different facts, and the Global one is no longer "there are
              no positions": there are, and the line says what they order. */}
          {(scored.length > 0 || unscored.length > 0) && (mixesScenes || !laddered) && (
            <div
              className="notice-banner"
              title={
                mixesScenes
                  ? GLOBAL_POSITION_HINT
                  : `Positions need at least ${coverage?.minComponentSize ?? minSceneSize} players who have played each other.`
              }
            >
              {mixesScenes
                ? GLOBAL_POSITION_NOTICE
                : `Too few players for positions \u2014 ${selectedComponent?.componentSize ?? 'a few'} in this scene.`}
            </div>
          )}

          {scored.length === 0 ? (
            <NobodyRatedYet hasPlayers={unscored.length > 0} />
          ) : (
            <section className="ranking-section">
              {/* "Players", not "Ranked": the table holds everyone the engine
                  will quote a number for, and some of those rows carry no
                  position. A count of 5 under a heading claiming they are all
                  ranked would be a small lie told by the furniture. Which rows
                  are placed is what the `#` column is for. */}
              <div className="section-head">
                <h2>Players</h2>
                <span className="section-count">{scored.length}</span>
              </div>
              <div className="panel table-scroll">
                <table className="data-table ladder-table">
                  <thead>
                    <tr>
                      {laddered && (
                        <th scope="col" className="numeric">
                          {/* On Global the `#` is the one thing on the page
                              that needs qualifying, so it carries the dotted
                              underline the Rating and Margin headers use. In
                              one scene the order is earned and needs nothing. */}
                          {mixesScenes ? (
                            <abbr className="col-hint" title={GLOBAL_POSITION_HINT}>#</abbr>
                          ) : (
                            '#'
                          )}
                        </th>
                      )}
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
                      {/* Kept beside the positions rather than instead of
                          them. On a mixed ladder it is what lets a reader see
                          that #1 and #2 come from scenes that have never
                          met - which is the whole caveat, shown. */}
                      {mixesScenes && <th scope="col">Scene</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {scored.map((entry) => {
                      const bar = marginBar(entry, scale);
                      const unsettled = ratingDisplay(entry) === 'unsettled';
                      const why = ratingExplanation(
                        ratingDisplay(entry),
                        entry.provisionalReason,
                        entry.gamesUntilRated,
                        minGames
                      );
                      // Games against the published threshold, compactly: the
                      // "how close am I" answer, without a row of pips on
                      // every line of a ladder.
                      const gate = unsettled
                        ? gateProgress(entry.gamesPlayed, minGames, entry.provisionalReason)
                        : null;
                      return (
                        <tr key={entry.playerId} className={unsettled ? 'is-unsettled' : undefined}>
                          {laddered && (
                            <td className="numeric rank-cell">
                              {/* The rank the API sent, or a dash with the
                                  reason it withheld one. Two reasons, and they
                                  are different kinds of thing: an unsettled
                                  rating is short of *evidence*, while a
                                  too-small scene is a *comparison* problem
                                  with a perfectly good rating behind it. The
                                  place is never inferred from the number. */}
                              {entry.rank === null ? (
                                <span
                                  className="rank-none"
                                  title={
                                    (unsettled
                                      ? why
                                      : sceneTooSmallExplanation(entry.componentSize, minSceneSize)) || undefined
                                  }
                                >
                                  --
                                </span>
                              ) : (
                                <span className={`rank-badge${entry.rank <= 3 ? ' is-top' : ''}`}>
                                  {entry.rank}
                                </span>
                              )}
                            </td>
                          )}
                          <td>
                            <PlayerLink entry={entry} />
                          </td>
                          <td className="numeric" title={why || undefined}>
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
                          <td className="numeric" title={gate ? why || undefined : undefined}>
                            {gate ? `${gate.filled}/${gate.total}` : entry.gamesPlayed ?? '--'}
                          </td>
                          <td className="numeric">{entry.matchesPlayed ?? '--'}</td>
                          {/* The depth behind the position, as the cell's
                              hint. Cross-scene play would be the better
                              measure and it does not exist - 0 of 56,257
                              recorded games cross a scene - so what is shown
                              is the thing that does vary between rows: how
                              many players a place here was earned among. */}
                          {mixesScenes && (
                            <td className="muted" title={sceneSizeHint(entry)}>
                              {entry.regionLabel ?? '--'}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {unscored.length > 0 && (
            <section className="ranking-section">
              {/* The only place the word still appears on this page: players
                  with too few games for the engine to quote a number at all.
                  Everyone who has one is in the table above, unsettled rows
                  included - a column of "Unranked" read as a broken page. */}
              <div className="section-head">
                <h2>{UNRANKED_LABEL}</h2>
                <span className="section-count">{unscored.length}</span>
              </div>
              <ul className="panel provisional-list">
                {unscored.map((entry) => {
                  const gate = gateProgress(entry.gamesPlayed, minGames, entry.provisionalReason);
                  const why = UNRANKED_NO_GAMES_EXPLANATION;
                  return (
                    <li key={entry.playerId}>
                      <PlayerLink entry={entry} />
                      {/* The word, and nothing else. The reason is the tooltip;
                          the general rule is the footer's hover note. */}
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

/**
 * A player's name, linking to their page.
 *
 * The link reads the current query string rather than taking it as a prop,
 * because this renders in four places on two pages and the only thing it needs
 * from the URL is the one flag `carryPreview` knows about. While Rankings is
 * unlisted that flag is the whole section: a link that drops it lands the
 * reader on a player page with the mode switch gone (see lib/preview.ts).
 */
function PlayerLink({ entry }: { entry: LeaderboardEntry | PlayerSearchHit }) {
  const { search } = useLocation();
  return (
    <Link
      to={carryPreview(`/rankings/players/${encodeURIComponent(entry.playerId)}`, search)}
      className="player-link"
    >
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

  const where = component?.regionLabel ?? GLOBAL_SCENE_LABEL;
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
  const { search } = useLocation();
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
          {/* Even the way out carries the flag: the reader should be able to
              come back to an unlisted section they were just looking at. */}
          <Link to={carryPreview('/', search)}>Find an event to play in &rarr;</Link>
        </p>
      </div>
    </section>
  );
}

/** Search by display name. There is no browsable list of players by design. */
function PlayerSearch() {
  const { search } = useLocation();
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
              to={carryPreview(`/rankings/players/${encodeURIComponent(hit.playerId)}`, search)}
              className="search-result"
              role="option"
              aria-selected={false}
            >
              <span>
                {hit.displayName ?? 'Unknown player'}
                {hit.tagLine && <span className="player-tag">#{hit.tagLine}</span>}
              </span>
              {/* Same rule as the ladder: a number whenever there is one,
                  muted when it is unsettled, the word only when there is
                  none. */}
              <span className={ratingDisplay(hit) === 'rated' ? 'muted' : 'unranked'}>
                {ratingDisplay(hit) === 'none' ? UNRANKED_LABEL : formatRating(hit.rating)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default RankingPage;
