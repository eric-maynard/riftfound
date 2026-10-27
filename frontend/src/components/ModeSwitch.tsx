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
 * The Rankings mark, built **out of** the Events mark rather than alongside it.
 * `scripts/build-rankings-mark.py` lifts the swirl straight off `logo.png` by
 * colour and strokes a trophy over its open centre, at the lens's size, offset
 * and palette. Three earlier versions redrew the swirl from Riot's published
 * artwork and each produced a visibly different one - denser blades, a closed
 * ring - sitting next to the original in the same control. Compositing cannot
 * drift: there is one swirl, and it is the one already on the page.
 *
 * **The filename is versioned because `deploy.sh frontend` only invalidates
 * `index.html`.** A changed asset that keeps its name is served from browser
 * and edge caches long after the deploy, which is exactly how an earlier fix
 * to this mark appeared not to have shipped for hours. Bump the suffix rather
 * than overwrite.
 */
const RANKING_MARK = '/logo-rankings-v5.png';

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
