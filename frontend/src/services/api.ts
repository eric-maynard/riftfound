import type { EventsResponse, EventResponse, EventFilters, ScrapeInfoResponse, GeocodeResponse, GeocodeSuggestionsResponse } from '../types/event';
import type {
  PlayerMatchesResponse,
  PlayerProfileResponse,
  PlayerSearchResponse,
  RankingsResponse,
  RatingSeriesResponse,
  SceneMapResponse,
  SetsResponse,
} from '../types/ranking';
import type {
  TournamentAvailabilityResponse,
  TournamentDetailResponse,
} from '../types/tournament';

const API_BASE = '/api';

/**
 * A failed request, carrying the status alongside the API's own message.
 *
 * The status matters because a 404 is often not an error: most events have no
 * tournament facts, and the message the API sends for that ("No tournament
 * facts for this event") is not something a caller should have to pattern
 * match on. The `message` is unchanged, so callers that already read it still
 * work.
 */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

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
    throw new ApiError(error.error || `HTTP ${response.status}`, response.status);
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

/**
 * Every scene with a place, for the map.
 *
 * No parameters, deliberately - not a bounding box, not a zoom. The whole
 * catalogue is one cached answer every reader shares (one DynamoDB Query, 46
 * read units measured on production), where a viewport parameter would
 * fragment the edge cache into a key per pan. Filtering a few hundred
 * kilobytes is the browser's job.
 */
export async function getSceneMap(): Promise<SceneMapResponse> {
  return fetchApi<SceneMapResponse>('/rankings/map');
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

// --- Tournament facts ------------------------------------------------------

/**
 * The hard ceiling the API enforces on one availability request. Mirrors
 * `MAX_AVAILABILITY_IDS` in `backend/src/models/tournament.ts`: over it the
 * endpoint 400s, so the caller chunks rather than discovering that at runtime.
 */
export const MAX_AVAILABILITY_IDS = 50;

/**
 * Which of these events have standings or a roster worth opening.
 *
 * One call answers for a whole day list. Asking per event would be an N+1 on
 * every calendar render, which is why this endpoint is batched at all.
 */
export async function getTournamentAvailability(
  externalIds: string[]
): Promise<TournamentAvailabilityResponse> {
  // Sorted so the URL is a function of the *set* of ids, not the order the
  // calendar happened to lay them out in. The same day re-rendered in a
  // different order is the same question, and an unsorted key asked the edge a
  // brand new one each time - a guaranteed miss on a route whose miss is a
  // 100-key BatchGet.
  const ids = [...externalIds].slice(0, MAX_AVAILABILITY_IDS).sort().join(',');
  return fetchApi<TournamentAvailabilityResponse>(
    `/events/tournament-availability?ids=${encodeURIComponent(ids)}`
  );
}

/** One event's standings, pairings and roster, with ratings joined on. */
export async function getEventTournament(externalId: string): Promise<TournamentDetailResponse> {
  return fetchApi<TournamentDetailResponse>(
    `/events/${encodeURIComponent(externalId)}/tournament`
  );
}
