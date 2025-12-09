# Riftfound

A calendar view for Riftbound TCG events with location-based filtering. Data scraped from https://locator.riftbound.uvsgames.com/

## Quick Start

```bash
# Install dependencies
npm install

# Start dev servers (SQLite mode, no geocoding)
./dev.sh

# Or with PostgreSQL + Photon geocoder
./dev.sh --docker --photon
```

Frontend: http://localhost:5173

## Features

- Calendar view with Google Calendar-style month grid
- Location-based filtering (5mi, 10mi, 25mi, 50mi, 100mi radius)
- Format filtering (Constructed, Sealed, Draft, Multiplayer)
- Auto-detects user location, defaults to San Francisco if denied
- Events displayed as "Time | Shop Name" with hover tooltips

## Project Structure

```
riftfound/
├── backend/          # Express.js API (port 3001)
├── frontend/         # React + Vite calendar UI (port 5173)
├── scraper/          # Event scraper + geocoding queue
├── infrastructure/   # Docker, Photon, AWS deployment
└── dev.sh            # Development script
```

## Development

### dev.sh Options

| Flag | Description |
|------|-------------|
| (none) | SQLite mode, no Docker, no geocoding |
| `--docker` | Start PostgreSQL via docker-compose |
| `--postgres` | Use PostgreSQL for app (implies --docker) |
| `--photon` | Start Photon geocoder (first run downloads ~8GB) |
| `--stop-docker` | Stop Docker services on exit |

### Manual Commands

```bash
npm run dev:backend   # Start backend only
npm run dev:frontend  # Start frontend only
npm run dev:scraper   # Run scraper once
npm test              # Run scraper unit tests
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/events` | List events with filtering |
| `GET /api/events/:id` | Single event |
| `GET /api/events/info` | Scrape stats |
| `GET /api/events/geocode?q=` | Geocode location |

### Query Parameters

- `page`, `limit` - Pagination
- `search` - Text search
- `city`, `state`, `country` - Location filters
- `eventType` - Format filter
- `lat`, `lng`, `radiusKm` - Distance filtering
- `calendarMode=true` - Return all events in 3-month range

## Architecture

- **Database**: SQLite for dev, PostgreSQL for production
- **Geocoding**: Self-hosted Photon (OSM-based), no external APIs
- **Shops table**: Geocoded store locations, events reference via `shop_id`
- **Scraper**: Runs every 60min, up to 500 events (20 pages × 25/page)

## Deployment

See [infrastructure/aws-deployment.md](infrastructure/aws-deployment.md) for AWS setup:
- RDS PostgreSQL
- ECS Fargate for backend/scraper
- S3 + CloudFront for frontend
- ECS Fargate + EFS for Photon

## License

Apache License 2.0 - see [LICENSE](LICENSE)
