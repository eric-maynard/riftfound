import { z } from 'zod';

// Schema for event data (adjust based on actual scraped data structure)
export const EventSchema = z.object({
  id: z.string().uuid(),
  externalId: z.string(), // ID from the source
  name: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  startDate: z.date(),
  startTime: z.string().nullable(), // e.g., "7:30 AM (UTC)"
  endDate: z.date().nullable(),
  eventType: z.string().nullable(),
  organizer: z.string().nullable(), // Store/shop name
  playerCount: z.number().nullable(), // Registered players
  price: z.string().nullable(), // e.g., "A$15.00", "Free Event"
  url: z.string().url().nullable(),
  imageUrl: z.string().url().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  scrapedAt: z.date(),
  // Shop coordinates (from joined shops table)
  shopLatitude: z.number().nullable().optional(),
  shopLongitude: z.number().nullable().optional(),
});

export type Event = z.infer<typeof EventSchema>;

// Schema for creating/updating events (without auto-generated fields)
export const CreateEventSchema = EventSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type CreateEvent = z.infer<typeof CreateEventSchema>;

// Query parameters for listing events
export const EventQuerySchema = z.object({
  page: z.string().transform(Number).default('1'),
  limit: z.string().transform(Number).default('20'),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  startDateFrom: z.string().datetime().optional(),
  startDateTo: z.string().datetime().optional(),
  search: z.string().optional(),
  eventType: z.string().optional(),
  // Location-based filtering
  lat: z.string().transform(Number).optional(),
  lng: z.string().transform(Number).optional(),
  radiusKm: z.string().transform(Number).default('100'),
  // Calendar mode - returns all events without pagination for a 3-month range
  calendarMode: z.string().transform(v => v === 'true').optional(),
});

export type EventQuery = z.infer<typeof EventQuerySchema>;
