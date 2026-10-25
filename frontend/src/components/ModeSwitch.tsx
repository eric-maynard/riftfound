import { NavLink } from 'react-router-dom';

/**
 * The site mark, doubling as the switch between the two sections.
 *
 * Two marks share one track - the looking glass for Events, the trophy for
 * Ranking - with a thumb sliding under whichever is active and the other
 * desaturated. They are real links, not ARIA tabs, because each is a route
 * someone can bookmark and share; `aria-current` carries the selected state.
 *
 * Each side remembers the query string its section was last on, so switching
 * away and back does not throw away a shared calendar filter URL or the set and
 * scene a reader picked on the ranking page.
 */

/**
 * Which trophy treatment the ranking mark uses. `compact` keeps the swirl's
 * open centre - the most recognisable part of the rift motif - which `classic`
 * crosses with the trophy's left handle. Swapping variants is this line.
 */
const RANKING_MARK = '/logo-ranking-compact.png';

interface ModeSwitchProps {
  eventsSearch: string;
  rankingSearch: string;
  /** 'events' | 'ranking' - drives the thumb position and which mark is lit. */
  active: 'events' | 'ranking';
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
        <span className="sr-only">Events</span>
      </NavLink>
      <NavLink
        to={{ pathname: '/ranking', search: rankingSearch }}
        className="mode-switch-option"
        title="Ranking"
      >
        <img src={RANKING_MARK} alt="" aria-hidden="true" />
        <span className="sr-only">Ranking</span>
      </NavLink>
    </nav>
  );
}

export default ModeSwitch;
