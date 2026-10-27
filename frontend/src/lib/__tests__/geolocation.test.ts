import { describe, expect, it } from 'vitest';
import {
  GEO_LABELS,
  GEO_MESSAGES,
  type LocationControlInput,
  geoErrorOutcome,
  locationControl,
  sameSpot,
  shouldAutoLocate,
} from '../geolocation';

describe('geoErrorOutcome', () => {
  it('maps the three codes the spec defines', () => {
    expect(geoErrorOutcome(1)).toBe('denied'); // PERMISSION_DENIED
    expect(geoErrorOutcome(2)).toBe('unavailable'); // POSITION_UNAVAILABLE
    expect(geoErrorOutcome(3)).toBe('timeout'); // TIMEOUT
  });

  it('treats anything unrecognised as unavailable rather than guessing', () => {
    // "Blocked" and "too slow" would both be claims about a code we have never
    // seen; "could not work out where it is" is true of any of them.
    expect(geoErrorOutcome(0)).toBe('unavailable');
    expect(geoErrorOutcome(99)).toBe('unavailable');
  });
});

describe('shouldAutoLocate', () => {
  const base = {
    support: 'available' as const,
    sharedLocation: false,
    permission: 'prompt' as const,
    autoAsked: false,
  };

  it('asks on a first visit, because current location is the default', () => {
    expect(shouldAutoLocate(base)).toBe(true);
    expect(shouldAutoLocate({ ...base, permission: 'unknown' })).toBe(true);
  });

  it('never asks over a shared link', () => {
    // The calendar's filters are shareable, and ?lat=&lng= is a statement
    // about where to look that outranks where the reader happens to be.
    expect(shouldAutoLocate({ ...base, sharedLocation: true })).toBe(false);
    expect(shouldAutoLocate({ ...base, sharedLocation: true, permission: 'granted' })).toBe(false);
  });

  it('never asks when the permission is already denied', () => {
    // The call would fail instantly without prompting anyone, so there is
    // nothing to be had from making it.
    expect(shouldAutoLocate({ ...base, permission: 'denied' })).toBe(false);
    expect(shouldAutoLocate({ ...base, permission: 'denied', autoAsked: true })).toBe(false);
  });

  it('prompts automatically once per browser and not again', () => {
    expect(shouldAutoLocate({ ...base, autoAsked: true })).toBe(false);
    expect(shouldAutoLocate({ ...base, permission: 'unknown', autoAsked: true })).toBe(false);
  });

  it('still locates every visit once permission is granted', () => {
    // Reading a granted permission shows no prompt, so there is no prompt to
    // spam - and this is what makes current location a default rather than a
    // one-time seed.
    expect(shouldAutoLocate({ ...base, permission: 'granted', autoAsked: true })).toBe(true);
  });

  it('does nothing where the browser cannot', () => {
    expect(shouldAutoLocate({ ...base, support: 'no-api' })).toBe(false);
    expect(shouldAutoLocate({ ...base, support: 'insecure', permission: 'granted' })).toBe(false);
  });
});

describe('sameSpot', () => {
  const spot = { lat: 37.7749, lng: -122.4194 };

  it('is false when either side is missing', () => {
    expect(sameSpot(null, spot)).toBe(false);
    expect(sameSpot(spot, undefined)).toBe(false);
    expect(sameSpot(null, null)).toBe(false);
  });

  it('matches a place that has been through the share URL', () => {
    // buildShareableURL writes four decimal places, so a fix and the link made
    // from it must still count as the same place - otherwise a reader who
    // shares "near me" and reopens their own link is told they have wandered.
    expect(sameSpot({ lat: 37.774929, lng: -122.419418 }, spot)).toBe(true);
  });

  it('separates places a radius filter would treat differently', () => {
    // ~2.5km north: a different answer for a 5mi search.
    expect(sameSpot({ lat: 37.7974, lng: -122.4194 }, spot)).toBe(false);
    expect(sameSpot({ lat: 37.7749, lng: -122.4294 }, spot)).toBe(false);
  });

  it('does not split hairs below the share precision', () => {
    // 1e-5 degrees is about a metre. Nothing on this site means anything
    // different at that distance.
    expect(sameSpot({ lat: 37.77491, lng: -122.41941 }, spot)).toBe(true);
  });

  it('treats the equator and the prime meridian as themselves', () => {
    // (-0).toFixed() and (0).toFixed() must not disagree.
    expect(sameSpot({ lat: 0, lng: 0 }, { lat: -0, lng: -0 })).toBe(true);
  });
});

describe('locationControl', () => {
  const base: LocationControlInput = {
    support: 'available',
    permission: 'prompt',
    outcome: 'idle',
    attempt: 'none',
    atCurrentLocation: false,
  };

  it('offers the control on a first visit and says nothing', () => {
    const control = locationControl(base);
    expect(control.available).toBe(true);
    expect(control.label).toBe(GEO_LABELS.idle);
    expect(control.disabled).toBe(false);
    expect(control.status).toBe('');
  });

  it('withholds the button where geolocation cannot work, and says why', () => {
    // A control that can never do anything is furniture, and a disabled one is
    // unfocusable - so the note carries the reason instead.
    const noApi = locationControl({ ...base, support: 'no-api' });
    expect(noApi.available).toBe(false);
    expect(noApi.status).toBe(GEO_MESSAGES.noApi);

    const insecure = locationControl({ ...base, support: 'insecure' });
    expect(insecure.available).toBe(false);
    // Named by its cause: http fails with PERMISSION_DENIED, and telling that
    // reader to change a browser setting would send them after the wrong thing.
    expect(insecure.status).toBe(GEO_MESSAGES.insecure);
  });

  it('is busy and unpressable while a fix is in flight', () => {
    const control = locationControl({ ...base, outcome: 'locating', attempt: 'user' });
    expect(control.label).toBe(GEO_LABELS.locating);
    expect(control.disabled).toBe(true);
    expect(control.busy).toBe(true);
    expect(control.status).toBe(GEO_MESSAGES.locating);
  });

  describe('denied', () => {
    it('says so in the label before anyone presses it', () => {
      // Learned from the permission store on load: no attempt has been made,
      // so there is nothing to announce, but the affordance must not promise
      // something JavaScript cannot deliver.
      const control = locationControl({ ...base, permission: 'denied' });
      expect(control.available).toBe(true);
      expect(control.label).toBe(GEO_LABELS.blocked);
      expect(control.hint).toBe(GEO_MESSAGES.blockedHint);
      expect(control.status).toBe('');
    });

    it('stays pressable, because only the browser can undo it', () => {
      // A reader who has just allowed us in site settings needs something to
      // press, and a disabled button is skipped by a screen reader.
      expect(locationControl({ ...base, permission: 'denied' }).disabled).toBe(false);
      expect(locationControl({ ...base, outcome: 'denied', attempt: 'user' }).disabled).toBe(false);
    });

    it('explains how to allow it when the reader presses it', () => {
      const control = locationControl({ ...base, outcome: 'denied', attempt: 'user' });
      expect(control.status).toBe(GEO_MESSAGES.denied);
      // Instructional, not a failure: nothing broke, and the reader holds the
      // switch - so it is not printed in the error red.
      expect(control.tone).toBe('muted');
    });

    it('stays quiet when the refusal came from the attempt on load', () => {
      // Nobody asked for that attempt, so nobody is told it failed.
      expect(locationControl({ ...base, outcome: 'denied', attempt: 'auto' }).status).toBe('');
    });
  });

  it('offers a retry after a timeout or an unavailable position', () => {
    const timedOut = locationControl({ ...base, outcome: 'timeout', attempt: 'user' });
    expect(timedOut.label).toBe(GEO_LABELS.retry);
    expect(timedOut.status).toBe(GEO_MESSAGES.timeout);
    expect(timedOut.tone).toBe('error');

    const unavailable = locationControl({ ...base, outcome: 'unavailable', attempt: 'user' });
    expect(unavailable.label).toBe(GEO_LABELS.retry);
    expect(unavailable.status).toBe(GEO_MESSAGES.unavailable);

    // Same rule as denied: the load-time attempt does not report itself.
    expect(locationControl({ ...base, outcome: 'timeout', attempt: 'auto' }).status).toBe('');
  });

  describe('located', () => {
    const located: LocationControlInput = {
      ...base,
      permission: 'granted',
      outcome: 'located',
      attempt: 'user',
      atCurrentLocation: true,
      locationName: 'Oakland, CA',
    };

    it('confirms where it landed, by name', () => {
      expect(locationControl(located).status).toBe('Showing events near Oakland, CA.');
      expect(locationControl(located).label).toBe(GEO_LABELS.idle);
    });

    it('falls back to a phrase when reverse geocoding named nothing', () => {
      expect(locationControl({ ...located, locationName: 'My Location' }).status).toBe(
        'Showing events near your current location.',
      );
      expect(locationControl({ ...located, locationName: null }).status).toBe(
        'Showing events near your current location.',
      );
    });

    it('stays pressable so a reader who has moved can re-check', () => {
      const control = locationControl(located);
      expect(control.disabled).toBe(false);
      expect(control.hint).toBe(GEO_MESSAGES.refreshHint);
    });

    it('offers the way back once the reader has searched elsewhere', () => {
      // The one-click return. This is the state the feature exists for: a fix
      // we still hold, and filters pointing at another city.
      const control = locationControl({ ...located, atCurrentLocation: false });
      expect(control.label).toBe(GEO_LABELS.back);
      expect(control.disabled).toBe(false);
      // Nothing announced: the reader is where they asked to be.
      expect(control.status).toBe('');
    });

    it('describes what is on screen even if the permission was revoked after', () => {
      // Rare, but the label should describe the map rather than the store; the
      // next press is where they find out it is blocked.
      const control = locationControl({ ...located, permission: 'denied' });
      expect(control.label).toBe(GEO_LABELS.idle);
    });
  });
});
