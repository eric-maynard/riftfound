import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getSceneMap } from '../services/api';
import type { ComponentSummary, SceneMapEntry } from '../types/ranking';
import {
  filterSceneOptions,
  findSceneOption,
  NO_PIN_FLAG,
  sceneCatalogueOptions,
  sceneCountSummary,
  sceneMapPath,
  sceneOptionSelection,
  sceneOptions,
} from '../lib/ranking';
import { carryPreview } from '../lib/preview';

/**
 * The scene picker: a search field that opens onto a list of scenes beside a
 * map of them.
 *
 * ## One pane, two halves, one state
 *
 * Clicking the field opens a pane split the way a search-results page is - the
 * list on the left, the map on the right - and the two halves are views of the
 * same state rather than two controls that happen to be adjacent:
 *
 * - **typing filters both**. The map draws exactly the rows the list is
 *   showing, because the pins are derived from the filtered rows and not
 *   filtered separately;
 * - **pointing at one lights the other**. Hovering a row - or walking onto it
 *   with the arrow keys - emphasises its pin; hovering a pin emphasises and
 *   scrolls to its row;
 * - **choosing in either is the same choice**: one `onChange`, which is
 *   `RankingPage`'s `updateParam(URL_PARAMS.REGION, ...)`. There is no second
 *   way to set the scope and the map does not own any state of its own.
 *
 * This replaced a `By name | Map` pair of modes. Two modes make a reader choose
 * which half of one answer they want before they have seen either, and the map
 * was the half nobody found; a split needs no such choice.
 *
 * ## The list is the control; the map is an aid
 *
 * The list is the combobox - `role="listbox"`, `aria-activedescendant`,
 * type-ahead, arrows, Enter, Escape - exactly as it was before the map
 * existed, and it is complete: every scene is a row, including the 21 that have
 * no pin. A keyboard or screen-reader user never has to touch the map, and
 * nothing is reachable only through it. The map carries `role="application"`
 * and a label saying so.
 *
 * ## Two ids, and the whole point of this control
 *
 * **A row is a scene, and now it opens that scene's board.** `option.id` is the
 * engine's `sceneId` - what the map highlights and what `?scene=` records - and
 * `option.scope` is the `componentId` of the pool those players are rated in.
 * Picking a row writes the **scene**: the ladder has a `scene:<id>` scope now,
 * which is that pool's board filtered to this scene's rows and re-ranked among
 * them.
 *
 * It used to write the pool, because a scene had no board to open - and that is
 * the reported bug, because a pool is named after the modal city of a
 * reachability closure: picking `Peninsula` landed on a ladder headed `North
 * West Community Development Council`, a Singapore CDC label. The row's `meta`
 * still says which other scenes share the pool, because that is what the "see
 * the whole rating pool" link on the board leads to.
 *
 * This control also used to *list* components under the word "scene", which is
 * why `Peninsula` and `South Bay` were not offered anywhere and why the list
 * read `Karlsruhe, Deutschland` and `Paris, France`.
 *
 * ## Where the rows come from, and why not from the ladder
 *
 * From `/api/rankings/map` - the engine's scene directory - and not from
 * `/api/rankings`' `components`, which is **41 pools of 1,307 components**:
 * whatever the global board's first page happened to touch, and components
 * rather than scenes besides. The directory is also the map's own source, which
 * is what makes the two halves agree about which scenes exist and what they are
 * called.
 *
 * `components` is still used, as the **rows shown while the directory is in
 * flight**: a list that works immediately beats a correct list that appears a
 * moment later, and the footer says what is happening. Those fallback rows are
 * pools, so their `id` *is* a `componentId` and they carry no `scope` field at
 * all - they therefore write `?region=`, where a catalogue row writes
 * `?scene=`. `sceneOptionSelection` resolves that, and the distinction is
 * load-bearing: writing a pool's id under `?scene=` would be an id from the
 * wrong partition under the right parameter name, which is the shape of the bug
 * this release fixes. An explicit `null` scope means "this scene has no pool",
 * which is not the same as "the id is a pool" and still writes `?scene=`.
 *
 * ## What stays out of the bundle
 *
 * The map canvas is `React.lazy`, so Leaflet's chunk loads when the pane opens
 * and never on a ladder load. Nothing here imports `lib/sceneMap.ts` - Rollup
 * hoists a module shared between an eager and a lazy chunk into the eager one
 * whole (see `lib/ranking.ts`), which is why the row helpers this file needs
 * live in `lib/ranking.ts` instead. The catalogue *fetch* is deliberately not
 * behind the lazy boundary: the list must not wait on a map library it does
 * not use.
 */

/** The map canvas. Lazy; see the note above. */
const SceneMap = lazy(() => import('./SceneMap'));

/**
 * Below this width the pane is the list alone.
 *
 * A 390px phone cannot show a list beside a map; stacking them would push the
 * list - the thing that actually picks a scene - most of a screen down, for a
 * canvas where 1,286 pins sit under a fingertip. So the phone gets the list,
 * which is the better control at that size anyway, and the footer carries a
 * link to the full map page, which is built for a whole screen and can be
 * pinched. This is a render decision rather than a CSS one on purpose: a
 * display:none map still downloads Leaflet, fetches a basemap and measures
 * itself wrong.
 */
const SPLIT_MIN_WIDTH = 760;

/** Gutter kept between the pane and the viewport edge when it is nudged left. */
const PANE_GUTTER = 12;

/**
 * Rows drawn at once.
 *
 * There are 1,307 scenes and rendering every one of them costs ~300ms on open
 * and ~120ms a keystroke (measured, dev build) - a dropdown that stutters
 * while you type. The list is ordered biggest-first, so the cap keeps the rows
 * anyone is likely to be after, and typing reaches the rest; the same device as
 * the map page's own list, with the same footer line saying how many are left.
 *
 * The map is **not** capped: it draws every match. So a pin outside the first
 * 150 rows has no row to light up when it is hovered - its tooltip still names
 * it, and a click still picks it. That is the trade, and the alternative (a
 * list that stutters) is worse for the control's actual job.
 */
const LIST_CAP = 150;

interface SceneCatalogue {
  /** Scenes with a pin. What the map draws. */
  located: SceneMapEntry[];
  /** Every scene, pinned or not. What the list offers. */
  all: SceneMapEntry[];
}

/** One fetch per page load, shared by every open of the pane. */
let catalogueRequest: Promise<SceneCatalogue> | null = null;

function loadCatalogue(): Promise<SceneCatalogue> {
  if (!catalogueRequest) {
    catalogueRequest = getSceneMap()
      .then((response) => ({
        located: response.data.scenes,
        all: [...response.data.scenes, ...response.data.unlocated],
      }))
      .catch((error: unknown) => {
        // Never cache a failure: the next open is the retry, and the fallback
        // rows keep the picker working in the meantime.
        catalogueRequest = null;
        throw error;
      });
  }
  return catalogueRequest;
}

interface SceneSelectProps {
  components: ComponentSummary[];
  /**
   * The row to mark as chosen: a `sceneId` once the directory has loaded, or a
   * `componentId` from a bare `?region=` link, which is what the fallback rows
   * are keyed on. Either way it is an **id**, never a scope.
   */
  value: string | null;
  /**
   * The two URL parameters this choice sets, because they are two facts and
   * exactly one of them is written per row.
   *
   * `sceneId` goes in `?scene=` and `region` in `?region=`; the page reads the
   * first in preference to the second, so a scene row sets the scene and
   * clears the pool, while a fallback pool row does the reverse. A scene with
   * no pool still sets the scene - the board answers "no pool yet" honestly,
   * which it could not do when the picker fell back to Global.
   * `sceneOptionSelection` decides which, in one place.
   */
  onChange: (sceneId: string | null, region: string | null) => void;
  /** Hover/focus text for the label - the picker explains itself here. */
  hint?: string;
  /**
   * What the page calls the current selection, for the closed field before the
   * catalogue has loaded. `components` carries 41 scenes of 1,307, so without
   * this the field was blank for any scene arriving in a shared `?region=`
   * link or picked on the map.
   */
  selectedLabel?: string | null;
}

function SceneSelect({ components, value, onChange, hint, selectedLabel }: SceneSelectProps) {
  const { search } = useLocation();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [catalogue, setCatalogue] = useState<SceneCatalogue | null>(null);
  const [catalogueFailed, setCatalogueFailed] = useState(false);
  /** The scene the pointer is over, on either half. Null when nothing is. */
  const [hovered, setHovered] = useState<string | null>(null);
  const [splitFits, setSplitFits] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= SPLIT_MIN_WIDTH
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  // The rows. The catalogue when it is here, the ladder's 41 until then.
  const options = useMemo(
    () => (catalogue ? sceneCatalogueOptions(catalogue.all) : sceneOptions(components)),
    [catalogue, components]
  );
  const selected = findSceneOption(options, value);
  const matches = useMemo(() => filterSceneOptions(options, query), [options, query]);

  // The pins: the same rows, minus the ones with no place to be drawn. Derived
  // from `matches` rather than filtered separately, so the halves cannot
  // disagree about what the query means.
  const mapScenes = useMemo(() => {
    if (!catalogue) return [];
    if (query.trim() === '') return catalogue.located;
    const wanted = new Set(matches.map((option) => option.id));
    return catalogue.located.filter((scene) => wanted.has(scene.sceneId));
  }, [catalogue, matches, query]);

  const selectedScene = useMemo(
    () => (catalogue && value ? catalogue.all.find((scene) => scene.sceneId === value) ?? null : null),
    [catalogue, value]
  );

  /** The rows drawn, and so the rows the arrow keys and Enter walk. */
  const visible = useMemo(() => matches.slice(0, LIST_CAP), [matches]);

  /** The scene to emphasise: the pointer wins, else the keyboard's row. */
  const activeOption = visible[activeIndex] ?? null;
  const highlighted = hovered ?? activeOption?.id ?? null;

  /** The selected row's own "why there is no pin", or null. Contextual copy. */
  // The map link only carries a selection it knows is a **scene** id. Before
  // the directory lands, `value` may be a `componentId` off a shared
  // `?region=` link, and `?scene=<a component id>` is the exact bug this whole
  // change fixes - it would open the map and select nothing.
  const mapLink = selectedScene === null ? '/rankings/map' : sceneMapPath(selectedScene.sceneId);

  const selectedPinHint = selected?.pinHint ?? null;

  // Fetch once, when the pane is first opened. Not on mount: a reader who
  // never touches the picker should not pay for the catalogue.
  useEffect(() => {
    if (!open || catalogue) return;
    let live = true;
    loadCatalogue()
      .then((loaded) => live && setCatalogue(loaded))
      .catch(() => live && setCatalogueFailed(true));
    return () => {
      live = false;
    };
  }, [open, catalogue]);

  // Whether there is room for the map half. Watched rather than read once, so
  // rotating a tablet does not leave a half-pane behind.
  useEffect(() => {
    const media = window.matchMedia(`(min-width: ${SPLIT_MIN_WIDTH}px)`);
    const sync = () => setSplitFits(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // Clamp the highlight whenever the list shortens under the typing.
  useEffect(() => {
    setActiveIndex((index) => (index < visible.length ? index : 0));
  }, [visible.length]);

  // Keep the highlighted row in view - for the arrow keys, and for a pin the
  // pointer has wandered onto, which is the map half talking back to the list.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>('[data-highlighted="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, hovered]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
    setHovered(null);
  }, []);

  /** Dismiss and hand focus back to the field, which is where it came from. */
  const closeAndFocus = useCallback(() => {
    close();
    inputRef.current?.focus();
  }, [close]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, close]);

  /*
   * Keep the pane inside the viewport.
   *
   * It is anchored to the field's left edge and is far wider than the field, so
   * on a narrow desktop window its right edge would otherwise run off the page
   * and take the horizontal scrollbar with it. CSS cannot express "shift left
   * by however much you overflow" - it needs the element's own x - so this
   * measures and sets one custom property. Clamped so the fix can never push
   * the pane off the *left* edge instead, which is the version of this bug that
   * cannot be scrolled back into view.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const pane = paneRef.current;
    if (!pane) return;
    const place = () => {
      pane.style.setProperty('--pane-shift', '0px');
      const box = pane.getBoundingClientRect();
      const overflow = box.right - (document.documentElement.clientWidth - PANE_GUTTER);
      if (overflow <= 0) return;
      pane.style.setProperty('--pane-shift', `${-Math.min(overflow, Math.max(0, box.left - PANE_GUTTER))}px`);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, splitFits]);

  function chooseIndex(index: number) {
    const option = visible[index];
    if (!option) return;
    const { sceneId, region } = sceneOptionSelection(option);
    onChange(sceneId, region);
    closeAndFocus();
  }

  /**
   * A click on the map half.
   *
   * A pin is a choice, so it behaves like a row: it picks the scene and
   * closes. A click on the basemap arrives as `null` - `SceneMap` reads that as
   * "clear the selection" for the map *page*, where there is no list to go back
   * to - and is ignored here, because this pane has a visible `Global` row at
   * the top of its list and clearing by clicking the sea is an affordance
   * nobody can see.
   *
   * A pin is always a scene, never a pool, so no directory lookup is needed any
   * more: it writes `?scene=` and clears `?region=` exactly as its row does. It
   * used to have to find the pin's `componentId` on the directory precisely
   * because the pool was the only thing the ladder could be scoped to.
   */
  const selectFromMap = useCallback(
    (sceneId: string | null) => {
      if (sceneId === null) return;
      onChange(sceneId, null);
      closeAndFocus();
    },
    [onChange, closeAndFocus]
  );

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIndex(0);
          return;
        }
        setHovered(null);
        setActiveIndex((index) => (index + 1 >= visible.length ? 0 : index + 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        setHovered(null);
        setActiveIndex((index) => (index - 1 < 0 ? Math.max(0, visible.length - 1) : index - 1));
        return;
      case 'Enter':
        if (!open) return;
        event.preventDefault();
        chooseIndex(activeIndex);
        return;
      case 'Escape':
        if (!open) return;
        event.preventDefault();
        // Dismiss without choosing. Focus stays in the field, which is both
        // where it already was and where a reader expects to carry on typing.
        close();
        return;
      case 'Tab':
        if (open) close();
        return;
      default:
    }
  }

  const listId = 'scene-select-list';
  // All three counts leave out the `Global` row, which is a scope rather than a
  // scene: "1,308 scenes" would be off by one in a way a reader could check.
  const total = options.length - 1;
  const shown = matches.filter((option) => option.id !== null).length;
  const drawn = visible.filter((option) => option.id !== null).length;

  return (
    <div className="filter-group scene-select" ref={wrapRef}>
      <label className="filter-label" htmlFor="ranking-region" title={hint}>
        Scene
        {hint && (
          <span className="filter-hint" tabIndex={0} role="note" aria-label={hint} title={hint}>
            ?
          </span>
        )}
      </label>
      <input
        ref={inputRef}
        id="ranking-region"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeOption ? `scene-option-${activeIndex}` : undefined}
        autoComplete="off"
        className="scene-select-input"
        placeholder="Search scenes"
        // Closed, the field *is* the current selection; open, it is the query.
        value={open ? query : selected?.label ?? selectedLabel ?? ''}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActiveIndex(0);
          setHovered(null);
        }}
        onFocus={() => {
          setQuery('');
          setOpen(true);
          setActiveIndex(0);
        }}
        // A click on a field that already has focus fires no `focus` event, so
        // without this the pane could not be reopened after Escape.
        onMouseDown={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />

      {open && (
        <div className={`scene-pane${splitFits ? ' is-split' : ''}`} ref={paneRef}>
          <div
            ref={listRef}
            id={listId}
            className="scene-pane-list"
            role="listbox"
            aria-label="Scenes"
          >
            {visible.length === 0 ? (
              <div className="search-empty">No scene by that name.</div>
            ) : (
              visible.map((option, index) => {
                const isHighlighted = option.id === highlighted && highlighted !== null;
                return (
                  <div
                    key={option.id ?? 'global'}
                    id={`scene-option-${index}`}
                    role="option"
                    aria-selected={option.id === value}
                    data-highlighted={index === activeIndex || isHighlighted}
                    className={`scene-option${index === activeIndex ? ' is-active' : ''}${
                      isHighlighted ? ' is-highlighted' : ''
                    }`}
                    onMouseEnter={() => {
                      setActiveIndex(index);
                      setHovered(option.id);
                    }}
                    onMouseLeave={() => setHovered(null)}
                    onMouseDown={(event) => {
                      // Choose before the input's blur can close the list.
                      event.preventDefault();
                      chooseIndex(index);
                    }}
                  >
                    {/* The name, on its own line and first in the source.
                        Everything else on the row is secondary to it and the
                        layout now says so - see `.scene-option` in index.css
                        for the measurement that forced that, where the name was
                        being ellipsised to zero pixels by its own metadata. */}
                    <span className="scene-option-label">{option.label}</span>
                    {/* The second line: everything secondary, together. `metaHint`
                        carries the figure the short copy leaves out - how many
                        scenes share this ladder - for a reader who wants it, in
                        the same word-on-the-row/reason-in-a-title idiom as the
                        flag beside it. */}
                    <span className="scene-option-meta" title={option.metaHint ?? undefined}>
                      {option.meta}
                    </span>
                    {/* Words, not colour, and only on the rows it applies to: a
                        scene with no pin would otherwise simply fail to appear
                        on the map beside it, which reads as the map having lost
                        it. The reason is the flag's title; the selected scene
                        gets it in full under the map.

                        It sits on the **detail** line rather than beside the
                        name, and after the meta rather than before it. A
                        sibling of the label was already right - an ellipsis
                        inside the name must not be able to eat the flag - but
                        while it shared the name's line it could still take ~45px
                        off it, which on a 35-character label is the difference
                        between a legible name and a truncated one. Line one is
                        the name and nothing else; this is a fact about the
                        scene, so it belongs with the other facts. */}
                    {option.located === false && (
                      <span className="scene-flag" title={option.pinHint ?? undefined}>
                        {NO_PIN_FLAG}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {splitFits && (
            <div className="scene-pane-map">
              {/* Mounted as soon as there is a catalogue, pins or not: a query
                  that matches nothing would otherwise tear the map down and
                  build it again on the next keystroke, which flickers and
                  throws away the reader's view. An empty map reads correctly
                  as "nothing here matches". */}
              {catalogue ? (
                <Suspense fallback={<p className="scene-pane-wait muted">Loading the map...</p>}>
                  <SceneMap
                    scenes={mapScenes}
                    // Passed whole rather than looked up in `scenes`: a scene
                    // with no pin is not in that list, and its venues are the
                    // only thing the map can honestly draw for it.
                    selected={selectedScene}
                    selectedId={value}
                    highlightedId={highlighted}
                    onHighlight={setHovered}
                    onSelect={selectFromMap}
                    variant="mini"
                  />
                </Suspense>
              ) : (
                <p className="scene-pane-wait muted">
                  {catalogueFailed
                    ? 'The map is unavailable - the list is complete.'
                    : 'Loading the map...'}
                </p>
              )}

              {/* The one thing on this half that is not a pin: the way to the
                  full page, carrying the selection and the preview flag. */}
              <Link
                className="scene-pane-expand"
                to={carryPreview(mapLink, search)}
                title="Open the full scene map"
              >
                <span aria-hidden="true">&#10530;</span>
                <span className="sr-only">Open the full scene map</span>
              </Link>

              {/* Said where the pin would have been, and only for the scene
                  that is actually selected: a reader who picks Toronto and
                  watches nothing light up has otherwise been told the map lost
                  it. Never standing copy - most selections have a pin. */}
              {selectedPinHint && <p className="scene-pane-nopin">{selectedPinHint}</p>}
            </div>
          )}

          <p className="scene-pane-foot">
            <span className="muted">
              {catalogue ? sceneCountSummary(shown, total) : 'Loading every scene...'}
              {/* Only when the list is actually cut short. The map page's list
                  says the same thing the same way. */}
              {shown > drawn && ` · ${(shown - drawn).toLocaleString('en-US')} more, keep typing`}
            </span>
            {/* On a phone this is the only way to the map, so it is a named
                link rather than the glyph the split pane overlays on its own
                canvas. */}
            {!splitFits && (
              <Link
                className="scene-pane-foot-link"
                to={carryPreview(mapLink, search)}
              >
                See these on the map &rarr;
              </Link>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

export default SceneSelect;
