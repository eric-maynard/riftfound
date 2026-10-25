import { NavLink } from 'react-router-dom';

/**
 * The two top-level sections. These are real links, not ARIA tabs, because
 * each one is a route a reader can bookmark and share - `aria-current` carries
 * the selected state.
 *
 * Each tab remembers the query string its section was last on, so switching
 * away and back does not throw away a shared calendar filter URL or the set and
 * scene a reader picked on the ranking page.
 */
interface SectionTabsProps {
  eventsSearch: string;
  rankingSearch: string;
}

function SectionTabs({ eventsSearch, rankingSearch }: SectionTabsProps) {
  const sections = [
    { to: { pathname: '/', search: eventsSearch }, label: 'Events', end: true },
    { to: { pathname: '/ranking', search: rankingSearch }, label: 'Ranking', end: false },
  ];

  return (
    <nav className="section-tabs" aria-label="Sections">
      {sections.map((section) => (
        <NavLink
          key={section.label}
          to={section.to}
          end={section.end}
          className={({ isActive }) => `section-tab${isActive ? ' active' : ''}`}
        >
          {section.label}
        </NavLink>
      ))}
    </nav>
  );
}

export default SectionTabs;
