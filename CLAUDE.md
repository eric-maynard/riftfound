# Riftfound

Event calendar aggregator for Riftbound TCG events, scraped from two sources and merged:

- **UVS Games** store locator API (https://locator.riftbound.uvsgames.com/)
- **Riot's official playriftbound event API** (https://events.playriftbound.com/)

See [scraper/CLAUDE.md](scraper/CLAUDE.md) for how the two sources are fetched and de-duplicated.

## Architecture

```
riftfound/
├── backend/     # Express.js API (Lambda + API Gateway)
├── frontend/    # React + Vite calendar UI (S3 + CloudFront)
├── scraper/     # Event scraper (Lambda + EventBridge)
└── infrastructure/  # Terraform, Docker for local dev
```

**Production Stack (Serverless):**
- Frontend: S3 + CloudFront
- Backend API: Lambda + API Gateway (via CloudFront)
- Scraper: Lambda + EventBridge (hourly)
- Database: DynamoDB
- Geocoding: Mapbox Geocoding API v6

## Quick Start

```bash
./dev.sh                    # SQLite mode, no geocoding
./dev.sh --docker           # PostgreSQL only
./dev.sh --docker --photon  # PostgreSQL + Photon geocoder (first run downloads ~8GB)
```

## Key Design Decisions

- **Database**: SQLite for dev, DynamoDB for production. Controlled by `DB_TYPE` env var.
- **Geocoding**: Mapbox API (primary) with public Photon fallback.
- **Shops table**: Stores geocoded locations to avoid re-geocoding. Events reference shops via `shop_id`.
- **Calendar mode**: API returns all events in 3-month window without pagination when `calendarMode=true`.
- **Distance filtering**: Haversine formula. Frontend uses miles, backend uses km internally.
- **Two event sources**: UVS Games (one global query, paginated) plus Riot's playriftbound API
  (persisted GraphQL query; it clamps its distance filter to ~161km, so it is swept from many
  anchor coordinates seeded by the UVS pass, in rotating batches). Matched on a location+time
  de-duplication key, guarded by a price+category check, then **field-merged** so Riot's
  authoritative event type and registration URL land on the incumbent UVS row.
- **Sanitisation**: every free-text field from either source is stripped of HTML before it
  reaches the database (`scraper/src/sanitize.ts`).

## Default Behavior

- Calendar defaults to San Francisco, CA with 25mi radius
- Tries browser geolocation on load, falls back to SF if denied
- Scraper runs every 60 minutes via EventBridge

## Environment Variables

Key vars (see `.env.example` for full list):
- `DB_TYPE`: `sqlite`, `postgres`, or `dynamodb`
- `MAPBOX_ACCESS_TOKEN`: Required for production geocoding (public token with default scopes)
- `PLAYRIFTBOUND_ENABLED`: Enable Riot's playriftbound event source (default: `true`)
- `PLAYRIFTBOUND_REQUEST_DELAY_MS`: Polite rate limit for playriftbound (default: `1000`)
- `PLAYRIFTBOUND_QUERY_HASH`: Manual override for Riot's persisted query hash (normally self-healing)

## Deployment

Production runs on AWS serverless: S3/CloudFront for frontend, Lambda for backend and scraper, DynamoDB for data.

### Setup (first time)

```bash
cp deploy.env.example deploy.env
# Edit deploy.env with your AWS values

cd infrastructure/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars, set use_dynamodb = true
export TF_VAR_mapbox_access_token="pk.your-token"
terraform init
terraform apply
```

### Deploy Commands

```bash
./deploy.sh frontend       # Build React app, upload to S3, invalidate CloudFront
./deploy.sh backend-lambda # Deploy backend API to Lambda
./deploy.sh scraper-lambda # Deploy scraper to Lambda
./deploy.sh lambdas        # Deploy both backend and scraper to Lambda
```

### Lambda Logs

```bash
# Scraper logs
aws logs tail /aws/lambda/riftfound-scraper-prod --region us-west-2 --follow

# API logs
aws logs tail /aws/lambda/riftfound-api-prod --region us-west-2 --follow

# Test scraper manually
aws lambda invoke --function-name riftfound-scraper-prod --invocation-type Event /tmp/out.json
```

### Infrastructure

Terraform config in `infrastructure/terraform/`. To modify infrastructure:

```bash
cd infrastructure/terraform
terraform plan
terraform apply
```

## Metrics

Site analytics and database stats are in `scripts/metrics/`. See the [Metrics README](scripts/metrics/README.md) for full docs.

```bash
cd scripts/metrics

# Traffic metrics (CloudFront logs)
./download-logs.sh 30         # Download last 30 days of logs
./analyze-logs.sh week        # Quick summary
python analyze-logs.py        # Detailed analysis

# Database metrics (shops/events)
./db-metrics.sh --remote      # Production stats

# Geocoding metrics (cache vs Mapbox API usage)
./geocode-metrics.sh --remote # Analyze from CloudWatch logs

# Interactive analysis
jupyter notebook metrics.ipynb
```

Key metrics tracked:
- **Traffic**: unique visitors, page views, event clicks, location searches
- **Database**: events/shops added per day, distribution by type/state
- **Geocoding**: cache hit rate, Mapbox API calls (forward/reverse/autocomplete), error rates
