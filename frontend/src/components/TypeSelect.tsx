import { useState, useRef, useEffect } from 'react';
import { eventColor } from '../lib/eventColors';

interface TypeSelectProps {
  value: string | null;
  options: string[];
  onChange: (value: string | null) => void;
}

function ColorDot({ type }: { type: string }) {
  return (
    <span
      className="type-color-dot"
      style={{ backgroundColor: eventColor(type) }}
    />
  );
}

function TypeSelect({ value, options, onChange }: TypeSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSelect = (optionValue: string | null) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  return (
    <div className="type-select" ref={containerRef}>
      <button
        type="button"
        className="type-select-trigger"
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="type-select-value">
          {value ? (
            <>
              {value}
              <ColorDot type={value} />
            </>
          ) : (
            <>
              Any
              <span className="type-color-dots">
                {options.map((opt) => (
                  <ColorDot key={opt} type={opt} />
                ))}
              </span>
            </>
          )}
        </span>
        <span className="type-select-arrow"></span>
      </button>

      {isOpen && (
        <div className="type-select-dropdown" role="listbox">
          <div
            className={`type-select-option ${value === null ? 'selected' : ''}`}
            onClick={() => handleSelect(null)}
            role="option"
            aria-selected={value === null}
          >
            <span>Any</span>
            <span className="type-color-dots">
              {options.map((opt) => (
                <ColorDot key={opt} type={opt} />
              ))}
            </span>
          </div>
          {options.map((option) => (
            <div
              key={option}
              className={`type-select-option ${value === option ? 'selected' : ''}`}
              onClick={() => handleSelect(option)}
              role="option"
              aria-selected={value === option}
            >
              <span>{option}</span>
              <ColorDot type={option} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TypeSelect;
