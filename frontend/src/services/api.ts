import type { EventsResponse, EventResponse, EventFilters, ScrapeInfoResponse, GeocodeResponse } from '../types/event';

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
