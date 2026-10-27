import { Router, Request, Response, NextFunction } from 'express';
import { RankingQuerySchema, parseScope } from '../models/ranking.js';
import * as rankingService from '../services/rankingService.js';
import { cacheRanking } from '../middleware/cacheControl.js';

const router = Router();

// The ladder moves only when the rating engine refits, which is once a day, so
// this is the most cacheable thing the API serves - and the most expensive to
// answer. See middleware/cacheControl.ts for the cadences.
router.use(cacheRanking);

// GET /api/rankings/map - every scene with a place, for the map of scenes
//
// Mounted **before** `/` so it matches as a literal; there is no `/:param`
// route on this router today, but the tournaments router already had to be
// mounted ahead of the events one for exactly this reason, and a future
// `/:scope` here would otherwise swallow it silently.
//
// It takes no parameters at all, deliberately: the whole catalogue is one
// Query and one cached answer that every reader shares, where a bounding-box
// or zoom parameter would fragment the edge cache into a key per viewport for
// a payload of a few hundred kilobytes. Panning a map is a client-side
// concern. See `cacheRanking` - the catalogue only moves when the engine
// refits, which is daily.
router.get('/map', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await rankingService.getSceneMap();
    res.json({
      data: {
        scenes: result.scenes,
        unlocated: result.unlocated,
        coverage: result.coverage,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/rankings - a leaderboard page for one scope
// scope = all | set:<id> | component:<id> | set:<id>#component:<id>
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const queryResult = RankingQuerySchema.safeParse(req.query);

    if (!queryResult.success) {
      res.status(400).json({
        error: 'Invalid query parameters',
        details: queryResult.error.format(),
      });
      return;
    }

    const scope = parseScope(queryResult.data.scope);
    if (!scope) {
      res.status(400).json({
        error: 'Invalid scope. Expected all, set:<id>, component:<id> or set:<id>#component:<id>',
      });
      return;
    }

    const result = await rankingService.getRankings(scope, queryResult.data.limit, queryResult.data.cursor);

    res.json({
      data: {
        scope: result.scope,
        entries: result.entries,
        coverage: result.coverage,
        component: result.component,
        components: result.components,
      },
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
