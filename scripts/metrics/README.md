# Riftfound Metrics

Tools to analyze site traffic and database statistics.

## Setup

### Enable CloudFront Logging (One-Time)

CloudFront logging must be enabled in AWS. After the Terraform changes are applied:

```bash
cd infrastructure/terraform
terraform apply
```

This creates an S3 bucket for logs and enables CloudFront to write access logs there. Logs appear within a few minutes of requests.

### Add to deploy.env

Add the logs bucket name to your `deploy.env`:

```bash
# Get the bucket name
cd infrastructure/terraform
terraform output logs_bucket_name

# Add to deploy.env
echo "LOGS_BUCKET=riftfound-logs-XXXXXXXX" >> ../../deploy.env
```

## Usage

### Traffic Metrics (CloudFront Logs)

```bash
# Download logs from S3 (default: last 30 days)
./download-logs.sh
./download-logs.sh 7          # Last 7 days only

# Analyze with bash script
./analyze-logs.sh             # All downloaded logs
./analyze-logs.sh day         # Last 24 hours
./analyze-logs.sh week        # Last 7 days
./analyze-logs.sh month       # Last 30 days

# Analyze with Python (more detailed)
python analyze-logs.py                    # Table format
python analyze-logs.py --format json      # JSON output
python analyze-logs.py --days 7           # Last 7 days
python analyze-logs.py -o report.json --format json
```

### Database Metrics

```bash
# Local development database
./db-metrics.sh

# Production database (via SSH)
./db-metrics.sh --remote

# Specify time range
./db-metrics.sh --days 7
./db-metrics.sh --remote --days 14
```

### Geocoding Metrics (Google API Usage)

Analyzes geocoding cache effectiveness and Google API usage from Lambda CloudWatch logs.

```bash
# Basic geocode metrics (last 7 days)
./geocode-metrics.sh

# Specify time range
./geocode-metrics.sh --days 30

# Include places API calls per visitor ratio
# (requires CloudFront logs - run ./download-logs.sh first)
./geocode-metrics.sh --with-traffic

# Combined example
./geocode-metrics.sh --days 14 --with-traffic
```

Output includes:
- Cache hit/miss rate
- Google API calls by type (forward, reverse, autocomplete)
- Error rate
- With `--with-traffic`: Places API calls per visitor ratio

## Metrics Available

### Traffic Metrics

| Metric | Description |
|--------|-------------|
| Total requests | All HTTP requests to CloudFront |
| Unique visitors | Distinct IP addresses |
| Homepage views | Visits to `/` or `/index.html` |
| Event detail views | Visits to `/event/:id` pages |
| Unique events viewed | Number of distinct event pages accessed |
| API calls | Requests to `/api/*` endpoints |
| Calendar requests | Requests to `/api/events` (main calendar data) |
| Location searches | Geocode API calls (users searching locations) |
| Daily traffic | Requests and unique visitors per day |
| Top pages | Most visited URLs |
| Edge locations | CloudFront edge servers (indicates user geography) |

### Database Metrics

| Metric | Description |
|--------|-------------|
| Total events | All events in database |
| Total shops | All geocoded shop locations |
| Events added per day | New events discovered by scraper |
| Shops added per day | New shops discovered |
| Events by type | Breakdown by event category |
| Shops by state | Geographic distribution |
| Recent scrape runs | Last 10 scraper executions |

### Geocoding Metrics

| Metric | Description |
|--------|-------------|
| Cache hits/misses | Geocode cache effectiveness |
| Cache hit rate | Percentage of lookups served from cache |
| Google forward geocode | Address-to-coordinates API calls |
| Google reverse geocode | Coordinates-to-address API calls |
| Google autocomplete | Places API calls for location suggestions |
| Places API per visitor | Google Places calls divided by unique visitors |
| API calls per search | Percentage of location searches hitting Google API |

## Tracking Store Visit Clicks

To track when users click "Visit" to go to a store's registration page, you can add a redirect endpoint. This logs the click in CloudFront before redirecting:

```typescript
// In backend/src/routes/events.ts
router.get('/:id/visit', async (req, res) => {
  const event = await eventService.getById(req.params.id);
  if (event?.url) {
    res.redirect(event.url);
  } else {
    res.status(404).json({ error: 'Event not found' });
  }
});
```

Then in the frontend, link to `/api/events/:id/visit` instead of directly to the external URL. The click will appear in CloudFront logs.

## Log Retention

- CloudFront logs are automatically deleted after **90 days** (configured in Terraform)
- Downloaded logs in `./logs/` are not auto-deleted - clean up manually as needed

## Troubleshooting

### "No logs found"

1. Check that logging is enabled: `terraform output logs_bucket_name`
2. Logs appear a few minutes after requests - wait and retry
3. Verify AWS credentials: `aws sts get-caller-identity`

### "LOGS_BUCKET not set"

Either:
1. Add `LOGS_BUCKET=bucket-name` to `deploy.env`
2. Or run from a directory where `terraform output` works

### SSH connection failed (--remote)

Check `deploy.env` has correct values:
- `EC2_HOST` - Server IP or hostname
- `SSH_KEY_PATH` - Path to SSH private key
- `EC2_USER` - Username (default: `ec2-user`)
