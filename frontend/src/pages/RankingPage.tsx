import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { getRankings, getSets, searchPlayers } from '../services/api';
import SceneSelect from '../components/SceneSelect';
import SetScope from '../components/SetScope';
import type {
  ComponentSummary,
  LeaderboardEntry,
  PlayerSearchCoverage,
  PlayerSearchHit,
  RankingCoverage,
  SceneBoardInfo,
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
  GLOBAL_SCENE_LABEL,
  hasPositions,
  marginBar,
  marginScale,
  POOL_LINK_HINT,
  POOL_LINK_LABEL,
  POOL_POSITION_HINT,
  ratingDisplay,
  ratingExplanation,
  sceneBoardLabel,
  sceneBoardNotice,
  scenePath,
  SCENE_POSITION_HINT,
  SCENE_SPLIT_POOL_HINT,
  sceneSizeHint,
  sceneTooSmallExplanation,
  sceneUnknownNotice,
  searchCaption,
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
 *    the player simply reads "Unranked". The reason is a tooltip on the word,
 *    not prose beside every row, and this page carries no explainer section of
 *    its own: the general rule is one opt-in note in the site footer
 *    (`HOW_RANKINGS_WORK` in Layout.tsx). Every other caveat here sits on the
 *    thing it qualifies or it does not ship.
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
    'A group of stores close enough together that the players at them really play each other. The ladder it opens is the wider pool those players are ranked in, which usually covers a few neighbouring scenes.',
  pool:
    'A rating pool: every player whose recorded games chain together, which is the only group two ratings can be compared inside. It covers several scenes, so it is named after the pool rather than the scene you picked.',
  rating:
    'Worked out from games recorded at events. The ± is the margin of uncertainty around the number.',
  margin:
    'Each bar is one rating plus and minus its margin, drawn on one scale. Where two bars overlap, the order between those two players is not settled yet.',
} as const;

/**
 * The caveat on an incomplete count, as the hint on the count itself.
 *
 * It used to be a standing line under the coverage block, read by every
 * visitor whether or not the scope was capped. The `+` on the figure is the
 * visible half; this is the reason, for a reader who wants it.
 */
const COVERAGE_FLOOR_HINT =
  'A floor: this scope has more players than one page of coverage.';

const PAGE_SIZE = 25;
/**
 * Two parameters, still two facts - but `scene` is load-bearing now.
 *
 * `region` is a **pool** id (`component:<id>`, the only thing a rating scale
 * can be) and `scene` is the **place** the reader picked. Until now only
 * `region` chose a board: a `?scene=` link set the picker's caption and left
 * the pool's ladder underneath it, which is the reported bug - clicking
 * `Peninsula` landed on a board headed `North West Community Development
 * Council`, a Singapore CDC label, because that is the modal city of the pool
 * those players happen to chain into.
 *
 * So the scope now reads **scene first, pool second** (`buildScope`):
 *
 * - a `?scene=` link - what the map pin, the picker row and the event page all
 *   build - opens that scene's board;
 * - every `?region=` link handed out before this is byte-for-byte the page it
 *   always was, because nothing infers a scene from a pool;
 * - a link carrying both - which the picker used to write on every choice -
 *   resolves to the scene, which is what its author meant.
 *
 * The pool board is still reachable, and from the scene board itself: see
 * `POOL_LINK_LABEL`. It is the honest answer to "who else is on this scale".
 */
const URL_PARAMS = { SET: 'set', REGION: 'region', SCENE: 'scene' } as const;

interface RankingState {
  entries: LeaderboardEntry[];
  coverage: RankingCoverage | null;
  components: ComponentSummary[];
  component: { componentId: string | null; componentSize: number | null; regionLabel: string | null; comparable: boolean } | null;
  /** The scene header, on a scene scope only. Null on every other, and on an
   * API deploy that predates the scene board. */
  scene: SceneBoardInfo | null;
  cursor: string | null;
  hasMore: boolean;
}

const EMPTY_STATE: RankingState = {
  entries: [],
  coverage: null,
  components: [],
  component: null,
  scene: null,
  cursor: null,
  hasMore: false,
};

function RankingPage() {
  // Rankings is unlisted, so every link out of this page has to carry the
  // preview flag; the pool link under the scene summary is one of them.
  const { search } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const setId = searchParams.get(URL_PARAMS.SET) ?? ALL_SETS;
  const regionParam = searchParams.get(URL_PARAMS.REGION);
  const sceneParam = searchParams.get(URL_PARAMS.SCENE);

  const [state, setState] = useState<RankingState>(EMPTY_STATE);
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Scene first, pool second - see `URL_PARAMS`. A scene is never sent as
  // `component:<sceneId>`; that was the shape of the bug one layer down.
  const scope = useMemo(() => buildScope(setId, regionParam, sceneParam), [setId, regionParam, sceneParam]);

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
          // `?? null` rather than a default object: an API deployed before the
          // scene board sends nothing, and an invented header would claim the
          // scene does not exist. Without one the page falls back to naming
          // the pool, which is exactly what it did before.
          scene: response.data.scene ?? null,
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
    updateParams([[key, value]]);
  };

  /**
   * Several parameters in one write, because the scene and the scope have to
   * move together.
   *
   * Two `updateParam` calls would each build their patch from the same stale
   * `searchParams`, so the second would drop the first - the classic form of
   * this bug, and here it would leave a scene selected with the previous
   * scene's board under it.
   */
  const updateParams = (patch: [string, string | null][]) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of patch) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next);
  };

  // Everyone the engine will quote a number for is in the table - settled or
  // not. What `provisional` withholds is the *position*, not the figure.
  const { scored, unscored } = splitByRating(state.entries);
  const coverage = state.coverage;
  const selectedComponent = state.component;
  // The scene header, when this board is a scene's. It is what the page is
  // named after now; `selectedComponent` is still carried beside it, because
  // the pool is the second of the two facts and the link out to it.
  const selectedScene = state.scene;
  // Global is the scope that mixes pools; a scene or a `?region=` scope is one.
  const mixesScenes = !selectedComponent;
  // The `Pool` column exists only where it is a **second** number.
  //
  // On a scene that is most of its pool - which is the common shape, since the
  // engine writes a component ladder only for the largest pools and a small
  // pool is often one scene - every row's pool position equals its scene
  // position, and a column repeating the one beside it is furniture. The same
  // rule the `#` column itself follows (`hasPositions`): ask the data, not the
  // scope. It appears the moment one row differs, which is exactly when the
  // reader needs to know the two are not the same question.
  const showsPoolRank =
    selectedScene !== null && scored.some((entry) => entry.poolRank != null && entry.poolRank !== entry.rank);
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
  // The scene board's own caveat, or null when there is nothing to caveat. It
  // quotes the **pool's** size for the too-small case, because that is what
  // the threshold measures - a scene of forty whose pool is six still has no
  // orderable board, and the arithmetic has to be about the right set.
  const sceneNotice = selectedScene
    ? sceneBoardNotice(selectedScene, minSceneSize, selectedScene.componentSize)
    : null;
  const sceneUnknown = selectedScene ? sceneUnknownNotice(selectedScene) : null;

  return (
    <div className="ranking-page">
      <div className="ranking-head">
        <h1>Rankings</h1>
        <p className="ranking-head-sub">
          {/* **The heading names what the reader picked.**

              On a scene board that is the scene, and that is the whole repair:
              it used to name the *pool*, because a scene link had nowhere else
              to land, and a pool is named after the modal city of a
              reachability closure - so `Peninsula` in the picker sat under
              `North West Community Development Council` in the heading, a
              Singapore CDC label. The pool has not been hidden; it is one line
              down, under its own name, as the board a reader can widen to.

              On a pool board (a shared `?region=` link) the heading is the
              pool's, as it always was, and the hint still says why that name
              can differ from the picker's - one pool covers several scenes.
              Nothing is renamed to make two true names agree. */}
          {selectedScene ? (
            <abbr className="col-hint" title={HINTS.scene}>
              {sceneBoardLabel(selectedScene)}
            </abbr>
          ) : selectedComponent ? (
            <abbr className="col-hint" title={HINTS.pool}>
              {componentLabel(selectedComponent)}
            </abbr>
          ) : (
            componentLabel(selectedComponent)
          )}{' '}
          &middot; {scopeLabel}
        </p>
      </div>

      {/* One filter row, above everything it scopes.

          The map of scenes is **not** a fourth control here and not a peer tab
          above them either: it is the second mode of the Scene picker, because
          "which scene" and "which place" are one question asked two ways. A
          segmented `Ladder | Scene map` pair was tried above this row and
          removed - it claimed the map was a second view of the ladder, which
          put a reader one click from a page that answers a different question
          than the one they were in the middle of. The way to the full map is
          the expand control inside the picker's own mini map. */}
      <div className="ranking-filters">
        <SetScope
          sets={sets}
          value={setId}
          name="ranking-set"
          onChange={(next) => updateParam(URL_PARAMS.SET, next === ALL_SETS ? null : next)}
        />

        <SceneSelect
          components={state.components}
          // The scene when one was picked, else the scope - which is what the
          // fallback rows are keyed on, so a bare `?region=` link still marks
          // its row while the directory is in flight.
          value={sceneParam ?? regionParam}
          /* Both at once, and which of the two is written decides which board
             the reader gets.

             A **catalogue row** is a scene, so it writes `?scene=` and clears
             `?region=`: the scene now has a board of its own, so there is no
             longer any reason to send the reader to the pool's. That holds even
             for a scene with no pool - the API answers an empty board that says
             so, which is a better answer than silently falling back to Global,
             and that fallback is what the old `null` scope did.

             A **fallback row** - one built from the ladder's own `components`
             for the few hundred milliseconds before the directory lands - *is*
             a pool, so it writes `?region=`. `SceneSelect` tells the two apart;
             see its `onChange`. */
          onChange={(sceneId, nextScope) =>
            updateParams([
              [URL_PARAMS.SCENE, sceneId],
              [URL_PARAMS.REGION, nextScope],
            ])
          }
          hint={HINTS.scene}
          // The API's own name for what it just served, for the field before
          // the scene directory lands. The scene's own label when there is one;
          // otherwise the pool's, which is a different kind of name and is why
          // the heading above carries a hint saying so.
          selectedLabel={
            selectedScene ? sceneBoardLabel(selectedScene) : selectedComponent?.regionLabel ?? null
          }
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
            scene={selectedScene}
            scopeLabel={scopeLabel}
            search={search}
          />

          {/* A scene the engine has no item for. Not an error and not an empty
              board's fault: it is the state of every scene id until a refit has
              run with an accepted assignment, so a shared link lands here for
              up to a day after a deploy rather than 404ing through it. */}
          {sceneUnknown && <div className="notice-banner">{sceneUnknown}</div>}

          {/* One line. Why lives in the hover hint, like every other
              explanation on this page - the banner reports, it does not teach.

              Three facts now, and the scene one is the honest caveat this
              board needs: a scene is comparable *internally* because it sits
              inside one pool, and `componentCount > 1` is the case where it
              does not. See `sceneBoardNotice`, which also keeps the too-small
              line quoting the **pool's** size rather than the scene's. */}
          {(scored.length > 0 || unscored.length > 0) &&
            (selectedScene ? sceneNotice !== null : !laddered) && (
              <div
                className="notice-banner"
                title={
                  selectedScene
                    ? selectedScene.comparable
                      ? SCENE_SPLIT_POOL_HINT
                      : `Positions need at least ${minSceneSize} players who have played each other.`
                    : `Positions need at least ${coverage?.minComponentSize ?? minSceneSize} players who have played each other.`
                }
              >
                {selectedScene
                  ? sceneNotice
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
                          {/* On Global the `#` needs qualifying because the
                              order spans pools; on a scene board it needs
                              qualifying for the opposite reason - the number
                              is a place *here*, and the `Pool` column beside
                              it is the same player somewhere wider, so a
                              reader has to be told which is which. Both carry
                              the dotted underline the Rating and Margin
                              headers use. On a pool board the order is earned
                              over the whole board and needs nothing. */}
                          {mixesScenes ? (
                            <abbr className="col-hint" title={GLOBAL_POSITION_HINT}>#</abbr>
                          ) : selectedScene ? (
                            <abbr className="col-hint" title={SCENE_POSITION_HINT}>#</abbr>
                          ) : (
                            '#'
                          )}
                        </th>
                      )}
                      {/* The same player's place on the wider pool's board.
                          It earns a column because the two numbers answer two
                          questions - "where do I stand among the people I
                          play" and "where do I stand among everyone my games
                          chain to" - and because seeing #2 here beside #37
                          there is what makes the pool link below legible. */}
                      {showsPoolRank && (
                        <th scope="col" className="numeric">
                          <abbr className="col-hint" title={POOL_POSITION_HINT}>Pool</abbr>
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
                          {showsPoolRank && (
                            <td className="numeric muted" title={POOL_POSITION_HINT}>
                              {/* A dash, not a blank: a row with no place in
                                  the scene has none in the pool either - the
                                  gate is the pool's size in both cases - and
                                  the cell has to read as "no position" rather
                                  than as missing data. */}
                              {entry.poolRank ?? '--'}
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
  scene,
  scopeLabel,
  search,
}: {
  coverage: RankingCoverage | null;
  component: { componentId?: string | null; componentSize: number | null; regionLabel: string | null; comparable: boolean } | null;
  /** The scene header, on a scene board only. */
  scene: SceneBoardInfo | null;
  scopeLabel: string;
  search: string;
}) {
  if (!coverage) return null;

  // The block is named after what the reader picked, like the heading above
  // it: the scene on a scene board, the pool on a pool board, Global on
  // neither. It used to be the pool's name unconditionally, which is how a
  // Singapore label came to sit over a San Francisco scene.
  const where = scene ? sceneBoardLabel(scene) : component?.regionLabel ?? GLOBAL_SCENE_LABEL;
  const seen = coverage.totalPlayers;
  const ratedPercent = seen > 0 ? (coverage.ratedPlayers / seen) * 100 : 0;
  const poolId = scene?.componentId ?? null;

  return (
    <section className="panel scene-summary" aria-label="Rating coverage">
      <div className="scene-identity">
        <h2 className="scene-name">{where}</h2>
        <p className="scene-meta">
          <span className="scope-chip">{scopeLabel}</span>
          {/* On a scene board the size shown is the **scene's** - its own
              stores and its own players - and the pool's size travels on the
              link out to it instead. Printing the pool's figure here is what
              overstated a scene by an order of magnitude on the event page
              before the scene line was fixed. */}
          {scene ? (
            <>
              {scene.venueCount !== null && (
                <span>
                  {scene.venueCount.toLocaleString('en-US')} store{scene.venueCount === 1 ? '' : 's'}
                </span>
              )}
              {!scene.comparable && <span>too small for places</span>}
            </>
          ) : (
            <>
              {component?.componentSize !== null && component?.componentSize !== undefined && (
                <span>{component.componentSize} players in the co-play graph</span>
              )}
              {component && !component.comparable && <span>too small for places</span>}
            </>
          )}
        </p>
        {/* **The pool board stays reachable, and this is the way to it.** It
            is the honest answer to "who else is on this scale", and the scene
            board is deliberately the narrower question - so the link is here
            rather than the destination. Named after the pool, with its size,
            because a control reading "the whole ladder" would imply the scene
            board was a partial one. `carryPreview`, like every internal link
            on this page: the section is unlisted and a bare href strands the
            reader. */}
        {scene && poolId !== null && (
          <p className="scene-meta">
            <Link
              className="scene-pool-link"
              to={carryPreview(scenePath(poolId), search)}
              title={POOL_LINK_HINT}
            >
              {POOL_LINK_LABEL}
            </Link>
            {scene.componentSize !== null && (
              <span>{scene.componentSize.toLocaleString('en-US')} players on it</span>
            )}
          </p>
        )}
      </div>

      <div className="scene-coverage">
        <span className="stat-label">Rated</span>
        <p className="coverage-headline">
          {/* The floor caveat rides the figure it is about rather than
              standing as a line under the block: more players here than one
              page of coverage means both counts understate. */}
          {coverage.coverageComplete ? (
            <>
              <strong>{coverage.ratedPlayers}</strong>
              <span className="coverage-of"> of {seen} players seen</span>
            </>
          ) : (
            <abbr className="col-hint" title={COVERAGE_FLOOR_HINT}>
              <strong>{coverage.ratedPlayers}</strong>
              <span className="coverage-of"> of {seen}+ players seen</span>
            </abbr>
          )}
        </p>
        <div
          className="coverage-track"
          role="img"
          aria-label={`${coverage.ratedPlayers} of ${seen} players seen here have enough recorded games to be rated.${
            coverage.coverageComplete ? '' : ` ${COVERAGE_FLOOR_HINT}`
          }`}
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
          <p>No games have been recorded for this slice yet.</p>
        )}
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
  const [coverage, setCoverage] = useState<PlayerSearchCoverage | undefined>(undefined);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setHits([]);
      setCoverage(undefined);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchPlayers(term)
        .then((response) => {
          if (cancelled) return;
          setHits(response.data);
          setCoverage(response.coverage);
        })
        .catch(() => {
          if (cancelled) return;
          setHits([]);
          // A failed request is not a complete search, and must not be
          // reported as "no player by that name".
          setCoverage({ complete: false, searchedPlayers: null, matched: 0, truncated: false, maxResults: 0 });
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

  const caption = searchCaption(coverage, hits.length);

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
          {/* The caption carries the three answers an empty or cut list needs
              to be read honestly - see `searchCaption`. It replaces a flat
              "No player by that name.", which this box printed over players
              the ladder beside it was listing. */}
          {!searching && caption && (
            <div className={caption.partial ? 'search-empty search-partial' : 'search-empty'} role="status">
              {caption.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default RankingPage;
