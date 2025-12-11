# Riftfound

A calendar view for Riftbound TCG events with location-based filtering. Data scraped from https://locator.riftbound.uvsgames.com/

**Live site**: https://www.riftfound.com

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
- Event type filtering (Summoner Skirmish, Nexus Night)
- Auto-detects user location, defaults to San Francisco if denied
- Events displayed as "Time | Shop Name" with hover tooltips showing full details
- Times displayed in user's local timezone

## Project Structure

```
riftfound/
├── backend/          # Express.js API (port 3001)
├── frontend/         # React + Vite calendar UI (port 5173)
├── scraper/          # Event scraper (distributed across 60min cycles)
├── infrastructure/   # Docker, Photon, Terraform AWS deployment
├── dev.sh            # Development script
└── deploy.sh         # Production deployment script
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
- `eventType` - Event type filter (Summoner Skirmish, Nexus Night)
- `lat`, `lng`, `radiusKm` - Distance filtering
- `calendarMode=true` - Return all events in 3-month range

## Architecture

- **Database**: SQLite for dev, PostgreSQL optional. Production uses SQLite on EBS.
- **Geocoding**: Self-hosted Photon (OSM-based), no external APIs
- **Shops table**: Geocoded store locations, events reference via `shop_id`
- **Scraper**: Runs every 60min cycle, fetches all ~30k events with requests distributed evenly across the cycle to avoid rate limiting

## Deployment

Production runs on AWS with Terraform:

- **Frontend**: S3 + CloudFront (HTTPS)
- **Backend/Scraper**: EC2 (t3.small) with PM2
- **Database**: SQLite on persistent EBS volume
- **Domain**: CloudFront + ACM certificate

### Deploy Commands

```bash
# First time setup
cp deploy.env.example deploy.env
# Edit deploy.env with your AWS values

# Deploy
./deploy.sh frontend   # React app to S3/CloudFront
./deploy.sh backend    # Backend/scraper to EC2
./deploy.sh all        # Everything
```

See [CLAUDE.md](CLAUDE.md) for detailed deployment docs.

## License

Apache License 2.0 - see [LICENSE](LICENSE)
