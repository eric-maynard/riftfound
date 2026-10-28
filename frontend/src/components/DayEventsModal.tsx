import { useEffect, useRef } from 'react';
import type { Event } from '../types/event';
import { eventColor } from '../lib/eventColors';
import EventTrophyLink from './EventTrophyLink';

/**
 * A day's events, in full, as a dialog.
 *
 * **It is no longer the phone path.** It used to be: desktop sent "+N more" to
 * FullCalendar's own popover and this opened only on a tap. The two surfaces
 * answered the same question in two different layouts with two sets of CSS,
 * and the popover existed on desktop only on the days that overflow - which is
 * the minority of days and exactly the reason the hover card's links were
 * unreachable everywhere else. So this is the one day list now, on every width
 * and from every route into it: the `+` on a day cell, the "+N more" link, and
 * a tap on a cell or its date.
 *
 * Each row is a coloured band carrying two separate targets: the event itself,
 * and - when that event has standings or a roster - a trophy to its event page.
 * They are *siblings*, not nested: a link inside a button is invalid markup and
 * announces as one confused control. The band holds the colour so the two can
 * sit side by side without either looking bolted on.
 *
 * It is also **the keyboard route to everything the hover card holds**. A
 * FullCalendar chip is a `<div>` with no event `url`, so it is not focusable
 * and never has been; the card it opens cannot be reached by keyboard at all.
 * Every row and trophy in here is a real control in the tab order, reached
 * from a real button in the grid, so the dialog behaves like one: focus moves
 * in on open, Escape dismisses, and focus goes back to whatever opened it.
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = `day-events-${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

  /*
   * Focus in, and focus back out again.
   *
   * Read at mount rather than passed down: this opens from four different
   * places - the day cell's `+`, FullCalendar's own "+N more" anchor, a tap on
   * a cell, a tap on its date number - and only two of those are elements this
   * app made. Whatever had focus is the thing to hand it back to.
   *
   * The dialog itself takes focus rather than its first row, because the
   * heading names the day the list is for and a reader dropped straight onto
   * "7:00 PM | Merlion Games" has lost it.
   */
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus();
      }
    };
  }, []);

  /*
   * Escape dismisses, deferring to `isCloseDisabled` exactly as the backdrop
   * does. That guard is what keeps the hover card on top of this list from
   * taking the list with it when it closes on a phone, and Escape has the same
   * two-layer problem the backdrop does.
   *
   * Bound on `document` in the capture phase, so it answers wherever focus has
   * got to - including inside the trophy link - and is gone the moment the
   * dialog unmounts.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isCloseDisabled?.()) return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isCloseDisabled, onClose]);

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
      <div
        className="day-events-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        <div className="day-events-header" id={headingId}>
          {dateStr}
          <button
            className="day-events-close"
            type="button"
            onClick={onClose}
            aria-label={`Close the events for ${dateStr}`}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path
                d="M5 5L15 15M15 5L5 15"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
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
