import { Router, Request, Response, NextFunction } from 'express';
import { EventQuerySchema } from '../models/event.js';
import * as eventService from '../services/eventService.js';
import { geocodeCity } from '../services/geocodingService.js';

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
router.get('/geocode', async (req: Request, res: Response, next: NextFunction) => {
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

export default router;
