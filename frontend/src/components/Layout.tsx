import { useRef } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import CalendarPage from '../pages/CalendarPage';
import ModeSwitch from './ModeSwitch';

/**
 * The calendar is mounted *here*, not by its route, so switching to the
 * Ranking tab hides it rather than unmounting it: its fetched events,
 * in-memory cache, staged filters and geolocation state all survive the round
 * trip. An event detail page is still a page of its own, as it was before.
 */
/**
 * Ranking is deployed but unlisted: the routes are live and shareable, the mode
 * switch is not rendered, so the section is reachable only by URL
 * (`/ranking`). Flip this to true to surface it to everyone - that is the whole
 * launch switch. Until then `?preview=ranking` shows the switch to whoever
 * follows that link, without a rebuild (see readTabsOverride).
 */
const SHOW_SECTION_TABS = false;

const TABS_STORAGE_KEY = 'riftfoundRankingTabs';

/**
 * Whether to show the mode switch while the Ranking section is still unlisted.
 *
 * `?preview=ranking` turns it on and is remembered, so a single link is enough
 * to hand someone the preview - they do not have to type anything into a
 * console, and it survives navigating between the sections. `?preview=off`
 * clears it again.
 */
function readTabsOverride(search: string): boolean {
  let stored: string | null = null;
  // Browser storage is unavailable in private windows and can throw outright.
  try {
    stored = localStorage.getItem(TABS_STORAGE_KEY);
  } catch {
    stored = null;
  }

  const requested = new URLSearchParams(search).get('preview');
  if (requested === 'ranking' || requested === 'off') {
    const on = requested === 'ranking';
    try {
      if (on) localStorage.setItem(TABS_STORAGE_KEY, 'on');
      else localStorage.removeItem(TABS_STORAGE_KEY);
    } catch {
      // Storage blocked: honour the parameter for this page view anyway.
    }
    return on;
  }

  return stored === 'on';
}

function Layout() {
  const location = useLocation();
  const pathname = location.pathname;
  const isEventDetail = pathname.startsWith('/events/');
  const isCalendar = pathname === '/';
  const isRanking = pathname.startsWith('/ranking');

  // Remember each section's query string so a tab switch keeps a shared
  // calendar filter URL and the ranking page's set/scene selection.
  const eventsSearch = useRef('');
  const rankingSearch = useRef('');
  if (isCalendar) eventsSearch.current = location.search;
  if (isRanking) rankingSearch.current = location.search;

  const showTabs = SHOW_SECTION_TABS || readTabsOverride(location.search);

  return (
    <div className="layout">
      {/* The mark is the section switch once Ranking is public. While it is
          unlisted the plain logo stands in, so a deploy cannot reveal the
          section by accident - but it still links home, which is the only way
          back from the unlisted ranking pages. */}
      {showTabs ? (
        <ModeSwitch
          eventsSearch={eventsSearch.current}
          rankingSearch={rankingSearch.current}
          active={isRanking ? 'ranking' : 'events'}
        />
      ) : (
        <Link to="/" aria-label="Riftfound home">
          <img src="/logo.png" alt="Riftfound" className="site-logo" />
        </Link>
      )}
      <main>
        <div className="container">
          {!isEventDetail && (
            <div hidden={!isCalendar}>
              <CalendarPage active={isCalendar} />
            </div>
          )}

          {!isCalendar && <Outlet />}
        </div>
      </main>
      <footer className="site-footer">
        <div className="container">
          Powered by the <a href="https://locator.riftbound.uvsgames.com/" target="_blank" rel="noopener noreferrer">Official Locator</a>
          {' | '}
          <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener noreferrer">Apache 2.0 License</a>
          {' | '}
          <a href="https://github.com/eric-maynard/riftfound" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
      </footer>
    </div>
  );
}

export default Layout;
