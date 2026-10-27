import { useEffect, useRef } from 'react';
import { useHref, useLocation, useNavigate } from 'react-router-dom';
import { carryPreview } from '../lib/preview';

/**
 * The trophy on an event row: "this event has standings".
 *
 * It only ever renders where it leads somewhere. The caller decides that from
 * `hasTournament` on `/api/events/tournament-availability` - never from
 * `hasResults`, because a results capture can exist with `status: 'none'`, the
 * ~29% of finished events whose organiser never ran pairings through Riot's
 * software. A trophy on one of those is a dead end.
 *
 * **Why the hand-rolled click handling.** This renders inside a calendar event
 * chip, and FullCalendar's `eventClick` is one *delegated native* listener for
 * `.fc-event` on the view element. A React `stopPropagation` is far too late:
 * the native event has already bubbled past that ancestor by the time React
 * dispatches from its root. So the stop happens here, natively, on the anchor
 * itself - and because that also keeps the event from reaching React's root,
 * the navigation is done by hand. Modified and non-primary clicks are let
 * through untouched, so "open in new tab" still works on a real `href`.
 *
 * The glyph is the site's own Rankings mark in one colour - same silhouette,
 * rim and splayed foot - so the trophy on an event row and the trophy in the
 * mode switch read as the same object.
 */

interface EventTrophyLinkProps {
  externalId: string;
  /**
   * What the trophy is *for*, in words, e.g. "Game Corner Bo1 Nexus Night".
   * Required: an icon with no accessible name is a link to nowhere for anyone
   * not looking at it.
   */
  label: string;
  /** Marks the modal variant, which gets a full touch target of its own. */
  variant?: 'inline' | 'touch';
}

function EventTrophyLink({ externalId, label, variant = 'inline' }: EventTrophyLinkProps) {
  const navigate = useNavigate();
  const { search } = useLocation();
  /*
   * The flag rides the destination, not just the `href`.
   *
   * This affordance exists only inside the Rankings preview, and the event
   * page it opens is the reader's entry into the section. Both routes out of
   * here go through `to`: the hand-rolled `navigate` below and the real
   * `href` a modified click follows. Dropping the flag on either one would
   * open a page whose mode switch is gone (lib/preview.ts).
   */
  const to = carryPreview(`/events/${encodeURIComponent(externalId)}`, search);
  const href = useHref(to);
  const ref = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onClick = (event: MouseEvent) => {
      // Never swallow a click someone meant for their browser.
      const modified =
        event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      // Stop either way: the surrounding chip must not also fire.
      event.stopPropagation();
      if (modified || event.defaultPrevented) return;
      event.preventDefault();
      navigate(to);
    };

    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [navigate, to]);

  const accessibleName = `Standings and roster for ${label}`;

  return (
    <a
      ref={ref}
      href={href}
      className={`event-trophy event-trophy-${variant}`}
      aria-label={accessibleName}
      title={accessibleName}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        {/* Handles, stroked - the pass the outline is drawn in. */}
        <path
          d="M5.2 3.6C2.2 3.2 0.6 5.2 1.2 7.4C1.7 9.1 3.8 9.8 6.0 9.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M14.8 3.6C17.8 3.2 19.4 5.2 18.8 7.4C18.3 9.1 16.2 9.8 14.0 9.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* Rim, bowl, stem, pedestal, foot. */}
        <rect x="4" y="0.6" width="12" height="2.2" rx="1.1" fill="currentColor" />
        <path
          d="M4.8 2.8C4.8 6.2 5.8 9.4 7.0 11.2C7.6 12.0 8.0 12.4 8.4 12.6L11.6 12.6C12.0 12.4 12.4 12.0 13.0 11.2C14.2 9.4 15.2 6.2 15.2 2.8Z"
          fill="currentColor"
        />
        <path d="M8.6 12.6L11.4 12.6L10.9 15.2L9.1 15.2Z" fill="currentColor" />
        <path d="M8.0 15.2L12.0 15.2L13.0 17.4L7.0 17.4Z" fill="currentColor" />
        <rect x="5.8" y="17.2" width="8.4" height="2.4" rx="0.8" fill="currentColor" />
      </svg>
    </a>
  );
}

export default EventTrophyLink;
