import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useEvents } from '../hooks/useEvents';
import type { Event } from '../types/event';

function EventCard({ event }: { event: Event }) {
  const startDate = new Date(event.startDate);

  return (
    <Link to={`/events/${event.id}`} style={{ textDecoration: 'none' }}>
      <div className="card" style={{ marginBottom: '1rem', cursor: 'pointer', transition: 'transform 0.2s' }}>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <div style={{
            minWidth: '80px',
            textAlign: 'center',
            padding: '0.5rem',
            backgroundColor: 'var(--color-primary)',
            borderRadius: '0.5rem',
          }}>
            <div style={{ fontSize: '0.875rem', textTransform: 'uppercase' }}>
              {startDate.toLocaleDateString('en-US', { month: 'short' })}
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
              {startDate.getDate()}
            </div>
          </div>

          <div style={{ flex: 1 }}>
            <h3 style={{ color: 'var(--color-text)', marginBottom: '0.25rem' }}>{event.name}</h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
              {[event.location, event.city, event.state].filter(Boolean).join(', ')}
            </p>
            {event.eventType && (
              <span style={{
                display: 'inline-block',
                marginTop: '0.5rem',
                padding: '0.25rem 0.5rem',
                backgroundColor: 'var(--color-bg)',
                borderRadius: '0.25rem',
                fontSize: '0.75rem',
                color: 'var(--color-text-muted)',
              }}>
                {event.eventType}
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

function EventsPage() {
  const [search, setSearch] = useState('');
  const { events, loading, error, pagination, setFilters } = useEvents();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setFilters({ search, page: 1 });
  };

  const handlePageChange = (page: number) => {
    setFilters({ search, page });
  };

  return (
    <div>
      <h1 style={{ marginBottom: '1.5rem' }}>Riftbound Events</h1>

      <form onSubmit={handleSearch} style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            className="input"
            placeholder="Search events..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit" className="btn btn-primary">Search</button>
        </div>
      </form>

      {loading && <p>Loading events...</p>}

      {error && (
        <div style={{ padding: '1rem', backgroundColor: '#7f1d1d', borderRadius: '0.5rem', marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <p style={{ color: 'var(--color-text-muted)' }}>No events found.</p>
      )}

      <div>
        {events.map((event) => (
          <EventCard key={event.id} event={event} />
        ))}
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginTop: '2rem' }}>
          <button
            className="btn btn-primary"
            disabled={pagination.page <= 1}
            onClick={() => handlePageChange(pagination.page - 1)}
          >
            Previous
          </button>
          <span style={{ display: 'flex', alignItems: 'center', padding: '0 1rem' }}>
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button
            className="btn btn-primary"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => handlePageChange(pagination.page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

export default EventsPage;
