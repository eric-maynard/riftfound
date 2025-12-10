# Scraper

TypeScript scraper for Riftbound events using the official API.

## Structure

```
src/
├── index.ts          # Entry point, runs distributed scrape loop
├── config.ts         # Zod-validated env config
├── database.ts       # DB operations for events, shops, scrape_runs
└── api.ts            # API client for Riftbound backend
```

## How It Works

The scraper uses the official Riftbound API with a **distributed scraping** approach:

1. **Get count** (`api.ts`): Single API call to get total event count and calculate pages needed
2. **Distributed fetching**: Spreads ~31 page requests evenly across the 60-minute cycle (~105s between requests)
3. **Upsert events** (`database.ts`): Inserts/updates events with coordinates from API
4. **Upsert stores**: Store info (with coordinates) embedded in each event response

This approach prevents burst traffic and maintains consistent, gentle load on the upstream API.

## API Endpoint

```
https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2/events/
  ?start_date_after=<today>
  &display_status=upcoming
  &latitude=0&longitude=0
  &num_miles=20000
  &upcoming_only=true
  &game_slug=riftbound
  &page=1
  &page_size=1000
```

Returns JSON with:
- Event details (name, description, date/time, format, price, capacity)
- Coordinates (latitude, longitude)
- Full store info (name, address, coordinates, website, email)

## Environment

- `SCRAPE_INTERVAL_MINUTES`: Cycle length (default: 60). Requests distributed evenly across cycle.
- `DB_TYPE`: `sqlite` or `postgres`
