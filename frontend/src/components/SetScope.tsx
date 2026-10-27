import type { SetInfo } from '../types/ranking';
import {
  ALL_SETS,
  ALL_SETS_LABEL,
  selectableSets,
  setBoundaryNote,
  setLabel,
  shouldUseSetPills,
} from '../lib/ranking';

/**
 * The set scope: segmented pills while the choice is short, a `<select>` once
 * it is not.
 *
 * Sets are an *unbounded, append-only* list. Riot ships roughly four a year,
 * `selectableSets` only ever adds one (a set with rating data never stops
 * having it), and so the control that fits today silently stops fitting. A
 * segmented row that works at three options overflows at ten, and overflow in
 * a filter is how a scope quietly becomes unreachable.
 *
 * So the control adapts rather than being chosen once. This is also what the
 * reference does, which the first pass got backwards: lolchess uses tabs for
 * *regions* - a fixed handful - and a dropdown for *sets*, where it is at
 * eighteen and counting. Pills were borrowed from the wrong control.
 *
 * It degrades on purpose. With no sets loaded this renders a single
 * "Radiance+" pill, which still reads as a deliberate scope label rather than
 * an empty control - the state the page is in whenever the API is down.
 */

interface SetScopeProps {
  sets: SetInfo[];
  value: string;
  onChange: (setId: string) => void;
  /** Distinguishes the two pages' controls when both are in the DOM. */
  name: string;
}

function SetScope({ sets, value, onChange, name }: SetScopeProps) {
  const options = selectableSets(sets);
  const active = options.find((set) => set.setId === value) ?? null;
  const asPills = shouldUseSetPills(options.length);

  return (
    <div className="filter-group set-scope-group">
      <span className="filter-label" id={`${name}-label`}>
        Set
      </span>

      {asPills ? (
        <div className="pill-group" role="radiogroup" aria-labelledby={`${name}-label`}>
          <button
            type="button"
            role="radio"
            aria-checked={value === ALL_SETS}
            className={`pill${value === ALL_SETS ? ' is-active' : ''}`}
            onClick={() => onChange(ALL_SETS)}
          >
            {ALL_SETS_LABEL}
          </button>
          {options.map((set) => (
            <button
              key={set.setId}
              type="button"
              role="radio"
              aria-checked={value === set.setId}
              className={`pill${value === set.setId ? ' is-active' : ''}`}
              onClick={() => onChange(set.setId)}
            >
              {setLabel(set)}
            </button>
          ))}
        </div>
      ) : (
        <select
          id={`${name}-select`}
          aria-labelledby={`${name}-label`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value={ALL_SETS}>{ALL_SETS_LABEL}</option>
          {options.map((set) => (
            <option key={set.setId} value={set.setId}>
              {setLabel(set)}
            </option>
          ))}
        </select>
      )}

      {active?.releaseDate && <span className="filter-note">{setBoundaryNote(active)}</span>}
    </div>
  );
}

export default SetScope;
