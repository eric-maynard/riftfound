import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentSummary } from '../types/ranking';
import { filterSceneOptions, findSceneOption, sceneOptions } from '../lib/ranking';

/**
 * The scene picker: type to filter, arrow keys to move, Enter to choose.
 *
 * There are already ~194 connected components and the number only grows with
 * every event scraped, so a plain `<select>` had become a scroll-and-hope list.
 * The interaction deliberately copies the calendar's location autocomplete
 * (`EventFilters.tsx`) - same input-plus-listbox shape, same key handling, same
 * click-outside dismissal - rather than inventing a second idiom for the same
 * job.
 *
 * Filtering itself lives in `lib/ranking.ts` as a pure function, so the list
 * behaviour is unit-tested without a DOM.
 */

interface SceneSelectProps {
  components: ComponentSummary[];
  value: string | null;
  onChange: (componentId: string | null) => void;
  /** Hover/focus text for the label - the picker explains itself here. */
  hint?: string;
}

function SceneSelect({ components, value, onChange, hint }: SceneSelectProps) {
  const options = useMemo(() => sceneOptions(components), [components]);
  const selected = findSceneOption(options, value);

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
        aria-activedescendant={open && matches[activeIndex] ? `scene-option-${activeIndex}` : undefined}
        autoComplete="off"
        className="scene-select-input"
        placeholder="Search scenes"
        // Closed, the field *is* the current selection; open, it is the query.
        value={open ? query : selected?.label ?? ''}
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
    </div>
  );
}

export default SceneSelect;
