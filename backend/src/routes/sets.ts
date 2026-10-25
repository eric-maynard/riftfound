import { Router, Request, Response, NextFunction } from 'express';
import * as rankingService from '../services/rankingService.js';

const router = Router();

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
