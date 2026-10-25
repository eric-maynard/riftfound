import type { EventsResponse, EventResponse, EventFilters, ScrapeInfoResponse, GeocodeResponse, GeocodeSuggestionsResponse } from '../types/event';
import type {
  PlayerMatchesResponse,
  PlayerProfileResponse,
  PlayerSearchResponse,
  RankingsResponse,
  RatingSeriesResponse,
  SetsResponse,
} from '../types/ranking';

const API_BASE = '/api';

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

export async function getEvents(filters?: EventFilters): Promise<EventsResponse> {
  const params = new URLSearchParams();

  if (filters) {
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') {
        params.set(key, String(value));
      }
    });
  }

  const query = params.toString();
  return fetchApi<EventsResponse>(`/events${query ? `?${query}` : ''}`);
}

export async function getEvent(id: string): Promise<EventResponse> {
  return fetchApi<EventResponse>(`/events/${id}`);
}

export async function getScrapeInfo(): Promise<ScrapeInfoResponse> {
  return fetchApi<ScrapeInfoResponse>('/events/info');
}

export async function geocodeCity(query: string): Promise<GeocodeResponse> {
  return fetchApi<GeocodeResponse>(`/events/geocode?q=${encodeURIComponent(query)}`);
}

export async function getLocationSuggestions(query: string): Promise<GeocodeSuggestionsResponse> {
  return fetchApi<GeocodeSuggestionsResponse>(`/events/geocode/suggest?q=${encodeURIComponent(query)}`);
}

export async function reverseGeocode(lat: number, lon: number): Promise<GeocodeResponse> {
  return fetchApi<GeocodeResponse>(`/events/geocode/reverse?lat=${lat}&lon=${lon}`);
}

// --- Ranking ---------------------------------------------------------------

export async function getRankings(options: {
  scope?: string;
  limit?: number;
  cursor?: string | null;
}): Promise<RankingsResponse> {
  const params = new URLSearchParams();
  if (options.scope) params.set('scope', options.scope);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  const query = params.toString();
  return fetchApi<RankingsResponse>(`/rankings${query ? `?${query}` : ''}`);
}

export async function getPlayer(playerId: string): Promise<PlayerProfileResponse> {
  return fetchApi<PlayerProfileResponse>(`/players/${encodeURIComponent(playerId)}`);
}

export async function getPlayerMatches(
  playerId: string,
  options: { limit?: number; cursor?: string | null; setId?: string | null } = {}
): Promise<PlayerMatchesResponse> {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.setId) params.set('setId', options.setId);
  const query = params.toString();
  return fetchApi<PlayerMatchesResponse>(
    `/players/${encodeURIComponent(playerId)}/matches${query ? `?${query}` : ''}`
  );
}

export async function getPlayerRatings(
  playerId: string,
  scope?: string
): Promise<RatingSeriesResponse> {
  const query = scope ? `?scope=${encodeURIComponent(scope)}` : '';
  return fetchApi<RatingSeriesResponse>(`/players/${encodeURIComponent(playerId)}/ratings${query}`);
}

export async function searchPlayers(query: string): Promise<PlayerSearchResponse> {
  return fetchApi<PlayerSearchResponse>(`/players/search?q=${encodeURIComponent(query)}`);
}

export async function getSets(): Promise<SetsResponse> {
  return fetchApi<SetsResponse>('/sets');
}
