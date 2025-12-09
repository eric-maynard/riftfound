import { useState, useEffect, useCallback } from 'react';
import type { Event, EventFilters, EventsResponse } from '../types/event';
import { getEvents } from '../services/api';

interface UseEventsResult {
  events: Event[];
  loading: boolean;
  error: string | null;
  pagination: EventsResponse['pagination'] | null;
  refetch: () => void;
  setFilters: (filters: EventFilters) => void;
}

export function useEvents(initialFilters?: EventFilters): UseEventsResult {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<EventsResponse['pagination'] | null>(null);
  const [filters, setFilters] = useState<EventFilters>(initialFilters || {});

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await getEvents(filters);
      setEvents(response.data);
      setPagination(response.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch events');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  return {
    events,
    loading,
    error,
    pagination,
    refetch: fetchEvents,
    setFilters,
  };
}
