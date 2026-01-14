import type { Event } from '../types/event';

interface EventTooltipProps {
  event: Event;
  position: { x: number; y: number };
  isMobile?: boolean;
  onClose?: () => void;
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

// Convert UTC date to local time with timezone abbreviation (e.g., "7:00 PM (PST)")
function formatTime(date: Date): string {
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const tzAbbr = date.toLocaleTimeString(undefined, { timeZoneName: 'short' })
    .split(' ')
    .pop() || '';
  return `${timeStr} (${tzAbbr})`;
}

function formatLocation(event: Event): string | null {
  // Format: "Shop Name (City, State)" e.g., "Merlion Games (San Carlos, CA)"
  const locationParts: string[] = [];

  if (event.city) {
    locationParts.push(event.city);
  }

  if (event.state) {
    locationParts.push(event.state);
  } else if (event.country) {
    locationParts.push(event.country);
  }

  const locationStr = locationParts.join(', ');

  if (event.organizer && locationStr) {
    return `${event.organizer} (${locationStr})`;
  } else if (event.organizer) {
    return event.organizer;
  } else if (locationStr) {
    return locationStr;
  } else if (event.location) {
    return event.location;
  }

  return null;
}

function EventTooltip({ event, position, isMobile, onClose }: EventTooltipProps) {
  const location = formatLocation(event);
  const time = formatTime(new Date(event.startDate));
  const visitUrl = `/api/events/${event.id}/visit`;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && onClose) {
      e.stopPropagation(); // Prevent click from reaching day events modal backdrop underneath
      onClose();
    }
  };

  const tooltipContent = (
    <div
      className={`event-tooltip ${isMobile ? 'event-tooltip-mobile' : ''}`}
      style={isMobile ? undefined : {
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%) translateY(-10px)',
      }}
    >
      {isMobile && (
        <a
          href={visitUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="event-tooltip-visit"
        >
          Visit &rsaquo;
        </a>
      )}
      <h3>{event.name}</h3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <p>
          {formatDate(event.startDate)} at {time}
        </p>

        {location && (
          <p>{location}</p>
        )}

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
          {event.eventType && (
            <span className="format-tag" style={{
              backgroundColor: event.eventType === 'Summoner Skirmish' ? '#ff79c6' :
                              event.eventType === 'Nexus Night' ? '#bd93f9' : '#6272a4'
            }}>{event.eventType}</span>
          )}

          {(event.playerCount !== null || event.capacity !== null) && (() => {
            const players = event.playerCount ?? 0;
            const capacity = event.capacity ?? 0;
            const isFull = capacity > 0 && players >= capacity;
            return (
              <span style={{
                color: isFull ? 'var(--color-red)' : 'var(--color-green)',
                fontSize: '0.75rem',
                fontWeight: 500,
              }}>
                {players}/{event.capacity ?? '?'} Players
              </span>
            );
          })()}

          {event.price && (
            <span style={{
              color: 'var(--color-orange)',
              fontSize: '0.75rem',
              fontWeight: 500,
            }}>
              {event.price}
            </span>
          )}
        </div>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <div className="event-tooltip-backdrop" onClick={handleBackdropClick}>
        {tooltipContent}
      </div>
    );
  }

  return tooltipContent;
}

export default EventTooltip;
