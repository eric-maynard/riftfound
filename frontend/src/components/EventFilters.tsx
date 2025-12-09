import { useState } from 'react';
import { geocodeCity } from '../services/api';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCitySearch = async () => {
    if (!cityInput.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const response = await geocodeCity(cityInput);
      onFiltersChange({
        ...filters,
        location: {
          lat: response.data.latitude,
          lng: response.data.longitude,
          displayName: response.data.displayName,
        },
        distanceMiles: filters.distanceMiles ?? 25,
      });
      setCityInput('');
    } catch {
      setError('Location not found');
    } finally {
      setLoading(false);
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
          <div className="location-input-row">
            <input
              type="text"
              placeholder="Enter city or zip code..."
              value={cityInput}
              onChange={(e) => setCityInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCitySearch()}
              disabled={loading}
            />
            <button
              onClick={handleCitySearch}
              disabled={loading || !cityInput.trim()}
              className="search-btn"
            >
              {loading ? 'Searching...' : 'Search'}
            </button>
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
