export interface Event {
  id: string;
  externalId: string;
  name: string;
  description: string | null;
  location: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  eventType: string | null;
  organizer: string | null;
  playerCount: number | null;
  price: string | null;
  url: string | null;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
  scrapedAt: string;
}

export interface ScrapeInfo {
  lastScrapeAt: string | null;
  totalEvents: number;
}

export interface ScrapeInfoResponse {
  data: ScrapeInfo;
}

export interface EventsResponse {
  data: Event[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface EventResponse {
  data: Event;
}

export interface EventFilters {
  page?: number;
  limit?: number;
  city?: string;
  state?: string;
  country?: string;
  startDateFrom?: string;
  startDateTo?: string;
  search?: string;
  eventType?: string;
  // Location-based filtering
  lat?: number;
  lng?: number;
  radiusKm?: number;
  // Calendar mode
  calendarMode?: boolean;
}

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  displayName: string;
}

export interface GeocodeResponse {
  data: GeocodeResult;
}

export interface GeocodeSuggestion {
  latitude: number;
  longitude: number;
  displayName: string;
  type: string;
}

export interface GeocodeSuggestionsResponse {
  data: GeocodeSuggestion[];
}
