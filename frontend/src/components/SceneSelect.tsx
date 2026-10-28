import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentSummary } from '../types/ranking';
import { filterSceneOptions, findSceneOption, sceneOptions } from '../lib/ranking';

/**
 * The scene picker, in two modes: **By name** and **Map**.
 *
 * ## By name - the default, and the accessible one
 *
 * Type to filter, arrow keys to move, Enter to choose. There are already ~194
 * connected components with a board of their own and the number grows with
 * every event scraped, so a plain `<select>` had become a scroll-and-hope list.
 * The interaction deliberately copies the calendar's location autocomplete
 * (`EventFilters.tsx`) - same input-plus-listbox shape, same key handling, same
 * click-outside dismissal - rather than inventing a second idiom for the same
 * job. Filtering itself lives in `lib/ranking.ts` as a pure function, so the
 * list behaviour is unit-tested without a DOM.
 *
 * It stays the default and it is never the mode a reader has to leave to reach
 * a scene. A map is not keyboard-navigable or screen-reader-navigable in any
 * useful way - `SceneMap` is `role="application"` and says so - so Map is an
 * alternative input, not the route to anything. Every scene a pin can choose,
 * this list can choose.
 *
 * ## Map - a mini canvas, where "which scene" is really "which place"
 *
 * The scene names are places (`Puget Sound`, `Lille, France`, `Central
 * Singapore Community Development Council, 01`), and a reader who knows where
 * they play but not what the engine's modal label calls it cannot type the
 * answer. Clicking a pin does **exactly** what choosing a row does - the same
 * `onChange`, which writes the same `?region=` scope - because the map is a
 * second way to express one choice, not a second mechanism.
 *
 * Two constraints shape how it is wired:
 *
 * - **the ladder does not pay for it.** `SceneMiniMap` is behind `React.lazy`,
 *   so Leaflet's 47KB chunk and the `/api/rankings/map` request happen the
 *   first time someone switches to Map and never on a ladder load. Nothing in
 *   this file imports `lib/sceneMap.ts`, for the Rollup reason written up in
 *   `lib/ranking.ts`: a module shared between an eager and a lazy chunk is
 *   hoisted into the eager one whole.
 * - **the way back is always visible.** The mode pair sits beside the label in
 *   both modes, so switching back is one click from anywhere in the control -
 *   which matters more here than it would on a page, because a map that
 *   replaced the field it was reached from would be a dead end.
 *
 * The pair borrows `.pill` from `SetScope`, because the page already spells
 * "pick one of these" that way and a second vocabulary for the same gesture is
 * how a UI stops being learnable. They are buttons with `aria-pressed`, not
 * links: this mode is a way of looking at one control, not a route - unlike
 * the expand control inside the map, which really does go somewhere.
 */

/** See the note above: Leaflet must not land in the ladder's bundle. */
const SceneMiniMap = lazy(() => import('./SceneMiniMap'));

interface SceneSelectProps {
  components: ComponentSummary[];
  value: string | null;
  onChange: (componentId: string | null) => void;
  /** Hover/focus text for the label - the picker explains itself here. */
  hint?: string;
  /**
   * What the page calls the current selection, when the option list cannot say.
   *
   * `components` is whatever `/api/rankings` sent, which is **41 scenes** on the
   * live board against 1,307 in the catalogue - so a scene chosen on the map,
   * or arriving in a shared `?region=` link, is routinely not in the list the
   * closed field reads its own caption from. Without this the field went blank
   * for exactly those scenes while the heading above it named them.
   */
  selectedLabel?: string | null;
}

function SceneSelect({ components, value, onChange, hint, selectedLabel }: SceneSelectProps) {
  const options = useMemo(() => sceneOptions(components), [components]);
  const selected = findSceneOption(options, value);

  const [mode, setMode] = useState<'name' | 'map'>('name');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => filterSceneOptions(options, query), [options, query]);

  // Clamp the highlight whenever the list shortens under the typing.
  useEffect(() => {
    setActiveIndex((index) => (index < matches.length ? index : 0));
  }, [matches.length]);

  // Keep the highlighted row in view when the arrows walk past the fold.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[data-active="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function close() {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  }

  function choose(index: number) {
    const option = matches[index];
    if (!option) return;
    onChange(option.id);
    close();
    inputRef.current?.blur();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIndex(0);
          return;
        }
        setActiveIndex((index) => (index + 1 >= matches.length ? 0 : index + 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        setActiveIndex((index) => (index - 1 < 0 ? Math.max(0, matches.length - 1) : index - 1));
        return;
      case 'Enter':
        if (!open) return;
        event.preventDefault();
        choose(activeIndex);
        return;
      case 'Escape':
        if (!open) return;
        event.preventDefault();
        close();
        return;
      case 'Tab':
        if (open) close();
        return;
      default:
    }
  }

  const listId = 'scene-select-list';
  const hintMark = hint ? (
    <span className="filter-hint" tabIndex={0} role="note" aria-label={hint} title={hint}>
      ?
    </span>
  ) : null;

  return (
    <div className="filter-group scene-select" ref={wrapRef}>
      <div className="scene-select-head">
        {/* The label is a `<label>` only where there is a field for it to name.
            In Map mode the control is a canvas and a chip list, neither of
            which a `for=` can point at, so it is a plain caption and the map
            carries its own label. */}
        {mode === 'name' ? (
          <label className="filter-label" htmlFor="ranking-region" title={hint}>
            Scene
            {hintMark}
          </label>
        ) : (
          <span className="filter-label" title={hint}>
            Scene
            {hintMark}
          </span>
        )}

        <div className="pill-group scene-modes" role="group" aria-label="Choose a scene by">
          <button
            type="button"
            className={`pill${mode === 'name' ? ' is-active' : ''}`}
            aria-pressed={mode === 'name'}
            onClick={() => setMode('name')}
          >
            By name
          </button>
          <button
            type="button"
            className={`pill${mode === 'map' ? ' is-active' : ''}`}
            aria-pressed={mode === 'map'}
            title="Pick a scene by where it plays. Every scene is still in the By name list."
            onClick={() => {
              // Leaving the open listbox behind would float it over the map.
              close();
              setMode('map');
            }}
          >
            Map
          </button>
        </div>
      </div>

      {mode === 'map' ? (
        <Suspense
          fallback={
            <div className="scene-mini">
              <div className="scene-mini-canvas">
                <p className="scene-mini-placeholder muted">Loading the map...</p>
              </div>
            </div>
          }
        >
          <SceneMiniMap
            value={value}
            onChange={onChange}
            selectedLabel={selected?.label ?? selectedLabel ?? null}
          />
        </Suspense>
      ) : (
        <>
          <input
            ref={inputRef}
            id="ranking-region"
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && matches[activeIndex] ? `scene-option-${activeIndex}` : undefined}
            autoComplete="off"
            className="scene-select-input"
            placeholder="Search scenes"
            // Closed, the field *is* the current selection; open, it is the
            // query. `selectedLabel` is the fallback for a scene the loaded
            // option list does not carry - see the prop's note.
            value={open ? query : selected?.label ?? selectedLabel ?? ''}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              setActiveIndex(0);
            }}
            onFocus={() => {
              setQuery('');
              setOpen(true);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          {open && (
            <div ref={listRef} id={listId} className="scene-options" role="listbox" aria-label="Scenes">
              {matches.length === 0 ? (
                <div className="search-empty">No scene by that name.</div>
              ) : (
                matches.map((option, index) => (
                  <div
                    key={option.id ?? 'everywhere'}
                    id={`scene-option-${index}`}
                    role="option"
                    aria-selected={option.id === value}
                    data-active={index === activeIndex}
                    className={`scene-option${index === activeIndex ? ' is-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => {
                      // Choose before the input's blur can close the list.
                      event.preventDefault();
                      choose(index);
                    }}
                  >
                    <span className="scene-option-label">{option.label}</span>
                    <span className="scene-option-meta">{option.meta}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default SceneSelect;
