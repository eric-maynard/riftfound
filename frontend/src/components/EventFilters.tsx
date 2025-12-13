import { useState, useEffect, useRef } from 'react';
import { getLocationSuggestions, geocodeCity } from '../services/api';
import type { GeocodeSuggestion } from '../types/event';
import TypeSelect from './TypeSelect';

export interface EventFilters {
  location: {
    lat: number;
    lng: number;
    displayName: string;
  } | null;
  distanceMiles: number;
  format: string | null;
}

interface EventFiltersProps {
  filters: EventFilters;
  appliedFilters: EventFilters;
  onFiltersChange: (filters: EventFilters) => void;
  onSearch: (filtersOverride?: EventFilters) => void;
  availableFormats: string[];
}

const DISTANCE_OPTIONS = [
  { value: 5, label: '5 mi' },
  { value: 10, label: '10 mi' },
  { value: 25, label: '25 mi' },
  { value: 50, label: '50 mi' },
  { value: 100, label: '100 mi' },
];

// Check if two filter states are equal
function filtersEqual(a: EventFilters, b: EventFilters): boolean {
  if (a.distanceMiles !== b.distanceMiles) return false;
  if (a.format !== b.format) return false;
  if (a.location === null && b.location === null) return true;
  if (a.location === null || b.location === null) return false;
  return (
    a.location.lat === b.location.lat &&
    a.location.lng === b.location.lng &&
    a.location.displayName === b.location.displayName
  );
}

function EventFiltersComponent({ filters, appliedFilters, onFiltersChange, onSearch, availableFormats }: EventFiltersProps) {
  const [cityInput, setCityInput] = useState(filters.location?.displayName || '');
  const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Check if search would do anything
  const hasChanges = !filtersEqual(filters, appliedFilters);
  // Allow search if:
  // 1. Location is set and there are changes, OR
  // 2. User has typed text that could be geocoded (even without autocomplete selection)
  const hasTypedLocation = cityInput.trim().length >= 2 && cityInput !== filters.location?.displayName;
  const canSearch = (filters.location !== null && hasChanges) || hasTypedLocation;

  // Update input when filters change externally (e.g., geolocation)
  useEffect(() => {
    if (filters.location?.displayName) {
      setCityInput(filters.location.displayName);
    }
  }, [filters.location?.displayName]);

  // Debounced search for suggestions
  useEffect(() => {
    const trimmedInput = cityInput.trim();
    if (trimmedInput.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    // Don't search if input matches current location
    if (filters.location?.displayName === trimmedInput) {
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const response = await getLocationSuggestions(trimmedInput);
        setSuggestions(response.data);
        setShowSuggestions(response.data.length > 0);
        setSelectedIndex(-1);
      } catch {
        setSuggestions([]);
      }
    }, 200); // 200ms debounce

    return () => clearTimeout(timer);
  }, [cityInput, filters.location?.displayName]);

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
    setCityInput(suggestion.displayName);
    onFiltersChange({
      ...filters,
      location: {
        lat: suggestion.latitude,
        lng: suggestion.longitude,
        displayName: suggestion.displayName,
      },
    });
    setSuggestions([]);
    setShowSuggestions(false);
    setError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) {
      // Allow Enter to trigger search when no suggestions showing
      if (e.key === 'Enter' && canSearch) {
        e.preventDefault();
        handleSearchClick();
      }
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
        } else {
          // No suggestion selected, trigger search with geocoding
          if (canSearch) {
            setShowSuggestions(false);
            handleSearchClick();
          }
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
        setCityInput('My Location');
        onFiltersChange({
          ...filters,
          location: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            displayName: 'My Location',
          },
        });
        setLoading(false);
      },
      () => {
        setError('Unable to get location');
        setLoading(false);
      }
    );
  };

  const handleDistanceChange = (value: number) => {
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

  const handleSearchClick = async () => {
    if (!canSearch) return;

    // If user typed something but didn't select from autocomplete, geocode it first
    if (hasTypedLocation) {
      setLoading(true);
      setError(null);
      try {
        const response = await geocodeCity(cityInput.trim());
        if (response.data) {
          const newLocation = {
            lat: response.data.latitude,
            lng: response.data.longitude,
            displayName: response.data.displayName,
          };
          setCityInput(response.data.displayName);
          // Pass new filters directly to onSearch to avoid state race condition
          const newFilters = {
            ...filters,
            location: newLocation,
          };
          onSearch(newFilters);
        } else {
          setError('Location not found');
        }
      } catch {
        setError('Unable to find location');
      } finally {
        setLoading(false);
      }
    } else {
      onSearch();
    }
  };

  return (
    <div className="event-filters">
      <div className="filter-row">
        <div className="filter-group">
          <label>Type</label>
          <TypeSelect
            value={filters.format}
            options={availableFormats}
            onChange={handleFormatChange}
          />
        </div>

        <div className="filter-group">
          <label>Distance</label>
          <select
            value={filters.distanceMiles}
            onChange={(e) => handleDistanceChange(Number(e.target.value))}
          >
            {DISTANCE_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.value}>
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

        <div className="filter-group search-group">
          <label>&nbsp;</label>
          <button
            className="btn-search"
            onClick={handleSearchClick}
            disabled={!canSearch}
          >
            Search
          </button>
        </div>
      </div>

      {error && <div className="filter-error">{error}</div>}
    </div>
  );
}

export default EventFiltersComponent;
