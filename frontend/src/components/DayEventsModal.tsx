import type { Event } from '../types/event';

interface DayEventsModalProps {
  date: Date;
  events: Event[];
  onClose: () => void;
  onEventClick: (event: Event) => void;
  isCloseDisabled?: () => boolean; // Called at click time to check if close should be prevented
}

// Colors per event type (Dracula palette)
const EVENT_COLORS: Record<string, string> = {
  'Nexus Night': '#bd93f9',
  'Summoner Skirmish': '#ff79c6',
  'Other': '#6272a4',
};

function formatTime(event: Event): string {
  const date = new Date(event.startDate);
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function DayEventsModal({ date, events, onClose, onEventClick, isCloseDisabled }: DayEventsModalProps) {
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
    <div className="day-events-backdrop" onClick={handleBackdropClick}>
      <div className="day-events-modal">
        <div className="day-events-header">{dateStr}</div>
        <div className="day-events-list">
          {events.map((event) => {
            const color = EVENT_COLORS[event.eventType || 'Other'] || EVENT_COLORS['Other'];
            const shop = event.organizer || event.city || 'Event';
            return (
              <button
                key={event.id}
                className="day-event-item"
                onClick={() => onEventClick(event)}
                style={{ backgroundColor: color }}
              >
                {formatTime(event)} | {shop}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default DayEventsModal;
