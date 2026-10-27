import { useState, useEffect, useId, useRef } from 'react';
import { getLocationSuggestions, geocodeCity } from '../services/api';
import type { GeocodeSuggestion } from '../types/event';
import { MY_LOCATION_NAME, type LocationControl } from '../lib/geolocation';
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
  useKilometers?: boolean;
  showFullEvents: boolean;
  onToggleShowFullEvents: () => void;
  /**
   * What the "use my current location" control says right now. Decided by
   * `locationControl` in `lib/geolocation.ts` and owned by `CalendarPage`,
   * because the same geolocation state drives the page-load default - there
   * used to be a second, divergent copy of it in this file.
   */
  currentLocationControl: LocationControl;
  onUseCurrentLocation: () => void;
}

const DISTANCE_VALUES = [5, 10, 25, 50, 100];

function getDistanceOptions(useKilometers: boolean) {
  const unit = useKilometers ? 'km' : 'mi';
  return DISTANCE_VALUES.map(value => ({
    value,
    label: `${value} ${unit}`,
  }));
}

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

function EventFiltersComponent({ filters, appliedFilters, onFiltersChange, onSearch, availableFormats, useKilometers = false, showFullEvents, onToggleShowFullEvents, currentLocationControl, onUseCurrentLocation }: EventFiltersProps) {
  const distanceOptions = getDistanceOptions(useKilometers);
  const hintId = useId();
  const [cityInput, setCityInput] = useState(filters.location?.displayName || '');
  const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  // Ref to suppress suggestions when search is in progress (prevents race with debounced fetch)
  const suppressSuggestionsRef = useRef(false);

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
      // Don't show suggestions if search is in progress
      if (suppressSuggestionsRef.current) {
        return;
      }
      try {
        const response = await getLocationSuggestions(trimmedInput);
        // Check again after async fetch in case search started during fetch
        if (suppressSuggestionsRef.current) {
          return;
        }
        setSuggestions(response.data);
        setShowSuggestions(response.data.length > 0);
        setSelectedIndex(-1);
      } catch {
        setSuggestions([]);
      }
    }, 600); // 600ms debounce to reduce API calls

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
    const newLocation = {
      lat: suggestion.latitude,
      lng: suggestion.longitude,
      displayName: suggestion.displayName,
    };
    const newFilters = {
      ...filters,
      location: newLocation,
    };
    setCityInput(suggestion.displayName);
    onFiltersChange(newFilters);
    setSuggestions([]);
    setShowSuggestions(false);
    setError(null);
    // Automatically search when a suggestion is selected
    onSearch(newFilters);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle Enter key specially - always allow geocoding typed text
    if (e.key === 'Enter') {
      e.preventDefault();

      // If a suggestion is selected, use it
      if (showSuggestions && selectedIndex >= 0 && selectedIndex < suggestions.length) {
        handleSelectSuggestion(suggestions[selectedIndex]);
        return;
      }

      // Otherwise, geocode the typed text if it's at least 2 characters
      const trimmedInput = cityInput.trim();
      if (trimmedInput.length >= 2) {
        setShowSuggestions(false);
        setSelectedIndex(-1);
        // Force geocoding by calling handleSearchClick, but we need to ensure
        // it geocodes even if the text matches current location
        handleSearchWithGeocode();
      }
      return;
    }

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
      case 'Escape':
        setShowSuggestions(false);
        setSelectedIndex(-1);
        break;
    }
  };

  /**
   * The location button cannot act right now - a fix is in flight, or a
   * geocode is.
   *
   * Carried as `aria-disabled` and a guard rather than the `disabled`
   * attribute: a disabled element loses focus, and "Locating..." can last ten
   * seconds, so a keyboard reader who pressed the button would be dumped back
   * on `<body>` and have to tab in again to find out what happened. The state
   * is still announced, and the press is still inert.
   */
  const locationButtonInert = currentLocationControl.disabled || loading;

  // Pressing the button clears a stale geocoding error: whatever the current
  // location turns out to be, "Location not found" is no longer the answer to
  // the question on screen.
  const handleUseCurrentLocationClick = () => {
    if (locationButtonInert) return;
    setError(null);
    setShowSuggestions(false);
    onUseCurrentLocation();
  };

  // A geocoding failure is about the thing the reader just typed, so it takes
  // the status line ahead of whatever the location control had to say.
  const statusMessage = error ?? currentLocationControl.status;
  const statusTone = error ? 'error' : currentLocationControl.tone;

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

  // Force geocode the typed text and search (used when pressing Enter)
  const handleSearchWithGeocode = async () => {
    const trimmedInput = cityInput.trim();
    if (trimmedInput.length < 2) return;

    // Close suggestions immediately when search starts
    suppressSuggestionsRef.current = true;
    setShowSuggestions(false);
    setSuggestions([]);
    setSelectedIndex(-1);
    setLoading(true);
    setError(null);
    try {
      const response = await geocodeCity(trimmedInput);
      if (response.data) {
        const newLocation = {
          lat: response.data.latitude,
          lng: response.data.longitude,
          displayName: response.data.displayName,
        };
        setCityInput(response.data.displayName);
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
  };

  const handleSearchClick = async () => {
    if (!canSearch) return;

    // Close suggestions immediately when search starts
    suppressSuggestionsRef.current = true;
    setShowSuggestions(false);
    setSuggestions([]);
    setSelectedIndex(-1);

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
            {distanceOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
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
              onFocus={() => {
                // Re-enable suggestions when user focuses input again
                suppressSuggestionsRef.current = false;
                // Clear the "My Location" stand-in when the reader clicks in
                // to type a place. It only appears when reverse geocoding
                // could not name the fix, and it is not a search term.
                if (cityInput === MY_LOCATION_NAME) {
                  setCityInput('');
                }
                if (suggestions.length > 0) {
                  setShowSuggestions(true);
                }
              }}
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
          <div className="location-options-row">
            {/* A real <button>, not the `<a href="#">` this used to be. It acts
                on this page rather than going anywhere: a link announces itself
                as navigation, answers Enter but not Space, and - the reason it
                matters here - has an href that `carryPreview` would have to
                keep the preview flag on. A button has nothing to carry.

                Withheld entirely where geolocation cannot work at all (no API,
                or an insecure origin); the live region below then carries the
                reason, because a control that can never do anything is
                furniture and a disabled one is unfocusable. Everywhere else it
                stays pressable - including when the permission is blocked,
                where the label says so and the press explains how to undo it.
                See lib/geolocation.ts. */}
            {currentLocationControl.available && (
              <button
                type="button"
                className="use-location-button"
                onClick={handleUseCurrentLocationClick}
                aria-disabled={locationButtonInert || undefined}
                aria-busy={currentLocationControl.busy || undefined}
                aria-describedby={currentLocationControl.hint ? hintId : undefined}
                title={currentLocationControl.hint || undefined}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <circle cx="8" cy="8" r="1.75" fill="currentColor" />
                  <path
                    d="M8 0.5v2.5M8 13v2.5M0.5 8h2.5M13 8h2.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                {currentLocationControl.label}
              </button>
            )}
            {currentLocationControl.hint && (
              <span id={hintId} className="sr-only">{currentLocationControl.hint}</span>
            )}
            <label className="hide-full-toggle">
              <input
                type="checkbox"
                checked={!showFullEvents}
                onChange={onToggleShowFullEvents}
              />
              <span className="toggle-switch" />
              <span>Hide full events</span>
            </label>
          </div>
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

      {/* One live region for both kinds of news - a failed geocode and the
          state of the location control - and it is **always in the DOM**,
          empty or not. A `role="status"` element that appears at the same
          moment as its text is an insertion rather than an update, and screen
          readers routinely miss those; an empty block box has no line box, so
          it costs no height while it waits. A geocode error wins the slot,
          because it answers the thing the reader just did. */}
      <p
        className={`filter-status${statusTone === 'error' ? ' filter-status-error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {statusMessage}
      </p>
    </div>
  );
}

export default EventFiltersComponent;
