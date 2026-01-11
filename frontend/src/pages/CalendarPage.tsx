import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventClickArg, EventHoveringArg, DatesSetArg, MoreLinkArg } from '@fullcalendar/core';
import type { DateClickArg } from '@fullcalendar/interaction';
import { getEvents, reverseGeocode } from '../services/api';
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

// Mobile/tablet detection via user agent
// Source: https://stackoverflow.com/a/11381730
// Posted by Michael Zaporozhets, modified by community. License: CC BY-SA 4.0
function isMobileOrTablet(): boolean {
  const a = navigator.userAgent || navigator.vendor || (window as unknown as { opera?: string }).opera || '';
  return /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino|android|ipad|playbook|silk/i.test(a) ||
    /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(a.substr(0, 4));
}

// Hook version - value is constant since user agent doesn't change
function useIsMobile() {
  return useState(() => isMobileOrTablet())[0];
}

// localStorage key for settings
const SETTINGS_KEY = 'riftfound_settings';

interface Settings {
  weekStartsOnMonday: boolean;
  useKilometers: boolean;
  location?: {
    lat: number;
    lng: number;
    displayName: string;
  };
  distanceMiles?: number;
}

const DEFAULT_SETTINGS: Settings = {
  weekStartsOnMonday: false,
  useKilometers: false,
};

function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors
  }
}

function CalendarPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tooManyEvents, setTooManyEvents] = useState(false);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Get initial location from saved settings or use default
  const initialLocation = settings.location ?? DEFAULT_LOCATION;
  const initialDistance = settings.distanceMiles ?? DEFAULT_DISTANCE_MILES;

  // Staged filters (what user is editing)
  const [stagedFilters, setStagedFilters] = useState<Filters>(() => ({
    location: initialLocation,
    distanceMiles: initialDistance,
    format: null,
  }));

  // Applied filters (what's actually being used for the query)
  const [appliedFilters, setAppliedFilters] = useState<Filters>(() => ({
    location: initialLocation,
    distanceMiles: initialDistance,
    format: null,
  }));

  const [locationInitialized, setLocationInitialized] = useState(false);
  const [tooltipEvent, setTooltipEvent] = useState<Event | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const [dayEventsModal, setDayEventsModal] = useState<{ date: Date; events: Event[] } | null>(null);
  // Track when tooltip just closed to prevent touch event from also closing the modal
  // Use ref so we can check it at click time, not render time
  const modalDisabledUntilRef = useRef(0);
  const calendarRef = useRef<FullCalendar>(null);
  const [searchTrigger, setSearchTrigger] = useState(0);
  const isMobile = useIsMobile();

  const { minDate, maxDate } = useMemo(() => getValidDateRange(), []);

  // Try to get user's location on mount, unless we have a saved location
  useEffect(() => {
    if (locationInitialized) return;

    // If we have a saved location, use it and skip geolocation
    if (settings.location) {
      setLocationInitialized(true);
      setSearchTrigger(t => t + 1); // Trigger search with saved location
      return;
    }

    // No saved location - try geolocation, fallback to San Francisco
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;

          // Try to reverse geocode to get city name
          let displayName = 'My Location';
          try {
            const response = await reverseGeocode(lat, lng);
            if (response.data) {
              displayName = response.data.displayName;
            }
          } catch {
            // Reverse geocoding failed, use 'My Location' as fallback
          }

          const newLocation = {
            lat,
            lng,
            displayName,
          };
          setStagedFilters(prev => ({
            ...prev,
            location: newLocation,
          }));
          setAppliedFilters(prev => ({
            ...prev,
            location: newLocation,
          }));
          // Save location to localStorage so we don't prompt again on next visit
          setSettings(prev => {
            const updated = {
              ...prev,
              location: newLocation,
              distanceMiles: initialDistance,
            };
            saveSettings(updated);
            return updated;
          });
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
  }, [locationInitialized, settings.location]);

  // Fetch events when search is triggered
  useEffect(() => {
    if (searchTrigger === 0) return; // Don't fetch on initial render

    async function fetchEvents() {
      setLoading(true);
      setError(null);
      setTooManyEvents(false);

      try {
        const radiusKm = settings.useKilometers
          ? appliedFilters.distanceMiles  // Already in km
          : appliedFilters.distanceMiles * MILES_TO_KM;

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
        // Show warning if we hit the 1000 event limit
        setTooManyEvents(response.pagination.total >= 1000);
      } catch {
        setError('Failed to load events. Please try again.');
      } finally {
        setLoading(false);
      }
    }

    fetchEvents();
  }, [searchTrigger, appliedFilters, settings.useKilometers]);

  // Close settings popover when clicking outside
  useEffect(() => {
    if (!settingsOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [settingsOpen]);

  // Toggle week start setting
  const handleToggleWeekStart = useCallback(() => {
    setSettings(prev => {
      const updated = { ...prev, weekStartsOnMonday: !prev.weekStartsOnMonday };
      saveSettings(updated);
      return updated;
    });
  }, []);

  // Toggle distance units setting
  const handleToggleUnits = useCallback(() => {
    setSettings(prev => {
      const updated = { ...prev, useKilometers: !prev.useKilometers };
      saveSettings(updated);
      return updated;
    });
  }, []);

  // Handle search button click
  // Accepts optional filters to apply directly (avoids race condition when geocoding)
  const handleSearch = useCallback((filtersOverride?: Filters) => {
    const filtersToApply = filtersOverride ?? stagedFilters;
    setAppliedFilters(filtersToApply);
    if (filtersOverride) {
      setStagedFilters(filtersOverride);
    }
    // Save location and distance to settings
    if (filtersToApply.location) {
      const locationToSave = filtersToApply.location;
      setSettings(prev => {
        const updated = {
          ...prev,
          location: locationToSave,
          distanceMiles: filtersToApply.distanceMiles,
        };
        saveSettings(updated);
        return updated;
      });
    }
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

  // Handle "+more" link click - use our custom modal instead of FullCalendar's popover
  const handleMoreLinkClick = useCallback((info: MoreLinkArg): string => {
    if (!isMobile) return 'popover'; // On desktop, use FullCalendar's default popover
    // Extract our Event objects from FullCalendar's event segments
    const dayEvents = info.allSegs.map(seg => seg.event.extendedProps.event as Event);
    if (dayEvents.length > 0) {
      setDayEventsModal({ date: info.date, events: dayEvents });
    }
    // Return 'none' to prevent FullCalendar's default popover on mobile
    return 'none';
  }, [isMobile]);

  const handleDayEventsClose = useCallback(() => {
    setDayEventsModal(null);
  }, []);

  const handleDayEventClick = useCallback((event: Event) => {
    // Keep day events modal open, just show tooltip on top
    setTooltipEvent(event);
  }, []);

  // When closing tooltip, if day events modal is open, just close tooltip (go back to modal)
  // Set a brief disabled period to prevent touch events from also closing the modal
  const handleTooltipCloseWithModal = useCallback(() => {
    setTooltipEvent(null);
    // Disable modal backdrop clicks for 300ms to prevent touch event double-firing
    modalDisabledUntilRef.current = Date.now() + 300;
  }, []);

  // Callback to check if modal close should be disabled (checked at click time, not render time)
  const isModalCloseDisabled = useCallback(() => {
    return !!tooltipEvent || Date.now() < modalDisabledUntilRef.current;
  }, [tooltipEvent]);

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
          useKilometers={settings.useKilometers}
        />
      </div>

      {error && (
        <div className="error-banner">
          {error}
        </div>
      )}

      {tooManyEvents && !error && (
        <div className="warning-banner">
          Warning: Too many events to display. Try reducing the search radius.
        </div>
      )}

      <div className="fc-wrapper">
        {loading && (
          <div className="loading-overlay">
            <div>Loading events...</div>
          </div>
        )}

        <div className="settings-container" ref={settingsRef}>
          <button
            className="settings-button"
            onClick={() => setSettingsOpen(prev => !prev)}
            aria-label="Settings"
            title="Settings"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
            </svg>
          </button>
          {settingsOpen && (
            <div className="settings-popover">
              <div className="settings-header">Settings</div>
              <label className="settings-option">
                <span>Week starts on Monday</span>
                <input
                  type="checkbox"
                  checked={settings.weekStartsOnMonday}
                  onChange={handleToggleWeekStart}
                />
                <span className="toggle-switch" />
              </label>
              <label className="settings-option">
                <span>Use kilometers</span>
                <input
                  type="checkbox"
                  checked={settings.useKilometers}
                  onChange={handleToggleUnits}
                />
                <span className="toggle-switch" />
              </label>
            </div>
          )}
        </div>

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
          firstDay={settings.weekStartsOnMonday ? 1 : 0}
          dayMaxEventRows={3}
          moreLinkContent={(arg) => isMobile ? `+${arg.num}` : `+${arg.num} more`}
          moreLinkClick={handleMoreLinkClick}
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
          isCloseDisabled={isModalCloseDisabled}
          backdropDisabled={!!tooltipEvent}
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
