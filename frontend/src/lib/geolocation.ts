/**
 * "Use my current location", as a state machine.
 *
 * The feature is two lines of browser API and about eight states, which is
 * why the states live here as pure functions rather than inside the component:
 * `useCurrentLocation` owns the `navigator` calls, `EventFilters` owns the
 * markup, and what the control should *say* in each state is decided once,
 * here, and tested without a DOM.
 *
 * The states, and what each one is:
 *
 * | state | how we know | the control |
 * |---|---|---|
 * | unsupported - no API | `navigator.geolocation` missing | no button, one note |
 * | unsupported - insecure | `window.isSecureContext` false | no button, one note |
 * | not asked yet | permission `prompt`, or no Permissions API | "Use my current location" |
 * | asked and granted | permission `granted`, or a fix arrived | as above - pressing re-locates |
 * | in flight | a call is outstanding | "Locating...", disabled, `aria-busy` |
 * | asked and denied | permission `denied`, or error code 1 | "Location blocked - how to allow" |
 * | timed out | error code 3 | "Try my current location again" |
 * | position unavailable | error code 2 | as above |
 * | located, reader moved on | a fix, but the filters point elsewhere | "Back to my current location" |
 *
 * **The denied state is the one to get right.** A permission the reader has
 * refused cannot be re-prompted from JavaScript: `getCurrentPosition` fails
 * immediately with `PERMISSION_DENIED` and no prompt is shown, so a button
 * that keeps saying "Use my current location" is a button that does nothing,
 * twice, and then a third time. Three things follow, and all three are
 * deliberate:
 *
 *  1. The **label changes** - the control says it is blocked before it is
 *     pressed, because the affordance is the honest place for that fact.
 *  2. It stays **enabled** anyway. The only route out of `denied` is the
 *     browser's own site settings, and a reader who has just used them needs
 *     something to press; a disabled button is also unfocusable, so a screen
 *     reader would skip the one element that explains the situation.
 *  3. Pressing it prints **how to allow it** rather than failing silently.
 *     The press still calls `getCurrentPosition` first - that is free, prompts
 *     nobody, and locates the reader outright if they have already unblocked
 *     us - so the instruction is the fallback, not the whole response.
 *
 * How long "blocked" survives a reload depends on the browser. Where there is
 * a Permissions API the refusal is read straight back out of it and the label
 * is right from the first paint; on a browser without one (Safari before 16)
 * `permission` comes back `unknown` and the control opens reading "Use my
 * current location" again. That is deliberate rather than a gap to paper over:
 * the alternative is persisting "they said no", and a reader who merely
 * *dismissed* the prompt - which is indistinguishable from a refusal there -
 * would then be told they are blocked when one press would prompt them again.
 * The press is cheap and self-correcting; the wrong label is not.
 *
 * Nothing here announces anything the reader did not ask for: a status line is
 * produced only for an attempt they made themselves (`attempt === 'user'`), so
 * the automatic attempt on page load cannot shout "could not find you" at
 * someone who simply opened the site.
 */

/** Whether this browser could do it at all, and if not, why not. */
export type GeoSupport = 'available' | 'no-api' | 'insecure';

/** What the browser's permission store says, as far as we can tell. */
export type GeoPermission = 'unknown' | 'prompt' | 'granted' | 'denied';

/** Where the last attempt got to. `idle` means there has not been one. */
export type GeoOutcome =
  | 'idle'
  | 'locating'
  | 'located'
  | 'denied'
  | 'timeout'
  | 'unavailable';

/** Who asked. The page-load attempt is `auto`; a button press is `user`. */
export type GeoAttempt = 'none' | 'auto' | 'user';

/** The name used when reverse geocoding cannot put a city to the coordinates. */
export const MY_LOCATION_NAME = 'My Location';

export const GEO_LABELS = {
  idle: 'Use my current location',
  back: 'Back to my current location',
  locating: 'Locating…',
  blocked: 'Location blocked - how to allow',
  retry: 'Try my current location again',
} as const;

export const GEO_MESSAGES = {
  noApi: 'This browser will not report your location. Search for a city or zip code instead.',
  // Chrome and Safari refuse geolocation outright on plain http, with no
  // prompt and no error the reader could act on, so the note names the cause
  // rather than the symptom. (`localhost` is a secure context, so this does
  // not fire in development.)
  insecure:
    'Your location needs a secure (https) connection. Search for a city or zip code instead.',
  locating: 'Finding your location…',
  blockedHint: 'Your browser is blocking location for this site.',
  denied:
    'Riftfound is blocked from using your location. Allow it in your browser’s ' +
    'settings for this site - usually the icon beside the address - then press the ' +
    'button again.',
  timeout: 'Your location is taking too long to arrive. Check your connection and try again.',
  unavailable:
    'Your device could not work out where it is. Try again, or search for a city instead.',
  refreshHint: 'Already showing your current location. Press to check it again.',
} as const;

/** Everything the control's wording depends on. */
export interface LocationControlInput {
  support: GeoSupport;
  permission: GeoPermission;
  outcome: GeoOutcome;
  attempt: GeoAttempt;
  /** Are the applied filters pointing at the fix we hold? See `sameSpot`. */
  atCurrentLocation: boolean;
  /** The resolved place name, for the "showing events near X" line. */
  locationName?: string | null;
}

export interface LocationControl {
  /**
   * Render the button at all. False only where it could never work, and the
   * `status` note then says why - a control that can never do anything is
   * furniture, and a disabled one gives a reader nothing to read.
   */
  available: boolean;
  label: string;
  /** One sentence for `title` and the button's accessible description. */
  hint: string;
  disabled: boolean;
  busy: boolean;
  /** Live-region text. Empty when there is nothing worth announcing. */
  status: string;
  tone: 'muted' | 'error';
}

const QUIET: Pick<LocationControl, 'available' | 'disabled' | 'busy' | 'tone'> = {
  available: true,
  disabled: false,
  busy: false,
  tone: 'muted',
};

/**
 * Map a `GeolocationPositionError.code` onto an outcome.
 *
 * The numeric codes rather than the `GeolocationPositionError` constants,
 * because those live on a DOM interface this module is deliberately free of.
 * Anything unrecognised is treated as `unavailable`: "your device could not
 * work out where it is" is true of a code we have never seen, where "blocked"
 * and "too slow" would both be guesses.
 */
export function geoErrorOutcome(code: number): 'denied' | 'timeout' | 'unavailable' {
  if (code === 1) return 'denied'; // PERMISSION_DENIED
  if (code === 3) return 'timeout'; // TIMEOUT
  return 'unavailable'; // POSITION_UNAVAILABLE, and anything added later
}

/**
 * Should the page ask for a location by itself, on load?
 *
 * Current location is the default, so the answer is normally yes - but three
 * things outrank it:
 *
 *  - **A shared link wins outright.** The calendar's filters are shareable and
 *    a `?lat=&lng=` URL is a deliberate statement about where to look; a
 *    permission prompt firing over someone else's link would be both a
 *    surprise and wrong.
 *  - **A refusal is remembered.** `denied` means the browser would fail the
 *    call instantly, so there is nothing to gain by making it.
 *  - **One automatic prompt per browser, ever.** `autoAsked` is persisted, so
 *    a reader who dismissed the prompt without answering it - which leaves the
 *    permission in `prompt`, indistinguishable from never having been asked -
 *    is not asked again on every single visit. The explicit button is how they
 *    ask for it afterwards, which is most of why the button exists.
 *
 * `granted` is exempt from that last rule: reading an already-granted
 * permission shows no prompt, so there is no prompt to spam, and a reader who
 * granted it means it on every visit - which is what makes current location
 * the default rather than a one-time seed.
 */
export function shouldAutoLocate(input: {
  support: GeoSupport;
  /** The URL carried a location. */
  sharedLocation: boolean;
  permission: GeoPermission;
  /** This browser has been prompted automatically before. */
  autoAsked: boolean;
}): boolean {
  if (input.support !== 'available') return false;
  if (input.sharedLocation) return false;
  if (input.permission === 'denied') return false;
  if (input.permission === 'granted') return true;
  return !input.autoAsked;
}

/**
 * The precision the share URL is written at, and therefore the precision at
 * which two places count as the same place.
 */
const SHARE_PRECISION = 4;

/**
 * Are these the same spot?
 *
 * Rounded to the share URL's own four decimal places (~11m) rather than
 * compared exactly, so a link shared *from* "my current location" still reads
 * as "my current location" when the same reader opens it. Below that the two
 * numbers only differ because one of them went through the URL.
 */
export function sameSpot(
  a: { lat: number; lng: number } | null | undefined,
  b: { lat: number; lng: number } | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.lat.toFixed(SHARE_PRECISION) === b.lat.toFixed(SHARE_PRECISION) &&
    a.lng.toFixed(SHARE_PRECISION) === b.lng.toFixed(SHARE_PRECISION)
  );
}

/** "Showing events near Oakland, CA." */
function nearMessage(locationName?: string | null): string {
  const where =
    locationName && locationName !== MY_LOCATION_NAME ? locationName : 'your current location';
  return `Showing events near ${where}.`;
}

/**
 * What the control says, in one place.
 *
 * The order of the branches is the order of urgency. `located` is tested
 * before `denied` on purpose: a reader who revoked the permission *after* a
 * fix landed is still looking at their own location, so the label should
 * describe what is on screen, and the next press will tell them it is blocked.
 */
export function locationControl(input: LocationControlInput): LocationControl {
  const { support, permission, outcome, attempt, atCurrentLocation, locationName } = input;
  const spoken = attempt === 'user';

  if (support !== 'available') {
    return {
      available: false,
      label: GEO_LABELS.idle,
      hint: '',
      disabled: true,
      busy: false,
      status: support === 'insecure' ? GEO_MESSAGES.insecure : GEO_MESSAGES.noApi,
      tone: 'muted',
    };
  }

  if (outcome === 'locating') {
    return {
      available: true,
      label: GEO_LABELS.locating,
      hint: '',
      disabled: true,
      busy: true,
      status: GEO_MESSAGES.locating,
      tone: 'muted',
    };
  }

  if (outcome === 'located') {
    return atCurrentLocation
      ? {
          ...QUIET,
          label: GEO_LABELS.idle,
          hint: GEO_MESSAGES.refreshHint,
          status: spoken ? nearMessage(locationName) : '',
        }
      : // The fix is still good; the reader has simply searched their way to
        // another city since. This is the one-click way back, and the whole
        // reason an explicit control had to exist.
        { ...QUIET, label: GEO_LABELS.back, hint: '', status: '' };
  }

  if (outcome === 'denied' || permission === 'denied') {
    return {
      ...QUIET,
      label: GEO_LABELS.blocked,
      hint: GEO_MESSAGES.blockedHint,
      // Instructional, not a failure, so it is not printed in the error red:
      // nothing broke, and the reader is the one holding the switch.
      status: spoken && outcome === 'denied' ? GEO_MESSAGES.denied : '',
    };
  }

  if (outcome === 'timeout' || outcome === 'unavailable') {
    return {
      ...QUIET,
      label: GEO_LABELS.retry,
      hint: '',
      status: spoken ? GEO_MESSAGES[outcome] : '',
      tone: 'error',
    };
  }

  return { ...QUIET, label: GEO_LABELS.idle, hint: '', status: '' };
}
