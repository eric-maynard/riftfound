import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { carryPreview } from './lib/preview';
import Layout from './components/Layout';
import EventDetailPage from './pages/EventDetailPage';
import RankingPage from './pages/RankingPage';
import PlayerPage from './pages/PlayerPage';

/**
 * The scene map is the one page here that is **lazy**, and it is the only one
 * that needs to be.
 *
 * It is the only route that pulls in a library nobody else uses - Leaflet plus
 * its stylesheet, ~150KB raw - and it sits behind a preview flag, so eagerly
 * importing it would put a map library in the bundle every visitor to the
 * *calendar* downloads, for a page almost none of them can reach. That is the
 * same objection the Rankings CSS note makes about a webfont ("it would load
 * on the calendar too"), and the fix is one import.
 *
 * Every other route is eager: they share the app's own code and splitting them
 * would buy a request, not a saving.
 */
const ScenesPage = lazy(() => import('./pages/ScenesPage'));

/**
 * The index route renders nothing: Layout mounts the calendar itself so that
 * switching between Event View and Rankings cannot unmount it.
 */
function CalendarSlot() {
  return null;
}

/**
 * The section used to live at the singular `/ranking`, which was handed out as
 * a live link before the rename. Those URLs keep resolving: this forwards the
 * whole tail - `/ranking/players/:id`, the query string and the hash - to the
 * plural path, so a shared scene or set selection survives the hop. The hash
 * is forwarded too, though the one anchor that used to be worth naming
 * (`#how-ranking-works`) went with the section it headed.
 */
function LegacyRankingRedirect() {
  const location = useLocation();
  const tail = location.pathname.replace(/^\/ranking/, '');
  return (
    <Navigate
      to={{ pathname: `/rankings${tail}`, search: location.search, hash: location.hash }}
      replace
    />
  );
}

/**
 * Anything unrecognised goes back to the calendar.
 *
 * It keeps the preview flag and nothing else: the rest of an unmatched URL's
 * query string is as likely to be junk as the path was, but the flag is what
 * decides whether the mode switch exists. Landing someone on a calendar with
 * the section they were reading silently switched off is the same stranding
 * every other link here guards against (lib/preview.ts).
 */
function NotFoundRedirect() {
  const { search } = useLocation();
  return <Navigate to={carryPreview('/', search)} replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<CalendarSlot />} />
        <Route path="events/:id" element={<EventDetailPage />} />
        <Route path="rankings" element={<RankingPage />} />
        {/* Under `rankings`, not beside it: the map is a way into a scene's
            ladder, it is gated on the same preview flag, and `LegacyRankingRedirect`
            below forwards `/ranking/map` with the rest of the tail.

            The fallback is the same one-line "Loading..." the page itself
            shows while it fetches, so a slow chunk and a slow request look the
            same to a reader rather than flashing two different states. */}
        <Route
          path="rankings/map"
          element={
            <Suspense fallback={<p className="muted">Loading scenes...</p>}>
              <ScenesPage />
            </Suspense>
          }
        />
        <Route path="rankings/players/:playerId" element={<PlayerPage />} />
        <Route path="ranking/*" element={<LegacyRankingRedirect />} />
        <Route path="*" element={<NotFoundRedirect />} />
      </Route>
    </Routes>
  );
}

export default App;
