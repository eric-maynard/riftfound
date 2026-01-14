import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Event } from '../types/event';
import { getEvent } from '../services/api';

function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    async function fetchEvent() {
      try {
        const response = await getEvent(id!);
        setEvent(response.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch event');
      } finally {
        setLoading(false);
      }
    }

    fetchEvent();
  }, [id]);

  if (loading) {
    return <p>Loading event...</p>;
  }

  if (error) {
    return (
      <div>
        <div style={{ padding: '1rem', backgroundColor: '#7f1d1d', borderRadius: '0.5rem', marginBottom: '1rem' }}>
          {error}
        </div>
        <Link to="/">&larr; Back to events</Link>
      </div>
    );
  }

  if (!event) {
    return (
      <div>
        <p>Event not found.</p>
        <Link to="/">&larr; Back to events</Link>
      </div>
    );
  }

  const startDate = new Date(event.startDate);
  const endDate = event.endDate ? new Date(event.endDate) : null;

  return (
    <div>
      <Link to="/" style={{ display: 'inline-block', marginBottom: '1rem' }}>&larr; Back to events</Link>

      <div className="card">
        <h1 style={{ marginBottom: '1rem' }}>{event.name}</h1>

        <div style={{ display: 'grid', gap: '1rem', marginBottom: '1.5rem' }}>
          <div>
            <strong style={{ color: 'var(--color-text-muted)' }}>Date</strong>
            <p>
              {startDate.toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
              {endDate && ` - ${endDate.toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}`}
            </p>
          </div>

          {event.location && (
            <div>
              <strong style={{ color: 'var(--color-text-muted)' }}>Location</strong>
              <p>{event.location}</p>
              {event.address && <p style={{ color: 'var(--color-text-muted)' }}>{event.address}</p>}
              <p style={{ color: 'var(--color-text-muted)' }}>
                {[event.city, event.state, event.country].filter(Boolean).join(', ')}
              </p>
            </div>
          )}

          {event.organizer && (
            <div>
              <strong style={{ color: 'var(--color-text-muted)' }}>Organizer</strong>
              <p>{event.organizer}</p>
            </div>
          )}

          {event.eventType && (
            <div>
              <strong style={{ color: 'var(--color-text-muted)' }}>Event Type</strong>
              <p>{event.eventType}</p>
            </div>
          )}
        </div>

        {event.description && (
          <div style={{ marginBottom: '1.5rem' }}>
            <strong style={{ color: 'var(--color-text-muted)' }}>Description</strong>
            <p style={{ whiteSpace: 'pre-wrap' }}>{event.description}</p>
          </div>
        )}

        <a
          href={`/api/events/${event.id}/visit`}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary"
        >
          View Original Event
        </a>
      </div>
    </div>
  );
}

export default EventDetailPage;
