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

function formatTime(timeString: string | null): string | null {
  if (!timeString) return null;
  // Clean up time string like "7:30 AM (UTC)" -> "7:30 AM"
  return timeString.replace(/\s*\(UTC\)\s*/i, '').trim();
}

function formatLocation(event: Event): string | null {
  // Prefer: City, State/Country (from organizer)
  // e.g., "Brisbane, QLD (Good Games Brisbane)"
  const parts: string[] = [];

  if (event.city) {
    parts.push(event.city);
  }

  if (event.state) {
    parts.push(event.state);
  } else if (event.country) {
    parts.push(event.country);
  }

  const locationStr = parts.join(', ');

  if (event.organizer && locationStr) {
    return `${locationStr} (${event.organizer})`;
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
  const time = formatTime(event.startTime);

  return (
    <div className="event-tooltip" style={{
      left: position.x,
      top: position.y,
      transform: 'translate(-50%, -100%) translateY(-10px)',
    }}>
      <h3>{event.name}</h3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <p>
          {formatDate(event.startDate)}
          {time && ` at ${time}`}
        </p>

        {location && (
          <p>{location}</p>
        )}

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
          {event.eventType && (
            <span className="format-tag">{event.eventType}</span>
          )}

          {event.playerCount !== null && event.playerCount !== undefined && (
            <span style={{
              color: 'var(--color-green)',
              fontSize: '0.75rem',
              fontWeight: 500,
            }}>
              {event.playerCount} Players
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
