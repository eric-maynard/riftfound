# Infrastructure

Docker setup for local dev + AWS deployment docs.

## Local Development

### docker-compose.yml

Services:
- `postgres`: PostgreSQL 16 on port 5432
- `photon`: Self-hosted Photon geocoder on port 2322 (profile: geocoding)

Photon uses custom Dockerfile that:
1. Downloads Photon JAR from GitHub releases
2. Downloads US country extract (~8GB) on first run
3. Starts Photon server

### dev.sh Flags

```bash
./dev.sh                    # SQLite, no docker
./dev.sh --docker           # PostgreSQL only
./dev.sh --docker --photon  # PostgreSQL + Photon (waits for health)
./dev.sh --postgres         # Use PostgreSQL for app (implies --docker)
./dev.sh --stop-docker      # Stop containers on Ctrl+C
```

The script waits for services to be healthy before starting backend/frontend.

## Photon Geocoder

- Image built from `infrastructure/photon/Dockerfile`
- **Always use `PHOTON_COUNTRY=us`** - we only need US data (~14GB), not worldwide (~70GB)
- Data persisted in `photon_data` Docker volume
- First run downloads ~14GB, takes 30-50 minutes depending on connection
- Health check: `curl http://localhost:2322/api?q=test`
- Elasticsearch port 9200 exposed for custom city imports

**IMPORTANT: Never move or restructure the Photon data directory.** The download takes 30+ minutes and the Elasticsearch index is fragile. The entrypoint.sh handles the nested directory structure (`photon_data/photon_data/elasticsearch`) - do not "fix" this by moving files. If you need to change paths, always backup the volume first with `docker run --rm -v photon_data:/data -v $(pwd):/backup alpine tar -czvf /backup/photon-backup.tar.gz /data`.

## AWS Deployment

Fully serverless architecture:
- Frontend: S3 + CloudFront
- Backend API: Lambda + API Gateway
- Scraper: Lambda + EventBridge (hourly)
- Database: DynamoDB
- Geocoding: Google Maps API

## Database Schema

See `init.sql`:
- `events`: Main event table with all scraped fields
- `shops`: Dimension table for geocoded store locations
- `geocache`: Cache for user city searches
- `scrape_runs`: Tracks scrape history
