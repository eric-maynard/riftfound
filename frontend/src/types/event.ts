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
  endDate: string | null;
  eventType: string | null;
  organizer: string | null;
  url: string | null;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
  scrapedAt: string;
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
}
