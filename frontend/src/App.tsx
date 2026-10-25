import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import EventDetailPage from './pages/EventDetailPage';
import RankingPage from './pages/RankingPage';
import PlayerPage from './pages/PlayerPage';

/**
 * The index route renders nothing: Layout mounts the calendar itself so that
 * switching between the Events and Ranking tabs cannot unmount it.
 */
function CalendarSlot() {
  return null;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<CalendarSlot />} />
        <Route path="events/:id" element={<EventDetailPage />} />
        <Route path="ranking" element={<RankingPage />} />
        <Route path="ranking/players/:playerId" element={<PlayerPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default App;
