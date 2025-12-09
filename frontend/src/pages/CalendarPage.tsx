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
  maxDate.setDate(0); // Last day of that month

  return { minDate, maxDate };
}

// Format time from "7:30 AM (UTC)" to "7:30 AM"
function formatEventTime(event: Event): string {
  if (!event.startTime) {
    // Extract time from startDate
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
    location: null,
    distanceMiles: null,
    format: null,
  });
  const [tooltipEvent, setTooltipEvent] = useState<Event | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const calendarRef = useRef<FullCalendar>(null);

  const { minDate, maxDate } = useMemo(() => getValidDateRange(), []);

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

  // Prevent navigation outside the valid date range
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
    <div>
      <EventFilters
        filters={filters}
        onFiltersChange={setFilters}
        availableFormats={AVAILABLE_FORMATS}
      />

      {error && (
        <div style={{
          marginBottom: '1rem',
          padding: '1rem',
          backgroundColor: 'rgba(255, 85, 85, 0.1)',
          border: '1px solid var(--color-error)',
          borderRadius: '8px',
          color: 'var(--color-error)',
        }}>
          {error}
        </div>
      )}

      <div className="fc-wrapper" style={{ position: 'relative' }}>
        {loading && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(40, 42, 54, 0.8)',
            zIndex: 10,
            borderRadius: '8px',
          }}>
            <div style={{ color: 'var(--color-text)' }}>Loading events...</div>
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
