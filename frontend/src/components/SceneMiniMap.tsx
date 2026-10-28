import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getSceneMap } from '../services/api';
import SceneMap from './SceneMap';
import type { SceneMapCoverage, SceneMapEntry } from '../types/ranking';
import {
  formatCount,
  offMapSentence,
  sceneLabel,
  scenePlaceHint,
} from '../lib/sceneMap';
import { sceneMapPath } from '../lib/ranking';
import { carryPreview } from '../lib/preview';

/**
 * The Map mode of the scene picker: pick a scene by pointing at where it plays.
 *
 * ## Why this module exists at all, rather than more JSX in `SceneSelect`
 *
 * It is the **lazy half** of the picker, and the split is load-bearing rather
 * than tidiness. Leaflet plus its stylesheet is a 47KB gzipped chunk, and the
 * ladder must not pay for it: `SceneSelect` reaches this file only through
 * `React.lazy`, so both the chunk and the `GET /api/rankings/map` request
 * happen the first time a reader switches to Map, and never on a ladder load.
 * Measured before and after: the main bundle is unchanged at 152.69KB gzipped.
 *
 * That is also why this file, and not `SceneSelect`, is what imports
 * `lib/sceneMap.ts`. Rollup hoists a module shared between an eager chunk and a
 * lazy one into the eager one *whole* (see the note in `lib/ranking.ts`), so one
 * helper imported from the picker itself would have dragged the map's geometry
 * and copy into every calendar visitor's bundle. `sceneMapPath` and
 * `carryPreview` are the eager-side exceptions by design - they are link
 * plumbing and already live in eager modules.
 *
 * ## What a click does
 *
 * Exactly what choosing a row in the By name list does: it calls the same
 * `onChange`, which is `RankingPage`'s `updateParam(URL_PARAMS.REGION, ...)`,
 * which writes `?region=` and rescopes the ladder. There is deliberately no
 * second path into the scope - the map is another *input* to one mechanism, not
 * a second mechanism - which is why clicking the basemap clears to Global, the
 * same null the picker's first row sends.
 *
 * ## The scenes that have no pin, which is the hard part
 *
 * Measured on production 2026-10-27: 1,286 of 1,307 scenes are located and
 * **21 are `dispersed`** - their match-weighted centroid falls 150-2,300km from
 * their own nearest venue, so the API withholds it rather than assert a place a
 * scene has never played (backend/CLAUDE.md, "The scene map"). Those 21 hold
 * **41% of recorded players**: Singapore 5,405, Toronto 2,213, New York 1,688,
 * Paris 1,306.
 *
 * A map mode that offered only pins would therefore lose the four biggest
 * scenes in the corpus, silently. Three things stop that, and none of them is a
 * pin at a guessed position:
 *
 * 1. **They are listed under the map as chips**, ordered by player count, and
 *    choosing one does the identical thing a pin does. So Map mode reaches
 *    every scene, and the two modes do not disagree about which scenes exist.
 * 2. **A selected dispersed scene says so, in words**, through the same
 *    `scenePlaceHint` the map page uses - with the distance that caused it -
 *    while the canvas draws its **venues**. A reader who arrives with Toronto
 *    selected must not be shown an empty map that looks like it lost the
 *    scene; it is shown where Toronto actually plays, and told why there is no
 *    one pin.
 * 3. **The frame follows the selection** (`sceneFocusBounds`), so those venue
 *    pins are what the canvas opens on rather than something the reader has to
 *    find by panning.
 *
 * ## One request per page load
 *
 * The payload is ~560KB of JSON for the whole catalogue, identical for every
 * reader and edge-cached, so toggling modes must not refetch it. It is kept in
 * a module-level promise: this module only exists once the reader has asked for
 * Map at all, and after that the data outlives any number of mode switches.
 */

/** The fetch, shared by every mount of this component in the page's lifetime. */
let catalogue: Promise<MiniMapData> | null = null;

interface MiniMapData {
  scenes: SceneMapEntry[];
  unlocated: SceneMapEntry[];
  coverage: SceneMapCoverage | null;
}

function loadCatalogue(): Promise<MiniMapData> {
  if (!catalogue) {
    catalogue = getSceneMap()
      .then((response) => ({
        scenes: response.data.scenes,
        unlocated: response.data.unlocated,
        coverage: response.data.coverage,
      }))
      .catch((error: unknown) => {
        // A failed fetch must not be cached as a failure: the reader's next
        // switch to Map is the retry, and By name worked throughout.
        catalogue = null;
        throw error;
      });
  }
  return catalogue;
}

interface SceneMiniMapProps {
  /** The selected scene, or null for Global. Same value the name picker holds. */
  value: string | null;
  /** The picker's own `onChange`. A pin and a dropdown row call this alike. */
  onChange: (componentId: string | null) => void;
  /**
   * What the rest of the page calls the current selection, used for the one
   * sentence that has to name a scene this map has never heard of.
   *
   * It is deliberately **not** used to re-caption the selected scene, and the
   * reason is a live inconsistency this control must not amplify.
   * `/api/rankings` takes `component.regionLabel` from `listComponents()` while
   * `/api/rankings/map` reads the engine's `COMPONENT#` item, and the two
   * disagree for **16 of the 41** scenes the ladder's picker offers: one
   * component reads `Simi Valley, CA` on the ladder and `New York, New York`
   * on the map; the scene whose chip here reads `Toronto, Canada` is
   * `City of Greater Dandenong, Australia` on the ladder. That bug is out of
   * scope, but either choice of name would make this control contradict
   * something a reader can see at the same moment - the page's heading, or the
   * chip they just clicked. So the note names no scene at all: the selection is
   * shown by the ringed pin and the pressed chip, the name is the page
   * heading's job, and each surface keeps the name its own source gave it.
   */
  selectedLabel: string | null;
}

function SceneMiniMap({ value, onChange, selectedLabel }: SceneMiniMapProps) {
  const { search } = useLocation();
  const [data, setData] = useState<MiniMapData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadCatalogue()
      .then((loaded) => live && setData(loaded))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const selected = useMemo(() => {
    if (!data || value === null) return null;
    return (
      data.scenes.find((scene) => scene.componentId === value) ??
      data.unlocated.find((scene) => scene.componentId === value) ??
      null
    );
  }, [data, value]);

  // Biggest first: the dispersed scenes are the biggest scenes in the corpus,
  // and a reader looking for Singapore should not have to read 20 chips first.
  const offMap = useMemo(
    () => (data ? [...data.unlocated].sort((a, b) => b.playerCount - a.playerCount) : []),
    [data]
  );
  const offMapNote = useMemo(
    () => (data ? offMapSentence(data.unlocated, data.coverage?.totalPlayers ?? 0) : null),
    [data]
  );

  /* The full page, with this selection intact - the map's own URL carries it
     (`sceneMapPath`), so this is the existing shareable view rather than a
     second way of saying the same thing. `carryPreview` because Rankings is
     unlisted: a link that drops the flag unmounts the mode switch under the
     reader and strands them (lib/preview.ts). */
  const fullMapTo = carryPreview(
    value === null ? '/rankings/map' : sceneMapPath(value),
    search
  );

  return (
    <div className="scene-mini">
      <div className="scene-mini-canvas">
        {data && data.scenes.length > 0 ? (
          <SceneMap
            scenes={data.scenes}
            // Passed whole rather than looked up inside the map: a dispersed
            // scene is not in `scenes` at all, and its venues are the only
            // thing the map can honestly draw for it.
            selected={selected}
            selectedId={value}
            onSelect={onChange}
            variant="mini"
          />
        ) : (
          <p className="scene-mini-placeholder muted">
            {/* Three states, not two: a catalogue that arrived with no pin in
                it is a real answer - the engine has never published where its
                scenes are - and reading "Loading" forever would be a lie about
                it. The chips below still carry every scene there is. */}
            {failed
              ? 'Could not load the map of scenes.'
              : data
                ? 'No scene has a place on the map yet.'
                : 'Loading the map...'}
          </p>
        )}

        {/* The way to the whole page. A link, not a button: it is a route
            someone can bookmark, and it is the only navigation this control
            does. The glyph carries a real accessible name, since an arrow pair
            announced on its own is not one. */}
        <Link className="scene-mini-expand" to={fullMapTo} title="Open the full scene map">
          <span aria-hidden="true">&#10530;</span>
          <span className="sr-only">Open the full scene map</span>
        </Link>
      </div>

      <p className="scene-mini-note">
        {failed ? (
          'Pick a scene by name instead - the list has every one of them.'
        ) : selected ? (
          // What the selected pin claims, or - for a dispersed scene - why
          // there is none. This is the whole answer to "where did my scene go":
          // it names the distance that cost the scene its pin and says the
          // venue dots are what replaced it. No scene name here; see
          // `selectedLabel`.
          scenePlaceHint(selected)
        ) : value !== null ? (
          // Selected on the ladder, absent from the map catalogue: the engine
          // refits the two at different times, so this is a lag rather than an
          // error, and By name still holds the scene.
          <>
            <strong>{selectedLabel ?? 'This scene'}</strong> is not in the map catalogue yet. It is
            still in the By name list.
          </>
        ) : (
          'Click a pin to scope the ladder to that scene, or the map itself for Global.'
        )}
      </p>

      {offMapNote && (
        <div className="scene-mini-offmap">
          <p className="scene-mini-offmap-note">{offMapNote}</p>
          <ul className="scene-mini-chips">
            {offMap.map((scene) => (
              <li key={scene.componentId}>
                {/* A button, not a pin: these scenes have no honest position,
                    and this is the same selection a pin makes. Also a real
                    focus target, which is what keeps 41% of the corpus
                    reachable without a mouse in this mode. */}
                <button
                  type="button"
                  className={`scene-mini-chip${scene.componentId === value ? ' is-active' : ''}`}
                  aria-pressed={scene.componentId === value}
                  title={scenePlaceHint(scene)}
                  onClick={() => onChange(scene.componentId)}
                >
                  {sceneLabel(scene)}
                  <span className="scene-mini-chip-count">{formatCount(scene.playerCount)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default SceneMiniMap;
