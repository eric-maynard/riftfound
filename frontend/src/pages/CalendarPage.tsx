import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import type { EventClickArg, EventHoveringArg, DatesSetArg } from '@fullcalendar/core';
import { getEvents } from '../services/api';
import type { Event } from '../types/event';
import EventFilters, { type EventFilters as Filters } from '../components/EventFilters';
import EventTooltip from '../components/EventTooltip';

// Miles to km conversion
const MILES_TO_KM = 1.60934;

// Default location: San Francisco, CA
const DEFAULT_LOCATION = {
  lat: 37.7749,
  lng: -122.4194,
  displayName: 'San Francisco, CA',
};

const DEFAULT_DISTANCE_MILES = 25;

// Known formats from the scraper
const AVAILABLE_FORMATS = ['Constructed', 'Sealed', 'Draft', 'Multiplayer'];

interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  extendedProps: {
    event: Event;
  };
}

// Calculate the valid date range (3 months from today)
function getValidDateRange() {
  const now = new Date();
  const minDate = new Date(now);
  minDate.setMonth(minDate.getMonth() - 1);
  minDate.setDate(1);

  const maxDate = new Date(now);
  maxDate.setMonth(maxDate.getMonth() + 3);
  maxDate.setDate(0);

  return { minDate, maxDate };
}

// Format time from "7:30 AM (UTC)" to "7:30 AM"
function formatEventTime(event: Event): string {
  if (!event.startTime) {
    const date = new Date(event.startDate);
    return date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  return event.startTime.replace(/\s*\(UTC\)\s*/i, '').trim();
}

// Create display title: "Time | Shop Name"
function formatEventTitle(event: Event): string {
  const time = formatEventTime(event);
  const shop = event.organizer || event.city || 'Event';
  return `${time} | ${shop}`;
}

function CalendarPage() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({
    location: DEFAULT_LOCATION,
    distanceMiles: DEFAULT_DISTANCE_MILES,
    format: null,
  });
  const [locationInitialized, setLocationInitialized] = useState(false);
  const [tooltipEvent, setTooltipEvent] = useState<Event | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const calendarRef = useRef<FullCalendar>(null);

  const { minDate, maxDate } = useMemo(() => getValidDateRange(), []);

  // Try to get user's location on mount, fallback to San Francisco
  useEffect(() => {
    if (locationInitialized) return;

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setFilters(prev => ({
            ...prev,
            location: {
              lat: position.coords.latitude,
              lng: position.coords.longitude,
              displayName: 'My Location',
            },
            distanceMiles: DEFAULT_DISTANCE_MILES,
          }));
          setLocationInitialized(true);
        },
        () => {
          // Geolocation denied or failed, keep default (San Francisco)
          setLocationInitialized(true);
        },
        { timeout: 5000 }
      );
    } else {
      setLocationInitialized(true);
    }
  }, [locationInitialized]);

  useEffect(() => {
    async function fetchEvents() {
      setLoading(true);
      setError(null);

      try {
        const radiusKm = filters.distanceMiles
          ? filters.distanceMiles * MILES_TO_KM
          : undefined;

        const response = await getEvents({
          calendarMode: true,
          ...(filters.location && radiusKm && {
            lat: filters.location.lat,
            lng: filters.location.lng,
            radiusKm,
          }),
          ...(filters.format && {
            eventType: filters.format,
          }),
        });
        setEvents(response.data);
      } catch {
        setError('Failed to load events. Please try again.');
      } finally {
        setLoading(false);
      }
    }

    fetchEvents();
  }, [filters]);

  // Convert events to FullCalendar format
  const calendarEvents: CalendarEvent[] = events.map((event) => ({
    id: event.id,
    title: formatEventTitle(event),
    start: event.startDate,
    extendedProps: {
      event,
    },
  }));

  const handleEventClick = (info: EventClickArg) => {
    navigate(`/events/${info.event.id}`);
  };

  const handleEventMouseEnter = (info: EventHoveringArg) => {
    const eventData = info.event.extendedProps.event as Event;
    setTooltipEvent(eventData);
    setTooltipPosition({ x: info.jsEvent.clientX, y: info.jsEvent.clientY });
  };

  const handleEventMouseLeave = () => {
    setTooltipEvent(null);
  };

  const handleDatesSet = (dateInfo: DatesSetArg) => {
    const calendarApi = calendarRef.current?.getApi();
    if (!calendarApi) return;

    const currentStart = dateInfo.start;

    if (currentStart < minDate) {
      calendarApi.gotoDate(minDate);
    } else if (currentStart > maxDate) {
      calendarApi.gotoDate(maxDate);
    }
  };

  return (
    <div className="calendar-page">
      <EventFilters
        filters={filters}
        onFiltersChange={setFilters}
        availableFormats={AVAILABLE_FORMATS}
      />

      {error && (
        <div className="error-banner">
          {error}
        </div>
      )}

      <div className="fc-wrapper">
        {loading && (
          <div className="loading-overlay">
            <div>Loading events...</div>
          </div>
        )}

        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin]}
          initialView="dayGridMonth"
          events={calendarEvents}
          eventClick={handleEventClick}
          eventMouseEnter={handleEventMouseEnter}
          eventMouseLeave={handleEventMouseLeave}
          datesSet={handleDatesSet}
          validRange={{
            start: minDate,
            end: maxDate,
          }}
          fixedWeekCount={false}
          dayMaxEvents={4}
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: '',
          }}
          height="auto"
          eventDisplay="block"
          displayEventTime={false}
        />
      </div>

      {tooltipEvent && (
        <EventTooltip event={tooltipEvent} position={tooltipPosition} />
      )}
    </div>
  );
}

export default CalendarPage;
