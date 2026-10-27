import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
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
 * plural path, so a shared scene selection or a `#how-ranking-works` anchor
 * survives the hop.
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

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<CalendarSlot />} />
        <Route path="events/:id" element={<EventDetailPage />} />
        <Route path="rankings" element={<RankingPage />} />
        <Route path="rankings/players/:playerId" element={<PlayerPage />} />
        <Route path="ranking/*" element={<LegacyRankingRedirect />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default App;
