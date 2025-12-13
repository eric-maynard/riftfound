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

### Production Photon Setup (EC2)

**CRITICAL: Data is stored in `/data/photon_data` on the EC2 instance.**
**DO NOT move, copy, or alter this directory. The Elasticsearch index is extremely fragile.**
**The download takes ~50-60 minutes and expands to ~30GB. This must NEVER be repeated.**

First time setup on EC2:
```bash
# Build the image
cd /opt/riftfound/infrastructure/photon
docker build -t riftfound-photon:latest .

# Create data directory with correct permissions
sudo mkdir -p /data/photon_data
sudo chown 1000:1000 /data/photon_data

# Start Photon with bind mount to /data (NOT a Docker volume)
docker run -d --name photon \
  --restart unless-stopped \
  -p 2322:2322 \
  -p 9200:9200 \
  -e PHOTON_COUNTRY=us \
  -v /data/photon_data:/photon/photon_data \
  riftfound-photon:latest

# Monitor download progress (shows % complete)
docker logs -f photon

# Check progress without following
docker logs photon 2>&1 | grep -o "[0-9]* 14.4G" | tail -1
```

**How to restart Photon (if container stops or server reboots):**
```bash
# The --restart unless-stopped policy handles this automatically
# But if you need to manually restart:
docker start photon

# Verify it's running:
docker ps | grep photon  # Should show "Up X seconds/minutes"
curl http://localhost:2322/api?q=test  # Should return JSON within ~10s
```

**Key configuration for resilience:**
- `--restart unless-stopped`: Auto-restart on crash or server reboot (survives restarts!)
- `-v /data/photon_data:/photon/photon_data`: Bind mount to /data volume (99GB, plenty of space)
- `-e PHOTON_COUNTRY=us`: Downloads US-only data (14.4GB download, ~30GB indexed)
- Ports 2322 (API) and 9200 (Elasticsearch for custom city imports)
- User 1000:1000 owns /data/photon_data (matches container user)

**Data persistence guarantees:**
- Survives container stop/start (`docker stop photon && docker start photon`)
- Survives container removal and recreation (as long as /data/photon_data is untouched)
- Survives server reboot (data on EBS /data volume, container auto-restarts)
- Does NOT survive if /data/photon_data is deleted or moved

**Directory structure (DO NOT ALTER):**
```
/data/photon_data/
└── photon_data/           # Nested on purpose! entrypoint.sh expects this.
    └── elasticsearch/      # Fragile Elasticsearch index
        └── data/
```

**What to do if download fails or Photon crashes:**
1. Check logs: `docker logs photon`
2. Check disk space: `df -h` (need ~35GB free on /data)
3. If corrupted, you MUST delete everything and re-download:
   ```bash
   docker rm -f photon
   sudo rm -rf /data/photon_data
   sudo mkdir -p /data/photon_data
   sudo chown 1000:1000 /data/photon_data
   # Then run the docker run command above again
   ```

Check status after server reboot:
```bash
docker ps | grep photon  # Should show "Up X minutes"
curl http://localhost:2322/api?q=test  # Should return JSON
```

## AWS Deployment

Currently deployed on EC2 with:
- SQLite database with EBS persistence
- Photon running in Docker with named volume
- PM2 managing backend and scraper processes

## Database Schema

See `init.sql`:
- `events`: Main event table with all scraped fields
- `shops`: Dimension table for geocoded store locations
- `geocache`: Cache for user city searches
- `scrape_runs`: Tracks scrape history
