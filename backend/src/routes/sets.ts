import { Router, Request, Response, NextFunction } from 'express';
import * as rankingService from '../services/rankingService.js';
import { cacheRanking } from '../middleware/cacheControl.js';

const router = Router();

// The set catalogue changes when Riot releases a set. The refit cadence is
// several orders of magnitude more often than that, so it is the safe bound.
router.use(cacheRanking);

// GET /api/sets - sets the rating engine has data for, with any published
// boundaries. `releaseDate` is null for sets whose dates were never published
// (sets 1-3), so consumers must cope with an unknown boundary.
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sets = await rankingService.listSets();
    res.json({ data: sets });
  } catch (error) {
    next(error);
  }
});

export default router;
