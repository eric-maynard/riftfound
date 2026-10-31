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
./ranking-metrics.sh venues --remote         # per-venue aggregates + the scene assignment in force
./ranking-metrics.sh validate --remote       # held-out accuracy, knob sweeps, event-tier weights, set carry
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

`venues` prints the per-store aggregates the `VENUE#` items are built from, and
the **scene in force** for each - read from the stored assignment, never
recomputed, so the report cannot disagree with what the items say. If no
assignment exists it says so, and every venue and player item carries a null
scene until one does.

`validate` also sweeps the **event-tier weights**, and prints the match
distribution by tier first, because that is what decides whether weighting can
help: up-weighting a tier that holds 1% of the matches cannot improve a ladder,
only add variance. The shipped table is neutral; see
[scraper/CLAUDE.md](../../scraper/CLAUDE.md), "is an event tier worth a weight?".

`validate` also sweeps the **set-carry rotation widening** - how wide the prior
is when a per-era fit opens from the previous era's closing ratings instead of
the global prior. Three tables, because they are three different claims: the
held-out log loss on the rows every variant can call, the same split by how thin
the player's record in the *new* era is, and what the carry does to each era's
rated population. The shipped default is on at a rotation of 100; see
[scraper/CLAUDE.md](../../scraper/CLAUDE.md), "does carrying a rating across a
set era help?". Re-run it at the first real rotation with a gap on both sides.

All read-only; `fit` is a dry run and never writes derived items. The `--file`
form reads NDJSON of `{externalId, results, roster}` objects, which is how a
complete region can be measured before the production results backfill reaches
it - partial coverage systematically *understates* connectivity, because a
missing event is a missing set of edges.

Shares its graph, model and validation code with the production rating pass
(`scraper/src/ranking/`), so the numbers in a report are the numbers the ladder
was actually built from. Design notes and the current measured values are in
[scraper/CLAUDE.md](../../scraper/CLAUDE.md).

### Region coverage (the drawing pass's feedback loop)

```bash
./region-coverage.sh                 # local SQLite
./region-coverage.sh --remote        # production, read-only
./region-coverage.sh --remote --json # machine-readable, for an agent drawing polygons
./region-coverage.sh --remote --max-unplaced 100   # list more of the gaps
./region-coverage.sh --dir /tmp/draft-regions      # try a draft set of polygons
```

**This replaced `scene-recluster.sh`, and the replacement is the point.** A
scene used to be a clustering an operator re-ran and accepted, which meant the
runbook that used to sit here was mostly about *limiting the damage of running
it*: what churn to tolerate, how many ids had to carry, when to roll back. The
last re-clustering moved **308 of 2,518 shared venues (12.2%)**, created 474
scene ids and retired 144, so a reader's scene label changed and their
bookmarked `?scene=` link died - for no reason anybody decided.

A scene is a **hand-drawn region polygon** now, checked into the repo under
`scraper/src/ranking/regions/`, and a store's scene is a point-in-polygon test.
There is nothing to accept and nothing to roll back: a boundary moves when
somebody edits it, in a commit, with a diff. So there is no write in this
directory any more - **everything in `scripts/metrics/` is read-only.**

What there *is* instead is a coverage problem, because a drawn map covers only
what somebody has drawn. A store outside every polygon gets `sceneId: null` and
is **reported**; it is never snapped to the nearest polygon, which is how a
Mexicali store ended up filed in California. This report is how that stays
visible.

#### What it prints, and what to do about each

It validates every region file first and refuses with **every** problem listed
at once, so one run fixes a batch rather than one coordinate at a time. Then:

| section | what it means | what to do |
|---|---|---|
| **venues in no region** | busiest first, with coordinates, the store's city label, and **the scene it is filed under today** | draw the next polygon. The "filed as today" column is usually the right name for it, and a store that *has* a scene today is a reader whose bookmark is about to stop resolving - so those come first |
| **regions holding no store** | the only visible symptom of a swapped `[lat, lng]` pair that stayed inside both coordinate ranges | check the printed centre against where you meant the region to be. Or it is a polygon drawn ahead of the data, which is fine |
| **regions wider than 30km** across their own stores | not a cap - nothing clamps a drawn polygon - but a region reporting 400km is a corridor or a country | decide on purpose. 30km is the yardstick because at 30km the New York area resolves into the seven scenes a local would draw, and at 50km it starts merging across San Francisco Bay, which is a ferry |
| **regions below the play-share bar** | most of this region's players' games are against people *outside* it, so its ladder is thin | usually nothing. This is a health signal, not a gate - see below |

#### The play-share bar is not a gate any more

The measurement is unchanged (share of a region's players' matches that are
against other players in the same region, threshold 0.5) and its consequence is
not. It used to **delete** a scene below the bar: its venues came back with no
scene at all, 38 venues and 172 of 39,390 players on the live assignment. A
region is drawn by a human, so deleting one because of a match count would be
exactly the churn the polygons remove. The figure is published on the `SCENE#`
item instead (`intraShare`, `ladderMeaningful`), and the API and UI say *"this
region's ladder is not meaningful yet"* beside a region that is still named,
still pinned and still counted.

So a region in that list is **not** a region to redraw on its own. Redraw it if
the *boundary* looks wrong - two half-scenes meeting at a bridge or a border
crossing is the usual cause, and it reads as a low share plus a wide extent.

#### The format, and the four rules

In full, with the reasoning, in
[`scraper/src/ranking/regions/README.md`](../../scraper/src/ranking/regions/README.md).
The short version:

1. **`[longitude, latitude]`**, GeoJSON order, longitude first. The loader
   rejects any latitude outside [-90, 90] and says it looks swapped.
2. **`id` is hand-chosen, `r-` prefixed, lowercase-kebab, never derived from
   membership.** It is the thing that must not move.
3. **Outer ring first, holes after.** Open rings are closed by the loader.
4. **No two regions may overlap.** Sharing a border is expected and fine.

And `carriesSceneId` is the migration: set it to the `sceneId` a polygon
succeeds and **that** id is what gets published, so every stored item and every
shared link keeps resolving.

#### Driving this from an agent

`--json` emits the stats, the unplaced venues (with their current scene), the
empty regions, the wide regions and the low-play-share regions as one object, so
an agent drawing polygons can read its own feedback without parsing tables. The
loader's error output is also a list, so a batch of coordinate fixes is one
round trip.

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
| Match distribution by tier | Matches, players, and players whose *whole* record is in one tier - what a tier weight would actually act on |
| Tier weight sweep | Candidate event-tier weight tables against held-out accuracy, log loss and Brier. The gate on whether weighting a tier helps at all |
| Publishing bar | Players admitted at each (min games, max uncertainty) pair |
| Per-venue aggregates | Players, rated players, matches, events and the scene in force per store - the `VENUE#` items a map reads |

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
