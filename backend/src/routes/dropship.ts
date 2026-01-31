import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as dropshipService from '../services/dropshipService.js';

const router = Router();

// Schema for buylist items
const BuylistItemSchema = z.object({
  quantity: z.number().int().positive(),
  cardName: z.string().min(1),
});

// Schema for check request
const CheckRequestSchema = z.object({
  items: z.array(BuylistItemSchema).min(1),
  city: z.string().optional(),
});

// Schema for submit request
const SubmitRequestSchema = z.object({
  email: z.string().email(),
  city: z.string().optional().default(''),
  items: z.array(BuylistItemSchema).min(1),
});

// POST /api/dropship/check - Validate buylist
router.post('/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = CheckRequestSchema.safeParse(req.body);

    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request',
        details: parseResult.error.format(),
      });
      return;
    }

    const result = await dropshipService.checkBuylist(parseResult.data.items);

    res.json({
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/dropship/submit - Submit dropship request
router.post('/submit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = SubmitRequestSchema.safeParse(req.body);

    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request',
        details: parseResult.error.format(),
      });
      return;
    }

    const result = await dropshipService.submitDropshipRequest(parseResult.data);

    res.json({
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
