import { Router, Request, Response, NextFunction } from 'express';
import { RankingQuerySchema, parseScope } from '../models/ranking.js';
import * as rankingService from '../services/rankingService.js';

const router = Router();

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
