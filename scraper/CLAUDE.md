# Scraper

TypeScript scraper for Riftbound events + geocoding queue processor.

## Structure

```
src/
├── index.ts          # Entry point, runs scrape loop
├── config.ts         # Zod-validated env config
├── database.ts       # DB operations for events, shops, scrape_runs
├── scraper.ts        # HTTP fetching with pagination
├── parser.ts         # Cheerio HTML parsing (unit testable)
└── geocoding.ts      # Photon geocoding for shops
```

## How It Works

1. **Scrape loop** (`index.ts`): Runs every `SCRAPE_INTERVAL_MINUTES` (default 60)
2. **Fetch pages** (`scraper.ts`): Paginates through events, 25 per page, max `SCRAPE_MAX_PAGES`
3. **Parse HTML** (`parser.ts`): Extracts event data using `data-testid` selectors
4. **Upsert events** (`database.ts`): Inserts/updates events, creates shops as needed
5. **Geocode shops** (`geocoding.ts`): Processes shops with `geocode_status='pending'`

## Parser Details

Parses event cards by `data-testid`:
- `eventCard-{id}` - Card container, ID extracted from testid
- `eventCard-text-title` - Event name
- `eventCard-text-date` - Date string
- `eventCard-text-time` - Time string
- `eventCard-text-entryFee` - Price
- `eventCard-text-storeName` - Location (city, state)

Format/players extracted from lucide icons:
- `.lucide-trophy` sibling → format (Constructed, Sealed, Draft, Multiplayer)
- `.lucide-users` sibling → player count
- `.lucide-store` sibling → store/organizer name

## Shops Table

- Unique by `name` (store name)
- `location_text`: Raw location string for geocoding
- `geocode_status`: pending → completed/failed
- Events reference shops via `shop_id` foreign key

## Testing

```bash
npm test  # or: npx vitest
```

Unit tests in `__tests__/parser.test.ts` with HTML fixtures.

## Environment

- `RIFTBOUND_EVENTS_URL`: Source URL (default: https://locator.riftbound.uvsgames.com/events)
- `SCRAPE_INTERVAL_MINUTES`: Loop interval (default: 60)
- `SCRAPE_MAX_PAGES`: Max pages to fetch (default: 20)
- `PHOTON_URL`: Geocoder endpoint
