import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseEventsFromHtml } from '../parser.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8');
}

describe('parseEventsFromHtml', () => {
  describe('single event card', () => {
    it('extracts all fields from a complete event card', () => {
      const html = loadFixture('event-card.html');
      const events = parseEventsFromHtml(html);

      expect(events).toHaveLength(1);
      const event = events[0];

      expect(event.externalId).toBe('269198');
      expect(event.name).toBe('Tuesday Evening Nexus Nights - 1v1');
      expect(event.startTime).toBe('7:30 AM (UTC)');
      expect(event.price).toBe('A$13.00');
      expect(event.location).toBe('NSW, AU');
      expect(event.organizer).toBe('The Hobby Cave');
      expect(event.playerCount).toBe(7);
      expect(event.eventType).toBe('Constructed');
      expect(event.imageUrl).toContain('riftbound_logo.png');
      expect(event.url).toBe('https://locator.riftbound.uvsgames.com/events/269198');
    });

    it('extracts city and country from location', () => {
      const html = loadFixture('event-card.html');
      const events = parseEventsFromHtml(html);
      const event = events[0];

      expect(event.city).toBe('NSW');
      expect(event.country).toBe('AU');
    });

    it('parses date correctly', () => {
      const html = loadFixture('event-card.html');
      const events = parseEventsFromHtml(html);
      const event = events[0];

      // Dec 9, 2025 7:30 AM UTC
      expect(event.startDate.getUTCFullYear()).toBe(2025);
      expect(event.startDate.getUTCMonth()).toBe(11); // December is 11
      expect(event.startDate.getUTCDate()).toBe(9);
    });
  });

  describe('multiple events', () => {
    it('extracts all unique events', () => {
      const html = loadFixture('multiple-events.html');
      const events = parseEventsFromHtml(html);

      // Should have 3 unique events (duplicate card should be filtered)
      expect(events).toHaveLength(3);
    });

    it('handles Free Event price', () => {
      const html = loadFixture('multiple-events.html');
      const events = parseEventsFromHtml(html);

      const freeEvent = events.find(e => e.externalId === '100001');
      expect(freeEvent?.price).toBe('Free Event');
    });

    it('handles USD price format', () => {
      const html = loadFixture('multiple-events.html');
      const events = parseEventsFromHtml(html);

      const usEvent = events.find(e => e.externalId === '200002');
      expect(usEvent?.price).toBe('$25.00');
    });

    it('handles GBP price format', () => {
      const html = loadFixture('multiple-events.html');
      const events = parseEventsFromHtml(html);

      const ukEvent = events.find(e => e.externalId === '300003');
      expect(ukEvent?.price).toBe('£10.00');
    });

    it('extracts different event formats', () => {
      const html = loadFixture('multiple-events.html');
      const events = parseEventsFromHtml(html);

      const formats = events.map(e => e.eventType);
      expect(formats).toContain('Sealed');
      expect(formats).toContain('Draft');
      expect(formats).toContain('Multiplayer');
    });

    it('handles missing store name gracefully', () => {
      const html = loadFixture('multiple-events.html');
      const events = parseEventsFromHtml(html);

      const ukEvent = events.find(e => e.externalId === '300003');
      // No lucide-store icon in this card
      expect(ukEvent?.organizer).toBeNull();
    });

    it('extracts NZ country code', () => {
      const html = loadFixture('multiple-events.html');
      const events = parseEventsFromHtml(html);

      const nzEvent = events.find(e => e.externalId === '100001');
      expect(nzEvent?.country).toBe('NZ');
      expect(nzEvent?.city).toBe('Auckland');
    });

    it('extracts US country code', () => {
      const html = loadFixture('multiple-events.html');
      const events = parseEventsFromHtml(html);

      const usEvent = events.find(e => e.externalId === '200002');
      expect(usEvent?.country).toBe('US');
      expect(usEvent?.city).toBe('California');
    });

    it('extracts UK country code', () => {
      const html = loadFixture('multiple-events.html');
      const events = parseEventsFromHtml(html);

      const ukEvent = events.find(e => e.externalId === '300003');
      expect(ukEvent?.country).toBe('UK');
      expect(ukEvent?.city).toBe('London');
    });
  });

  describe('edge cases', () => {
    it('returns empty array for HTML with no events', () => {
      const html = '<html><body>No events here</body></html>';
      const events = parseEventsFromHtml(html);
      expect(events).toHaveLength(0);
    });

    it('skips cards without valid event ID', () => {
      const html = `
        <div data-testid="eventCard-text-title">This is not an event card</div>
        <div data-testid="eventCard-abc">Invalid ID</div>
      `;
      const events = parseEventsFromHtml(html);
      expect(events).toHaveLength(0);
    });

    it('skips cards without a title', () => {
      const html = `
        <div data-testid="eventCard-123456">
          <span data-testid="eventCard-text-date">Dec 9, 2025</span>
        </div>
      `;
      const events = parseEventsFromHtml(html);
      expect(events).toHaveLength(0);
    });
  });
});
