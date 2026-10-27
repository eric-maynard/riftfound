import { Router, Request, Response, NextFunction } from 'express';
import { EventQuerySchema } from '../models/event.js';
import * as eventService from '../services/eventService.js';
import { geocodeCity, geocodeSuggestions, reverseGeocode } from '../services/geocodingService.js';
import { geocodeLimiter } from '../middleware/rateLimit.js';
import { cacheEventList, cacheGeocode, noStore } from '../middleware/cacheControl.js';

const router = Router();

/*
 * Freshness is per route here rather than per router, because these four
 * things change at four different rates: the event list follows the hourly
 * scraper, a geocode is a geographic constant, and `/visit` is a redirect that
 * should always be answered live. See middleware/cacheControl.ts.
 */

// GET /api/events - List events with filtering
router.get('/', cacheEventList, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const queryResult = EventQuerySchema.safeParse(req.query);

    if (!queryResult.success) {
      res.status(400).json({
        error: 'Invalid query parameters',
        details: queryResult.error.format(),
      });
      return;
    }

    const { events, total } = await eventService.getEvents(queryResult.data);

    res.json({
      data: events,
      pagination: {
        page: queryResult.data.page,
        limit: queryResult.data.limit,
        total,
        totalPages: Math.ceil(total / queryResult.data.limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/info - Get scrape info (last updated, total count)
router.get('/info', cacheEventList, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const info = await eventService.getScrapeInfo();
    res.json({
      data: {
        lastScrapeAt: info.lastScrapeAt?.toISOString() || null,
        totalEvents: info.totalEvents,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/geocode - Geocode a city/location for filtering
// `cacheGeocode` sits *after* `geocodeLimiter` on all three of these, and the
// order is load-bearing: the limiter answers 429 itself, so a cache header set
// ahead of it would be attached to that 429 and CloudFront would then serve one
// throttled caller's rejection to everyone for a day.
router.get('/geocode', geocodeLimiter, cacheGeocode, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = req.query.q as string;

    if (!query || query.trim().length === 0) {
      res.status(400).json({ error: 'Query parameter "q" is required' });
      return;
    }

    const result = await geocodeCity(query);

    if (!result) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }

    res.json({
      data: {
        latitude: result.latitude,
        longitude: result.longitude,
        displayName: result.displayName,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/geocode/suggest - Autocomplete suggestions for location search
router.get('/geocode/suggest', geocodeLimiter, cacheGeocode, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = req.query.q as string;

    if (!query || query.trim().length < 2) {
      res.json({ data: [] });
      return;
    }

    const suggestions = await geocodeSuggestions(query);
    res.json({ data: suggestions });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/geocode/reverse - Reverse geocode coordinates to location name
router.get('/geocode/reverse', geocodeLimiter, cacheGeocode, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);

    if (isNaN(lat) || isNaN(lon)) {
      res.status(400).json({ error: 'Query parameters "lat" and "lon" are required and must be valid numbers' });
      return;
    }

    const result = await reverseGeocode(lat, lon);

    if (!result) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }

    res.json({
      data: {
        latitude: result.latitude,
        longitude: result.longitude,
        displayName: result.displayName,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/:id - Get single event
router.get('/:id', cacheEventList, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const event = await eventService.getEventById(req.params.id);

    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    res.json({ data: event });
  } catch (error) {
    next(error);
  }
});

const PLAYRIFTBOUND_EVENT_URL_PREFIX = 'https://playriftbound.com/en-us/events/';

// GET /api/events/:id/visit - Track click and redirect to external event page
router.get('/:id/visit', noStore, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const event = await eventService.getEventById(req.params.id);

    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    // Riot-only events (from the playriftbound source) have no UVS locator page;
    // send them to their Riot registration page. Everything else, including UVS
    // events merged with a Riot twin, keeps the UVS locator link.
    if (event.externalId.startsWith('prb-') && event.url?.startsWith(PLAYRIFTBOUND_EVENT_URL_PREFIX)) {
      res.redirect(302, event.url);
      return;
    }

    const locatorUrl = `https://locator.riftbound.uvsgames.com/events/${event.externalId}`;
    res.redirect(302, locatorUrl);
  } catch (error) {
    next(error);
  }
});

export default router;
