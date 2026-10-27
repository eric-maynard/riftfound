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
./ranking-metrics.sh validate --remote       # held-out accuracy, knob sweeps, event-tier weights
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

All read-only; `fit` is a dry run and never writes derived items. The `--file`
form reads NDJSON of `{externalId, results, roster}` objects, which is how a
complete region can be measured before the production results backfill reaches
it - partial coverage systematically *understates* connectivity, because a
missing event is a missing set of edges.

Shares its graph, model and validation code with the production rating pass
(`scraper/src/ranking/`), so the numbers in a report are the numbers the ladder
was actually built from. Design notes and the current measured values are in
[scraper/CLAUDE.md](../../scraper/CLAUDE.md).

### Re-clustering scenes (the runbook)

```bash
./scene-recluster.sh --remote                      # propose and diff; writes nothing
./scene-recluster.sh --remote --show               # print the assignment in force and stop
./scene-recluster.sh --remote --write              # accept the proposal
./scene-recluster.sh --remote --rollback --write   # restore the assignment it replaced
./scene-recluster.sh --remote --resolution 1.5     # sweep the knob (1 is the measured optimum)
./scene-recluster.sh --remote --max-moves 60       # list more of the stores that would move
./scene-recluster.sh --remote --json               # machine-readable, for an agent driving it
```

A **scene** is a Louvain community of the co-play graph, projected onto stores: a
store belongs to one scene, a scene has a ranking, an event happens at a store.
The assignment is **persisted**, read by every rating refit, and rewritten only
by this script.

**This is not a cron job and must not become one.** A partition refitted on 90%
of the same matches moves 12-18% of its labels, so a scene recomputed every
refit would reshuffle the UI's scene selector daily. Persisting it is what makes
a store's scene stable; running this script is what makes it change.

#### When to re-cluster

Good reasons, roughly in order of how often they come up:

- **The data has materially grown.** A new region has filled in, or the results
  backfill has reached a month it had nothing for. Scene boundaries drawn on 10%
  coverage are not wrong so much as premature.
- **A set rotation or a new event tier has changed who plays whom.** The
  measurement that motivated this design showed the partition is partly a
  property of the window's event mix: deleting the prerelease tier moved
  community ARI to 0.54. A real change in the mix is a real change in the
  scenes.
- **Someone reports a store in the wrong scene**, and `--show` plus
  `./ranking-metrics.sh venues --remote` confirm its purity is low.

Bad reasons: a modularity number you would like to be higher, a quiet week, or
tidiness. Every re-clustering spends reader trust in the scene labels.

#### What to look at before accepting

The script prints a diff and then a verdict. **Read the diff, not the
modularity** - a partition can have excellent modularity and still rename every
scene, which is the only failure a reader actually notices.

| what | where | accept when |
|---|---|---|
| **venue churn** | "venues that would move" | under ~10%. The CLI warns over 10% and says STOP over 25% |
| **scene ids carried over** | "scene ids carried over" vs the live scene count | at least 70%. Ids are carried by venue-set Jaccard (>= 0.5), so a low rate means the scenes were redrawn and any saved link to a scene breaks |
| **the moved list** | highest purity first | the movers are boundary stores, not whole cities. A store moving at **high** purity means the clustering genuinely changed its mind, which is the row to understand before accepting |
| **median venue purity** | "median venue purity A -> B" | stays high. 99.3% was measured on a complete region; "a store belongs to one scene" is only honest while this holds |
| **stores per scene** | the "stores per scene" row | **3 or more**. A scene pools several stores - that is what makes it a scene rather than a venue. The CLI says STOP below 3, ahead of every other gate, because it is the one check a first run cannot skip |
| **modularity** | the proposed line | above ~0.3, the level the literature treats as real community structure. Below that there is no scene structure to publish - usually too little coverage. **Very high** modularity (>0.95) alongside a low stores-per-scene is the same symptom, not reassurance |
| **resolution** | the proposed line | the same as last time, unless you mean to change it. gamma = 1 is the measured stability optimum (12.1% churn, against 19.7% at 0.5 and 21.8% at 2), so churn from a knob change is self-inflicted |

#### What a bad result looks like

- **Churn over 25% with most ids retired.** This is a re-partition, not a
  refresh. The usual cause is a large new event tier entering the window, or a
  resolution change. Re-run at the default resolution before accepting anything.
- **Modularity under 0.3.** The graph has no density structure to find yet.
  Expected at low coverage: the chronological coverage table in
  scraper/CLAUDE.md shows what partial coverage does.
- **Median purity falling sharply.** Stores are being split across scenes, so
  the one-store-one-scene claim is weakening. Worth understanding before it
  reaches a store page.
- **A single scene swallowing most venues.** Compare "proposed" against the live
  line. A largest community of 11-17% was invariant across every coverage level
  measured; one at 60% means something is wrong with the graph, not with the
  scenes.
- **Hundreds of scenes with two stores each.** The failure the first production
  dry run actually hit: 2,149 venues clustered into 1,042 scenes at modularity
  0.9844, against a complete region's 390 venues in 51 communities at 0.83. The
  results backfill had not captured the cross-venue edges that join stores into
  a scene. Wait for coverage; a fragmented graph produces *more* communities and
  *higher* modularity, so both reassuring-looking numbers move the wrong way.

#### Accepting, and rolling back

Writing an assignment changes **nothing a reader sees, immediately**. The scene
fields on the stored items are rewritten by the next rating refit (up to
`RANKING_REFIT_INTERVAL_HOURS`, default 24). So the order is: write, read the
diff once more, and let the refit pick it up.

Rollback is one command:

```bash
./scene-recluster.sh --remote --rollback --write
```

Each write keeps the assignment it replaced, **one level deep**, so there is
exactly one undo. Roll back before running another re-clustering if you are not
sure - a second write replaces the stored predecessor and the first assignment
is gone.

If an assignment is ever unreadable, the refit logs it and publishes null scenes
rather than failing: the ladder is unaffected and the fix is to re-cluster.

#### Driving this from an agent

A prompt that covers the whole procedure, including the stop conditions and the
rollback, is in
[prompts/recluster-scenes.md](prompts/recluster-scenes.md). `--json` emits the
proposal, the diff and the verdict notes as one object, so an agent can apply
the gates above without parsing tables.

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
