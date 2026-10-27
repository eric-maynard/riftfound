import type { Event } from '../types/event';
import { eventColor } from '../lib/eventColors';
import EventTrophyLink from './EventTrophyLink';

/**
 * The day list behind "+N more" on phones.
 *
 * Each row is a coloured band carrying two separate targets: the event itself,
 * and - when that event has standings or a roster - a trophy to its event page.
 * They are *siblings*, not nested: a link inside a button is invalid markup and
 * announces as one confused control. The band holds the colour so the two can
 * sit side by side without either looking bolted on.
 */

interface DayEventsModalProps {
  date: Date;
  events: Event[];
  onClose: () => void;
  onEventClick: (event: Event) => void;
  isCloseDisabled?: () => boolean; // Called at click time to check if close should be prevented
  backdropDisabled?: boolean; // When true, backdrop pointer events are disabled entirely
  /**
   * External ids of the events in this list that have standings or a roster -
   * `hasTournament` on `/api/events/tournament-availability`, never
   * `hasResults`. Absent ids simply get no trophy, so the list renders
   * immediately and the trophies arrive when the one request does.
   */
  tournamentIds?: ReadonlySet<string>;
}

function formatTime(event: Event): string {
  const date = new Date(event.startDate);
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function DayEventsModal({
  date,
  events,
  onClose,
  onEventClick,
  isCloseDisabled,
  backdropDisabled,
  tournamentIds,
}: DayEventsModalProps) {
  const dateStr = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  const handleBackdropClick = (e: React.MouseEvent) => {
    // Check at click time if close should be prevented
    if (isCloseDisabled?.()) return;
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="day-events-backdrop"
      onClick={handleBackdropClick}
      style={backdropDisabled ? { pointerEvents: 'none' } : undefined}
    >
      <div className="day-events-modal">
        <div className="day-events-header">{dateStr}</div>
        <div className="day-events-list">
          {events.map((event) => {
            const color = eventColor(event.eventType);
            const shop = event.organizer || event.city || 'Event';
            const hasTournament = tournamentIds?.has(event.externalId) ?? false;
            return (
              <div key={event.id} className="day-event-row" style={{ backgroundColor: color }}>
                <button className="day-event-item" onClick={() => onEventClick(event)}>
                  {formatTime(event)} | {shop}
                </button>
                {hasTournament && (
                  <EventTrophyLink
                    externalId={event.externalId}
                    label={event.name || shop}
                    variant="touch"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default DayEventsModal;
