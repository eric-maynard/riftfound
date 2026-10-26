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

### Player Rating Metrics (Co-play Graph & Accuracy)

Measures the structure the ratings are built on, and how well they predict. Run
`connectivity` before trusting any number the ranking UI shows: in a
paired-comparison model, ratings are only identified up to a constant *per
connected component*, so if play is clustered a global ladder is not meaningful.

```bash
./ranking-metrics.sh connectivity --remote   # measure the co-play graph
./ranking-metrics.sh communities --remote    # Louvain communities vs connected components
./ranking-metrics.sh venues --remote         # per-venue aggregates (what a map view needs)
./ranking-metrics.sh validate --remote       # held-out accuracy vs Riot's tiebreakers
./ranking-metrics.sh bar --remote            # how many players clear each publishing bar
./ranking-metrics.sh fit --remote            # dry-run refit summary (writes nothing)
./ranking-metrics.sh all --remote            # everything

./ranking-metrics.sh connectivity            # local SQLite (dev)
./ranking-metrics.sh all --file sample.ndjson  # a captured regional sample
./ranking-metrics.sh validate --holdout-days 10
```

`communities` answers the follow-on question - a connected component is not a
*scene*, since one travelling player welds two cities into one component, so it
runs Louvain modularity maximisation over the same graph weighted by matches
played and reports the size distribution, the modularity, the agreement with
geography, how the partition moves as coverage grows and how much the labels
churn on a subsample. Nothing it computes is published: `componentId` still
means a connected component. `--resolution` and `--metro-radius-km` tune it.

All read-only; `fit` is a dry run and never writes derived items. The `--file`
form reads NDJSON of `{externalId, results, roster}` objects, which is how a
complete region can be measured before the production results backfill reaches
it - partial coverage systematically *understates* connectivity, because a
missing event is a missing set of edges.

Shares its graph, model and validation code with the production rating pass
(`scraper/src/ranking/`), so the numbers in a report are the numbers the ladder
was actually built from. Design notes and the current measured values are in
[scraper/CLAUDE.md](../../scraper/CLAUDE.md).

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

### Player Rating Metrics

| Metric | Description |
|--------|-------------|
| Giant component share | Fraction of rated players who are mutually reachable through play. The number that decides whether a global ladder means anything. |
| Component size distribution | How the rest of the player pool fragments |
| Multi-venue players | Players who played at more than one venue, and at how many |
| Venue graph components | Venues linked when a player played at both |
| Cross-venue matches by `tournamentType` | Which kinds of event supply the bridging edges |
| Leave-one-type-out | Giant-component share after deleting a whole event tier - the falsifiable form of "the tier ladder connects the scenes" |
| Matches per player | Percentiles, and how many players clear each game count |
| Held-out accuracy / log loss / Brier | The model against Riot's own tiebreakers, an experience baseline and a coin flip, on a temporal split |
| Prior SD sweep | Held-out log loss by prior strength - how the prior was chosen |
| Observation level sweep | Match vs per-game weighting, compared out of sample |
| Games per match by type | How much per-game Bo3 detail organizers actually record. Strongly type-dependent, so any pooled figure is an artefact of the window's event mix. |
| Pooled vs per-type fit | Whether one rating across sealed (Pre-Rift) and constructed (Nexus Night / Summoner Skirmish) events costs accuracy - i.e. whether `format` is worth a rating dimension |
| Publishing bar | Players admitted at each (min games, max uncertainty) pair |

Every type-keyed number from this feed depends on its window: `tournamentType`
composition swings hard between prerelease fortnights and normal months, so pass
an explicit `--days` and say which window a figure came from.

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
