# Scraper

TypeScript scraper for Riftbound events. Two sources are merged into one event set:

1. **UVS Games API** (`src/api.ts`) - the store locator behind https://locator.riftbound.uvsgames.com/
2. **playriftbound API** (`src/sources/playriftbound.ts`) - Riot's official event search

## Structure

```
src/
├── index.ts                    # Entry point, runs distributed scrape loop + second source
├── lambda.ts                   # Lambda entry point: coordinator, UVS shard workers, playriftbound pass
├── config.ts                   # Zod-validated env config
├── database.ts                 # DB operations for events, shops, scrape_runs
├── dedupe.ts                   # Cross-source de-duplication key + match guard
├── merge.ts                    # Field-merge policy for matched cross-source pairs
├── sanitize.ts                 # Free-text sanitisation for everything written to the DB
├── api.ts                      # UVS Games API client (source 1)
└── sources/playriftbound.ts    # Riot playriftbound API client (source 2)
```

## How It Works

The scraper uses the UVS Games API with a **distributed scraping** approach:

1. **Get count** (`api.ts`): Single API call to get total event count and calculate pages needed
2. **Distributed fetching**: Spreads ~31 page requests evenly across the 60-minute cycle (~105s between requests)
3. **Upsert events** (`database.ts`): Inserts/updates events with coordinates from API
4. **Upsert stores**: Store info (with coordinates) embedded in each event response

The API's offset pagination is not stable across a run: a measured 607 of 40,433
rows (1.5%) were the *same* event id returned on more than one page. Every run
therefore tracks the ids it has already handled (`eventIdsSeen` +
`markEventSeen`) and skips repeats instead of upserting them twice; the count is
reported in the run summary (`Duplicate event ids skipped`).

This approach prevents burst traffic and maintains consistent, gentle load on the upstream API.

## API Endpoint

```
https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2/events/
  ?start_date_after=<today>
  &start_date_before=<today+90days>
  &display_status=upcoming
  &latitude=0&longitude=0
  &num_miles=20000
  &upcoming_only=true
  &game_slug=riftbound
  &page=1
  &page_size=1000
```

Only fetches events within 90 days to match the calendar display range.

Returns JSON with:
- Event details (name, description, date/time, format, price, capacity)
- Coordinates (latitude, longitude)
- Full store info (name, address, coordinates, website, email)

## Second Source: playriftbound (`src/sources/playriftbound.ts`)

Riot's own event search. Locally (`index.ts`) it runs once at the end of each
cycle after the UVS pass. In production see "Lambda layout" below.
It adds authoritative event types (straight from Riot's `tournamentType` enum
rather than inferred from the event name) and real registration URLs, which the
UVS source does not provide.

```
GET https://events.playriftbound.com/api/gql
  ?variables={"sport":"rb","first":100,"filter":{"rb":{"coords":{...},"distanceMeters":120000}},"sortBy":{"rb":"DATE"}}
  &extensions={"persistedQuery":{"version":1,"sha256Hash":"<hash>"}}
Headers: apollo-require-preflight, apollographql-client-name, apollographql-client-version
```

Three constraints shape this client:

### 1. Anchor-based coverage (there is no global query)

Every search is anchored on a coordinate, the distance filter is enforced server
side, and - this is the important part - **the server silently clamps the radius
to ~161km (100 miles)**. Asking for `distanceMeters: 5000000` around San
Francisco returns 428 events, the farthest of them 159km away, with
`hasNextPage: false`; a query from Chicago with the same 5,000km radius returns a
completely disjoint set of midwest events. A whole-world request (lat 0 / lon 0,
40,000km) returns zero edges. There is no equivalent of the UVS source's
`num_miles=20000` global query.

Coverage therefore comes from many anchors rather than a few:

- Anchors are derived from the coordinates the **UVS pass just collected**, one
  per geohash-3 cell (`anchorsFromCoordinates`). Precision-3 cells are ~156km
  square, so a query from the cell centre (at most ~110km from any corner) covers
  the whole cell - and coverage automatically tracks wherever Riftbound is
  actually played instead of a hand-maintained city list.
- `SEED_ANCHORS` (~48 global metros) is only a fallback for when no coordinates
  are available.
- Real data currently spans **1,000+ cells**, which is far more than is polite to
  query in one cycle, so each run sweeps a window of
  `PLAYRIFTBOUND_MAX_ANCHORS_PER_RUN` anchors (`selectAnchorBatch`) that slides
  with the wall clock and wraps once a day. Using clock *position* rather than a
  run counter means no persisted state is needed (each production run is a fresh
  Lambda invocation) and the schedule can change without opening coverage gaps:
  as long as runs-per-day x anchors-per-run >= total anchors, consecutive windows
  overlap. The production 2-hourly schedule gives 12 x 150 = 1,800 anchor-slots a
  day for ~1,000 anchors.

Pagination uses `after: <pageInfo.endCursor>` while `pageInfo.hasNextPage`.
Results are date-ordered, so paging for an anchor stops once a page runs past the
90-day calendar horizon. Anchors that return nothing are normal.

### 2. Persisted query hash self-heal

The API only accepts persisted queries (`PERSISTED_QUERY_ID_REQUIRED` otherwise),
and the `sha256Hash` for `CompeteTournamentSearch` rotates on every Riot deploy.
The scraper ships with a known-good hash and, on `PERSISTED_QUERY_NOT_IN_LIST`:

1. Re-reads Riot's public persisted-query manifest chunk and regex-extracts the
   current id for `CompeteTournamentSearch`.
2. If that chunk filename has itself rotated (404), fetches the events page HTML,
   collects the `_next/static/chunks/*.js` URLs it references, and probes them
   (plus chunk names referenced from inside them, which is where the webpack
   runtime names the lazily-loaded manifest chunk).
3. Caches the new hash for the process lifetime, retries once, and logs loudly.

If no hash can be resolved the source logs an error and returns zero events -
the UVS source still completes. `PLAYRIFTBOUND_QUERY_HASH` can pin a hash
manually as an escape hatch.

### 3. Polite rate limiting

This is Riot's production API and riftfound is a guest on it. Every request is
spaced by `PLAYRIFTBOUND_REQUEST_DELAY_MS` (default 1000ms, ~1 req/sec) with a
longer pause between anchors, and the rotating batch caps a run at ~150 anchors
(each anchor costs a 2s inter-anchor pause plus 1s per extra page, so ~6-8 minutes
for 150 anchors). In Lambda the pass also takes a `deadline` and stops early
rather than eating the invocation's time budget; unswept anchors simply roll over
to the next run.

## Lambda layout (production)

EventBridge (`rate(2 hours)`) invokes the **coordinator**, which reads the UVS
page count and async-invokes the same function as:

- N **UVS workers** (`mode: 'worker'`, `SCRAPER_PAGES_PER_SHARD` /
  `SCRAPER_MAX_SHARDS`), each upserting one page range. No worker sees the whole
  feed, so none of them can seed anchors or build the de-dupe index.
- one **playriftbound pass** (`mode: 'playriftbound'`, DynamoDB only), with its
  own 15-minute budget. It reads the stored UVS rows back from the table (GSI1,
  one Query per day for the 90-day window) *before* the sweep to seed anchors and
  *again after* it to build the de-dupe index, by which time this cycle's UVS
  workers have normally finished. Matched pairs only `UpdateItem` the
  merge-owned attributes (`eventType`, `url`, `playerCount`, `capacity`, `price`,
  `sources`) on the UVS row; a `prb-` row that now matches a UVS row (inserted
  before its twin was known) is deleted. `PLAYRIFTBOUND_RESERVED_MS` (default
  300000) is held back from the sweep for that work.

Because the two passes are separate writers, the DynamoDB upsert keeps a merged
row merged when a UVS worker re-writes it (`preserveMergedFields` in merge.ts);
otherwise every UVS cycle would revert Riot's type/url until the anchor is next
swept.

### Cancelled events (`src/cancellations.ts`)

Neither source reports cancellations, so rows are removed when their source stops
listing them. The sharded Lambda does this per source:

- **UVS**: the coordinator writes a `SCRAPE_CYCLE` item and passes its `cycleId`
  to the workers; each worker writes the event ids its shard saw (gzipped, under
  `SCRAPE_CYCLE#<cycleId>`, 3-day TTL) and whether it paged to the end. At the
  start of each run the coordinator deletes upcoming UVS rows that none of the
  last **3 complete cycles** saw. Several cycles are required because UVS offset
  pagination drifts mid-scrape. Guards: start more than 3h away and inside the
  fetch window, created before the oldest of those cycles, and no more than
  max(500, 5%) deletions or it does nothing.
- **playriftbound**: an anchor whose pages were read to the end returns every
  event within its radius, so stored `prb-` rows within (radius - 5km) of such an
  anchor that weren't returned are deleted. Guards: start more than 3h away,
  created before the sweep, no more than max(25, 20%) of covered rows.

Rescheduled events keep their id in both sources, so the upsert simply moves them.

### Shops shared by both sources

A Riot organizer that is a store UVS already lists is attached to the UVS shop row
instead of getting its own (`src/shopMatch.ts`). Evidence, strongest first: a Riot
event of that organizer de-duplicated against a UVS event (its shop wins by vote),
else a UVS shop within 250m with a similar name, or the only UVS shop within 50m.
Resolved organizers' events are written with the UVS shop's id/name/coordinates
(the UVS shop row itself is never written by this pass), older stored events are
re-pointed, and the synthesised shop row is deleted.

## De-duplication

The two sources share no identifier, so events are matched on location + time
(`src/dedupe.ts`):

```
round(latitude, 3) | round(longitude, 3) | start time truncated to the minute
```

3 decimal places is ~110m: tight enough to keep neighbouring stores apart, loose
enough to absorb the two APIs' different geocoders. Lookups also check the eight
neighbouring cells, because a store the two APIs geocode ~20m apart can still
land either side of a rounding boundary. Measured against the live feeds in the
Bay Area, where 42 events matched, the neighbour-cell lookup reaches **98.5%
recall on provable duplicates**; the 6 remaining misses are geocode drift wider
than one cell, not different events.

### The price + category guard

Location + time alone over-merges. Of 391 pairs that matched on location and time
across the whole feed, **192 were not the same event**: overwhelmingly a store's
stale recurring UVS series sitting on top of that same store's Riot prerelease.
Concrete case - Games of Martinez, 2026-10-16T01:00Z: UVS "Thursday Nexus Nights"
($15, Nexus Night) against Riot "Radiance Pre-Rift Event" ($40, Pre-Rift).

The audit found a clean discriminator:

| | price agrees |
|---|---|
| sources agree on category | **86.9%** |
| sources disagree on category | **3.6%** |

So `looksLikeDifferentEvent` **rejects a candidate match when price *and*
category both differ**, and the two records are kept as two separate events. A
null/missing price or category on either side is *not* a difference - only two
present, conflicting values count. "Free", "Free Event" and "$0.00" are treated
as the same price.

Because a store can have several events in one cell at one minute, the index maps
a key to a *list* of UVS events and the guard picks which of them (if any) the
Riot event actually is.

### Merging matched pairs

A match is **not** a reason to throw a record away. The UVS record stays the row
of record (same `external_id`, so no duplicate row is created) and Riot's fields
are merged onto it (`src/merge.ts`):

| field | winner | why |
|---|---|---|
| `eventType` | **Riot** | real `tournamentType` enum vs UVS name-regex inference (82.8% accurate, ~27% wrong outside prerelease week). Riot's generic `Other` does not overwrite a specific UVS category. |
| `url` | **Riot** | UVS is null on every row; Riot has one on 100% |
| `playerCount` | **UVS** | Riot returns an empty `registrantCounts` for ~70% of events, so its count is null 72% of the time. Riot only fills a UVS null. |
| `description`, `imageUrl`, `endDate` | **UVS** | Riot's search API exposes none of the three |
| `capacity`, `price` | **UVS** unless null | incumbent value; avoids rewriting rows every run |
| `name`, `organizer`, `location`, address, coords, `startDate`, store | **UVS** | incumbent; churning them rewrites the whole table for no visible gain |

The merged row records its origin in a `sources` field (`uvs`,
`uvs,playriftbound`) - a column on SQLite, an attribute on DynamoDB - so where a
row came from is inspectable rather than guessable.

A UVS row can only absorb **one** Riot record per run: if a store runs two Riot
tournaments at the same minute and the same place, the first merges into the
matching UVS row and the second is inserted as its own event.

The index is built during the UVS pass only. playriftbound events are never
de-duplicated against each other - one store legitimately runs two different
tournaments at the same minute, and Riot's tournament ids already keep those
apart.

playriftbound events are stored with a `prb-` prefix on `external_id` so they can
never collide with UVS numeric ids, and their organizers are stored as shops with
a synthesised numeric `external_id` (FNV-1a hash of Riot's organizer UUID, offset
into a reserved range) unless they resolve to a UVS shop (see above).

Because anchors are swept in rotating batches, a playriftbound event missing from
one run's "seen" set is expected rather than cancelled, so `index.ts`'s whole-run
stale cleanup always excludes `prb-` events; the Lambda uses the per-anchor rule
above instead.

## Sanitisation

Both feeds are user-editable (store owners type their own event names, organizer
names and descriptions) and both used to be written to the DB verbatim. Riot's
live API currently returns 11 events whose `organizer.name` ends in
`<script src="https://…/jquery.js?v=2"></script>` - a stored-XSS payload in
production data.

`src/sanitize.ts` strips (never escapes) markup from every free-text field that
reaches the DB - `name`, `description`, `organizer`, `location`, `address`,
`city`, `state`, `country` and the store/shop name - for **both** sources:

1. script/style/iframe/object/embed/svg elements are removed *with their contents*
2. remaining tags are removed repeatedly, so `<scr<b>ipt>` cannot re-form
3. leftover angle brackets and control characters are dropped
4. whitespace is collapsed and the value trimmed

Records are cleaned and **kept**, never dropped. It is applied at the two source
converters *and* at the `upsertEventWithStore` / `upsertShopFromApi` boundary, so
no future code path can write raw text to a table.

## Environment

- `SCRAPE_INTERVAL_MINUTES`: Cycle length (default: 60). Requests distributed evenly across cycle.
- `DB_TYPE`: `sqlite` or `postgres`
- `PLAYRIFTBOUND_ENABLED`: Enable the second source (default: `true`)
- `PLAYRIFTBOUND_REQUEST_DELAY_MS`: Delay between playriftbound requests (default: `1000`)
- `PLAYRIFTBOUND_MAX_ANCHORS_PER_RUN`: Anchors swept per run (default: `150`)
- `PLAYRIFTBOUND_QUERY_HASH`: Pin the persisted query hash (optional, normally self-healing)

## Tests

```bash
npm test --workspace=scraper   # vitest
```
