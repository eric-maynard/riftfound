# Scraper

TypeScript scraper for Riftbound events using the official API.

## Structure

```
src/
├── index.ts          # Entry point, runs scrape loop
├── config.ts         # Zod-validated env config
├── database.ts       # DB operations for events, shops, scrape_runs
├── api.ts            # API client for Riftbound backend (NEW)
├── scraper.ts        # Legacy HTML scraper (deprecated)
├── parser.ts         # Legacy HTML parsing (deprecated)
└── geocoding.ts      # Legacy Photon geocoding (deprecated)
```

## How It Works

The scraper now uses the official Riftbound API instead of HTML scraping:

1. **Fetch from API** (`api.ts`): Hits `/api/v2/events/` with `upcoming_only=true`, `num_miles=20000` (worldwide)
2. **Pagination**: 1000 events per page, ~31 requests to get all ~30k events
3. **Upsert events** (`database.ts`): Inserts/updates events with coordinates from API
4. **Upsert stores**: Store info (with coordinates) embedded in each event response

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

## Benefits Over HTML Scraping

- **30k+ events** vs ~500 from paginated HTML
- **Pre-geocoded** coordinates from API (no Photon needed)
- **Structured JSON** vs fragile HTML parsing
- **Faster** - ~31 API calls vs slow HTML scraping
- **Complete store data** including contact info

## Environment

- `SCRAPE_INTERVAL_MINUTES`: Loop interval (default: 60)
- `DB_TYPE`: `sqlite` or `postgres`

Note: `PHOTON_URL`, `SCRAPE_MAX_PAGES`, `RIFTBOUND_EVENTS_URL` are no longer used.
