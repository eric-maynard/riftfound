import { Router, Request, Response, NextFunction } from 'express';
import {
  MAX_AVAILABILITY_IDS,
  TournamentAvailabilityQuerySchema,
  isValidEventExternalId,
} from '../models/tournament.js';
import * as tournamentService from '../services/tournamentService.js';

/**
 * Tournament facts for one event: standings, pairings and roster, with each
 * player's rating attached.
 *
 * Mounted at `/api/events` *ahead of* the events router, so
 * `/tournament-availability` is matched as a literal before `/:id` can swallow
 * it. Anything these two routes do not match falls through to the events
 * router untouched.
 */
const router = Router();

/**
 * These pages list named individuals - display names and tag lines Riot
 * already publishes on its own event pages - so they carry the same noindex
 * posture as the player routes. There is no bulk export here either: the
 * availability endpoint answers yes/no for ids the caller already has, and the
 * detail endpoint serves one event at a time.
 */
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// GET /api/events/tournament-availability?ids=a,b,c
// Which of these events have results and/or a roster. Registered before the
// detail route so "tournament-availability" is never read as an event id.
router.get('/tournament-availability', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const queryResult = TournamentAvailabilityQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      res.status(400).json({
        error: 'Invalid query parameters',
        details: queryResult.error.format(),
      });
      return;
    }

    const ids = queryResult.data.ids;
    const availability = await tournamentService.getTournamentAvailability(ids);

    res.json({
      data: availability,
      meta: { requested: ids.length, limit: MAX_AVAILABILITY_IDS },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/:externalId/tournament - standings, pairings, roster, ratings
router.get('/:externalId/tournament', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isValidEventExternalId(req.params.externalId)) {
      res.status(400).json({ error: 'Invalid event id' });
      return;
    }

    const detail = await tournamentService.getTournament(req.params.externalId);
    // Neither fact exists. Not an error state - most events never have one -
    // but there is no page to render, so say so rather than serve an empty one.
    if (!detail) {
      res.status(404).json({ error: 'No tournament facts for this event' });
      return;
    }

    res.json({ data: detail });
  } catch (error) {
    next(error);
  }
});

export default router;
