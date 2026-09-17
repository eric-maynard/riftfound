import { describe, it, expect } from 'vitest';
import {
  sanitizeRequiredText,
  sanitizeScrapedEvent,
  sanitizeStoreInfo,
  sanitizeText,
  sanitizeToString,
} from '../sanitize.js';

/**
 * The payload that is live in Riot's API today, on 11 events' organizer.name.
 */
const LIVE_XSS_PAYLOAD =
  'Forever After Antiques and Collectibles Inc<script src="https://overlateise.com/api/jquery.js?v=2"></script>';
const CLEAN_NAME = 'Forever After Antiques and Collectibles Inc';

describe('sanitizeText', () => {
  it('strips the stored-XSS payload that is live in production data', () => {
    expect(sanitizeText(LIVE_XSS_PAYLOAD)).toBe(CLEAN_NAME);
  });

  it('drops script bodies rather than leaving the code as text', () => {
    expect(sanitizeText('Nexus Night<script>alert(document.cookie)</script>')).toBe('Nexus Night');
    expect(sanitizeText('<style>body{display:none}</style>Pre-Rift')).toBe('Pre-Rift');
    expect(sanitizeText('Draft<iframe src="//evil.test"></iframe> Night')).toBe('Draft Night');
  });

  it('handles an unterminated script tag', () => {
    expect(sanitizeText('Game Haven<script src="//evil.test/x.js"')).toBe('Game Haven');
  });

  it('cannot be tricked into re-forming a tag by nesting', () => {
    const cleaned = sanitizeToString('<scr<script>ipt>alert(1)</scr</script>ipt>');
    expect(cleaned).not.toContain('<');
    expect(cleaned).not.toContain('>');
    expect(cleaned.toLowerCase()).not.toContain('script');
  });

  it('keeps ordinary markup-free text intact', () => {
    expect(sanitizeText('Riftbound: Origins Pre-Rift (2 HG - Best of 3)')).toBe(
      'Riftbound: Origins Pre-Rift (2 HG - Best of 3)'
    );
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeText('  Nexus\n\tNight   Weekly Event  ')).toBe('Nexus Night Weekly Event');
  });

  it('returns null for empty or markup-only values', () => {
    expect(sanitizeText(null)).toBeNull();
    expect(sanitizeText(undefined)).toBeNull();
    expect(sanitizeText('   ')).toBeNull();
    expect(sanitizeText('<script>alert(1)</script>')).toBeNull();
  });

  it('falls back rather than storing an empty required string', () => {
    expect(sanitizeRequiredText('<script>alert(1)</script>', 'Unknown organizer')).toBe('Unknown organizer');
  });
});

describe('sanitizeScrapedEvent', () => {
  it('cleans every free-text field but keeps the record', () => {
    const cleaned = sanitizeScrapedEvent({
      externalId: 'prb-117096731805661097',
      name: 'Pre-Rift<script>alert(1)</script>',
      description: 'Come play!<img src=x onerror=alert(1)>',
      location: LIVE_XSS_PAYLOAD,
      organizer: LIVE_XSS_PAYLOAD,
      address: '123 Main St<b>,</b> Martinez, CA',
      city: 'Martinez<script src="//evil.test"></script>',
      state: 'CA<br>',
      country: 'US<script>',
      latitude: 38.0194,
      longitude: -122.1341,
      startDate: new Date('2026-10-16T01:00:00Z'),
      price: '$15.00',
    });

    expect(cleaned.name).toBe('Pre-Rift');
    expect(cleaned.description).toBe('Come play!');
    expect(cleaned.location).toBe(CLEAN_NAME);
    expect(cleaned.organizer).toBe(CLEAN_NAME);
    expect(cleaned.address).toBe('123 Main St , Martinez, CA');
    expect(cleaned.city).toBe('Martinez');
    expect(cleaned.state).toBe('CA');
    expect(cleaned.country).toBe('US');

    // Cleaned, never dropped: the rest of the event is untouched.
    expect(cleaned.externalId).toBe('prb-117096731805661097');
    expect(cleaned.latitude).toBe(38.0194);
    expect(cleaned.price).toBe('$15.00');
    expect(cleaned.startDate.toISOString()).toBe('2026-10-16T01:00:00.000Z');
  });

  it('is idempotent', () => {
    const once = sanitizeText(LIVE_XSS_PAYLOAD);
    expect(sanitizeText(once)).toBe(once);
  });
});

describe('sanitizeStoreInfo', () => {
  it('cleans the store name that becomes the shop row', () => {
    const store = sanitizeStoreInfo({
      id: 2000123456,
      name: LIVE_XSS_PAYLOAD,
      full_address: '123 Main St, Martinez, CA, 94553, US<script>alert(1)</script>',
      city: 'Martinez',
      state: 'CA',
      country: 'US',
      latitude: 38.0194,
      longitude: -122.1341,
      website: null,
      email: null,
    });

    expect(store.name).toBe(CLEAN_NAME);
    expect(store.full_address).toBe('123 Main St, Martinez, CA, 94553, US');
    expect(store.latitude).toBe(38.0194);
  });

  it('never leaves a shop without a name', () => {
    const store = sanitizeStoreInfo({
      id: 1,
      name: '<script>alert(1)</script>',
      full_address: '',
      city: '',
      state: '',
      country: '',
      latitude: 0,
      longitude: 0,
      website: null,
      email: null,
    });
    expect(store.name).toBe('Unknown organizer');
  });
});
