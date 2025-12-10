import type { Event } from '../types/event';

interface EventTooltipProps {
  event: Event;
  position: { x: number; y: number };
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

function EventTooltip({ event, position }: EventTooltipProps) {
  const location = formatLocation(event);
  const time = formatTime(new Date(event.startDate));

  return (
    <div className="event-tooltip" style={{
      left: position.x,
      top: position.y,
      transform: 'translate(-50%, -100%) translateY(-10px)',
    }}>
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

          {(event.playerCount !== null || event.capacity !== null) && (
            <span style={{
              color: 'var(--color-green)',
              fontSize: '0.75rem',
              fontWeight: 500,
            }}>
              {event.playerCount ?? 0}/{event.capacity ?? '?'} Players
            </span>
          )}

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
}

export default EventTooltip;
