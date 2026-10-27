import { useRef } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import CalendarPage from '../pages/CalendarPage';
import ModeSwitch from './ModeSwitch';

/**
 * The calendar is mounted *here*, not by its route, so switching to
 * Rankings hides it rather than unmounting it: its fetched events,
 * in-memory cache, staged filters and geolocation state all survive the round
 * trip. An event detail page is still a page of its own, as it was before.
 */
/**
 * Rankings is deployed but unlisted: the routes are live and shareable, the
 * mode switch is not rendered, so the section is reachable only by URL
 * (`/rankings`). Flip this to true to surface it to everyone - that is the
 * whole launch switch. Until then `?preview=rankings` shows the switch to
 * whoever follows that link, without a rebuild (see readTabsOverride).
 */
const SHOW_SECTION_TABS = false;

/**
 * The whole of "how rankings work", as one tooltip in the footer.
 *
 * Succinct on purpose: a reader wants a ladder, not our methodology. The code
 * is linked beside it for anyone who wants the real answer.
 */
const HOW_RANKINGS_WORK =
  'Ratings come from games recorded at events. They only compare players who ' +
  'have actually played each other, so a ranking is always scoped to a scene. ' +
  'A player needs 8 recorded games before a rating is published; until then ' +
  'they read Unranked. The \u00b1 is how uncertain the number still is.';

const TABS_STORAGE_KEY = 'riftfoundRankingTabs';

/**
 * Whether to show the mode switch while Rankings is still unlisted.
 *
 * `?preview=rankings` turns it on and is remembered, so a single link is
 * enough to hand someone the preview - they do not have to type anything into
 * a console, and it survives navigating between the sections. `?preview=off`
 * clears it again. The singular `?preview=ranking` is still honoured: that
 * link was handed out before the section was renamed.
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
  if (requested === 'rankings' || requested === 'ranking' || requested === 'off') {
    const on = requested !== 'off';
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
  // Matches the legacy singular path too, so the one render before its
  // redirect lands does not flash the calendar's mark.
  const isRanking = pathname.startsWith('/ranking');

  // Remember each section's query string so a tab switch keeps a shared
  // calendar filter URL and the Rankings set/scene selection.
  const eventsSearch = useRef('');
  const rankingSearch = useRef('');
  if (isCalendar) eventsSearch.current = location.search;
  if (isRanking) rankingSearch.current = location.search;

  const showTabs = SHOW_SECTION_TABS || readTabsOverride(location.search);

  return (
    <div className="layout">
      {/* The mark is the section switch once Rankings is public. While it is
          unlisted the plain logo stands in, so a deploy cannot reveal the
          section by accident - but it still links home, which is the only way
          back from the unlisted Rankings pages. */}
      {showTabs ? (
        <ModeSwitch
          eventsSearch={eventsSearch.current}
          rankingSearch={rankingSearch.current}
          active={isRanking ? 'rankings' : 'events'}
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
          {' | '}
          {/* Not a link: the whole explanation is the tooltip. The ranking page
              used to carry this as a section at its foot, which was a page of
              prose explaining our method to someone who wanted a ladder. */}
          <abbr className="footer-note" title={HOW_RANKINGS_WORK}>How Rankings Work</abbr>
        </div>
      </footer>
    </div>
  );
}

export default Layout;
