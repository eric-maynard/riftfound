# Riftfound

Event calendar aggregator for Riftbound TCG events, scraped from https://locator.riftbound.uvsgames.com/

## Architecture

```
riftfound/
├── backend/     # Express.js API (Lambda + API Gateway)
├── frontend/    # React + Vite calendar UI (S3 + CloudFront)
├── scraper/     # Event scraper (Lambda + EventBridge)
└── infrastructure/  # Terraform, Docker for local dev
```

**Production Stack:**
- Frontend: S3 + CloudFront
- Backend API: Lambda + API Gateway
- Scraper: Lambda + EventBridge (hourly)
- Database: DynamoDB
- Geocoding: Google Maps API

## Quick Start

```bash
./dev.sh                    # SQLite mode, no geocoding
./dev.sh --docker           # PostgreSQL only
./dev.sh --docker --photon  # PostgreSQL + Photon geocoder (first run downloads ~8GB)
```

## Key Design Decisions

- **Database**: SQLite for dev, DynamoDB for production. Controlled by `DB_TYPE` env var.
- **Geocoding**: Google Maps API (primary) with public Photon fallback.
- **Shops table**: Stores geocoded locations to avoid re-geocoding. Events reference shops via `shop_id`.
- **Calendar mode**: API returns all events in 3-month window without pagination when `calendarMode=true`.
- **Distance filtering**: Haversine formula. Frontend uses miles, backend uses km internally.

## Default Behavior

- Calendar defaults to San Francisco, CA with 25mi radius
- Tries browser geolocation on load, falls back to SF if denied
- Scraper runs every 60 minutes via EventBridge

## Environment Variables

Key vars (see `.env.example` for full list):
- `DB_TYPE`: `sqlite`, `postgres`, or `dynamodb`
- `GOOGLE_MAPS_API_KEY`: Required for production geocoding

## Deployment

Production runs on AWS serverless: S3/CloudFront for frontend, Lambda for backend and scraper, DynamoDB for data.

### Setup (first time)

```bash
cp deploy.env.example deploy.env
# Edit deploy.env with your AWS values

cd infrastructure/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars, set use_dynamodb = true
export TF_VAR_google_maps_api_key="your-key"
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

# Geocoding metrics (cache vs Google API usage)
./geocode-metrics.sh --remote # Analyze from PM2 logs

# Interactive analysis
jupyter notebook metrics.ipynb
```

Key metrics tracked:
- **Traffic**: unique visitors, page views, event clicks, location searches
- **Database**: events/shops added per day, distribution by type/state
- **Geocoding**: cache hit rate, Google API calls (forward/reverse/autocomplete), error rates
