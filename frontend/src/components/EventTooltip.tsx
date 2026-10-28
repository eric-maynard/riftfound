import { Link } from 'react-router-dom';
import type { Event } from '../types/event';
import { eventColor } from '../lib/eventColors';
import { carryPreview } from '../lib/preview';

interface EventTooltipProps {
  event: Event;
  position: { x: number; y: number };
  isMobile?: boolean;
  onClose?: () => void;
  /**
   * Whether this event has standings or a roster worth linking to. The hover
   * card is one of the two places the link lives, the day list being the
   * other; the grid chip carries no trophy.
   *
   * It was the *only* place for a while, and unreachable there: the card
   * closed the moment the pointer left the chip, so on any day without a
   * "+N more" link to escape through, nobody could click it. The footer below
   * is the fix.
   *
   * Already gated on the Rankings preview flag by the caller - the set is
   * empty without it - so an unflagged reader never sees this.
   */
  hasTournament?: boolean;
  /** Carried through so the link keeps the preview flag alive. */
  linkSearch?: string;
  /**
   * The pointer arrived on, or left, the card's footer - the one strip of it
   * that takes pointer events at all.
   *
   * The card is `pointer-events: none` everywhere else and stays that way: it
   * is drawn over the pointer's own cell and its neighbours, so a card that
   * swallowed the mouse would turn every chip behind it into a dead spot for
   * as long as it was open, and hover-browsing is the thing this grid is for.
   * The footer is the exception because it is the only part anyone needs to
   * *click*, and it is 24px tall and flush with the card's bottom edge, a
   * pixel or two above the cursor - the shortest reachable journey there is.
   *
   * The caller runs a close timer rather than closing on the chip's
   * `mouseleave`; these two tell it when to hold off and when to let go. It
   * reads them as a *state* rather than as a cancel, because React synthesises
   * `onMouseEnter` from the `mouseout` of the element being left and so
   * delivers this one before FullCalendar's own `eventMouseLeave`; the
   * reasoning is written out where the timer lives.
   */
  onFooterEnter?: () => void;
  onFooterLeave?: () => void;
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

function EventTooltip({
  event,
  position,
  isMobile,
  onClose,
  hasTournament,
  linkSearch,
  onFooterEnter,
  onFooterLeave,
}: EventTooltipProps) {
  const location = formatLocation(event);
  const time = formatTime(new Date(event.startDate));
  const visitUrl = `/api/events/${event.id}/visit`;
  /*
   * Wrapped in `carryPreview` even though `linkSearch` is the query the reader
   * is already on and so already holds the flag. That is the deal lib/preview.ts
   * asks for - every internal link generated inside the preview goes through
   * the one carrier - and it costs nothing: with the flag present on the target
   * the target comes back character for character. What it buys is that this
   * link cannot be the surface that drops it if the caller ever narrows what it
   * passes down.
   */
  const standingsTo = carryPreview(
    `/events/${encodeURIComponent(event.externalId)}${linkSearch ? `?${linkSearch}` : ''}`,
    linkSearch ?? ''
  );

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
            <span
              className="format-tag"
              style={{ backgroundColor: eventColor(event.eventType) }}
            >{event.eventType}</span>
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

      {hasTournament && (
        // The card's footer: full width, flush with its bottom edge, and the
        // only part of the card that takes pointer events. See onFooterEnter.
        <div
          className="event-tooltip-actions"
          onMouseEnter={onFooterEnter}
          onMouseLeave={onFooterLeave}
        >
          <Link to={standingsTo} className="event-tooltip-standings">
            Standings and roster &rsaquo;
          </Link>
        </div>
      )}
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
