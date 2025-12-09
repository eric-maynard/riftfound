import { Outlet, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getScrapeInfo } from '../services/api';

function formatTimeAgo(dateString: string | null): string {
  if (!dateString) return 'Never';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

function Layout() {
  const [lastScrapeAt, setLastScrapeAt] = useState<string | null>(null);
  const [totalEvents, setTotalEvents] = useState<number>(0);

  useEffect(() => {
    getScrapeInfo()
      .then(response => {
        setLastScrapeAt(response.data.lastScrapeAt);
        setTotalEvents(response.data.totalEvents);
      })
      .catch(console.error);
  }, []);

  return (
    <div className="layout">
      <header style={{
        backgroundColor: 'var(--color-bg-secondary)',
        borderBottom: '1px solid var(--color-border)',
        padding: '1rem 0',
      }}>
        <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Link to="/" style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--color-text)' }}>
            Riftfound
          </Link>
          <nav style={{ display: 'flex', gap: '1rem' }}>
            <Link to="/">Events</Link>
            <Link to="/calendar">Calendar</Link>
          </nav>
        </div>
      </header>

      <main style={{ padding: '2rem 0' }}>
        <div className="container">
          <Outlet />
        </div>
      </main>

      <footer style={{
        backgroundColor: 'var(--color-bg-secondary)',
        borderTop: '1px solid var(--color-border)',
        padding: '1rem 0',
        marginTop: 'auto',
      }}>
        <div className="container" style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>
          <p>
            Data sourced from{' '}
            <a
              href="https://locator.riftbound.uvsgames.com/events"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--color-text-muted)', textDecoration: 'underline' }}
            >
              Riftbound Event Locator
            </a>
            . Last updated {formatTimeAgo(lastScrapeAt)}.
            {totalEvents > 0 && ` ${totalEvents.toLocaleString()} events tracked.`}
          </p>
        </div>
      </footer>
    </div>
  );
}

export default Layout;
