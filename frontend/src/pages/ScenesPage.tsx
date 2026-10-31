import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { getSceneMap } from '../services/api';
import SceneMap from '../components/SceneMap';
import type { SceneMapCoverage, SceneMapEntry } from '../types/ranking';
import {
  filterScenes,
  formatCount,
  formatSpread,
  sceneComparableHint,
  sceneCoverageSentence,
  sceneLabel,
  sceneLadderNote,
  scenePlaceHint,
  scenePurityHint,
  scenePurityLabel,
  sceneSummary,
} from '../lib/sceneMap';
import {
  POOL_LINK_HINT,
  POOL_LINK_LABEL,
  SCENE_MAP_PARAM,
  sceneLadderPath,
  scenePath,
} from '../lib/ranking';
import { carryPreview } from '../lib/preview';

/**
 * The map of scenes: where the competitive scenes are, and the way into each
 * one's ladder.
 *
 * ## What a pin means, and what it does not
 *
 * A scene is a cluster of **stores** - close enough together that the players
 * who play at them really play each other - published by the rating engine from
 * an assignment an operator accepted, and named the way a local names it:
 * `Peninsula`, `South Bay`, `Nassau County`.
 *
 * **This page used to list connected components instead**, which is why it read
 * `Karlsruhe, Deutschland` and `Paris, France` and why `Peninsula` was not
 * selectable anywhere on it - and why a `?scene=<sceneId>` link, the only kind
 * an event page can produce, resolved to the unfiltered world view. A component
 * is a reachability closure of the co-play graph: one travelling player welds
 * two cities into one permanently, and the measured case was a 1,688-player
 * component labelled `New York, New York` whose five busiest stores were all in
 * California.
 *
 * A scene's pin is the **match-weighted centroid of the venues its own games
 * were played at**, computed by the engine during its replay, where the
 * coordinates and the membership are in the same hand. Nothing here geocodes
 * anything or infers a position from a name.
 *
 * So the page has to carry three caveats the map cannot:
 *
 * 1. **A scene with no geocoded venue has no pin, and is listed instead.**
 *    Never at its label's city (a different precision claim wearing the same
 *    clothes), never at `0, 0`.
 * 2. **Some stores are in no scene at all**, and they cannot be listed here
 *    because they are absent from a catalogue of scenes by construction. A
 *    geographic cluster is only published as a scene when its players play
 *    each other enough to rank anybody, so a store whose regulars only ever
 *    play visitors keeps none - 38 venues on the live assignment. The coverage
 *    line counts them, because nothing else on the page can.
 * 3. **A scene is not a ladder.** The ladder's scope is a *rating pool* - a
 *    connected component - and a pool covers several scenes, so the link out of
 *    a scene says what it opens rather than calling it "this scene's ladder".
 *    `sceneLadderNote` is that sentence.
 *
 * ## Layout
 *
 * Map above, list below, on the same data and with the same selection - a flat
 * column of sibling sections, like every other page in this section, so it
 * restacks on a phone without a second layout. The list is not a fallback: it
 * is the keyboard and screen-reader surface for the whole page (the map is
 * `role="application"` with a label pointing at it), it holds the unlocated
 * scenes, and it is how a reader finds a named scene without hunting a world
 * map for a 5px dot.
 *
 * Every link out of here goes through `carryPreview` - Rankings is unlisted,
 * and one link that drops the flag unmounts the mode switch and strands the
 * reader with no visible way back (see `lib/preview.ts`).
 */

/** Scenes listed before the list asks the reader to narrow it. */
const LIST_LIMIT = 60;

const HINTS = {
  scene:
    'A group of stores close enough together that the players at them really play each other. It is where you play, not a ranking: ratings are only comparable between players whose games chain together, which is a wider pool covering several scenes.',
  place:
    'Each pin is the centroid of the venues that scene’s games were played at, weighted by how many were played at each, and the disc around it is how far those venues spread. A scene with no geocoded venue has no pin and is listed below instead; a store whose players only ever play visitors is in no scene at all, and is counted here rather than drawn.',
  spread:
    'The mean distance from the pin to the venues it was computed from. A small figure is a city; a large one is a travel circuit, and the pin is its middle rather than a place anyone plays.',
} as const;

interface MapState {
  scenes: SceneMapEntry[];
  unlocated: SceneMapEntry[];
  coverage: SceneMapCoverage | null;
}

const EMPTY: MapState = { scenes: [], unlocated: [], coverage: null };

/** The selected scene lives in the URL, so a view of one scene is shareable. */
// `SCENE` is shared with `sceneMapPath` in lib/sceneMap.ts, which is how an
// event page links in here with one scene already selected. Two spellings of
// it would be a link that selects nothing.
const URL_PARAMS = { SCENE: SCENE_MAP_PARAM, QUERY: 'q' } as const;

function ScenesPage() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<MapState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedId = searchParams.get(URL_PARAMS.SCENE);
  const query = searchParams.get(URL_PARAMS.QUERY) ?? '';

  useEffect(() => {
    let live = true;
    setLoading(true);
    getSceneMap()
      .then((response) => {
        if (!live) return;
        setState({
          scenes: response.data.scenes,
          unlocated: response.data.unlocated,
          coverage: response.data.coverage,
        });
        setError(null);
      })
      .catch(() => live && setError('Could not load the scene map.'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      // `replace`, not push: panning around a map should not fill the back
      // button with a history entry per scene a reader glanced at.
      const next = new URLSearchParams(searchParams);
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const select = useCallback(
    (sceneId: string | null) => updateParam(URL_PARAMS.SCENE, sceneId),
    [updateParam]
  );

  const all = useMemo(() => [...state.scenes, ...state.unlocated], [state.scenes, state.unlocated]);
  const matching = useMemo(() => filterScenes(all, query), [all, query]);
  // The map shows what the search matched, so typing a city narrows the pins
  // too rather than only the list.
  const mapScenes = useMemo(() => filterScenes(state.scenes, query), [state.scenes, query]);
  const selected = useMemo(
    () => all.find((scene) => scene.sceneId === selectedId) ?? null,
    [all, selectedId]
  );

  const coverage = state.coverage;
  // Published alongside, so the "too small to order" sentence quotes the
  // server's threshold rather than a constant guessed here - the same
  // discipline as the ladder's.
  const minSceneSize = coverage?.minComponentSize ?? 8;

  return (
    <div className="ranking-page scenes-page">
      {/* The way back, above the heading.
          This page is a drill-down now: it is reached from the expand control
          inside the ladder's scene picker, so the reader was mid-task on the
          ladder and the return trip is the likeliest next thing they want. It
          is repeated at the foot, because the page is a 60-row list and a reader
          who has walked down it should not have to walk back up to leave.
          `carryPreview` on both - Rankings is unlisted and a link without the
          flag strands the reader (lib/preview.ts). */}
      <p className="scene-back">
        <Link to={carryPreview('/rankings', location.search)}>&larr; Back to the ladder</Link>
      </p>

      <div className="ranking-head">
        <h1>Scenes</h1>
        <p className="ranking-head-sub">
          <abbr className="col-hint" title={HINTS.scene}>
            Where Riftbound is played
          </abbr>
        </p>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && all.length === 0 ? (
        <p className="muted">Loading scenes...</p>
      ) : (
        <>
          {/* The coverage line, first, because it is the caveat on everything
              below it. One line, with the method in the hover hint - the same
              split the ladder uses for its own caveats. */}
          {coverage && (
            <p className="scene-map-coverage">
              <abbr className="col-hint" title={HINTS.place}>
                {sceneCoverageSentence(coverage)}
              </abbr>
            </p>
          )}

          {mapScenes.length > 0 && (
            // `selected` is passed whole rather than looked up inside the map,
            // because a dispersed scene is not in `mapScenes` at all and its
            // venues are the only thing the map can honestly draw for it.
            <SceneMap
              scenes={mapScenes}
              selected={selected}
              selectedId={selectedId}
              onSelect={select}
            />
          )}

          {selected && (
            <SceneDetail
              scene={selected}
              minSceneSize={minSceneSize}
              search={location.search}
              onClear={() => select(null)}
            />
          )}

          <div className="scene-list-head">
            <label className="scene-search">
              <span className="sr-only">Find a scene</span>
              <input
                type="search"
                value={query}
                placeholder="Find a scene"
                onChange={(event) => updateParam(URL_PARAMS.QUERY, event.target.value)}
              />
            </label>
            <span className="muted">
              {formatCount(matching.length)} of {formatCount(all.length)}
            </span>
          </div>

          {matching.length === 0 ? (
            <p className="muted">No scene matches that.</p>
          ) : (
            <ul className="scene-list">
              {matching.slice(0, LIST_LIMIT).map((scene) => (
                <SceneRow
                  key={scene.sceneId}
                  scene={scene}
                  selected={scene.sceneId === selectedId}
                  minSceneSize={minSceneSize}
                  search={location.search}
                  onSelect={select}
                />
              ))}
            </ul>
          )}

          {matching.length > LIST_LIMIT && (
            <p className="muted">
              {formatCount(matching.length - LIST_LIMIT)} more &mdash; search to narrow them.
            </p>
          )}

          <p className="scene-foot">
            <Link to={carryPreview('/rankings', location.search)}>Back to the ladder</Link>
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The selected scene, expanded.
 *
 * The one place the page states a pin's basis in full, because this is the one
 * place a reader has asked about a specific scene. An unlocated scene gets the
 * same block minus the geography, rather than a different component: what is
 * known about it is its ladder, and that is the same link either way.
 */
function SceneDetail({
  scene,
  minSceneSize,
  search,
  onClear,
}: {
  scene: SceneMapEntry;
  minSceneSize: number;
  search: string;
  onClear: () => void;
}) {
  const located = scene.latitude !== null && scene.longitude !== null;
  const tooSmall = sceneComparableHint(scene, minSceneSize);
  const ladder = sceneLadderNote(scene);
  const purity = scenePurityHint(scene);
  const purityLabel = scenePurityLabel(scene);
  const place = scenePlaceHint(scene);

  return (
    <div className="scene-detail">
      <div className="scene-detail-head">
        <h2>
          {sceneLabel(scene)}
          {scene.isGiant && <span className="scene-tag">largest scene</span>}
        </h2>
        <button type="button" className="scene-clear" onClick={onClear}>
          Clear
        </button>
      </div>

      <p className="scene-detail-summary">{sceneSummary(scene)}</p>

      <dl className="scene-facts">
        <div>
          <dt>Matches</dt>
          <dd>{formatCount(scene.matchCount)}</dd>
        </div>
        <div>
          <dt>Venues</dt>
          <dd>
            {/* What the pin was computed from is the caveat on this figure,
                so it rides the figure rather than a paragraph below. */}
            <abbr className="col-hint" title={place}>
              {located && scene.locatedVenues < scene.venueCount
                ? `${formatCount(scene.locatedVenues)} of ${formatCount(scene.venueCount)} on the map`
                : formatCount(scene.venueCount)}
            </abbr>
          </dd>
        </div>
        {/* The spread is shown for a dispersed scene too, and matters more
            there: it is the figure that says why the scene has no pin. */}
        {(located || scene.dispersed) && scene.spreadKm !== null && scene.spreadKm > 0 && (
          <div>
            <dt>
              <abbr className="col-hint" title={HINTS.spread}>
                Spread
              </abbr>
            </dt>
            <dd>{formatSpread(scene.spreadKm)}</dd>
          </div>
        )}
        {/* How honestly the scene holds together, as a figure beside the other
            figures rather than as a sentence reading one out. Absent at 100%,
            which is what makes it worth a column when it is there. */}
        {purityLabel && purity && (
          <div>
            <dt>
              <abbr className="col-hint" title={purity}>
                In-scene play
              </abbr>
            </dt>
            <dd>{purityLabel}</dd>
          </div>
        )}
      </dl>

      {/* Only when there is no pin. A scene missing from the map beside this
          panel reads as a scene the map lost, and nothing else on the page
          says otherwise; a scene that *is* pinned needs no sentence, and its
          basis is the hint on the venue count above. */}
      {(!located || scene.dispersed) && <p className="scene-place-note">{place}</p>}

      {tooSmall && <p className="scene-place-note">{tooSmall}</p>}

      {/* How honestly the scene holds together, where it does not hold
          outright. Silent at 100%, which is almost every scene. */}
      {purity && <p className="scene-place-note">{purity}</p>}

      {/* The links out, and the sentence that keeps them honest.

          **The pin leads to this scene's board now**, which is what a reader
          clicking `Peninsula` was asking for all along. It used to lead to the
          pool's, because a scene had no board - and a pool is named after the
          modal city of a reachability closure, so this control opened a ladder
          headed `North West Community Development Council`, a Singapore CDC
          label, from a San Francisco scene.

          **The pool is still one click away, and labelled as the pool.** It is
          the honest answer to "who else is on this scale", and the scene board
          is deliberately the narrower question, so it is the second link rather
          than the first. `sceneLadderNote` is the sentence that says the two
          apart, and it is above both because it qualifies both.

          A scene with no pool still has a board - the API answers it with the
          scene named and nothing on it, which says "nobody who plays here has
          been placed yet" better than a withheld link does - so the scene link
          is unconditional and only the pool link is gated. */}
      <p className="scene-place-note">{ladder}</p>
      <Link className="scene-ladder-link" to={carryPreview(sceneLadderPath(scene.sceneId), search)}>
        Open this scene&rsquo;s ladder
      </Link>
      {scene.componentId !== null && (
        <Link
          className="scene-pool-link"
          to={carryPreview(scenePath(scene.componentId), search)}
          title={POOL_LINK_HINT}
        >
          {POOL_LINK_LABEL}
        </Link>
      )}
    </div>
  );
}

/** One row of the list. Selecting it moves the map; the link leads to the ladder. */
function SceneRow({
  scene,
  selected,
  minSceneSize,
  search,
  onSelect,
}: {
  scene: SceneMapEntry;
  selected: boolean;
  minSceneSize: number;
  search: string;
  onSelect: (sceneId: string) => void;
}) {
  const located = scene.latitude !== null && scene.longitude !== null;
  const tooSmall = sceneComparableHint(scene, minSceneSize);

  return (
    <li className={selected ? 'scene-row is-selected' : 'scene-row'}>
      {/* A button rather than a link, because selecting is not navigation -
          and it is a real focus target, which is what makes the map's content
          reachable by keyboard at all. */}
      <button
        type="button"
        className="scene-row-main"
        aria-pressed={selected}
        onClick={() => onSelect(scene.sceneId)}
      >
        <span className="scene-row-name">
          {sceneLabel(scene)}
          {/* Not colour alone: a scene off the map says so in words, and the
              two reasons are different sentences rather than one. "Not
              geocoded" is a gap in our data; "spans several regions" is a fact
              about the scene, and it is the one that applies to the biggest
              scenes in the corpus. */}
          {scene.dispersed ? (
            <span className="scene-flag" title={scenePlaceHint(scene)}>
              spans several regions
            </span>
          ) : (
            !located && (
              <span className="scene-flag" title={scenePlaceHint(scene)}>
                not on the map
              </span>
            )
          )}
          {tooSmall && (
            <span className="scene-flag" title={tooSmall}>
              too small to order
            </span>
          )}
        </span>
        <span className="scene-row-summary">{sceneSummary(scene)}</span>
      </button>
      {/* `Ladder` means **this scene's** ladder now, which is what the word
          was always read as. It used to open the pool's board - wider than the
          scene, and named after a city somewhere else - and that mismatch is
          the bug this release fixes. The scene board exists even for a scene
          whose players are in no pool: it comes back named and empty, which
          says "nobody here has been placed yet" where a withheld link said
          nothing at all. So the link is unconditional; the pool is reached from
          the detail panel. */}
      <Link className="scene-row-link" to={carryPreview(sceneLadderPath(scene.sceneId), search)}>
        Ladder
      </Link>
    </li>
  );
}

export default ScenesPage;
