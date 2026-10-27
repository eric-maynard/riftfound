import { NavLink } from 'react-router-dom';

/**
 * The site mark, doubling as the switch between the two sections.
 *
 * Two marks share one track - the looking glass for Event View, the trophy
 * for Rankings - with a thumb sliding under whichever is active and the other
 * desaturated. They are real links, not ARIA tabs, because each is a route
 * someone can bookmark and share; `aria-current` carries the selected state.
 *
 * Each side remembers the query string its section was last on, so switching
 * away and back does not throw away a shared calendar filter URL or the set and
 * scene a reader picked in Rankings.
 *
 * **The names are visible on phones.** Two 36px marks with the inactive one
 * desaturated is a legible toggle on a pointer device, where the sliding thumb
 * animates and hover lifts the other side. On touch there is no hover, the
 * thumb reads as decoration at that size, and the whole control sits centred
 * at the top of the page looking like a logo - so a first-time phone reader
 * could not tell it was a control at all, let alone which half was live. The
 * targets were never the problem (both measure 44x44 and nothing overlaps
 * them); the affordance was. Under 600px the switch is already out of the
 * fixed corner and in the page flow, where it is not competing with the
 * calendar for width, so the names can simply be shown - and the lavender
 * wash moves from the sliding pseudo-element onto the active option itself,
 * because once the two sides have different widths a fixed `translateX` is
 * pointing at the wrong place. CSS carries all of that; the markup is the
 * same control either way.
 */

/**
 * The Rankings mark, built to the same composition as the Events mark: Riot's
 * Riftbound swirl, inset in the canvas, with a small object over its open
 * centre pushed down and to the right. The offsets are measured off `logo.png`
 * so the two read as siblings; `public/logo-rankings-v3.svg` carries the
 * numbers and the reasoning.
 *
 * **The filename is versioned because `deploy.sh frontend` only invalidates
 * `index.html`.** A changed asset that keeps its name is served from browser
 * and edge caches long after the deploy, which is exactly how an earlier fix
 * to this mark appeared not to have shipped for hours. Bump the suffix rather
 * than overwrite.
 */
const RANKING_MARK = '/logo-rankings-v3.png';

interface ModeSwitchProps {
  eventsSearch: string;
  rankingSearch: string;
  /** 'events' | 'rankings' - drives the thumb position and which mark is lit. */
  active: 'events' | 'rankings';
}

function ModeSwitch({ eventsSearch, rankingSearch, active }: ModeSwitchProps) {
  return (
    <nav className="mode-switch" data-active={active} aria-label="Sections">
      <NavLink
        to={{ pathname: '/', search: eventsSearch }}
        end
        className="mode-switch-option"
        title="Events"
      >
        <img src="/logo.png" alt="" aria-hidden="true" />
        <span className="mode-switch-label">Events</span>
      </NavLink>
      <NavLink
        to={{ pathname: '/rankings', search: rankingSearch }}
        className="mode-switch-option"
        title="Rankings"
      >
        <img src={RANKING_MARK} alt="" aria-hidden="true" />
        <span className="mode-switch-label">Rankings</span>
      </NavLink>
    </nav>
  );
}

export default ModeSwitch;
