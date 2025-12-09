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
- Uses `PHOTON_COUNTRY=us` env var for US-only data
- Data persisted in `photon_data` Docker volume
- First run downloads ~14GB, takes 30+ minutes depending on connection
- Health check: `curl http://localhost:2322/api?q=test`

**IMPORTANT: Never move or restructure the Photon data directory.** The download takes 30+ minutes and the Elasticsearch index is fragile. The entrypoint.sh handles the nested directory structure (`photon_data/photon_data/elasticsearch`) - do not "fix" this by moving files. If you need to change paths, always backup the volume first with `docker run --rm -v riftfound_photon_data:/data -v $(pwd):/backup alpine tar -czvf /backup/photon-backup.tar.gz /data`.

To use California only (smaller ~1GB):
```yaml
environment:
  - PHOTON_COUNTRY=us-california
```

## AWS Deployment

See `aws-deployment.md` for:
- RDS PostgreSQL setup
- ECS Fargate for backend/scraper
- S3 + CloudFront for frontend
- ECS Fargate + EFS for Photon (needs ~70GB for worldwide data)

## Database Schema

See `init.sql`:
- `events`: Main event table with all scraped fields
- `shops`: Dimension table for geocoded store locations
- `geocache`: Cache for user city searches
- `scrape_runs`: Tracks scrape history
