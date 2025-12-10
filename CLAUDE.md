# Riftfound

Event calendar aggregator for Riftbound TCG events, scraped from https://locator.riftbound.uvsgames.com/

## Architecture

```
riftfound/
├── backend/     # Express.js API (port 3001)
├── frontend/    # React + Vite calendar UI (port 5173)
├── scraper/     # Event scraper + geocoding queue
└── infrastructure/  # Docker, Photon geocoder, AWS deployment
```

## Quick Start

```bash
./dev.sh                    # SQLite mode, no geocoding
./dev.sh --docker           # PostgreSQL only
./dev.sh --docker --photon  # PostgreSQL + Photon geocoder (first run downloads ~8GB)
```

## Key Design Decisions

- **Database**: SQLite for dev, PostgreSQL for production. Controlled by `DB_TYPE` env var.
- **Geocoding**: Self-hosted Photon (OSM-based) for production. No external API dependencies.
- **Shops table**: Stores geocoded locations to avoid re-geocoding. Events reference shops via `shop_id`.
- **Calendar mode**: API returns all events in 3-month window without pagination when `calendarMode=true`.
- **Distance filtering**: Haversine formula. Frontend uses miles, backend uses km internally.

## Default Behavior

- Calendar defaults to San Francisco, CA with 25mi radius
- Tries browser geolocation on load, falls back to SF if denied
- Scraper runs every 60 minutes (configurable via `SCRAPE_INTERVAL_MINUTES`)

## Environment Variables

Key vars (see `.env.example` for full list):
- `DB_TYPE`: `sqlite` or `postgres`
- `SCRAPE_INTERVAL_MINUTES`: How often scraper cycles (default: 60). Requests are distributed evenly across the cycle.
