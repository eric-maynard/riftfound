import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import CalendarPage from './pages/CalendarPage';
import EventDetailPage from './pages/EventDetailPage';
import DropshipPage from './pages/DropshipPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<CalendarPage />} />
        <Route path="events/:id" element={<EventDetailPage />} />
        <Route path="dropship" element={<DropshipPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default App;
