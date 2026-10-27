import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * `Cache-Control` for the read-only GET endpoints.
 *
 * Every one of these answers is byte-identical for every visitor - there are
 * no sessions, no cookies and no personalisation anywhere in this API - so the
 * only question a cache header has to answer is *how often does the underlying
 * thing change*. That question has a different answer per route family, and it
 * is answered here rather than in the CloudFront config, because the code that
 * knows the cadence is the code that serves the data.
 *
 * `max-age` is what a browser may reuse without asking; `s-maxage` is what
 * CloudFront may serve without asking the origin (a Lambda invocation, an API
 * Gateway request and a round of DynamoDB reads). The browser figure is always
 * the shorter of the two: an edge hit is cheap and shared, so it is worth
 * holding for longer than a single reader's copy.
 *
 * `stale-while-revalidate` is here for the **browser**, not for CloudFront,
 * which does not implement it. Chromium honours it, which turns a back/forward
 * navigation or a tab switch into an instant render plus a background refresh
 * instead of a spinner. It is a bonus where it lands, never the mechanism.
 */
interface Freshness {
  /** `max-age`, seconds: a reader's own copy. */
  browser: number;
  /** `s-maxage`, seconds: the shared copy at the edge. */
  edge: number;
  /** `stale-while-revalidate`, seconds. Browsers only; see above. */
  stale: number;
}

function cacheable(freshness: Freshness): RequestHandler {
  const value = [
    'public',
    `max-age=${freshness.browser}`,
    `s-maxage=${freshness.edge}`,
    `stale-while-revalidate=${freshness.stale}`,
  ].join(', ');

  return (req: Request, res: Response, next: NextFunction): void => {
    // Only a read is cacheable, and only GET/HEAD are in CloudFront's
    // `cached_methods` anyway. A POST or an OPTIONS preflight falls through
    // with no header, which the cache policy's `default_ttl = 0` reads as
    // "do not cache".
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.setHeader('Cache-Control', value);
    }
    next();
  };
}

/**
 * The rating engine's cadence.
 *
 * The engine refits every `RANKING_REFIT_INTERVAL_HOURS` (24 in production),
 * and between refits the leaderboards, profiles, match logs and rating series
 * do not move at all. An hour at the edge is therefore not a staleness budget
 * so much as a rounding error on a daily figure - and it is the difference
 * between one origin hit an hour and one per visitor, on the endpoints that
 * cost the most to answer (see `getRankings`: four DynamoDB round trips).
 *
 * It is deliberately an hour and not a day. The refit is not phase-locked to
 * anything, so a 24h edge TTL could hide a whole refit for a whole day, and
 * "the ladder did not change when the engine ran" is a worse failure than any
 * amount of money this would save over an hour.
 */
export const cacheRanking = cacheable({ browser: 300, edge: 3600, stale: 86400 });

/**
 * The scraper's cadence, for the tournament facts.
 *
 * Standings and rosters arrive when the hourly scraper captures them, so a
 * quarter of an hour at the edge keeps a freshly finished event's trophy and
 * standings appearing within the same hour they were recorded. The
 * availability sweep is the reason this matters: the calendar asks about every
 * visible event on every page load, 50 ids a request, and each request is a
 * 100-key BatchGet - around 50 read units for an answer that is almost always
 * the same one.
 */
export const cacheTournamentFacts = cacheable({ browser: 300, edge: 900, stale: 3600 });

/**
 * The event list and the single-event lookup.
 *
 * Shorter than the facts above, because this is the calendar and a stale
 * calendar is the one thing nobody wants: five minutes at the edge against an
 * hourly scraper means an event can never be more than five minutes behind
 * what the last scrape knew. The payoff is still large, because the default
 * view is *shared* - the frontend falls back to San Francisco at 25 miles when
 * geolocation is denied, so that one 150KB response answers a large share of
 * first loads.
 */
export const cacheEventList = cacheable({ browser: 60, edge: 300, stale: 3600 });

/**
 * Geocoding, which is the one place a cache miss spends money outside AWS.
 *
 * A city's coordinates do not move, and the autocomplete endpoint is called
 * per keystroke, so every edge hit here is a Mapbox request that never
 * happens. The server-side shops/geocache table already protects the repeated
 * lookups it knows about; this protects the ones it does not, before they
 * reach a Lambda at all.
 */
export const cacheGeocode = cacheable({ browser: 3600, edge: 86400, stale: 604800 });

/**
 * Explicitly not cacheable.
 *
 * For the click-through redirect and the health check. `/visit` is counted out
 * of the CloudFront access log, which records cache hits too, but a redirect
 * is cheap and an endpoint whose whole job is to be hit should not be answered
 * from a cache. The health check must report the state of a live Lambda or it
 * reports nothing.
 */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
