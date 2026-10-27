import { useCallback, useEffect, useRef, useState } from 'react';
import { reverseGeocode } from '../services/api';
import {
  type GeoAttempt,
  type GeoOutcome,
  type GeoPermission,
  type GeoSupport,
  MY_LOCATION_NAME,
  geoErrorOutcome,
} from '../lib/geolocation';

export interface LocatedPlace {
  lat: number;
  lng: number;
  displayName: string;
}

export interface UseCurrentLocationResult {
  support: GeoSupport;
  permission: GeoPermission;
  outcome: GeoOutcome;
  attempt: GeoAttempt;
  /** The last fix this session resolved to, or null. */
  fix: LocatedPlace | null;
  /** Read the permission store. Resolves to `unknown` where it cannot be read. */
  probe: () => Promise<GeoPermission>;
  /**
   * Ask the browser where we are. Resolves to the place, or null on any
   * failure - the failure itself lands in `outcome`, which is what the control
   * reads, so callers only have to handle the happy path.
   */
  locate: (kind: 'auto' | 'user') => Promise<LocatedPlace | null>;
}

/**
 * The page-load attempt and the button press want different patience.
 *
 * On load the reader has not asked for anything, so a slow fix must not hold
 * the calendar up: five seconds, and a cached fix up to five minutes old is
 * fine. When they press the button they have asked, and a cold GPS fix on a
 * phone genuinely takes longer than five seconds, so the timeout doubles and
 * the cache window shrinks to a minute - "my current location" should not mean
 * "where I was when I opened the tab".
 */
const AUTO_OPTIONS: PositionOptions = { timeout: 5000, maximumAge: 300_000 };
const USER_OPTIONS: PositionOptions = { timeout: 10_000, maximumAge: 60_000 };

/**
 * Can this browser report a location, and if not, why not?
 *
 * The `isSecureContext` half matters: `navigator.geolocation` exists on plain
 * http, and calling it there fails with `PERMISSION_DENIED` - the same code a
 * reader's refusal produces - so without this check the control would tell
 * someone on an http origin to go and change a browser setting that is not the
 * problem. `localhost` is a secure context by specification, so development is
 * unaffected.
 */
function detectSupport(): GeoSupport {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'no-api';
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure';
  return 'available';
}

async function readPermission(): Promise<GeoPermission> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state as GeoPermission;
  } catch {
    // Safari before 16 throws on this descriptor rather than returning a
    // state. `unknown` is the honest answer, and it is also the one that lets
    // the automatic attempt go ahead, which is the behaviour we want there.
    return 'unknown';
  }
}

/**
 * The browser half of "use my current location".
 *
 * All the wording and all the decisions live in `lib/geolocation.ts`; this
 * holds the three impure things - the permission store, `getCurrentPosition`,
 * and the reverse geocode that turns a fix into a place name - and the state
 * they produce. One copy, shared by the page-load default and the button,
 * because there used to be two near-identical copies (in `CalendarPage` and in
 * `EventFilters`) and they had already drifted apart: see the coordinate note
 * in `locate` below.
 */
export function useCurrentLocation(): UseCurrentLocationResult {
  const [support] = useState<GeoSupport>(detectSupport);
  const [permission, setPermission] = useState<GeoPermission>('unknown');
  const [outcome, setOutcome] = useState<GeoOutcome>('idle');
  const [attempt, setAttempt] = useState<GeoAttempt>('none');
  const [fix, setFix] = useState<LocatedPlace | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Watch the permission store, so the control heals itself.
   *
   * The whole point of the denied state is that only the browser's own site
   * settings can leave it - and a reader who uses them does not reload the
   * page afterwards. `PermissionStatus.onchange` fires on that, so the button
   * stops saying "blocked" the moment it stops being true.
   */
  useEffect(() => {
    if (support !== 'available') return;
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;

    let status: PermissionStatus | null = null;
    const onChange = () => {
      if (status && mounted.current) setPermission(status.state as GeoPermission);
    };

    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((result) => {
        status = result;
        if (mounted.current) setPermission(result.state as GeoPermission);
        result.addEventListener('change', onChange);
      })
      .catch(() => {
        // No permission store to watch; `unknown` stands.
      });

    return () => {
      status?.removeEventListener('change', onChange);
    };
  }, [support]);

  const probe = useCallback(async () => {
    const state = await readPermission();
    if (mounted.current) setPermission(state);
    return state;
  }, []);

  const locate = useCallback(
    (kind: 'auto' | 'user') =>
      new Promise<LocatedPlace | null>((resolve) => {
        if (detectSupport() !== 'available') {
          resolve(null);
          return;
        }

        setAttempt(kind);
        setOutcome('locating');

        navigator.geolocation.getCurrentPosition(
          async (position) => {
            const { latitude, longitude } = position.coords;

            // The device's own coordinates, with the geocoder's *name*.
            //
            // The two old copies of this disagreed, and one of them was wrong:
            // `EventFilters` filtered on the coordinates reverse geocoding
            // handed back, which are the centre of the named city, not the
            // reader. In a large metro that moves them tens of miles and
            // quietly changes which events fall inside a 5mi radius - on a
            // control labelled "my current location". So the fix decides where
            // to search and the lookup only decides what to call it.
            let displayName = MY_LOCATION_NAME;
            try {
              const response = await reverseGeocode(latitude, longitude);
              if (response.data?.displayName) displayName = response.data.displayName;
            } catch {
              // No city name available. The coordinates are what filters, so
              // this costs the reader a label, not a search.
            }

            const place: LocatedPlace = { lat: latitude, lng: longitude, displayName };
            if (mounted.current) {
              setFix(place);
              setOutcome('located');
              // A fix is proof of permission, whatever the store said - and on
              // a browser with no Permissions API it is the only proof there is.
              setPermission('granted');
            }
            resolve(place);
          },
          (error) => {
            const next = geoErrorOutcome(error.code);
            if (mounted.current) {
              setOutcome(next);
              if (next === 'denied') setPermission('denied');
            }
            resolve(null);
          },
          kind === 'user' ? USER_OPTIONS : AUTO_OPTIONS,
        );
      }),
    [],
  );

  return { support, permission, outcome, attempt, fix, probe, locate };
}
