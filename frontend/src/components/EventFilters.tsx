import { useState, useEffect, useRef } from 'react';
import { getLocationSuggestions } from '../services/api';
import type { GeocodeSuggestion } from '../types/event';

export interface EventFilters {
  location: {
    lat: number;
    lng: number;
    displayName: string;
  } | null;
  distanceMiles: number | null;
  format: string | null;
}

interface EventFiltersProps {
  filters: EventFilters;
  onFiltersChange: (filters: EventFilters) => void;
  availableFormats: string[];
}

const DISTANCE_OPTIONS = [
  { value: null, label: 'Any Distance' },
  { value: 5, label: '5 mi' },
  { value: 10, label: '10 mi' },
  { value: 25, label: '25 mi' },
  { value: 50, label: '50 mi' },
  { value: 100, label: '100 mi' },
];

function EventFiltersComponent({ filters, onFiltersChange, availableFormats }: EventFiltersProps) {
  const [cityInput, setCityInput] = useState('');
  const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Debounced search for suggestions
  useEffect(() => {
    if (cityInput.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const response = await getLocationSuggestions(cityInput);
        setSuggestions(response.data);
        setShowSuggestions(response.data.length > 0);
        setSelectedIndex(-1);
      } catch {
        setSuggestions([]);
      }
    }, 200); // 200ms debounce

    return () => clearTimeout(timer);
  }, [cityInput]);

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelectSuggestion = (suggestion: GeocodeSuggestion) => {
    onFiltersChange({
      ...filters,
      location: {
        lat: suggestion.latitude,
        lng: suggestion.longitude,
        displayName: suggestion.displayName,
      },
      distanceMiles: filters.distanceMiles ?? 25,
    });
    setCityInput('');
    setSuggestions([]);
    setShowSuggestions(false);
    setError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) {
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : prev));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
          handleSelectSuggestion(suggestions[selectedIndex]);
        }
        break;
      case 'Escape':
        setShowSuggestions(false);
        setSelectedIndex(-1);
        break;
    }
  };

  const handleUseMyLocation = () => {
    if (!navigator.geolocation) {
      setError('Geolocation not supported');
      return;
    }

    setLoading(true);
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        onFiltersChange({
          ...filters,
          location: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            displayName: 'My Location',
          },
          distanceMiles: filters.distanceMiles ?? 25,
        });
        setLoading(false);
      },
      () => {
        setError('Unable to get location');
        setLoading(false);
      }
    );
  };

  const handleDistanceChange = (value: number | null) => {
    onFiltersChange({
      ...filters,
      distanceMiles: value,
    });
  };

  const handleFormatChange = (value: string | null) => {
    onFiltersChange({
      ...filters,
      format: value,
    });
  };

  const handleClearLocation = () => {
    onFiltersChange({
      ...filters,
      location: null,
      distanceMiles: null,
    });
  };

  return (
    <div className="event-filters">
      <div className="filter-row">
        <div className="filter-group">
          <label>Format</label>
          <select
            value={filters.format ?? ''}
            onChange={(e) => handleFormatChange(e.target.value || null)}
          >
            <option value="">All Formats</option>
            {availableFormats.map((format) => (
              <option key={format} value={format}>
                {format}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label>Distance</label>
          <select
            value={filters.distanceMiles ?? ''}
            onChange={(e) => handleDistanceChange(e.target.value ? Number(e.target.value) : null)}
            disabled={!filters.location}
          >
            {DISTANCE_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.value ?? ''}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group location-group">
          <label>Location</label>
          <div className="location-input-wrapper">
            <input
              ref={inputRef}
              type="text"
              placeholder="Enter city or zip code..."
              value={cityInput}
              onChange={(e) => setCityInput(e.target.value)}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              onKeyDown={handleKeyDown}
              disabled={loading}
              autoComplete="off"
            />
            {showSuggestions && suggestions.length > 0 && (
              <div ref={suggestionsRef} className="location-suggestions">
                {suggestions.map((suggestion, index) => (
                  <div
                    key={`${suggestion.latitude}-${suggestion.longitude}`}
                    className={`suggestion-item ${index === selectedIndex ? 'selected' : ''}`}
                    onClick={() => handleSelectSuggestion(suggestion)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <span className="suggestion-name">{suggestion.displayName}</span>
                    <span className="suggestion-type">{suggestion.type}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <a
            href="#"
            className="use-location-link"
            onClick={(e) => {
              e.preventDefault();
              if (!loading) handleUseMyLocation();
            }}
          >
            Use my current location
          </a>
        </div>
      </div>

      {error && <div className="filter-error">{error}</div>}

      {filters.location && (
        <div className="active-filter">
          <span>
            {filters.location.displayName}
            {filters.distanceMiles && ` (within ${filters.distanceMiles} mi)`}
          </span>
          <button onClick={handleClearLocation} className="btn-clear">
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

export default EventFiltersComponent;
