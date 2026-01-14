import { Router, Request, Response, NextFunction } from 'express';
import { EventQuerySchema } from '../models/event.js';
import * as eventService from '../services/eventService.js';
import { geocodeCity, geocodeSuggestions, reverseGeocode } from '../services/geocodingService.js';
import { geocodeLimiter } from '../middleware/rateLimit.js';

const router = Router();

// GET /api/events - List events with filtering
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
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
router.get('/info', async (_req: Request, res: Response, next: NextFunction) => {
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
router.get('/geocode', geocodeLimiter, async (req: Request, res: Response, next: NextFunction) => {
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
router.get('/geocode/suggest', geocodeLimiter, async (req: Request, res: Response, next: NextFunction) => {
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
router.get('/geocode/reverse', geocodeLimiter, async (req: Request, res: Response, next: NextFunction) => {
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
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
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

// GET /api/events/:id/visit - Track click and redirect to external event page
router.get('/:id/visit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const event = await eventService.getEventById(req.params.id);

    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    // Build the external locator URL and redirect
    const locatorUrl = `https://locator.riftbound.uvsgames.com/events/${event.externalId}`;
    res.redirect(302, locatorUrl);
  } catch (error) {
    next(error);
  }
});

export default router;
