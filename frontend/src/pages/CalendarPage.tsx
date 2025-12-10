import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
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

// Event categories inferred from event names (Summoner Skirmish first)
const AVAILABLE_FORMATS = ['Summoner Skirmish', 'Nexus Night', 'Other'];

// Priority order for event display (lower = higher priority)
const EVENT_TYPE_PRIORITY: Record<string, number> = {
  'Summoner Skirmish': 0,
  'Nexus Night': 1,
  'Other': 2,
};

// Colors per event type (Dracula palette)
const EVENT_COLORS: Record<string, string> = {
  'Nexus Night': '#bd93f9',      // Purple
  'Summoner Skirmish': '#ff79c6', // Pink
  'Other': '#6272a4',             // Muted blue-grey
};

interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  backgroundColor: string;
  borderColor: string;
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

// Convert UTC startDate to local time string (e.g., "7:00 PM")
function formatEventTime(event: Event): string {
  const date = new Date(event.startDate);
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
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

  // Staged filters (what user is editing)
  const [stagedFilters, setStagedFilters] = useState<Filters>({
    location: DEFAULT_LOCATION,
    distanceMiles: DEFAULT_DISTANCE_MILES,
    format: null,
  });

  // Applied filters (what's actually being used for the query)
  const [appliedFilters, setAppliedFilters] = useState<Filters>({
    location: DEFAULT_LOCATION,
    distanceMiles: DEFAULT_DISTANCE_MILES,
    format: null,
  });

  const [locationInitialized, setLocationInitialized] = useState(false);
  const [tooltipEvent, setTooltipEvent] = useState<Event | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const calendarRef = useRef<FullCalendar>(null);
  const [searchTrigger, setSearchTrigger] = useState(0);

  const { minDate, maxDate } = useMemo(() => getValidDateRange(), []);

  // Try to get user's location on mount, fallback to San Francisco
  useEffect(() => {
    if (locationInitialized) return;

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const newLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            displayName: 'My Location',
          };
          setStagedFilters(prev => ({
            ...prev,
            location: newLocation,
          }));
          setAppliedFilters(prev => ({
            ...prev,
            location: newLocation,
          }));
          setLocationInitialized(true);
          setSearchTrigger(t => t + 1); // Trigger search after geolocation
        },
        () => {
          // Geolocation denied or failed, keep default (San Francisco)
          setLocationInitialized(true);
          setSearchTrigger(t => t + 1); // Trigger initial search
        },
        { timeout: 5000 }
      );
    } else {
      setLocationInitialized(true);
      setSearchTrigger(t => t + 1); // Trigger initial search
    }
  }, [locationInitialized]);

  // Fetch events when search is triggered
  useEffect(() => {
    if (searchTrigger === 0) return; // Don't fetch on initial render

    async function fetchEvents() {
      setLoading(true);
      setError(null);

      try {
        const radiusKm = appliedFilters.distanceMiles * MILES_TO_KM;

        const response = await getEvents({
          calendarMode: true,
          ...(appliedFilters.location && {
            lat: appliedFilters.location.lat,
            lng: appliedFilters.location.lng,
            radiusKm,
          }),
          ...(appliedFilters.format && {
            eventType: appliedFilters.format,
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
  }, [searchTrigger, appliedFilters]);

  // Handle search button click
  const handleSearch = useCallback(() => {
    setAppliedFilters(stagedFilters);
    setSearchTrigger(t => t + 1);
  }, [stagedFilters]);

  // Convert events to FullCalendar format
  const calendarEvents: CalendarEvent[] = events.map((event) => {
    const color = EVENT_COLORS[event.eventType || 'Other'] || EVENT_COLORS['Other'];
    return {
      id: event.id,
      title: formatEventTitle(event),
      start: event.startDate,
      backgroundColor: color,
      borderColor: color,
      extendedProps: {
        event,
      },
    };
  });

  const handleEventClick = (info: EventClickArg) => {
    const eventData = info.event.extendedProps.event as Event;
    const locatorUrl = `https://locator.riftbound.uvsgames.com/events/${eventData.externalId}`;
    window.open(locatorUrl, '_blank');
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
        filters={stagedFilters}
        appliedFilters={appliedFilters}
        onFiltersChange={setStagedFilters}
        onSearch={handleSearch}
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
          dayMaxEventRows={3}
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: '',
          }}
          height="auto"
          eventDisplay="block"
          displayEventTime={false}
          eventOrder={(a, b) => {
            const aType = (a.extendedProps?.event as Event)?.eventType || 'Other';
            const bType = (b.extendedProps?.event as Event)?.eventType || 'Other';
            const aPriority = EVENT_TYPE_PRIORITY[aType] ?? 99;
            const bPriority = EVENT_TYPE_PRIORITY[bType] ?? 99;
            return aPriority - bPriority;
          }}
        />
      </div>

      {tooltipEvent && (
        <EventTooltip event={tooltipEvent} position={tooltipPosition} />
      )}
    </div>
  );
}

export default CalendarPage;
