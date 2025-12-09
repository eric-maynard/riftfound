import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import EventsPage from './pages/EventsPage';
import EventDetailPage from './pages/EventDetailPage';
import CalendarPage from './pages/CalendarPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<EventsPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="events/:id" element={<EventDetailPage />} />
      </Route>
    </Routes>
  );
}

export default App;
