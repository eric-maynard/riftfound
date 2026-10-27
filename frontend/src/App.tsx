import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { carryPreview } from './lib/preview';
import Layout from './components/Layout';
import EventDetailPage from './pages/EventDetailPage';
import RankingPage from './pages/RankingPage';
import PlayerPage from './pages/PlayerPage';

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
        <Route path="rankings/players/:playerId" element={<PlayerPage />} />
        <Route path="ranking/*" element={<LegacyRankingRedirect />} />
        <Route path="*" element={<NotFoundRedirect />} />
      </Route>
    </Routes>
  );
}

export default App;
