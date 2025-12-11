import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventClickArg, EventHoveringArg, DatesSetArg } from '@fullcalendar/core';
import type { DateClickArg } from '@fullcalendar/interaction';
import { getEvents } from '../services/api';
import type { Event } from '../types/event';
import EventFilters, { type EventFilters as Filters } from '../components/EventFilters';
import EventTooltip from '../components/EventTooltip';
import DayEventsModal from '../components/DayEventsModal';

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

// Create display title: "Time | Shop Name" (desktop) or just "Time" (mobile)
function formatEventTitle(event: Event, isMobile: boolean): string {
  const time = formatEventTime(event);
  if (isMobile) {
    return time;
  }
  const shop = event.organizer || event.city || 'Event';
  return `${time} | ${shop}`;
}

// Mobile breakpoint (matches CSS)
const MOBILE_BREAKPOINT = 600;

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= MOBILE_BREAKPOINT);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return isMobile;
}

function CalendarPage() {
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
  const [dayEventsModal, setDayEventsModal] = useState<{ date: Date; events: Event[] } | null>(null);
  const calendarRef = useRef<FullCalendar>(null);
  const [searchTrigger, setSearchTrigger] = useState(0);
  const isMobile = useIsMobile();

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
      title: formatEventTitle(event, isMobile),
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

    if (isMobile) {
      // On mobile, show the tooltip card instead of opening link
      setTooltipEvent(eventData);
      setTooltipPosition({ x: 0, y: 0 }); // Position not used in mobile mode
    } else {
      // On desktop, open the locator link directly
      const locatorUrl = `https://locator.riftbound.uvsgames.com/events/${eventData.externalId}`;
      window.open(locatorUrl, '_blank');
    }
  };

  const handleTooltipClose = useCallback(() => {
    setTooltipEvent(null);
  }, []);

  // Get events for a specific date
  const getEventsForDate = useCallback((date: Date): Event[] => {
    const dateStr = date.toISOString().split('T')[0];
    return events.filter((event) => {
      const eventDate = new Date(event.startDate).toISOString().split('T')[0];
      return eventDate === dateStr;
    });
  }, [events]);

  // Handle date click (on mobile, show day events modal)
  const handleDateClick = useCallback((info: DateClickArg) => {
    if (!isMobile) return;
    const dayEvents = getEventsForDate(info.date);
    if (dayEvents.length > 0) {
      setDayEventsModal({ date: info.date, events: dayEvents });
    }
  }, [isMobile, getEventsForDate]);

  // Handle nav link day click (clicking the date number)
  const handleNavLinkDayClick = useCallback((date: Date) => {
    if (!isMobile) return;
    const dayEvents = getEventsForDate(date);
    if (dayEvents.length > 0) {
      setDayEventsModal({ date, events: dayEvents });
    }
  }, [isMobile, getEventsForDate]);


  const handleDayEventsClose = useCallback(() => {
    setDayEventsModal(null);
  }, []);

  const handleDayEventClick = useCallback((event: Event) => {
    // Keep day events modal open, just show tooltip on top
    setTooltipEvent(event);
  }, []);

  // When closing tooltip, if day events modal is open, just close tooltip (go back to modal)
  // Otherwise close everything
  const handleTooltipCloseWithModal = useCallback(() => {
    setTooltipEvent(null);
    // dayEventsModal stays open if it was open
  }, []);

  const handleEventMouseEnter = (info: EventHoveringArg) => {
    // Disable hover tooltip on mobile (tap-to-view handles it)
    if (isMobile) return;
    const eventData = info.event.extendedProps.event as Event;
    setTooltipEvent(eventData);
    setTooltipPosition({ x: info.jsEvent.clientX, y: info.jsEvent.clientY });
  };

  const handleEventMouseLeave = () => {
    // Disable hover tooltip on mobile (tap-to-view handles it)
    if (isMobile) return;
    setTooltipEvent(null);
  };

  // Note: validRange already restricts navigation, so we don't need manual date checking
  // The handleDatesSet callback was causing navigation issues at boundaries
  const handleDatesSet = useCallback((_dateInfo: DatesSetArg) => {
    // FullCalendar's validRange handles boundary enforcement automatically
    // We keep this callback for future use (e.g., analytics) but don't manipulate dates
  }, []);

  return (
    <div className="calendar-page">
      <img src="/logo.png" alt="Riftfound" className="site-logo" />
      <div className="page-header">
        <EventFilters
          filters={stagedFilters}
          appliedFilters={appliedFilters}
          onFiltersChange={setStagedFilters}
          onSearch={handleSearch}
          availableFormats={AVAILABLE_FORMATS}
        />
      </div>

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
          plugins={[dayGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          events={calendarEvents}
          eventClick={handleEventClick}
          eventMouseEnter={handleEventMouseEnter}
          eventMouseLeave={handleEventMouseLeave}
          dateClick={handleDateClick}
          datesSet={handleDatesSet}
          validRange={{
            start: minDate,
            end: maxDate,
          }}
          fixedWeekCount={false}
          dayMaxEventRows={3}
          moreLinkContent={(arg) => isMobile ? `+${arg.num}` : `+${arg.num} more`}
          navLinks={isMobile}
          navLinkDayClick={handleNavLinkDayClick}
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: '',
          }}
          height="auto"
          eventDisplay="block"
          displayEventTime={false}
          eventOrder={(a: unknown, b: unknown) => {
            const aEvent = (a as { extendedProps?: { event?: Event } })?.extendedProps?.event;
            const bEvent = (b as { extendedProps?: { event?: Event } })?.extendedProps?.event;
            // Sort by start time
            const aTime = aEvent?.startDate ? new Date(aEvent.startDate).getTime() : 0;
            const bTime = bEvent?.startDate ? new Date(bEvent.startDate).getTime() : 0;
            return aTime - bTime;
          }}
        />
      </div>

      {dayEventsModal && (
        <DayEventsModal
          date={dayEventsModal.date}
          events={dayEventsModal.events}
          onClose={handleDayEventsClose}
          onEventClick={handleDayEventClick}
        />
      )}

      {tooltipEvent && (
        <EventTooltip
          event={tooltipEvent}
          position={tooltipPosition}
          isMobile={isMobile}
          onClose={dayEventsModal ? handleTooltipCloseWithModal : handleTooltipClose}
        />
      )}
    </div>
  );
}

export default CalendarPage;
