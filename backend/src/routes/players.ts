import { Router, Request, Response, NextFunction } from 'express';
import {
  PlayerMatchesQuerySchema,
  PlayerRatingsQuerySchema,
  PlayerSearchQuerySchema,
  isValidPlayerId,
  parseScope,
} from '../models/ranking.js';
import * as rankingService from '../services/rankingService.js';
import { cacheRanking } from '../middleware/cacheControl.js';

const router = Router();

// Profiles, match logs and rating series all come out of the same refit, so
// they keep the same freshness as the ladder itself.
router.use(cacheRanking);

/**
 * Player pages carry display names and taglines that Riot already publishes on
 * its own event pages, but there is no reason for a search engine to build a
 * directory of them out of this API. Every player route is marked noindex and
 * there is no endpoint that lists players in bulk.
 */
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

function invalidQuery(res: Response, error: { format(): unknown }): void {
  res.status(400).json({ error: 'Invalid query parameters', details: error.format() });
}

// GET /api/players/search?q= - display-name search.
// Registered before /:playerId so "search" is never read as an id.
router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const queryResult = PlayerSearchQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      invalidQuery(res, queryResult.error);
      return;
    }

    const hits = await rankingService.searchPlayers(queryResult.data.q, queryResult.data.limit);
    res.json({ data: hits });
  } catch (error) {
    next(error);
  }
});

// GET /api/players/:playerId - profile, per-set ratings and component info
router.get('/:playerId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isValidPlayerId(req.params.playerId)) {
      res.status(400).json({ error: 'Invalid player id' });
      return;
    }

    // Never 404s for a well-formed id. The engine has no profile for most of a
    // tournament field, and those players exist - they are on a roster. That
    // state is `known: false` with a `no-rating` verdict and null numbers, the
    // same answer `/matches` and `/ratings` already give for the same id (see
    // `unknownProfile` in services/rankingService.ts). A malformed id is still
    // a 400 above.
    const player = await rankingService.getPlayer(req.params.playerId);
    res.json({ data: player });
  } catch (error) {
    next(error);
  }
});

// GET /api/players/:playerId/matches - paginated match log with opponents
router.get('/:playerId/matches', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isValidPlayerId(req.params.playerId)) {
      res.status(400).json({ error: 'Invalid player id' });
      return;
    }

    const queryResult = PlayerMatchesQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      invalidQuery(res, queryResult.error);
      return;
    }

    const { matches, cursor, hasMore } = await rankingService.getPlayerMatches(
      req.params.playerId,
      queryResult.data.limit,
      queryResult.data.cursor,
      queryResult.data.setId
    );

    res.json({
      data: matches,
      pagination: { limit: queryResult.data.limit, cursor, hasMore },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/players/:playerId/ratings?scope= - rating-over-time series
router.get('/:playerId/ratings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isValidPlayerId(req.params.playerId)) {
      res.status(400).json({ error: 'Invalid player id' });
      return;
    }

    const queryResult = PlayerRatingsQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      invalidQuery(res, queryResult.error);
      return;
    }

    const scope = parseScope(queryResult.data.scope);
    if (!scope) {
      res.status(400).json({
        error: 'Invalid scope. Expected all, set:<id>, component:<id> or set:<id>#component:<id>',
      });
      return;
    }

    const series = await rankingService.getPlayerRatings(
      req.params.playerId,
      scope,
      queryResult.data.limit
    );

    res.json({ data: series });
  } catch (error) {
    next(error);
  }
});

export default router;
