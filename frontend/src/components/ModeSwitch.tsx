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
 */

/**
 * Which trophy treatment the Rankings mark uses. `compact` keeps the swirl's
 * open centre - the most recognisable part of the rift motif - which `classic`
 * crosses with the trophy's left handle. Swapping variants is this line.
 */
const RANKING_MARK = '/logo-ranking-compact.png';

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
        title="Event View"
      >
        <img src="/logo.png" alt="" aria-hidden="true" />
        <span className="sr-only">Event View</span>
      </NavLink>
      <NavLink
        to={{ pathname: '/rankings', search: rankingSearch }}
        className="mode-switch-option"
        title="Rankings"
      >
        <img src={RANKING_MARK} alt="" aria-hidden="true" />
        <span className="sr-only">Rankings</span>
      </NavLink>
    </nav>
  );
}

export default ModeSwitch;
