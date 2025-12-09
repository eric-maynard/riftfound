import { Router, Request, Response, NextFunction } from 'express';
import { EventQuerySchema } from '../models/event.js';
import * as eventService from '../services/eventService.js';

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
