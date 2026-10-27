# Scraper

TypeScript scraper for Riftbound events. Two sources are merged into one event set:

1. **UVS Games API** (`src/api.ts`) - the store locator behind https://locator.riftbound.uvsgames.com/
2. **playriftbound API** (`src/sources/playriftbound.ts`) - Riot's official event search

A third pass (`src/sources/playriftboundResults.ts`) adds **tournament facts** -
who registered for a Riot event and what happened in it - for events the first
two passes have already stored. It is not a discovery sweep.

A fourth pass (`src/ranking/`) derives **player ratings** from those facts. It
scrapes nothing: it replays the stored history, fits one model over all of it,
and writes the items the ranking API and UI read.

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
├── sources/playriftbound.ts    # Riot playriftbound API client (source 2)
├── sources/playriftboundResults.ts  # Rosters + results for stored Riot events (pass 3)
└── ranking/                    # Player ratings derived from those facts (pass 4)
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
The scraper ships with a known-good hash (`868030f6…`, read out of Riot's live
manifest and verified on 2026-10-25) and, on `PERSISTED_QUERY_NOT_IN_LIST`,
rediscovers it, caches it for the process lifetime, retries once and logs loudly.

**Everything in the chain is named after a content hash, so nothing can be
hardcoded.** Discovery is therefore a crawl, in this order:

1. A manifest chunk filename *this process* already found (one request). Only
   populated after a successful discovery, so it is a name we have seen live.
2. **The live crawl.** Fetch the events page HTML, read the
   `_next/static/chunks/*.js` names it references in document order, and probe
   them. A chunk name found *inside* a probed chunk but absent from the page is a
   lazily-loaded chunk, and is **unshifted to the front of the queue** - the
   manifest is always one of those. A chunk is the manifest when it contains
   Apollo's `"format":"apollo-persisted-query-manifest"` payload; the id is
   regex-extracted from its `{"id":"<64 hex>","name":"CompeteTournamentSearch"}`
   entry.
3. Long shot: the chunk filename measured when `playriftbound.ts` was last
   updated (`3ljhtmeypccge.js`). Tried only when the crawl could not start at
   all, because this name is guaranteed to rot.

Measured on Riot's 2026-10-25 build:

| | |
|---|---|
| chunks the events page references | **36** |
| of those that hold the manifest | **0** - it is lazily loaded and never named in the HTML |
| only pointer to it | a Turbopack loader call inside `1x7ey3ub0c35t.js` (11th in document order): `e.v(t=>Promise.all(["static/chunks/3ljhtmeypccge.js"].map(t=>e.l(t)))…)` |
| chunk names reachable but *not* in the HTML | **2** - which is why lazy names jump the queue |
| probes needed to reach the manifest | **12** of a 60 budget (plain FIFO cost 31) |
| manifest chunk | 149,859 bytes, 165 operations |
| hashes in the HTML itself | none - no 64-hex id, no `persistedQuery`, not even the operation name |

The previous design read a hardcoded manifest chunk URL first
(`00kyxx5y6b23i.js`, verified 2026-09-15). By 2026-10-25 it was serving **HTTP
404 with a 9-byte body**, so step 1 was dead and the self-heal was one Riot
deploy away from silently failing. Expect any filename in this class to rotate;
the crawl is the path that survives.

Retired ids stay in Riot's allow-list for a while - the hash shipped on
2026-09-15 still answered HTTP 200 on 2026-10-25 - so a stale hash degrades
*late*. That is precisely why the discovery path has to be kept alive: by the
time the API starts rejecting the hash, discovery has usually been broken for
weeks.

If no hash can be resolved the source logs an error and returns zero events -
the UVS source still completes. `PLAYRIFTBOUND_QUERY_HASH` can pin a hash
manually as an escape hatch, and skips discovery entirely.

#### The document shape rotates too

A new hash is a new *document*, not just a new id. Riot's 2026-10 build moved the
event address from `organizer.physicalAddress` to
`tournament.tournamentLocation`. Since `convertTournamentNode` drops any node
without coordinates, that rename alone would have made a successful
rediscovery return **zero events, silently**. The parser now accepts either
field (`tournamentLocation ?? physicalAddress`). Over 25 events returned by both
documents the two fields agreed to within 1m on all 25, and `tournamentLocation`
was non-null on 100/100 events, so the swap is safe for de-duplication.

When bumping the hash, diff the node shape against what
`convertTournamentNode` reads - not just that the query returns HTTP 200.

### 3. Polite rate limiting

This is Riot's production API and riftfound is a guest on it. Every request is
spaced by `PLAYRIFTBOUND_REQUEST_DELAY_MS` (default 1000ms, ~1 req/sec) with a
longer pause between anchors, and the rotating batch caps a run at ~150 anchors
(each anchor costs a 2s inter-anchor pause plus 1s per extra page, so ~6-8 minutes
for 150 anchors). In Lambda the pass also takes a `deadline` and stops early
rather than eating the invocation's time budget; unswept anchors simply roll over
to the next run.

### Riot's `tournamentType` enum, in full

Read out of Riot's web bundle on 2026-10-26, from chunk `0zmnko3-hmh1v.js`
(787,431 bytes, 9th of the 36 chunks the events page references), which carries
the generated TypeScript enum verbatim. **Eleven values:**

| tier group | values |
|---|---|
| local | `LEARN_TO_PLAY` `NEXUS_NIGHT` `OPEN_PLAY` `PRE_RIFT` |
| premier | `SUMMONER_SKIRMISH` |
| competitive | `NEXUS_CUP` `CHALLENGE_SERIES` `SHOWDOWN_SERIES` `REGIONAL` `CONTINENTAL` `WORLD_CHAMPIONSHIP` |

Three things worth knowing:

- **There is no `RC` and no `RQ`.** The championship and qualifier tiers are
  spelled `WORLD_CHAMPIONSHIP`, `CONTINENTAL` and `REGIONAL`, with the three
  series tiers between those and `SUMMONER_SKIRMISH`. A weighting table keyed on
  invented literals would match nothing and look like it was working.
- **Riot's own filter UI exposes only five of the eleven**, grouped exactly as
  "Local" and "Premier" above. The six competitive tiers are in the schema and
  not yet filterable - consistent with no such event having been scheduled.
- **The same object literal holds the format enum**: `CONSTRUCTED`,
  `LIMITED_DRAFT`, `LIMITED_SEALED`, with a separate game-format enum
  (`ONE_V_ONE`, `TWO_V_TWO`) in the filter options. That is the vocabulary
  `playFormat` is stored in, verbatim.

How it was found, which is the part that will need repeating: the enum is **not**
in the persisted-query manifest (that holds operation documents, not schema
types). It is in a page chunk, so the route is the same crawl the hash
self-heal uses - fetch the events page, read the `static/chunks/*.js` names it
references, probe them and grep for `NEXUS_NIGHT`. One chunk of 36 held it.
Riot's *server-rendered page* also carries the filter's `eventTypeOptions` array
with the five user-visible values and their labels, which is a cheaper check and
a smaller answer.

#### `mapEventType` now maps all eleven, and that moves some rows

Until 2026-10-26 it mapped three and **everything else collapsed into `Other`**,
which made a casual Open Play indistinguishable from a World Championship in our
own data - and therefore made any tier-keyed rating weight impossible to
express. All eleven are now mapped, with Riot's own labels except that
`NEXUS_NIGHT` keeps the singular `Nexus Night` this codebase and the frontend
filter have always used.

Two of the previously-unmapped values are in the feed **today**: one live query
each from San Francisco and New York returned 200 upcoming events as
`NEXUS_NIGHT` 188, `OPEN_PLAY` 9, `LEARN_TO_PLAY` 3.

What moves, counted over the 47,179 stored `prb-` events in a -59/+90 day window
on 2026-10-26:

| stored `eventType` | all | already past |
|---|---|---|
| Nexus Night | 21,883 | 8,325 |
| Pre-Rift | 12,204 | 12,187 |
| Summoner Skirmish | 11,600 | 0 |
| **Other** | **1,492** | **787** |

So **up to 1,492 rows (3.2%) change label**, and the live sample says they are
overwhelmingly Open Play and Learn to Play - *casual* tiers below Nexus Night,
not championships. Three consequences to be explicit about, since this field is
read outside the scraper:

1. **The calendar's event-type chips change for those rows.** They stop reading
   `Other` and start reading `Open Play` / `Learn to Play`. The frontend's
   "Format" filter matches on `eventType`, so new labels behave the way `Other`
   does today rather than appearing as filter options - nothing breaks, nothing
   new is selectable until the frontend adds them.
2. **Only upcoming rows pick it up.** `hasEventChanged` includes `eventType`, so
   an upcoming row acquires the new label on the next anchor sweep. The 787 rows
   whose event has already happened keep `Other` **permanently**, for the same
   reason `playFormat` cannot be backfilled: the search API is upcoming-only.
3. **`mergeEventType` now overwrites more UVS categories.** Its rule is "Riot's
   enum wins unless Riot said `Other`", and a Riot event that used to say `Other`
   now says `Open Play`, so it will win where it previously deferred to the UVS
   name-inferred category. That is the intended direction - the UVS inference is
   82.8% accurate and Riot's is an enum - but it is a behaviour change, not a
   no-op.

An unrecognised value still falls through to `Other`, and must: the enum
demonstrably grows, and no record is ever dropped for carrying a value we do not
know.

### The event format is captured here or nowhere

Riot's `RiftboundTournamentConfig.format` (`CONSTRUCTED`, `SEALED`, …) is stored
as **`playFormat`** in TypeScript and **`play_format`** in SQL, set only by this
source. The UVS feed has an `event_format` string of its own, but `api.ts` has
never read it, so no UVS record carries a format and there is nothing to merge
against - Riot's value simply wins.

**Why not just `format`.** The frontend already ships a user-facing "Format"
filter, and that filter actually filters `eventType` (All / Constructed / Sealed
/ Draft / Multiplayer). A bare `format` in our schema would therefore collide
with an established label that means something else, which is a real bug waiting
to be written. `playFormat` is Riot's field and nothing else.

**Stored raw.** The upstream value goes in verbatim - not normalised to title
case, not mapped onto `eventType`'s vocabulary. It is an enum, and the one thing
this document can demonstrate about Riot's enums is that they change (see "the
correction" under the rating pass), so readers map it and the scraper does not.

**It is prospective-only, permanently.** This matters more than the field does:

- `CompeteTournamentSearch` is **upcoming-only**, so it will never return a past
  event and cannot be replayed for one.
- The event detail page the third pass reads has **no format field at all** - the
  `CompeteTournament` object was checked directly and carries no format, rules or
  deck field.

So the search sweep is the only surface that ever sees it, and only while the
event is still in the future. **Every event that happened before this field
shipped has no format and never will** - roughly 90,000 rows. Null is the normal
value, not a failure: nothing may treat it as an error and nothing may drop a
record for lacking one. The window closes daily, which is the whole reason the
field is captured now even though nothing consumes it yet (the rating pass
measured that *pooling* formats beats splitting them - see "is `format` worth a
rating dimension?").

Mechanically it is threaded exactly where `sources` is: sanitised at the
converter *and* the storage boundary, carried on `EventFactContext` so the
rosters and results inherit it, Riot-owned in `merge.ts` (so a UVS re-write
cannot blank it - `preserveMergedFields`), and part of `hasEventChanged`, which
is what lets rows already in the table acquire it on the next sweep instead of
never.

## Third pass: tournament rosters and results (`src/sources/playriftboundResults.ts`)

Riot publishes, per event, who signed up for it and - once it has been played -
the standings, the pairings and the per-game outcomes. This pass collects both as
**immutable, timestamped facts keyed on Riot's stable player UUID**, so that a
later rating pass can replay the whole history from scratch and get the same
answer however the formula changes. Nothing here stores a derived rating.

Locally (`index.ts`) it runs at the end of each cycle, after the other two
sources. In production it is its own Lambda invocation (see "Lambda layout").

### Which rows are results candidates

A stored event is a candidate when a **Riot tournament id can be derived from
it**, which is two row shapes, not one:

1. a `prb-` `external_id` - a Riot event the UVS feed never duplicated. The id
   is the prefix stripped.
2. any row whose `url` is a Riot event page - which is what a **merged** row
   looks like. The id is parsed out of the URL.

`resultsCandidateTournamentId` (in `sources/playriftbound.ts`, beside the
converter that writes those URLs) is the single test, and both backends' loaders
call it: `loadEventFactCandidatesDynamoDB` over the day partitions, and the
SQLite query, where the `LIKE` on the URL is only a pre-filter.

**The second shape was missing, and it was the largest gap in this pipeline.**
Selecting on the `prb-` prefix alone - which is what the loader did until
2026-10-27 - made every merged event *structurally invisible* to this pass. The
merge keeps the UVS record as the row of record (same `external_id`, see
"Merging matched pairs"), so a matched event has a numeric UVS id and no prefix
to match on; it was never a candidate, so it was never queued, so it could never
have results. Measured against production on 2026-10-27, lookback 45:

| | before | now |
|---|---|---|
| candidates in the window | 22,852 | **26,904** |
| of those, merged rows | 0 | **4,052** |
| merged rows with any capture already | - | **0** - the proof that none was ever queued |
| **results-due** | 15,928 | **19,352** (+3,424) |
| roster-due | 141 | **314** (+173) |

At the 71% of finished events that hold real pairings (see "An empty capture is
a fact"), 3,424 newly-queued results are worth roughly **2,400 events with
standings** - projected on that rate, not yet observed, since the queue has not
reached them. The investigation that found this gap put steady-state trophy
coverage on a fully-backfilled window at 22.8% today against ~34.7% with these
rows, a ~52% relative increase and the largest single win available in this
pipeline. The 173 extra rosters are the better half per row: a *dated* roster
only exists on an **upcoming** event's page, so those were hours from being
unrecoverable rather than merely uncaptured.

**Why `url` is the route.** `url` is Riot-owned in the merge policy (UVS has no
event URL on any row; Riot has one on 100%), so Riot's event page URL survives
on the merged row - it is the one Riot-derived identifier that does. Verified
rather than assumed, on one day partition (`DATE#2026-10-18`, 2,977 stored rows):
62 rows were merged and **62 of 62** carried a
`https://playriftbound.com/en-us/events/<id>` URL, while all 389 UVS-only rows
carried **no URL at all**. So a parseable URL and a merged row are the same set
today, and a UVS-only row cannot sneak in.

**The parser is a URL parse, not a regex** (`tournamentIdFromEventUrl`). It
tolerates what legitimately varies - the scheme, `www.`, the locale segment and
its case (this converter writes `en-us`, the user-facing links elsewhere in the
repo use `en-US`), a trailing slash, a query string, a fragment - and rejects a
hostname that merely *contains* `playriftbound.com`, which is the failure a loose
regex would ship: `playriftbound.com.evil.test` passes any `includes` or
`endsWith` test. Hosts are compared exactly against a two-entry allow-list after
a leading `www.` is dropped, the path must be `/events/<id>` with at most one
locale segment in front, and the id must be a run of digits.

**What the derived id does *not* change is the key the capture is written
under.** `RESULTS#`/`ROSTER#` are still built from the event row's own
`external_id`, so a merged event's facts land under its **UVS** id. That is
deliberate and it is what makes the whole thing work end to end: the calendar
and the backend's `tournament-availability` BatchGet ask about the event ids they
already hold, which for a merged event *is* the UVS id, so the capture is where
the reader looks. The Riot id travels on the fact's `tournamentId` attribute -
which is where the API reads it for the "view on playriftbound" link, falling
back to the prefix-strip only for a fact written before that attribute existed.
Nothing downstream of the loader can tell a URL-derived candidate from a
`prb-` one.

### Why page HTML and not GraphQL

Both facts are embedded, public and unauthenticated, in the Next.js RSC flight
payload of the event detail page:

```
GET https://playriftbound.com/en-US/events/<tournamentId>
```

`<tournamentId>` is the id the candidate loader derived - our `external_id` with
the `prb-` prefix stripped, or, for a merged row, the id parsed out of its `url`
(see "Which rows are results candidates"). The JSON
arrives `\"`-escaped inside a `self.__next_f.push([1,"…"])` script, so the
payload is read back out with `JSON.parse` of the string literal (which also
handles `\\`, `\n` and `\uXXXX` - a naive replace of `\"` corrupts those). The
payload as a whole is not JSON, so the `CompeteTournament` object and the
`TournamentRegistrant` arrays are located by marker and brace-matched out of it.

There is **no bulk endpoint**: `CompeteTournamentSearch` is upcoming-only and
its selection set carries neither results nor registrants, so one GET per
tournament is the only route. A ~5KB JSON route does exist -
`GetCompeteTournamentForRiftboundPlayer` - but the detail page is server
rendered, so its persisted query id never passes through the browser and we do
not have the hash. The upside of reading the page instead is that this pass
needs **no persisted query hash at all**, and therefore has no dependency on the
self-heal in `playriftbound.ts`.

Decklists are not available: all 164 GraphQL operations and 122 fragments in
Riot's bundle were extracted, and the only deck surface is the
`deckSubmissionPolicy` config enum plus error codes. Do not build for them.

### Two fetches per event, ever

This is the whole reason the pass is cheap, and it rests on two properties of
the data:

- **Every registrant carries its own `acceptedTermsAt`.** One snapshot therefore
  reconstructs the entire signup curve retroactively, so registrations are never
  polled. (Polling the ~14,700 currently-upcoming `prb-` events would be ~4
  hours of continuous requests to Riot per sweep.)
- **Results are immutable** once the organizer finalises the rounds.

So each event gets:

1. a **roster** fetch inside `ROSTER_LEAD_MS` (24h) of its start - late enough
   that the field is nearly final, early enough that the page still shows
   registrants rather than pairings - and
2. a **results** fetch `RESULTS_SETTLE_MS` (6h) after its start.

That is ~700 fetches/day globally, ~12 minutes at 1 req/sec. Measured cost per
page: 80KB gzipped, ~0.8s, 210KB median uncompressed (226KB when there are
results). A 16-player / 3-round event normalises to well under 10KB.

Anything already captured is never fetched again. The one exception is the
`MAX_ATTEMPTS` rule: an event whose last round was still live when we looked is
stored as `partial` and re-checked once, `RESULTS_RECHECK_AFTER_MS` (24h) later,
after which the partial capture is accepted as-is. A roster already on file is
never replaced - a dated registrant list cannot be reconstructed afterwards, so
a post-event capture only fills a roster we never took.

### How far back the backfill can reach

The pass works **oldest-first**, so the window it looks through decides what is
recoverable at all: an event that ages out before the queue reaches it is lost
for good. `PLAYRIFTBOUND_RESULTS_LOOKBACK_DAYS` was **21** and is now **45**.
Three limits stack, and all three were measured against production on
2026-10-26 rather than reasoned about:

| limit | measurement | binds when |
|---|---|---|
| **event-row retention** | `DATE#` partitions hold rows back to 2026-08-28 (**-59d**) and **zero** at -60d and earlier - `deleteOldEvents(60)` runs every coordinator cycle, and a results capture needs an event row as its candidate | always; this is the hard ceiling |
| **when `prb-` rows start existing** | **2026-10-01** (227 rows). The whole of September holds **4** rows (09-25, 09-26, 09-28) and nothing before 09-25 | today; this is the binding limit |
| **Riot still serving the page** | 5 of 6 spot-checked 2026-09-25..10-03 pages returned HTTP 200 carrying the `esportsTournamentId` marker, 3 of them with `FINALIZED` rounds. The sixth 500s on every attempt - a broken event, not an age effect, since another event the same day is fine | not yet |

The honest headline: **raising the lookback does not recover the Vendetta era.**
Vendetta ran 2026-07-31..10-23, and this scraper's first `prb-` event row is
2026-10-01, because `CompeteTournamentSearch` is upcoming-only - it will never
return an event that had already happened. Most of that set's play was over
before we were looking, and no lookback, retention policy or backfill reaches
it. A store showing 5 Vendetta players is showing the truth about our data.

What the change does recover, measured with `loadEventFactCandidates` against
production:

| lookback | candidates | results-due | candidate load |
|---|---|---|---|
| **21** (before) | 21,426 | 15,208 | 27.5s |
| **26** | 22,842 | **16,383** | 26.4s |
| **45** (now) | 22,846 | 16,387 | 29.7s |
| 58 | 22,846 | 16,387 | 28.9s |

So the entire recoverable gain is the step from 21 to 26 days: **1,179 events**
that were about to become unreachable. The receipts are specific - 2026-10-01..03
held 983 `prb-` events and **0** results captures, because they fell out of a
21-day window while the queue was still working through 10-09. Everything past
26 days is worth 4 events, because the history does not go back further.

45 is therefore chosen for **headroom, not for today's data**: it reaches
everything that exists, stays 14 days inside the measured 59-day retention
floor, costs ~3s of extra candidate load out of an ~840s budget
(900s Lambda timeout less `PLAYRIFTBOUND_RESULTS_RESERVED_MS`), and needs no
further change as the history lengthens over the next two months. From roughly
2026-12-10 the retention ceiling becomes the binding limit instead, and 45 will
start clipping about a fortnight of recoverable history - at which point the
queue will long since have drained, so the window only matters for recovering
from an outage.

#### The queue, and how long it takes to drain

Measured on production 2026-10-27, at lookback 45, **with merged rows
included** (see "Which rows are results candidates" - adding them is the reason
this table moved):

| | |
|---|---|
| candidates in the window | **26,904** (22,852 `prb-` + 4,052 merged) |
| already have a results capture | 5,567 - all of them `prb-` |
| **results-due** | **19,352** (15,928 `prb-` + 3,424 merged) |
| roster-due (upcoming, inside `ROSTER_LEAD_MS`) | 314 (141 + 173) |
| page slots per day | 500/run x 12 runs/day (`rate(2 hours)`) = **6,000** |
| new work arriving per day | ~1,370: ~1,200 as before, plus ~86 merged events/day x 2 fetches |
| **net drain** | ~4,630/day |

**So about 4.3 days, and 4.5-5 with re-checks and failures** - up from the 3.5-4
days the `prb-`-only queue read, which is the cost of the +3,424 and is paid
once. 500 per run fits the budget on measurement rather than hope: a 250-item run
used 376s (1.5s per page - 0.8s fetch plus the 1s politeness delay), so 500 is
~750s plus ~37s of candidate loading against the 840s available.

**The new candidates interleave; they do not jump the queue.** Worth checking
rather than assuming, because `selectDueEventFacts` is strictly oldest-first on
the event's start time and an injection at the head would stall the existing
backfill. Measured, results-due in run-sized slices of 500:

| run | dates covered | merged share |
|---|---|---|
| 1-4 | 2026-10-01..10-08 | 274, 149, 249, 357 of 500 |
| 5-6 | 2026-10-08..10-15 | **499, 500** of 500 |
| 7 | 10-15..10-16 | 101 of 500 |
| 8-14 | 10-16..10-17 | 6-18 of 500 |

Merged rows are spread across the whole window, 49-235 per day, because they are
events like any other - and only **70 of 3,424** are strictly older than the
oldest `prb-` row still due, so almost nothing is inserted *ahead* of the
backlog. Runs 5 and 6 read as near-total takeovers and are the opposite: on
2026-10-08..10-15 the `prb-` queue is **already drained** (0 due), so the merged
rows are filling a hole rather than displacing anything. The real delay to the
existing backlog is the 2,049 merged rows dated before 2026-10-16, where its
bulk sits: **about 4 runs, ~8 hours**, once.

Two things that keep the per-run cap honest as the lookback grows. The candidate
load is one Query per UTC day plus a `BatchGetItem` of two fact keys per
candidate (~53,800 keys at this volume, up from ~45,700 with merged rows
included, in serial 100-key chunks), so it scales with the window and is now
~37s of the 840s. And `batchGetFactMeta` retries
`UnprocessedKeys` four times: a `RESULTS#` item can be 300KB, so a chunk can
come back heavily deferred, and a key dropped after four attempts reads as "not
captured" and costs one wasted re-fetch. Neither is new, but both get bigger
with the window, so they are the things to watch if the drain stalls.

#### Rosters are a different story, and worse

Raising the lookback recovers **results**. It does **not** recover rosters, and
the difference is not a detail:

- A **dated** roster - every registrant with their own `acceptedTermsAt`, which
  is what reconstructs a signup curve retroactively - exists only on the page of
  an event that has **not yet started**. All six old event pages fetched in the
  spot-check above contained **zero** occurrences of `acceptedTermsAt`: a played
  event's page shows pairings, not registrants.
- What a late capture gets instead is `normalizeRosterFromResults`, the
  `source: 'participants'` fallback: who was in the field, with their
  `esportsTeamId`, and `registeredAt: null`. Enough to know who played; nothing
  about when they signed up, and nothing at all for the 29% of finished events
  whose organizer never ran pairings.
- 4,698 of the 22,846 candidates (20.6%) have a roster on file. The rest will
  only ever have the thin version, or none.

So the recovery is asymmetric by construction, and the roster half of the window
closes daily whatever the lookback is.

### An empty capture is a fact, not an error

**71% of finished events have real results** (17 of 24 sampled). The other 29%
are listing-only: the organizer never ran pairings through Riot's software. Those
are recorded with `status: 'none'` precisely so they stop being fetched. An
upcoming event nobody has signed up for likewise simply has no registrants.

Because of that, a page that *cannot* be read must never be mistaken for one
with nothing in it, or a bad minute at Riot would permanently blank an event.
Three guards keep those apart, and all three throw rather than return empty:

1. the response must contain `</html>` (a short read does not),
2. the payload must contain `"esportsTournamentId":"<the id we asked for>"`,
   which every real event page carries whether or not it has results, and
3. if a `CompeteTournament` or registrant marker is present but its value never
   closes, the payload was truncated mid-object.

A failure records nothing, so the event stays due and is retried next run.

### Round status decides finality, not match status

Riot's tournament software routinely leaves matches reading `IN_PROGRESS` inside
a round it has `FINALIZED` - **21 of 22 matches** in one verified event, all 23
in another - while that round's standings are complete and correct. Gating
`final` on match status would mark almost every event `partial` and double the
fetches for no new data, so `status` is decided by round status alone.
`openMatches` is still stored, as a data-quality signal rather than a gate.

### Storage shape: one item per event per fact

`event_results` / `event_rosters` on SQLite; `RESULTS#<externalId>` and
`ROSTER#<externalId>` items on DynamoDB. One row per event per fact, **not** one
per match or per standing, because:

- "the results for this event" is a single `GetItem`. Split per match it would be
  a Query plus client-side reassembly, with the standings stitched back together
  from their own rows.
- "every match in chronological order", which a rating pass replaying history
  needs, is one Query per day against GSI1's `RESULTS#<date>` partition (and
  `ROSTER#<date>` for the rosters) - no scan, no new index, and each day comes
  back as ~350 whole events rather than ~8,000 fragments.
- a capture is written once and never edited, so the usual argument for row-level
  items (updating one match without rewriting the event) never applies.

DynamoDB's 400KB item limit is the one risk; `trimToItemLimit` drops the pairings
from an outsized tournament and sets `trimmed`. These items carry **no TTL**:
event rows age out after 60-90 days, but the facts are the input to a rating
history and have to outlive them. GSI1 projects ALL, so a fact is stored twice -
a few cents a month at this volume, and it buys the chronological read with no
infrastructure change.

Each fact denormalises the event context a rating pass needs - start time,
`eventType`, `playFormat`, shop id and coordinates - exactly because the event
row it came from will be gone. `playFormat` is on the fact for a specific reason:
the detail page a fact is built from has no format field, so copying it off the
event row is the only way a rating pass could ever see one. It is null on every
fact for an event discovered before the field shipped.

Change detection follows the same discipline as `hasEventChanged`: a `digest`
(sha256 of the capture's content, metadata excluded) is stored with the row, and
a re-check that reads back the same content writes only the attempt counter and
the timestamp (`UpdateItem` on DynamoDB, a two-column `UPDATE` on SQLite) instead
of rewriting the row.

### Identity, and the bye player

`player.id` is a stable Riot UUID and is the identity key for everything
downstream. `displayName` and `tagLine` are user-editable presentation data and
will churn, so nothing is ever keyed on them. `esportsTeamId` is the
per-tournament join key from a player to their standings row and match outcomes
(in 1v1 Constructed a "team" is one player).

Riot synthesises the empty half of a bye pairing as `bye-`-prefixed match, team
and player ids, with `displayName: "BYE"`. Every id is checked against that
prefix on the way in, so the bye player can never become a rated player, and
bye matches are flagged `bye: true` so a rating pass can skip them.

### Privacy

**This pass stores personal data, in a public repository's schema.** Recorded,
per named individual:

- **attendance**: that a person registered for a specific event at a specific
  venue, and the minute they signed up (`acceptedTermsAt`);
- **match history**: who they played, who won, the per-game outcomes, their
  final rank and Swiss record.

All of it is already public on Riot's own event pages. The rules this pass holds
itself to:

- **store only what results and ratings need.** Riot's registrant row carries
  more than we keep.
- **`displayName` and `tagLine` are sanitised** through `sanitize.ts`
  (`sanitizeEventResults` / `sanitizeEventRoster`) at the converter *and* at the
  `saveEventResults` / `saveEventRoster` boundary, like every other free-text
  field - see "Sanitisation".
- **nothing player-identifying is logged.** The pass logs counts only; not a
  name, not a player id, not even an event name.
- **exposure is no longer hypothetical.** The fourth pass (`src/ranking/`)
  derives a **public skill ladder of named individuals** from these rows, and
  the backend API and the ranking UI read it. What that publishes is covered
  below; the facts themselves still never leave the table.
- **retention is open-ended**, which is a deliberate consequence of wanting a
  replayable rating history and the one point here worth revisiting: unlike the
  event rows, these facts are never aged out.

### Privacy of the derived ratings

The rating pass widens the exposure, so the posture has to be stated for it too.

What it publishes, per named individual: a rating and its uncertainty, a rating
*curve over time*, win/loss/draw totals, a home region, the venues they play at,
and a **complete match log** - every opponent, every result, every game, every
event, with coordinates and dates.

- **Nothing here is new information.** All of it is already public on Riot's own
  event pages: the display name, the tag line, the pairings, the standings. The
  pass aggregates and ranks it; it does not uncover it.
- **Aggregation is still a change in kind.** "Their results are on Riot's site"
  and "they are 412th in California with a searchable 18-month match history"
  are different exposures even when the underlying facts are identical. That is
  a product decision, not a technical one, and it is being made here explicitly
  rather than by accident.
- **Identity is Riot's UUID.** Display names and tag lines are mutable
  presentation data, carried for rendering and never keyed on, so a player who
  renames themselves is renamed everywhere on the next refit.
- **Both are sanitised** through `sanitize.ts` at the converter *and* at the
  `saveRankingSnapshot` boundary, like every other free-text field.
- **Nothing player-identifying is logged.** The pass logs counts only - no
  player id, no display name, no event name, not even in an error path.
- **Retention is open-ended here too, and more consequentially.** The facts are
  an archive; the ratings are a *published* archive. There is currently no
  mechanism to age a rating out, to drop a player who stopped playing, or to
  honour a removal request - a deleted profile would simply be rebuilt by the
  next refit from the facts behind it. **This is the unresolved item.** If
  opt-out is ever needed, the place for it is a suppression list consulted in
  `snapshot.ts`, so that the facts stay intact and replayable while the derived
  items for that UUID are never emitted.

## Fourth pass: player ratings (`src/ranking/`)

The first three passes store facts. This one derives a **public skill ladder**
from them: it replays every stored match, fits one model over the whole history,
and writes the items the ranking API and UI read. It stores no facts of its own
and can be re-run from scratch at any time.

```
src/ranking/
├── sets.ts          # curated, source-cited set boundaries -> rating scopes
├── observations.ts  # stored results -> paired comparisons (flat typed arrays)
├── graph.ts         # the co-play graph: components, bridging, the measurements
├── communities.ts   # Louvain communities on the same graph - measurement
├── scenes.ts        # venue -> scene, persisted between deliberate re-clusterings
├── recluster.ts     # the re-clustering CLI: propose, diff, write only when told
├── whr.ts           # the model: Whole-History Rating with a global prior
├── validate.ts      # held-out accuracy against Riot's own tiebreakers
├── snapshot.ts      # fit -> the derived items, and the publishing bar
├── pass.ts          # replay, fit, write; the Lambda's `ranking` mode
└── report.ts        # CLI behind scripts/metrics/ranking-metrics.sh
```

### Why plain Elo is the wrong answer here

In any paired-comparison model, ratings are identified only up to an additive
constant **per connected component** of the co-play graph. Two local scenes that
never play each other have independently floating scales, so "1600" in one and
"1600" in the other have no common meaning.

Sequential Elo is worse than merely silent about this. It is zero-sum inside a
closed pool, so a cluster's mean stays pinned near its members' seed values
however strong they really are. Run it on disconnected local scenes and it
reports that every scene is exactly average - with no uncertainty attached, and
no way to tell that answer apart from a measured one. That is a wrong answer
dressed as a real one, and avoiding it is the reason for everything below.

So connectivity is **measured first** and published as a data-quality signal
rather than assumed away.

### Measured: the graph is far more connected than expected

Measured on a **complete regional sample** - every finished playriftbound event
in California, 2026-10-01..24. All 1,282 of them fetched at the polite rate,
1,015 of which held real results (79%, consistent with the 71% measured for pass
3). A complete *region* rather than a random sample of events, because random
sampling destroys exactly the structure being measured.

| | |
|---|---|
| events with usable results | **1,011** |
| matches (byes excluded) | **26,102** |
| recorded games | **29,175** |
| players with at least one match | **7,732** |
| venues | **390** |
| **components** | **29** |
| **giant component** | **7,531 players = 97.4%** |
| components smaller than 8 players | 22, holding 62 players (**0.80%**) |
| of which components of exactly 2 | 17 (a single pairing at an isolated venue) |
| players who played at more than one venue | **2,994 = 38.7%** |
| median venues per player | 1 (p75 = 2, p90 = 3) |
| venue graph | 390 venues, **12** components, giant **373 = 95.6%** |
| cross-venue matches | **11,914 of 26,102 = 45.6%** |
| median matches per player | **5** (p25 = 3, p90 = 14) |
| players with 10+ matches | **21.4%** |

**The giant component dominates, so a global ladder is not meaningless** - 97.4%
of players with any match are mutually reachable, and the non-giant remainder is
29 components holding 201 players between them, 17 of which are a single pairing.
That is the one assumption in the brief the data overturned in the *favourable*
direction. It is still not published as a global *ranking*: see "Publishing
honestly" below.

Worth noting how the measurement moved as the sample filled in: at 40% coverage
the giant share read 83.2% and multi-venue players 25.1%. Partial coverage
**systematically understates** connectivity, because a missing event is a missing
set of edges. So treat any connectivity number from an incomplete window as a
lower bound - which is exactly the situation the production backfill is in right
now (as of writing it has 7 events with results, and reads 28.3%).

**And treat this one as seasonal.** The window is Radiance's prerelease
fortnight: 2026-10-01..14 contained *zero* Pre-Rift events and 2026-10-15..22
contained 11,865 of them, so 83% of the sample's matches come from one weekend
of unusually well-attended, unusually cross-venue events. The leave-one-type-out
test below shows that removing them costs 31 points of giant share. **97.4% is
very likely the annual high-water mark, not the normal state.** Re-measure over a
month with no prerelease in it before the global board's default status is
treated as settled.

### Measured: the tier ladder is load-bearing

**Everything in this section is scoped to 2026-10-01..24, which is Radiance's
prerelease peak.** That window is not representative of the feed, and reading it
as if it were produced a wrong answer once already - see the correction below.
Re-run `./ranking-metrics.sh connectivity --remote` after the backfill reaches a
normal month before treating any share here as typical.

The hypothesis was that the event tier ladder (Nexus Night -> Summoner Skirmish
-> Pre-Rift) supplies the cross-venue edges. **Confirmed.**

Within the sample window, cross-venue bridging by type:

| type | matches (sample) | cross-venue | share of all cross-venue | cross-venue rate | venue pairs only it supplies |
|---|---|---|---|---|---|
| Pre-Rift | 21,708 | 10,174 | **85.4%** | 46.9% | **1,897** |
| Nexus Night | 4,301 | 1,692 | 14.2% | 39.3% | 147 |
| Other | 93 | 48 | 0.4% | 51.6% | 7 |

Pre-Rift supplies 85.4% of cross-venue matches. Part of that is volume - it is
83% of the matches in this window - but its cross-venue *rate* is genuinely
higher too (46.9% vs 39.3%), and it is the sole supplier of 1,897 venue pairs
against Nexus Night's 147.

And the direct falsifiable test - delete a whole tier and refit the components:

| removed | matches removed | components | giant share | delta |
|---|---|---|---|---|
| Pre-Rift | 21,708 (83%) | 63 | 66.5% | **-30.9 pp** |
| Nexus Night | 4,301 (16%) | 35 | 97.1% | -0.3 pp |
| Other | 93 | 29 | 97.4% | 0.0 pp |

This is the robust measurement, because unlike the table above it does not depend
on how "cross-venue" is defined. Removing Pre-Rift more than doubles the
component count and costs 31 points of giant share; removing Nexus Night costs
**0.3**. Per match removed, Pre-Rift is **~20x more load-bearing** (0.0014
pp/match vs 0.00007).

#### The correction: "there is no Summoner Skirmish" was a window artifact

An earlier version of this document claimed Riot's `tournamentType` takes only
three values and that Summoner Skirmish does not exist in the feed. **That was
wrong**, and the way it was wrong is worth keeping on record because the same
trap is still open.

`tournamentType` by date, counting stored `prb-` event rows:

| window | prb- events | composition |
|---|---|---|
| 2026-09-15..09-30 | 4 | Other 4 |
| 2026-10-01..10-14 | 4,453 | Nexus Night 4,163 · Other 290 · **Pre-Rift 0** |
| 2026-10-15..10-22 | 13,813 | **Pre-Rift 11,865** · Nexus Night 1,718 · Other 230 |
| 2026-10-23..10-25 | 2,626 | Nexus Night 2,072 · Pre-Rift 320 · Other 234 |
| 2026-10-26..11-08 | 5,200 | Nexus Night 4,855 · Other 307 · **Summoner Skirmish 24** · Pre-Rift 14 |
| 2026-11-09..11-30 | 10,372 | **Summoner Skirmish 5,558** · Nexus Night 4,580 · Other 234 |
| 2026-12-01..12-31 | 7,548 | **Summoner Skirmish 4,518** · Nexus Night 2,932 · Other 98 |

Summoner Skirmish is the Radiance-era competitive tier and **every one of its
events is scheduled for November onward**. The sample window contained zero of
them because none had been scheduled yet, not because the tier does not exist.
Reading "0 in my window" as "0 in the feed" was the error.

This also resolves an apparent contradiction between two counts of the *same*
field. A query of upcoming events returns Summoner Skirmish 10,571 and Pre-Rift
8; the table above reports Pre-Rift 12,185 for 2026-10-01..24. Both are
`eventType`, both are right: **the windows are disjoint.** The first looks
forward from today across the 90-day calendar, where Radiance-era Summoner
Skirmish dominates and the prerelease is spent; the second looks back over the
prerelease fortnight, where Pre-Rift was essentially all of it. Any type-keyed
number from this feed is meaningless without its window.

The practical consequences:

- **Nothing about Summoner Skirmish is measurable yet.** Results only exist for
  events that have finished, and the earliest Summoner Skirmish events are in
  November. There is no substitute window; the honest answer is to wait.
- **Radiance-era results amount to two days.** Radiance went legal 2026-10-23
  and the sample ends 10-24, so the post-street-date slice is 127 events and
  2,393 matches. (With prerelease events attributed to the set they preview -
  see below - the Radiance *era* is much larger, but it is still prerelease play,
  not Summoner Skirmish play.)
- **The bridging result will change.** Once Summoner Skirmish is the dominant
  tier, the leave-one-out test should be re-run; the expectation is that it
  takes over Pre-Rift's structural role, but that is a prediction, not a
  measurement.

#### What to re-run once the backfill completes

In order of how much the answer is expected to move:

1. `./ranking-metrics.sh connectivity --remote` over a month with no prerelease
   in it. The 97.4% giant share and the bridging table are both expected to move.
2. The games-per-match table below, by type, once Summoner Skirmish has finished
   events.
3. `./ranking-metrics.sh validate --remote`, which currently measures one region
   in one fortnight.
4. `./ranking-metrics.sh bar --remote`, to confirm the publishing bar still
   admits a sensible share when the event mix is normal.
5. `./scene-recluster.sh --remote` (dry run). Today it proposes 1,042 scenes of
   2.1 stores each and the CLI refuses it; a drained backfill should give
   something like the regional picture (7-8 stores per scene, modularity ~0.83).
6. `./ranking-metrics.sh validate --remote`'s tier-weight sweep, once any event
   above Nexus Night has finished. Today every tier above it has **zero**
   matches, so the table cannot be evaluated at all.

### Is a scene a connected component? Measured: no, but don't switch yet

`componentId` / `componentSize` / `regionLabel` are the output contract's answer
to "which scene is this player in", and the 97.4% giant share above says that
answer is already nearly vacuous: 7,531 of 7,732 players are in one component,
so a "Scene" selector built on components offers one entry containing everybody.
A single travelling player is enough to weld two cities together, because
reachability is a transitive closure and does not care how thin the link is.
`rankingCommunities.test.ts` pins that as an executable assertion: two six-player
cliques joined by **one** match are one component.

So the alternative was implemented and measured rather than argued about.
`src/ranking/communities.ts` is Louvain modularity maximisation (Blondel 2008)
over the co-play graph weighted by matches played, ~400 lines of arithmetic over
typed arrays, **no new runtime dependency** - the same posture as the hand-rolled
WHR solver. `./ranking-metrics.sh communities` is the report. **Nothing it
computes is published**: no item, key or attribute reads it, and `componentId`
still means a connected component.

#### What the communities look like

Complete California sample, resolution 1:

| | components (incumbent) | Louvain communities |
|---|---|---|
| partitions the 7,732 players into | **29** | **51** |
| largest holds | **97.4%** | **15.4%** (1,188 players) |
| modularity | 0.0 by construction (one blob) | **0.8299** |
| groups of >= 100 players | 1 | **14**, covering 91.5% |
| groups of >= 8 players | 7 | 29, covering 99.2% |
| compute time (7,732 nodes, 25,029 edges) | 21ms | **199ms** |

Modularity 0.83 is high - the literature treats anything above ~0.3 as real
community structure - so the dense groups are genuinely there and the giant
component is hiding them, not absorbing them.

#### Does a community correspond to a place?

Mostly yes, and the exceptions are informative. Venues were single-linked into
**metros** at 25km (46 of them) as the geographic yardstick:

| compared against | ARI | NMI | best-match disagreement |
|---|---|---|---|
| metro (25km linkage) | 0.390 | **0.761** | 43.9% |
| home venue | 0.112 | 0.671 | 80.7% |

- **A community is not a venue.** 0.11 ARI against home venue: communities pool
  several stores, which is what a scene is.
- **A community is not a metro either**, but it is close to one and clearly
  *about* geography: NMI 0.76. Of the 14 communities with >= 100 players, 11 have
  >= 95% of their members' home venues inside one metro. 19 communities span more
  than one metro, and 13 of the 46 metros are split across more than one
  community - that split is the interesting half, because it is a *real* local
  structure a map would not show: two groups of stores in the same metro whose
  players do not actually play each other.
- The exceptions are visible in the per-community rows: the largest community has
  a 133km mean venue spread (a corridor, not a city) and two of the smaller ones
  have dominant-metro purity of 38% and 34%, i.e. genuinely cross-metro circuits.

And the complementary measurement, which is what a map view would lean on: a
venue's players overwhelmingly belong to **one** community. Median share of a
venue's player-match participations in its dominant community is **99.3%**
(p10 = 76%). Venue -> community is nearly a function; community -> venue is not.

#### How the two partitions behave as coverage grows

The coverage question is the decisive one, so it is measured two ways. A missing
event is a missing set of edges, and the two realistic shapes of partial coverage
are not equivalent - events missing *at random* (optimistic: every venue keeps
some edges) and only the first X% of the window captured (what a backfill walking
the calendar produces).

Chronological coverage, which reproduces the 40% -> 83.2% data point measured
during the original sample fetch almost exactly:

| coverage | matches | components | giant share | communities | largest community | modularity |
|---|---|---|---|---|---|---|
| 10% | 1,689 | 44 | **24.9%** | 52 | 16.5% | 0.909 |
| 20% | 3,172 | 52 | **37.1%** | 63 | 13.5% | 0.902 |
| 40% | 9,924 | 44 | **82.8%** | 64 | 11.4% | 0.874 |
| 60% | 15,783 | 26 | **94.7%** | 48 | 12.7% | 0.860 |
| 80% | 21,790 | 18 | **98.1%** | 40 | 16.3% | 0.840 |
| 100% | 26,102 | 29 | **97.4%** | 51 | 15.4% | 0.830 |

Random coverage for comparison: 36.0% giant share at 10%, 92.2% at 40%, 97.4% at
100% - uniformly more optimistic than the chronological curve at the same
coverage, which is why a production number should be read against the
chronological one.

**The projection.** The giant share is saturating: the last 20 points of coverage
move it by 0.3pp (random) or -0.7pp (chronological, having already overshot to
98.1%). A complete region lands at **97-98%**, and there is no coverage level
beyond which it falls. Nationally the mechanism is the same one level up: each
contiguous travel region fills to ~97%, and interregional events then merge those
too. So the component partition's information content goes to **zero** as the
backfill completes - it is the one measurement here that is monotone in the
direction nobody wants.

Against that, **the community partition's shape is coverage-invariant**: 40-65
communities and a largest community of 11-17% across the entire range, with
modularity drifting slowly down from 0.91 to 0.83 as more cross-scene edges
appear. It answers the same question at every coverage level, which is exactly
the property a UI label needs and the property components lack.

#### Stability: the real cost

Re-run on a subsample and ask how many players would see a different scene label
(greedy best-match between the two labellings, so this is partition churn, not id
churn):

| subsample | community churn | community ARI | component churn | component ARI |
|---|---|---|---|---|
| 90% of matches, seed 1 | 17.7% | 0.747 | **0.0%** | 0.995 |
| 90% of matches, seed 2 | 13.4% | 0.799 | **0.0%** | 1.000 |
| 90% of matches, seed 3 | 12.3% | 0.757 | **0.1%** | 0.975 |
| 80% of matches, seed 4 | 13.4% | 0.776 | **0.3%** | 0.939 |

**This is the honest cost and it is not small: roughly one player in seven would
see a different scene next refit.** Restricting to players in communities of >= 100
does not help (13-18%), so it is not a small-group artifact; it is boundary
players, who genuinely play at two scenes and whose assignment is a close call.
Components are near-perfectly stable by comparison - and that stability is worth
nothing, because the thing being stably reported is "everyone".

Note what churn is *not* measured on: community **ids** are derived from the
smallest player UUID in the community, exactly as component ids are, so an id
changes whenever that one member moves. Id churn is therefore strictly worse than
partition churn. Any switch would need ids carried forward by overlap (match a
new community to last refit's by Jaccard and keep the old id above some
threshold) rather than derived from membership - which is a piece of persisted
state the ranking pass currently, deliberately, does not have.

#### Robustness to the event mix

The sample window is Radiance's prerelease fortnight and 83% of its matches are
Pre-Rift, so the partition was re-fitted with whole tiers deleted:

| removed | players left | communities | modularity | community ARI vs full | components | giant share | component ARI vs full |
|---|---|---|---|---|---|---|---|
| Nexus Night (16% of matches) | 7,369 | 54 | 0.836 | **0.783** | 35 | 97.1% | 0.954 |
| Pre-Rift (83% of matches) | 1,956 | 79 | 0.913 | **0.538** | 63 | 66.5% | **0.041** |

Deleting 83% of the matches degrades the community partition (ARI 0.54) and
*destroys* the component partition (ARI 0.041 - indistinguishable from chance),
while community modularity actually rises to 0.91. The density structure is
intrinsic; the connectivity structure is an artifact of how much data happens to
be present.

#### Cost of switching

- **Compute: negligible.** 199ms for 7,732 players and 25,029 edges, against a
  WHR fit that takes several seconds on the same data. Louvain is near-linear in
  edges, so a national graph an order of magnitude larger is a couple of seconds
  per refit. It would be recomputed every refit, like everything else.
- **Write volume: negligible.** A `COMMUNITY#<id>` catalogue item per community
  (51 at regional scale) plus two attributes on each profile and ladder row.
- **Contract: the expensive part, and it is not a rename.** `componentId` is
  doing a *statistical* job as well as a product one -
  `crossComponentUncertainty` is `sqrt(uncertainty^2 + sigma0^2/componentSize)`,
  and that formula is only correct for a connected component, because the
  floating offset it corrects for is a property of connectivity and nothing else.
  Redefining `componentId` to mean "community" would silently make that number
  wrong (every community sits *inside* the giant component, where the offset is
  already pinned to 1.7 points). So a switch is an **addition**: `communityId` /
  `communitySize` / `communityLabel` alongside the component fields, with the
  UI's "Scene" selector reading the new fields and `componentId` retained for
  scale honesty and `positionsSuppressed`.
- **One genuine bonus.** Community ladders are *more* defensible than the
  component ladders they would replace, not less: all 51 communities live inside
  one connected component, so their ratings are on one scale and a position
  inside a community board - and a comparison *between* two community boards - is
  meaningful. Today `scope=component:<id>` produces one board of 7,531 players
  and 28 near-empty ones, which as a product is nothing.
  `RANKING_MAX_COMPONENT_LADDERS` (50) would start to bind, since communities
  outnumber components.

#### Recommendation

**Components are the wrong primitive for a scene and the data says so. Do not
switch this week; switch when a label-stability mechanism exists.** Specifically:

1. **Keep `componentId` exactly as it is, permanently.** It answers "are these
   two ratings on the same scale", and nothing else can. It should stop being
   presented as a scene.
2. **Do not ship a component-based "Scene" selector.** At 97.4% giant share it
   lists one entry containing everybody, labelled by whichever venue wins the
   `displayCity` vote. That is worse than no selector, and the backfill is making
   it worse, not better. This is the actionable half and it does not need
   Louvain.
3. **Communities are the right definition when they can be *named* stably.** The
   blocker is 12-18% label churn per refit plus id churn on top; a selector whose
   entries reshuffle daily is not shippable. The fix is overlap-carried ids
   (Jaccard match against the previous refit, keep the old id above ~0.5) and a
   hysteresis rule so a boundary player does not flip on a single match. Both
   need persisted state across refits, which is a real design change to a pass
   whose whole premise is statelessness.
4. **Geography as the label, inference as the definition.** With venue ->
   community at 99.3% median purity, a community can be *named* from its
   dominant metro cheaply and reliably, which is the shape the original instinct
   described: geography becomes a label and a prior, not the definition.
5. **Re-measure after the prerelease falls out of the window.** Community ARI
   0.54 under Pre-Rift removal says the current partition is partly a property of
   one unusual fortnight. `./ranking-metrics.sh communities --remote` over a
   normal month is the gate, and it is the same gate the connectivity numbers are
   already waiting on.

The honest summary of the threshold question: **components stopped being
informative at around 60% coverage of a single region** (94.7% giant share), and
production is heading through that point, not toward it.

**All five of those recommendations are now implemented**, with the stability
mechanism recommendation 3 asked for. See the next section.

### Scenes: the persisted answer to "which store belongs to which scene"

`src/ranking/scenes.ts`. A **scene** is a Louvain community of the co-play
graph, projected onto stores and **persisted between deliberate
re-clusterings**. It exists because the section above established two things at
once: communities are the right definition of a scene, and recomputing them
every refit is unshippable.

The resolution is a product decision the measurement could not make: scenes are
re-clustered **occasionally and on purpose**, not as a by-product of a refit.
That single change turns the blocker into a non-issue - between two
re-clusterings a store's scene cannot move at all, not by a point of modularity
and not by one travelling player.

#### The model, in one line each

- **A scene belongs to the venue, not the player.** Every venue is assigned to
  the community holding the largest share of its player-match participations,
  and that share is stored as the venue's `purity`. This is honest rather than
  convenient: the median venue plays **99.3%** of its matches inside one
  community (p10 76%), so venue -> community is nearly a function.
- **A player's scene is their home venue's scene.** One hop, no new inference.
- **`componentId` is untouched, permanently.** It answers "are these two ratings
  on the same scale" and `crossComponentUncertainty` is only correct for a
  connected component. Scenes are an **addition**; redefining the component
  would silently corrupt that number. The two coexist on every item.
- **Nothing is clustered during a refit.** The rating pass reads the stored
  assignment (`loadSceneAssignment`, one `GetItem`) and joins it. A missing,
  empty or unreadable assignment yields `sceneId: null` everywhere and the
  ladder is unaffected - scenes are never invented on the fly.

#### How an id survives a re-clustering

This was the actual blocker, and it is not the partition churn: a community id
derived from its membership is renamed whenever that membership changes, so **id
churn is strictly worse than partition churn**. Ids are therefore **carried
forward from the previous assignment by Jaccard overlap**, keeping the old id
above `carryJaccard` (0.5, the threshold the stability analysis recommended).
Two proposed scenes cannot both exceed 0.5 against the same previous scene, so
the carry-over needs no tie-break rule; proposals are matched largest-first, and
a scene that matches nothing gets a fresh content-derived id rather than
inheriting a name.

**The overlap is computed on venue sets, not player sets.** A shop id is a
durable identity that outlives a season; a scene's player population turns over
continuously. Venues are the more stable signal for the thing being *named*, and
they are also what the assignment governs. Be precise about what this does and
does not inherit from the measurements above: the 12-18% figures are **player**
label churn, from the experiment that motivated this design.
`diffSceneAssignments` reports **venue** churn. They are different numbers and
are not quoted as if they were - which is why the operator path leads with the
diff rather than with a published churn target.

Labels come from geography, as recommendation 4 described: a scene is named from
the modal city label of its venues, and a carried id keeps its old label when no
venue in it is geocoded yet, so a name does not flicker to null between runs.

#### What is stored

One row, `SCENE_ASSIGNMENT`, rewritten only by an operator:

```
version, generatedAt, resolution, carryJaccard,
venues: [{ venue, shopExternalId, sceneId, purity }],
scenes: [{ sceneId, label }],
stats:  { venues, scenes, players, matches, modularity, communities, medianPurity, splitVenues },
previous: <the assignment this one replaced, one level deep>
```

Gzipped on DynamoDB, for the reason `SCRAPE_CYCLE` is: the payload scales with
the number of stores and the uncompressed JSON for a national assignment plus
one level of rollback history would run at the 400KB item limit. `previous` is
deliberately **one** level - rollback is one command, and the chain cannot grow
without bound. SQLite mirrors it as a single-row `ranking_scene_assignment`
table so `./dev.sh` and the storage tests exercise the real path.

This is **the only cross-refit state the rating pass has**, and it is read-only
from the pass's point of view. The "batch refit from scratch" premise is intact:
the refit still derives every number from the facts, and the one thing it does
not derive is the thing that must not move.

#### The two cautions, honoured

- **A capped roster, not 12,885 relationship rows.** `VENUE#` carries a
  `topPlayers` list of `RANKING_VENUE_TOP_PLAYERS` (25) entries ordered by
  matches played at that store, plus `topPlayersTruncated`. 25 covers the median
  venue's 22 players outright; the maximum is 209 and the rest is the long tail
  of one-night attendees a drill-down truncates anyway. The alternative -
  `VENUE#<id>` / `PLAYER#<id>` per pair - would be the first per-relationship
  item this pass writes, for a list nobody renders in full.
- **`venueKey`'s `geo:` fallback is never an id.** It rounds coordinates to
  ~1km, which is right for a graph node and wrong for a durable key: the id
  would move if the geocode moved. A `VENUE#` item exists only for a real
  `shopExternalId`, and an unresolved organizer stays off the map until
  `shopMatch.ts` resolves it. On the California sample this excluded nothing -
  390 of 390 venues had both a shop id and coordinates.

#### Re-clustering: the operator path

`scripts/metrics/scene-recluster.sh` (CLI: `src/ranking/recluster.ts`). Read-only
unless `--write`, and the sequence is always **cluster, diff against what is
live, print the churn and the stores that would move, then write**.

**The diff is the gate; modularity is not.** A partition can have excellent
modularity and still rename every scene, which is the one failure a reader
notices. The CLI prints a verdict with explicit stop conditions - venue churn
over 25%, under 70% of scene ids carried, modularity under 0.3, median purity
under 0.9 - and the runbook in
[scripts/metrics/README.md](../scripts/metrics/README.md) says what to look at,
what a bad result looks like and how to roll back.

The knobs carry over from the measurements above:

| knob | default | why |
|---|---|---|
| `--resolution` (`RANKING_SCENE_RESOLUTION`) | **1** | the measured stability optimum: swept against partition churn, 0.5 -> 19.7%, **1 -> 12.1%**, 2 -> 21.8% |
| `--carry-jaccard` | **0.5** | overlap-carried ids are what keep names stable; 0.5 also makes the match unambiguous |
| `--days` | 400 | the replay window, as everywhere else |

A written accepted assignment changes nothing immediately: the scene fields on
the stored items are rewritten by the **next refit**, up to
`RANKING_REFIT_INTERVAL_HOURS` later. That is a feature - the diff is reviewable
before anything a reader sees moves.

#### Measured: production is not ready to be clustered yet

The first dry run against production, 2026-10-27, 43-day replay, nothing
written:

| | |
|---|---|
| matches replayed | **56,257** |
| players | 27,318 |
| venues with a real shop id | **2,149** |
| scenes proposed | **1,042** |
| Louvain communities | 1,257 |
| **stores per scene** | **2.1** |
| modularity | **0.9844** |
| median venue purity | **100.0%** |
| venues below 60% purity | 43 |

**Do not accept that assignment, and the CLI now says so.** 2.1 stores per scene
is not a scene map: a scene is supposed to *pool* several stores - that is what
makes it a scene rather than a venue - and modularity 0.9844 next to it is the
same symptom rather than reassurance. The comparison that makes it obvious is
the complete California sample, where 390 venues gave **51** communities (7.6
venues each) at modularity 0.83.

The cause is coverage, not the method. The results backfill has reached roughly
2026-10-16 of a window that runs to today, so most of the cross-venue edges that
join stores into a scene simply have not been captured yet - the same mechanism
the chronological coverage table measures, one level up. A fragmented co-play
graph has *more* communities and *higher* modularity, so both numbers move in
the reassuring direction while the answer gets worse.

So `warnings()` gates on stores-per-scene (STOP below 3) ahead of everything
else, because it is the one check a first run cannot skip - there is no previous
assignment to compute churn against. The honest state today: **the plumbing is
in place, nothing is assigned, and every `sceneId` is null.** Re-run the dry run
once the backfill has drained (~4 days from 2026-10-26) and the national picture
should look like the regional one.


### The model: Whole-History Rating with a global prior

`src/ranking/whr.ts`. Chosen over regularized Bradley-Terry and over sequential
Elo. No new runtime dependency - it is ~200 lines of arithmetic over typed
arrays, and `package.json` gains nothing.

**Bradley-Terry likelihood.** P(A beats B) = sigmoid(r_A - r_B).

**A rating curve per player, not a number.** One rating per day played, with
consecutive days tied by a Wiener process of variance `w^2 * dt` (Coulom, 2008).
Two reasons this beats storing Elo snapshots: "rating over time" is a product
requirement and falls out natively, and the whole past curve is *revised* when
new evidence arrives - beating someone who later turns out to be strong
retroactively improves your rating at the time. An append-only Elo log cannot do
that.

**A global prior on each player's first rating,** r(t_1) ~ N(0, sigma0^2). This
is the piece that makes clustered play survivable. A component's common offset
gets posterior N(0, sigma0^2/n), so a disconnected cluster lands *at* the prior
mean with wide per-player uncertainty - an explicit "no evidence either way"
rather than a floating scale. `rankingModel.test.ts` pins this with two
disconnected round robins: both centre on the anchor to within 0.1 points, both keep
their internal order, and identical evidence in either pool yields identical
ratings.

Note the direction: a *larger* disconnected component is pinned *harder* to the
prior mean, because its offset is the average of more independent prior draws.
That is correct under an exchangeable prior, and it is why cross-component
differences are not presented as placements.

**Fitting** is Newton's method one player-block at a time. A single player's
Hessian is tridiagonal (likelihood terms diagonal, Wiener prior couples adjacent
days only), so each step is an O(T) Thomas solve, and **uncertainty is the
square root of that same matrix's inverse diagonal** - a by-product of the fit,
not a separate estimate. Steps are clamped to 2 natural units so an unbeaten
record cannot blow a block up. Convergence on the California sample
(26,102 matches, 7,732 players) takes 12-20 sweeps and a few seconds.

The uncertainty is a *lower bound*: the per-player block conditions on
opponents' ratings being known exactly. So the profile carries two numbers -
`uncertainty` for comparisons inside a component, and
`crossComponentUncertainty` = sqrt(uncertainty^2 + sigma0^2/componentSize) for
comparisons across them. For a two-player island the second collapses to the
prior SD, which is the honest statement.

### Where the scale is anchored

An unrated player sits at **1200**, not 1500. `RANKING_ELO_ORIGIN` (default
`1200`, `DEFAULT_ELO_ORIGIN` in `whr.ts`) is the whole of it.

This is a **display offset and nothing else.** The solver works in natural
(logistic) units with a prior mean of 0; everything it fits is a rating
*difference*, and the prior SD, the Wiener drift and the posterior SDs are all
widths rather than positions. So moving the anchor is an affine shift of a
relative scale and cannot change a prediction. That is a claim worth checking
rather than asserting, so it was checked three ways on the complete California
sample (1,011 events, 26,102 matches, 7,732 players):

| | 1500 | 1200 |
|---|---|---|
| held-out accuracy | 63.4% | **63.4%** |
| held-out log loss | 0.6390 | **0.6390** |
| held-out Brier | 0.2242 | **0.2242** |
| Newton sweeps to converge | 11 | **11** |
| final `maxDelta` | 7.618772469079608e-5 | **7.618772469079608e-5** |
| rated players | 2,603 | **2,603** |
| components / giant share | 29 / 97.4% | **29 / 97.4%** |

1. `./ranking-metrics.sh validate --file sample.ndjson` before and after is
   **byte-identical output**, the prior-SD sweep and the observation-level sweep
   included.
2. A full `buildSnapshot` at each anchor over the same observations: all 7,732
   profiles, all 10,366 leaderboard rows and all 16,907 rating-history points
   differ by **exactly 300.0 points** (largest deviation 1.1e-13, i.e. float
   noise), with **zero** differences in rank order, `rated`, `provisional`,
   `provisionalReason`, `gamesUntilRated`, `uncertainty`, `componentId` or
   `componentSize`.
3. `rankingModel.test.ts` now asserts against `DEFAULT_ELO_ORIGIN` rather than a
   literal, so the "two disconnected clusters both centre on the anchor" test
   proves the invariance instead of hard-coding one side of it.

**Stored numbers only move on the next refit.** Player profiles, ladder rows and
rating-history points all carry absolute ratings, and the pass does not migrate
them - it rewrites them. So between deploying this and the next refit completing
(up to `RANKING_REFIT_INTERVAL_HOURS`, default 24), the table holds 1500-anchored
values. A refit rewrites every one of them, and because the rank is in the sort
key the usual `RANK#` pruning handles the changeover; no backfill step exists or
is needed. Mixed anchors inside one snapshot are impossible - every item in a
snapshot is written from one fit, which carries one `eloOrigin`.

Why 1200 at all: it is a product choice, not a measured one. 1200 is the
new-player number in the chess and TCG idiom most Riftbound players will arrive
with, where 1500 reads as "average of a rated field". Nothing in the model
prefers either.

### Measured: the knobs

| knob | default | how it was picked |
|---|---|---|
| `RANKING_PRIOR_SIGMA_ELO` | **150** | Held-out log loss, swept: 75 -> 0.6564, 100 -> 0.6470, **150 -> 0.6404**, 200 -> 0.6449, 300 -> 0.6700, 450 -> 0.7203. A clear interior optimum, not a guess. |
| `RANKING_OBSERVATION_LEVEL` | **game-shared** | Held-out log loss, with a tie broken on not overstating confidence. See below. |
| `RANKING_WEIGHT_SCALE` | **1** | Swept; 0.7 and 1.4 are both marginally worse. |
| `RANKING_DRIFT_ELO_PER_SQRT_DAY` | **4** | **Not identifiable from current data** - held-out log loss is flat to 4 decimal places from 0.5 to 16, because the history is 25 days and the median player appears on 1-2 of them. 4 encodes ~76 points of drift per year, i.e. a metagame that moves with set rotation. Revisit when the history is longer than one set; until then this is a prior belief, not a measurement. |

### Measured: how much per-game detail actually exists

The brief expected per-game Bo3 outcomes to multiply the observations 2-3x. They
do not - but **the shortfall is a property of the event type, not of the feed**,
and an earlier version of this document got that wrong by quoting the pooled
figure. Scoped to 2026-10-01..24 and broken out properly:

| type | matches | games | games/match | 0 games | 1 | 2 | 3 |
|---|---|---|---|---|---|---|---|
| **Nexus Night** | 4,301 | 7,181 | **1.67** | 82 | 2,090 | 1,296 | 833 |
| **Pre-Rift** | 21,708 | 21,930 | **1.01** | 624 | 20,362 | 598 | 124 |
| Other | 93 | 64 | 0.69 | 29 | 64 | 0 | 0 |
| *pooled* | *26,102* | *29,175* | *1.12* | | | | |

Nexus Night is stable across sub-windows at **1.64 / 1.65 / 1.74** (10-01..14,
10-15..22, 10-23..24), and Pre-Rift at **1.01 / 0.99**. So:

- **Pre-Rift organizers record one game per match**, essentially always - 94% of
  Pre-Rift matches have exactly one recorded game. Plausibly a sealed event is
  run as single games, or the software is used only to enter the result.
- **Nexus Night organizers enter closer to a real Bo3**: 49% of its matches carry
  2 or 3 games.
- **The pooled 1.12 is a composition artifact.** It is low only because Pre-Rift
  was 83% of this window's matches. Quoting it as "the" games-per-match figure
  was the mistake; it describes a prerelease fortnight, not the game.

For planning purposes the number that matters is the one for the types that will
dominate Radiance-era play, which is Nexus Night plus Summoner Skirmish:
**~1.67 for Nexus Night, and unknown for Summoner Skirmish** until its events
have been played. Expect the pooled figure to rise toward Nexus Night's as the
prerelease falls out of the window.

#### Why `game-shared` is still the default

Three weighting levels are implemented and compared on held-out log loss:

| level | accuracy | log loss | Brier |
|---|---|---|---|
| **`game-shared`** (match weight split across its games) | **63.4%** | **0.6390** | **0.2242** |
| `game` (every recorded game is an observation) | 63.2% | 0.6404 | 0.2248 |
| `match` (margin ignored) | 63.3% | 0.6405 | 0.2247 |

The justification rests on two things, and deliberately **not** on the pooled
games-per-match figure:

1. **It wins out of sample**, albeit by 0.0015 nats across all three - a spread
   small enough that the three are honestly indistinguishable.
2. **It is the conservative choice on uncertainty.** Games inside one match share
   the players, the decks and the hour, so counting each as independent (`game`)
   understates the posterior SD by roughly 8%. Since the publishing bar is set on
   measured SD, understating it would quietly admit players who have not earned a
   rating.

Note that the independence objection gets *stronger*, not weaker, as organizer
reporting improves: at Nexus Night's 1.67 games/match there is real correlated
structure to get wrong, and at a true 2-3 there would be more. So `game-shared`
is the default that ages correctly. An earlier version of this document argued
the opposite from the pooled 1.12 - that the correlation hardly mattered - which
was the wrong argument for the right default.

A match with no recorded game winner (3.2% of them) still counts exactly once,
in every mode.

### Measured: held-out accuracy

`validate.ts`. The split is **temporal**, not random: the product question is
"does this predict the next match", and a random split leaks information
backwards through WHR's whole-history revision. Last 5 days held out, fit on
everything before:

19,227 training matches, 6,646 held-out matches, 3,708 of them between two
players the fit had seen before (10.4% cold start):

| predictor | scored | accuracy | log loss | Brier |
|---|---|---|---|---|
| **WHR (this model)** | 3,708 | **63.4%** | **0.6390** | **0.2242** |
| Riot tiebreaker (prior event GW%) | 3,708 | 58.6% | 0.7439 | 0.2612 |
| Experience (more matches played) | 3,221 | 58.1% | 0.6805 | 0.2437 |
| Coin flip | 3,708 | 50.0% | 0.6931 | 0.2500 |

**The headline number: 63.4% accuracy, log loss 0.6390, on 3,708 held-out
matches.** It beats Riot's own published tiebreakers on every metric, which is
the bar that matters - OMW%/GW%/OGW% are independent signal Riot already
computes, so a whole-history fit that could not beat "who had the better game-win
rate last time out" would not be earning its complexity. Note that Riot's
tiebreaker is *worse than a coin flip* on log loss (0.744 vs 0.693): it ranks
better than chance but is badly calibrated as a probability, which is exactly
what a tiebreaker is for and a rating is not.

Be clear about how modest this still is. Log loss 0.639 against a coin flip's
0.693 is an **7.8% improvement** over knowing nothing, and 63.4% accuracy on a
game with real variance is a weak signal honestly measured, not a strong one. It
is also measured inside one region in one fortnight. Re-run it as the history
grows: `./ranking-metrics.sh validate --remote`.

### Measured: is `format` worth a rating dimension?

Pre-Rift events are sealed/limited - you play what you opened - while Nexus Night
and Summoner Skirmish are constructed. Pooling both into one rating assumes they
measure the same ability. They might not, so it was measured rather than assumed.

**First, the plumbing constraint.** Riot returns a `format` field on its event
search API. It used to be parsed and then thrown away - 0 of 90,035 event rows
carried it - and it is now **stored, as `playFormat`** (see "The event format is
captured here or nowhere"). What has not changed is that it **cannot be
backfilled**: the search API is upcoming-only so it will not return a past event,
and the event detail page the results pass reads does not carry format at all.
So format exists only for events discovered *after* the field shipped, and for
everything before that it is gone for good. Any format-keyed analysis is
therefore limited to the prospective window, and will be for months.

So `tournamentType` is the proxy, and it is a good one here: Pre-Rift is the
sealed tier, Nexus Night and Summoner Skirmish the constructed ones.

**Second, the measurement.** For each type, a model fitted on *everything* and a
model fitted on *only that type*, scored on exactly the same held-out matches
(only matches where both fits had seen both players, so neither is credited for a
player it never met):

| type | held-out | type-only train | pooled acc | pooled loss | type-only acc | type-only loss | pooled - type |
|---|---|---|---|---|---|---|---|
| Pre-Rift | 2,709 | 15,956 | 63.5% | **0.6377** | 63.3% | 0.6403 | **-0.0026** |
| Nexus Night | 191 | 3,247 | 67.0% | **0.6158** | 64.7% | 0.6485 | **-0.0327** |

**Pooling wins on both, and wins decisively on Nexus Night.** A rating learned
mostly from sealed play predicts constructed matches *better* than a
constructed-only rating does - 0.616 against 0.649 log loss, and 67.0% against
64.7% accuracy.

**So: do not add a format dimension now.** At current data volumes splitting
ratings by format would make predictions worse.

Be precise about what this does and does not establish. The pooled fit has ~5x
the training data, so the result is confounded: it may show that sealed and
constructed skill are substantially the same quantity, or merely that **evidence
volume dominates** when the median player has 5 matches and a restricted fit
throws most of their record away. Those have different long-run implications -
the first says never split, the second says split once players have enough games
per format. Distinguishing them needs a volume-matched comparison, which this
data cannot support.

What is not confounded is the decision: today, pooling is better, by a margin far
larger than the gap between the three observation-level variants. Revisit when
Summoner Skirmish has finished events and `format` has been captured
prospectively for long enough to key on directly. The comparison is already
wired into `./ranking-metrics.sh validate`, so it is one command away.

### Measured: is an event tier worth a weight?

The request was to weight a match by the tier it was played at -
Championship > Qualifier > Skirmish > Nexus Night > everything else - on the
reasonable intuition that a result at a Championship says more about true skill
than a casual weeknight. The mechanism is implemented
(`WhrOptions.tierWeights`, `RANKING_TIER_WEIGHTS`) and **ships neutral: every
tier counts the same.** That is a measurement, not an unfinished edge.

**First, the distribution, because that decides whether weighting can help at
all.** Production facts, 40-day replay, 2026-10-26:

| tier | matches | share | players | whole record in this tier | median matches/player |
|---|---|---|---|---|---|
| Nexus Night | 31,236 | **55.5%** | 15,768 | **12,800** | 3 |
| Pre-Rift | 23,286 | **41.4%** | 13,660 | **10,728** | 3 |
| Other | 1,735 | 3.1% | 1,121 | 655 | 3 |
| *everything above Nexus Night* | **0** | **0%** | 0 | - | - |

Two numbers in that table do the work. **Zero matches exist in any tier above
Nexus Night** - no Summoner Skirmish has finished, and no competitive-tier event
has been scheduled at all - so the requested ordering is a weight on an empty
set. And **23,528 of the ~29,000 players have their entire record inside one
tier**, which a weight merely *rescales*: a rating is identified by differences,
so scaling every observation a player has cannot move their rating, only narrow
their posterior SD.

**Then the gate.** `./ranking-metrics.sh validate --remote --days 40
--holdout-days 11` sweeps candidate tables on a temporal split - 28,287 training
matches, 26,390 held out, 2,838 of them between two players the fit had seen:

| table | tiers it weights | accuracy | log loss | Brier |
|---|---|---|---|---|
| **neutral (DEFAULT)** | 0 | **59.2%** | 0.6681 | 0.2377 |
| ladder, 1.5x per tier | 2 | 58.9% | 0.6668 | 0.2371 |
| ladder, 2x per tier | 2 | 58.9% | 0.6678 | 0.2376 |
| competitive 2x / casual 0.5x | 9 | 59.2% | **0.6681** | **0.2377** |
| Pre-Rift 0.5x | 1 | 59.2% | **0.6681** | **0.2377** |

Read it carefully, because the two identical rows are the finding:

- **"competitive 2x / casual 0.5x" scores identically to neutral to four
  decimal places** - the requested shape of the table, scoring exactly as if it
  were not there, because none of the nine tiers it names exists in the data.
  That is the empirical version of the distribution table above.
- **"Pre-Rift 0.5x" is identical too**, for a subtler reason worth recording:
  the prerelease fortnight falls *inside the held-out window* here, so the
  training set is almost entirely Nexus Night and down-weighting Pre-Rift has
  almost nothing to act on.
- **The only variant that moves is one that down-weights the dominant tier, and
  it is indistinguishable from a global `weightScale` change.** "Ladder 1.5x"
  puts Nexus Night at 0.667 across a single-tier training set, and its scores
  (58.9% / 0.6668 / 0.2371) match `game-shared, scale 0.7` (59.0% / 0.6670 /
  0.2372) from the same run. So its 0.0013-nat log-loss gain is the
  already-measured `weightScale` effect, not a tier effect - and it costs 0.3pp
  of accuracy. 0.0013 nats is inside the noise band this document already
  established for the three observation levels (0.0015).

**So: do not weight tiers today.** Not because the idea is wrong - it is
plausible and the plumbing is in place - but because there is nothing yet to
weight, and the one measurable variant is a knob we already swept under a
different name.

Three failure modes the neutral default avoids, which are the reason to keep it
neutral rather than "harmless":

- **A weight narrows the posterior SD.** Up-weighting a tier is arithmetically
  "those matches happened more often", so it shrinks the uncertainty the
  publishing bar is set on. Players could clear 8 games / 120 SD on no extra
  real evidence. `rankingModel.test.ts` pins that this is what happens.
- **Rarity plus sparsity is variance, not signal.** With a median of 3-5 matches
  per player, a high weight on a rare tier lets a handful of matches dominate a
  few players' curves while most of the ladder is untouched. A noisier ladder
  looks sharper.
- **An unknown tier must not default low.** `defaultTierWeight` is 1 for the
  same reason `mapEventType` falls through to `Other`: the enum grows, and
  defaulting a new tier to a discount would silently devalue a whole tier of
  real competitive play the first time Riot ships one.

**What to re-run, and when.** The day the competitive tiers have finished
events: the same `validate` command, reading the distribution table first. The
ordering to try is the product one, and the gate is the measurement rather than
the intuition. Until then the table is in place, documented, and *untested
against real data for the tiers it was asked for* - which is exactly what it
should say.

### Publishing honestly: the bar, and what a rank means

The confidence gate lives **in the data**, on the item - `provisional`,
`provisionalReason`, `gamesUntilRated` - not in the UI, so the thresholds are
governed by the measured uncertainty distribution rather than a constant guessed
in the frontend.

Measured posterior SD against games played (prior SD 150):

| games | n | median SD | p90 SD | share at or below 120 |
|---|---|---|---|---|
| 1-2 | 855 | 130 | 139 | **0.7%** |
| 3-4 | 2,747 | 122 | 124 | 15.4% |
| 5-7 | 1,494 | 107 | 121 | 87.3% |
| 8-9 | 672 | 97 | 109 | 95.1% |
| 10-12 | 655 | 91 | 105 | 100% |
| 13-19 | 773 | 85 | 96 | 100% |
| 20+ | 536 | 73 | 84 | 100% |

The shape is the useful part: **a player with 1-2 games is statistically
indistinguishable from the prior** (median SD 130 against a prior of 150), and
the SD only falls below 120 somewhere around 5 games.

- **`RANKING_MIN_GAMES` = 8.** The binding test. At 8 games the median SD is 97
  points, 35% below the prior. Admits **33.7%** of players with any match at all
  (2,603 of 7,732) - a ladder of regulars rather than a list dominated by
  one-night attendees. (5 games would admit 50.5%, 10 would admit 25.4%.)
- **`RANKING_MAX_UNCERTAINTY_ELO` = 120.** Not a round number pulled from the
  air: it is where the game-count buckets separate cleanly, admitting 87% of
  players with 5-7 games and 0.7% of those with 1-2. It is *not* redundant with
  the game count - 4.9% of players with 8-9 games still fail it, which is the
  case a game count cannot see: eight games against the same single opponent
  carry far less information than eight against eight.
- **`RANKING_MIN_COMPONENT_SIZE` = 8.** Below this a rank is still *published*
  (the internal order is real) but `suppressPosition` is set, because "2nd of 3"
  in an isolated scene is not a placement. Costs 0.80% of the pool (62 players in
  22 components, 17 of them a single pairing).

These match the thresholds the API and UI were built against (8 / 120 / 8), which
is a coincidence worth stating rather than hiding: they were chosen there without
seeing this distribution, and the distribution happens to support them.

Below the bar the profile still exists and still carries `provisionalRating` and
the true uncertainty, so a reader can show "three more games" instead of a number
nobody should act on.

**Boards are ordered on the posterior mean, not a conservative estimate.** This
is a real choice with a real cost, visible in the live fit: the top of the
California board is a player with 12 games at 1809 +/- 98, ahead of one with 29
games at 1805 +/- 73. Ordering on `rating - k*uncertainty` (TrueSkill's
leaderboard convention) would rank the second player first and would reward
turning up. Mean ordering was kept because the contract's `rating` is the number
the UI renders and shifting the order away from it would make the displayed
rating and the position disagree - but the uncertainty is published alongside
every row precisely so a reader can see that rank 1 is the shakier of the two,
and a conservative sort is a one-line change in `snapshot.ts` if the product
wants it.

**Ranks are scoped to a component by default.** `positionsSuppressed` is set on
every cross-component board (`all`, `set:<id>`), because an ordering that spans
components is an ordering across scales that are only pinned by the prior. The
giant component's 97.4% share makes a global board *useful* - almost everyone on
it is genuinely comparable - but the 2.6% who are not would be silently
mis-ranked, so the board publishes an order and declines to call it a placement.
`RankingMeta.giantComponentShare` and every row's `componentId` /
`componentSize` travel with it, so a reader never has to take that on trust.

### Per-set ratings, and why all-time is the default

`sets.ts` holds a **curated, source-cited** set table. The point of the design is
that an unpublished boundary stays unpublished: Riot announced sets 2 (Spirit
Forged) and 3 (Unleashed) and never gave either an English street date, so there
is nothing to split 2025-10-31..2026-07-30 on. Rather than invent one, that span
is a single **era** covering sets 1-3, flagged `ambiguous`. Fill in a date and
the era splits into three - a table change, not a code change. The whole table is
overridable with `RANKING_SET_TABLE`, and a malformed override logs and falls
back rather than taking the pass down.

| set | name | English release |
|---|---|---|
| 1 | Origins | 2025-10-31 |
| 2 | Spirit Forged | *unpublished* |
| 3 | Unleashed | *unpublished* |
| 4 | Vendetta | 2026-07-31 |
| 5 | Radiance | 2026-10-23 |
| 6 | Legacy | 2027-01-29 |
| 7 | The Reckoning | 2027-04-30 |

An era's `releaseDate` stays the street date even though its membership now
includes the prerelease that precedes it. That is intentional: the date answers
"when did this set become legal", and the membership answers "which play was
with this set". The two genuinely differ by about a week.

#### A prerelease belongs to the set it previews

A prerelease is played **with** the new set - that is the whole point of one - so
Radiance's Pre-Rift weekend (2026-10-16..19) is Radiance play even though it
falls six days before the 2026-10-23 street date. Attributing it by date alone
would file it under the *outgoing* set, which is simply wrong about what was on
the table.

So `eraForEvent` moves a prerelease-tier event inside `leadDays` of a release
date forward into that set's era. Both the tier names and the window are
configurable (`RANKING_PRERELEASE_TYPES`, default `Pre-Rift`;
`RANKING_PRERELEASE_LEAD_DAYS`, default 14) - the names come from Riot's
`tournamentType` enum, and that enum demonstrably changes. Measured lead times
are short: Radiance 4-7 days, Legacy's Pre-Rift 2027-01-22..28 against a 01-29
street date, 1-7 days. 14 days is generous without reaching back far enough to
swallow the previous set's own prerelease. A Pre-Rift that runs *after* the
street date (320 of them did, 2026-10-23..25) is already in the new era by date
and is left alone.

The effect on the sample is large, and it is the difference between a usable
per-set ladder and an empty one:

| scope | rated players (by date) | rated players (prerelease attributed) |
|---|---|---|
| `set:s4` (Vendetta) | 2,327 | **460** |
| `set:s5` (Radiance) | **75** | **2,120** |

Each era is fitted **independently** on its own matches, which is right - a set
rotation is a real metagame reset - and expensive in evidence. An era with fewer
than `RANKING_MIN_SET_MATCHES` (50) matches is not fitted at all rather than
published as a page of provisional numbers. The public default scope is still
`all`: a per-set ladder is a filter over a narrower slice of each player's
record, so it is always the thinner evidence, and a set in its first weeks has
almost none.

One thing the table above does **not** mean: a healthy Radiance ladder is not the
same as a ladder of Radiance *constructed* play. All 2,120 of those rated players
earned it largely at prerelease events, which are sealed. Summoner Skirmish - the
Radiance constructed tier - has no finished events yet (see the tier section
above), so Radiance-era constructed skill is currently unmeasured.

### Storage: the output contract

The derived items, and why each is shaped as it is. **This is a contract with the
backend API and the ranking UI; additions are safe, renames are not.**

| item | PK | SK |
|---|---|---|
| player profile | `PLAYER#<uuid>` | `PROFILE` |
| rating history point | `PLAYER#<uuid>` | `RATING#<scope>#<YYYY-MM-DD>` |
| match log entry | `PLAYER#<uuid>` | `MATCH#<iso>#<matchId>` |
| leaderboard row | `RANKING#<scope>` | `RANK#<rank, 6 digits>#<playerId>` |
| leaderboard header | `RANKING_META#<scope>` | `PROFILE` |
| component profile | `COMPONENT#<id>` | `PROFILE` |
| set profile | `SET#<id>` | `PROFILE` |
| **venue profile** | **`VENUE#<shopExternalId>`** | **`PROFILE`** |
| **scene profile** | **`SCENE#<sceneId>`** | **`PROFILE`** |
| scope directory | `RANKING_INDEX` | `RANKING_INDEX` |
| match-log marker | `RANKING_LOG#<eventId>` | `RANKING_LOG#<eventId>` |
| scene assignment (not derived) | `SCENE_ASSIGNMENT` | `SCENE_ASSIGNMENT` |

`scope` is `all`, `set:<id>`, `component:<id>` or `set:<id>#component:<id>`.
Scenes do **not** add a scope: the player profile and every ladder row carry
`sceneId` / `sceneLabel` so a board can be filtered by scene without a new
ladder, and whether scenes deserve ladders of their own is a decision to take
with the API rather than by writing them.

- **A player page is one Query** on `PLAYER#<uuid>`: profile, chart and match log
  arrive together, separated by their SK prefixes.
- **A leaderboard is one item per player**, not a page of entries, so an
  SK-ascending Query on `RANKING#<scope>` *is* rank order. The rank is
  zero-padded to six digits for precisely that reason - unpadded, "10" sorts
  before "2".
- **The board header is in its own partition** (`RANKING_META#<scope>`) rather
  than as a `META` row inside the board, so a reader Querying a board never has
  to filter a non-player item out of the results.
- **`COMPONENT#`, `SET#`, `VENUE#` and `SCENE#` exist so the region selector,
  `/api/sets`, a venue map and a scene selector are one Query each**, instead of
  inferring the lists by scanning players.
- **The four catalogues are enumerable; the per-player items are not.**
  `SET#<id>`, `COMPONENT#<id>`, `VENUE#<id>` and `SCENE#<id>` carry GSI1 keys -
  `GSI1PK: 'SET'` / `'COMPONENT'` / `'VENUE'` / `'SCENE'`,
  `GSI1SK: '<PARTITION>#<id>'` - so each whole catalogue is **one Query** with no
  scan and no new index (GSI1 already exists and projects ALL). A single shared
  partition per catalogue is right because there are a handful of sets ever,
  components number in the dozens, scenes in the dozens, and venues in the
  hundreds regionally or low thousands nationally.

  This was missing originally, and the symptom was not obvious: the items existed
  and held the authoritative data (`SET#s4` → Vendetta, release 2026-07-31, 1,228
  matches; `SET#s5` → Radiance, 4 matches) but could only be fetched by an id the
  reader already had. So `/api/sets` could not list them, fell back to inferring
  set ids from player profiles, and served them with `name: null` - missing
  Radiance entirely, because nobody is rated in it yet. The component list was
  likewise being rebuilt by reading the global board and unioning profiles.
  Nothing needs migrating: a refit rewrites the whole item, so the keys land on
  the next one. `rankingCatalogue.test.ts` pins both queries.
- **No *other* GSI entries are added.** The per-player and per-board items would
  multiply GSI1's size for no read that needs it. Display-name search is a capped
  Scan on the API side until a GSI can be batched with other infrastructure work
  - so nothing here is designed assuming search is cheap.
- **The per-player match log is the one place duplicate writes are justified**:
  two items per match, one from each side, denormalising the opponent's display
  name, the per-game outcomes, the event, the venue and the set. The per-player
  page needs "every game and against whom" without replaying history.

SQLite mirrors all of this (`player_profiles`, `player_rating_history`,
`player_matches`, `ranking_rows`, `ranking_meta`, `ranking_components`,
`ranking_sets`) so `./dev.sh` can run a real refit and the storage tests run
against a real throwaway database rather than a mock. PostgreSQL is left out
rather than half-supported, exactly as `supportsEventFacts()` does -
`supportsRankingWrites()` is the same rule.

**The counts agree.** A profile's `gamesPlayed` is exactly the number of game
outcomes in that player's match log, `matchesPlayed` exactly the number of
entries, and the same per set. Everything comes from one pass over one
observation set, so it holds by construction, and `rankingStore.test.ts` pins it.

### Venue items, and the map view

**This is built.** A map of venues - zoomable down to one store, showing who
plays there - needs nothing the facts do not already carry: every match fact has
`shopExternalId` plus latitude and longitude, and on the California sample
**390 of 390 venues have both**, so there is no missing-data case to design
around. The numbers, measured with `./ranking-metrics.sh venues`:

| | |
|---|---|
| venues | **390** |
| with coordinates / with a shop id | 390 / 390 (**100%**) |
| distinct (player, venue) pairs | **12,885** |
| players per venue | median **22**, p10 7, p90 72, max 209 |
| *rated* players per venue (bar 8/120/8) | median **11**, p90 43, max 123 |
| venues with at least one rated player | **368 of 390** |
| venues with 8+ rated players | **258 of 390** |
| median share of a venue's play in one community | **99.3%** |

`VENUE#<shopExternalId>` / `SK: PROFILE`, with `GSI1PK: 'VENUE'` /
`GSI1SK: 'VENUE#<id>'`, carrying:

| field | notes |
|---|---|
| `venue` | `shop:<id>`, the graph's own key, for joining to the reports |
| `shopExternalId` | the item's id, and the only id it is ever keyed on |
| `name` | the shops table's city label; null until reverse geocoding lands |
| `latitude` / `longitude` | the **mean** of the venue's events' coordinates - a store does not move, but the two sources geocode it ~20m apart, so the mean is stable where "whichever event was read last" is not |
| `players`, `ratedPlayers`, `matches`, `events` | the aggregate a store page leads with |
| `firstSeen` / `lastSeen` | earliest and latest event played there, ISO |
| `sceneId`, `sceneLabel`, `scenePurity` | the scene it belongs to, and how true that is. Null until a re-clustering has been run |
| `topPlayers` | up to `RANKING_VENUE_TOP_PLAYERS` (25) entries, ordered by matches at this store, each with the published rating and `rated` |
| `topPlayersTruncated` | so a reader can say "and N others" |

Why this shape:

- **The GSI key is the whole point.** A map's first render is "every venue with
  a pin", which has to be one Query; the drill-down to one store is then a
  `GetItem`. Without the index key it is a Scan, and this is exactly the gap
  that had to be retrofitted onto `SET#` and `COMPONENT#` after `/api/sets` was
  caught inferring set ids from player profiles and serving them with
  `name: null`.
- **390 items regionally, a few thousand nationally.** Against a refit that
  already rewrites ~7,700 profiles and ~17,000 rating points, free.
- **The roster is capped and denormalised, not a relationship table.** 22
  players at the median, 209 at the maximum, 12,885 pairs regionally. A capped
  top-N answers the drill-down in one read and is what a map UI actually shows.
- **One dominant scene plus a purity number is an honest summary**, and that is
  only true because of the 99.3% figure. A venue whose purity is low is a
  genuinely split store, which is worth showing rather than hiding.
- **`venueKey`'s `geo:` fallback is never the id.** It rounds coordinates to
  ~1km - right for a graph node, wrong for a durable key, because the id would
  move if the geocode moved. Unresolved organizers are left off the map.

`SCENE#<sceneId>` / `SK: PROFILE`, `GSI1PK: 'SCENE'`, is the matching
catalogue - `label`, `venueCount`, `playerCount`, `ratedCount`, `matchCount`,
`medianPurity`, and `assignedAt` (when the **assignment** was made, which is not
the refit time). Its membership comes from the stored assignment, so a scene
cannot appear or vanish because a refit saw one more match; only its counts
move. A player belongs to a scene via their **home** venue, so scene player
counts partition the players rather than double-counting visitors - and
`rankingScenes.test.ts` pins that the per-scene counts sum to the profile count.

Pruning follows the same discipline as everything else: a venue whose last match
ages out of the replay window, or a scene a re-clustering retires, is deleted by
diffing against the scope directory (which now tracks `venueIds` and
`sceneIds`), so the catalogue Query never serves a pin with no data behind it.

### Giving a connected component a place on a map

`src/ranking/sceneMap.ts`, published on the `COMPONENT#<id>` item. This is what
the backend's `/api/rankings/map` and the frontend's `/rankings/map` read, and
it is the one piece of geography in this pass that is **not** about `VENUE#`.

Be precise about which primitive is being located, because this document argues
at length that they are different things. **This locates a `componentId`**, the
connected component - not a Louvain `sceneId`. That is a decision forced by the
data rather than a contradiction of the recommendation above: `SCENE#` items
require an accepted re-clustering, the first production dry run produced 1,042
scenes of 2.1 stores each and the CLI correctly refused it, and there are
**zero** `SCENE#` and zero `VENUE#` items in production today. There are
**1,235** `COMPONENT#` items, written by every refit. A map built on `SCENE#`
would be an empty map. When a re-clustering is finally accepted, the same
derivation applies unchanged to `SCENE#` - `scenePlace` takes venue tallies and
knows nothing about which partition produced them.

#### Why the derivation lives here and not in the API

Because the join is affordable in exactly one place. A component's coordinates
are not on the component: they are on the per-player match items
(`PLAYER#<uuid>` / `MATCH#…`, which denormalise `shopExternalId` and lat/lon),
and **there is no index from a component to its matches**. Locating 1,235
components at request time would mean reading every match item of every player.
During the replay, `findComponents` is already walking every match with its
event in hand, so the venue tallies are a by-product of a loop that was running
anyway, and the whole thing is written once a day with the rest of the snapshot.

#### What is published

`Component.venues` (graph.ts) carries, per venue of a component: the venue key,
the shop id, the matches *of that component* played there, and the **mean** of
that venue's events' coordinates (the mean for the same reason `VENUE#` uses
one - the two sources geocode a store ~20m apart, so "whichever event was read
last" wobbles). `scenePlace` turns that into five fields on the item:

| field | what it is |
|---|---|
| `latitude` / `longitude` | match-weighted **spherical** centroid of the located venues |
| `spreadKm` | match-weighted mean great-circle distance from that centroid |
| `locatedVenues` / `locatedMatches` | the evidence it was computed from, to read against `venueCount` / `matchCount` |
| `topVenues` | the busiest venues, capped at `RANKING_SCENE_MAP_TOP_VENUES` (5), position and match count only - **no name**, so no new free-text surface |

Three things that are deliberate:

- **The centroid is weighted by play, not by venue.** A component playing 400
  matches at one store and 3 at another is *at* the first store. An unweighted
  mean would put it a town away from where its games happen.
- **It is a spherical mean**, not a mean of degrees. A mean of degrees is wrong
  in two populated places: a component straddling the antimeridian averages
  +179 and -179 to 0 and lands in the Gulf of Guinea, and a mean of latitudes
  over-weights high latitudes. Unit vectors in, unit vector out, eight lines.
- **`spreadKm` is what keeps a single pin honest**, and it is the reason a pin
  is publishable at all. On the complete California sample the largest
  community had a **133km mean venue spread** - a corridor, not a city - so a
  map drawing it as a dot would assert a precision it does not have. The UI
  draws the spread as a real ground disc beside the dot.

#### It refuses to guess, in three specific ways

Each of these is reachable with real data and each publishes nulls rather than
a plausible-looking coordinate. `rankingSceneMap.test.ts` pins all three.

1. **No located venue, no centroid.** Not the `regionLabel`'s city (that is a
   different and weaker precision claim wearing the same clothes, and a
   geocoding call per component), not the first venue that happens to have a
   geocode, not `0, 0`. A production component reading
   `regionLabel: 'Rockhampton, Australia'` with no geocoded event is
   **unlocated**, and the API and UI are required to say so.
2. **Half a coordinate pair is not a coordinate.** A latitude with no longitude
   is the obvious route to a pin in the Gulf of Guinea; both are required, in
   the engine and again in the API's reader.
3. **An antipodal cancellation yields no centroid.** The resultant of the
   weighted unit vectors can be ~0, which is not a place. It cannot happen for
   a real travel region - 0 of 56,257 recorded games cross a component, so a
   component is reachable on the ground - and it is cheaper to handle than to
   argue about.

A `geo:` venue key is still *evidence* even though it is never an *identity*:
the key rounds to ~1km and must not become a durable id (see `scenes.ts`), but
the event coordinates behind it are real, so the position counts and the id
comes through null.

#### What this costs

Nothing measurable at write time - it is five numbers and up to five small maps
on 1,235 items a refit already rewrites, against ~27,000 profiles and ~17,000
rating points. At read time the whole catalogue is **one GSI1 Query**, measured
against production on 2026-10-27 at **46 read units for 1,235 items** *before*
these fields; expect roughly double once they land, which is still a Query and
still three orders of magnitude off a scan. `RANKING_SCENE_MAP_TOP_VENUES` is
the knob if the payload ever matters: it is the bulk of the growth.

#### Nothing is located until the next refit

The fields are written by `saveRankingSnapshot` like everything else, so a
production item only acquires them when a refit next runs with this code
deployed (`RANKING_REFIT_INTERVAL_HOURS`, 24). Until then every component comes
back **unlocated** and the map says so - which is the same discipline as every
other null here. It is not a failure state, and nothing may treat it as one.

### Idempotency, and the cost of a refit

The pass is a **batch refit from scratch**, deliberately. Incremental state would
be cheaper per run and wrong twice over: WHR revises the whole past curve, and
the results backfill fills in *older* events as it progresses, so facts do not
arrive in time order. An incremental rating would depend on the order the scraper
happened to capture things in - the opposite of what a replayable history is for.

Every key is a deterministic function of the snapshot's content, so re-running
over the same facts rewrites the same items with the same values. Three things
make that safe at volume:

1. **Pruning is mandatory, not hygiene.** A rank lives in the sort key, so a
   player who moves from rank 7 to 5 writes a *new* item; the old one is deleted
   by diffing each scope's stored `RANK#` keys (keys only) against what this
   snapshot wrote. Whole scopes, components and sets that vanished are tracked in
   the scope directory and removed too.
2. **Rating history is emitted only for players who clear the bar.** An unrated
   player has no chart to draw, and a point per play-day for every one-event
   attendee would dominate the write volume.
3. **The match log is written once per event**, then guarded by a
   `RANKING_LOG#<eventId>` marker carrying `MATCH_LOG_VERSION`. Deciding that
   20,000 events need nothing costs a few hundred RCUs via BatchGet rather than
   re-emitting a million items. Bumping the version forces a rewrite.

Component ids are derived from the smallest player UUID in the component, so the
same membership always gets the same id whatever order the replay saw it in.
**They are not stable across refits when two components merge** - that is
inherent, since a component is defined by its membership and the membership
changed. Boards carry the ids that exist in the snapshot they were written with,
so a reader never sees a dangling one.

Rating-history points for a player who *falls* below the bar are left in place
rather than hunted down; the profile's `rated` flag is what a reader gates on, so
they are invisible. Worth revisiting if the thresholds ever move much.

### Lambda mode (production)

A fifth mode alongside `coordinator` / `worker` / `playriftbound` /
`playriftboundResults`. The coordinator dispatches `mode: 'ranking'` only when
`RANKING_REFIT_INTERVAL_HOURS` (default 24) have passed since the last refit
completed, tracked in a `CONFIG#RANKING_REFIT` item. Gating in the coordinator
rather than with a second EventBridge rule keeps the cadence an environment
variable instead of a Terraform edit, and means most 2-hourly cycles dispatch
nothing. A failure in the refit check never costs a scrape cycle.

The replay is scan-free: one Query per UTC day against GSI1's `RESULTS#<date>`
and `ROSTER#<date>` partitions, the access pattern the facts were shaped for.
Days are fetched in batches of 8 but fed to the builder **in date order**, so the
result does not depend on which Query finished first.

Deadline handling is the opposite of the other passes: `RANKING_RESERVED_MS`
(default 120000) is held back, and if the replay runs out of time the pass
**writes nothing**. A ladder fitted on half the history is worse than yesterday's
ladder; the next cycle tries again. `RANKING_MAX_MATCHES` (2,000,000) caps the
replay so an unexpectedly large history cannot OOM the invocation.

Observations live in flat typed arrays with integer player and event indices
rather than objects - the whole history has to fit in one Lambda, and ~600k
matches is ~50MB that way.

### Failure modes to watch

- **The bye player becoming a rated player.** The upstream filter makes this
  impossible, but that is a promise about code, not a property of the stored
  rows, and a 40-0 player called "BYE" would be the most visible possible
  failure. Every match and team id is re-checked in `observations.ts`, leaks are
  *counted* (`byeLeaks`) and logged as an error rather than silently dropped.
  Currently 0 on 16,829 matches.
- **A prerelease window making any type-keyed number look typical.** This has
  already produced one wrong conclusion in this document (see "the correction"
  above). 83% of the sample's matches are Pre-Rift, drawn from a single weekend;
  Summoner Skirmish - the tier that will dominate Radiance-era play - has no
  finished events at all yet. **Every number keyed on `tournamentType`, and
  every games-per-match figure, carries its window or it is worthless.**
- **Per-set ladders looking broken.** A set in its first weeks has almost no
  evidence, by construction. Note the flip side of prerelease attribution: a set
  can have a *well-populated* ladder built almost entirely from sealed prerelease
  play, which is not the same thing as constructed skill in that set.
- **A component being read as a scene.** It is not one, and the giant share is
  the proof: at 97.4% a component-keyed "Scene" selector offers one entry
  holding everybody. The failure gets *worse* with coverage, not better - see
  "Is a scene a connected component?" - so a component id must never be the
  thing a region picker is built on, however convenient it is that one is
  already on every row.
- **A cross-component rank being read as a placement.** Hence
  `positionsSuppressed` and `giantComponentShare` on every board. If the giant
  share ever falls, the global board has to stop being the default.
- **Write volume.** A refit rewrites every profile and every rating point. At
  current regional scale that is a few thousand items; extrapolated nationally
  with the full backfill it is a few hundred thousand per refit. The 24-hour
  cadence is the lever, and `ranking-metrics.sh fit` reports the counts a refit
  would write without writing them.
- **`uncertainty` is a lower bound.** The per-player Hessian conditions on
  opponents being known. `crossComponentUncertainty` is the number for
  cross-region comparisons - though note that once a component is large it stops
  mattering: at 7,531 members the offset term is 150/sqrt(7531) = 1.7 points, so
  the two numbers are the same to one decimal place. It only bites on the small
  components, which is where it should.
- **A short perfect record can top the board.** See the ordering note above.
- **Region labels are null until shops are geocoded.** They come from the shop
  row's `displayCity`, so a venue awaiting reverse geocoding yields an unlabelled
  component. The ladder still works; the region selector shows `Cluster <id>`.
- **A scene being read before anything is assigned.** `sceneId` is null on every
  item until an operator runs a re-clustering, and null is the normal value, not
  a failure: nothing may treat it as an error and nothing may drop a record for
  lacking one. A reader should fall back to "no scene", never to `componentId`,
  which means something else entirely.
- **A scene assignment accepted on a fragmented graph.** The first production
  dry run produced 1,042 scenes of 2.1 stores each at modularity 0.9844, because
  the backfill had not captured the cross-venue edges yet. Fragmentation raises
  the community count *and* the modularity, so both of the numbers that look
  reassuring move the wrong way. The stores-per-scene gate exists for exactly
  this and is checked before everything else.
- **A tier weight acting on an empty set.** `RANKING_TIER_WEIGHTS` keyed on a
  tier with no events silently does nothing, and the measured proof is in the
  sweep: the requested table scored identical to neutral to four decimal places.
  Read the match distribution by tier *before* setting a weight, not after.
- **The lookback drifting into the retention gap.** A results capture needs an
  event row, and `deleteOldEvents(60)` removes those. 45 leaves 14 days of
  margin; raising it past the high 50s without re-measuring retention would
  mean querying day partitions whose rows are being deleted under the run, which
  degrades silently - the candidate simply is not there.

### Metrics

```bash
cd scripts/metrics
./ranking-metrics.sh connectivity --remote   # measure the co-play graph
./ranking-metrics.sh communities --remote    # Louvain communities vs components (measurement only)
./ranking-metrics.sh venues --remote         # per-venue aggregates + the scene in force
./ranking-metrics.sh validate --remote       # held-out accuracy + knob sweeps, incl. tier weights
./ranking-metrics.sh bar --remote            # what each publishing bar admits
./ranking-metrics.sh fit --remote            # dry-run refit (writes nothing)
./ranking-metrics.sh all --file sample.ndjson  # analyse a captured regional sample

./scene-recluster.sh --remote                # propose a scene re-clustering and diff it
./scene-recluster.sh --remote --show         # print the assignment in force
./scene-recluster.sh --remote --write        # accept it (the one write in this directory)
./scene-recluster.sh --remote --rollback --write   # undo the last one
```

`ranking-metrics.sh` is entirely read-only. `scene-recluster.sh` is read-only
**unless `--write`**, and it is the one deliberate write in `scripts/metrics/`:
see the runbook in [scripts/metrics/README.md](../scripts/metrics/README.md) for
when to re-cluster and what to check before accepting. The `--file` form takes NDJSON of `{externalId, results, roster}`
objects, which is how a complete region can be measured before the production
backfill reaches it.

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
  merge-owned attributes (`eventType`, `url`, `playFormat`, `playerCount`,
  `capacity`, `price`, `sources`) on the UVS row; a `prb-` row that now matches a UVS row (inserted
  before its twin was known) is deleted. `PLAYRIFTBOUND_RESERVED_MS` (default
  300000) is held back from the sweep for that work.
- one **playriftbound results pass** (`mode: 'playriftboundResults'`, DynamoDB
  only), also with its own 15-minute budget. It reads the event rows that
  identify a Riot tournament - `prb-` rows *and* merged rows, whose id comes off
  their `url` (see "Which rows are results candidates") - in a
  -45/+2 day window off GSI1 (see "How far back the backfill can reach"), BatchGets the *metadata* of the fact rows to see
  what has already been captured (so concluding that 8,000 events need nothing
  costs a few dozen RCUs), and then fetches one page per due event. It works off
  the previous cycle's rows, so it does not wait for this cycle's workers.
  Deadline-aware like the sweep: `PLAYRIFTBOUND_RESULTS_RESERVED_MS` (default
  60000) is held back and whatever is left rolls over to the next run.
- optionally one **rating refit** (`mode: 'ranking'`, DynamoDB only), dispatched
  only when `RANKING_REFIT_INTERVAL_HOURS` (default 24) have elapsed since the
  last one completed, so most cycles dispatch nothing. It reads fact rows, fits,
  and writes derived items; see "Fourth pass: player ratings" above. Its deadline
  behaviour is the opposite of the scrape passes - it writes nothing rather than
  a partial snapshot - and a failure in the dispatch check never costs a scrape
  cycle.

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
| `url` | **Riot** | UVS is null on every row; Riot has one on 100%. Load-bearing beyond display: it is the only Riot-derived identifier that survives on a merged row, so it is what makes a merged event a results candidate at all (see "Which rows are results candidates") |
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

Player `displayName` and `tagLine` from the results pass go through the same
policy (`sanitizeEventResults` / `sanitizeEventRoster`): a player chooses both in
a user-editable account system, so they are exactly the kind of field the
organizer payload turned up in. Ids are left alone - they are opaque UUIDs, not
free text, and they are the identity key the stored facts depend on.

The **derived** rating items get the same treatment: player display names and
tag lines, denormalised opponent names, event names, shop-derived region labels
and set labels all go through `sanitizePlayerProfile` /
`sanitizeMatchLogEntry` / `sanitizeRankingRow` / `sanitizeRankingMeta` /
`sanitizeComponentProfile` / `sanitizeSetProfile`. They are re-cleaned even
though the facts they came from were already clean, because a derived writer is
exactly the kind of new code path the two-boundary rule exists for.

Records are cleaned and **kept**, never dropped. It is applied at the source
converters *and* at the `upsertEventWithStore` / `upsertShopFromApi` /
`saveEventResults` / `saveEventRoster` / `saveRankingSnapshot` boundaries, so no
future code path can write raw text to a table.

## Environment

- `SCRAPE_INTERVAL_MINUTES`: Cycle length (default: 60). Requests distributed evenly across cycle.
- `DB_TYPE`: `sqlite` or `postgres`
- `PLAYRIFTBOUND_ENABLED`: Enable the second source (default: `true`)
- `PLAYRIFTBOUND_REQUEST_DELAY_MS`: Delay between playriftbound requests (default: `1000`)
- `PLAYRIFTBOUND_MAX_ANCHORS_PER_RUN`: Anchors swept per run (default: `150`)
- `PLAYRIFTBOUND_QUERY_HASH`: Pin the persisted query hash (optional, normally self-healing)
- `PLAYRIFTBOUND_RESULTS_ENABLED`: Enable the rosters + results pass (default: `true`)
- `PLAYRIFTBOUND_RESULTS_MAX_EVENTS_PER_RUN`: Event pages fetched per run (default: `250`; production sets `500`)
- `PLAYRIFTBOUND_RESULTS_LOOKBACK_DAYS`: How far back to look for finished
  events awaiting a results capture (default: `45`). Bounded above by
  `deleteOldEvents(60)` - a capture needs an event row as its candidate - and
  below by when `prb-` rows start existing. See "How far back the backfill can
  reach"; do not raise it past the high 50s without re-measuring retention.
- `PLAYRIFTBOUND_RESULTS_RESERVED_MS`: Lambda time held back from the results pass (default: `60000`)

The results pass shares `PLAYRIFTBOUND_REQUEST_DELAY_MS` for its rate limit.

Player ratings (`src/ranking/`):

- `RANKING_ENABLED`: Enable the rating refit (default: `true`)
- `RANKING_REFIT_INTERVAL_HOURS`: Minimum gap between refits (default: `24`)
- `RANKING_HISTORY_DAYS`: How far back the replay reads fact rows (default: `400`)
- `RANKING_RESERVED_MS`: Lambda time held back for the writes (default: `120000`)
- `RANKING_MAX_MATCHES`: Safety cap on the replay (default: `2000000`)

The model (see "Measured: the knobs"):

- `RANKING_PRIOR_SIGMA_ELO`: Prior SD of a player's rating (default: `150`)
- `RANKING_ELO_ORIGIN`: Where the published scale is anchored - an unrated
  player's rating (default: `1200`). A display offset: no prediction depends on
  it, but stored ratings only pick up a change on the next refit.
- `RANKING_DRIFT_ELO_PER_SQRT_DAY`: Wiener drift allowance (default: `4`)
- `RANKING_OBSERVATION_LEVEL`: `game-shared` | `game` | `match` (default: `game-shared`)
- `RANKING_WEIGHT_SCALE`: Total weight of one match (default: `1`)
- `RANKING_TIER_WEIGHTS`: JSON override for the per-event-tier weight on a
  match's evidence, keyed on the mapped `eventType`
  (`{"World Championship": 2, "Learn to Play": 0.5}`). **Empty by default** -
  every tier counts the same; see "is an event tier worth a weight?" for the
  measurement that chose that.
- `RANKING_DEFAULT_TIER_WEIGHT`: Weight for a tier the table does not mention,
  including every value Riot adds to its enum later (default: `1`)
- `RANKING_MAX_ITERATIONS`: Newton sweeps before giving up on convergence (default: `60`)

The publishing bar:

- `RANKING_MIN_GAMES`: No public rating below this many games (default: `8`)
- `RANKING_MAX_UNCERTAINTY_ELO`: ...or above this posterior SD (default: `120`)
- `RANKING_MIN_COMPONENT_SIZE`: Below this a rank is not a position (default: `8`)
- `RANKING_MAX_COMPONENT_LADDERS`: Component boards published, largest first (default: `50`)
- `RANKING_MIN_SET_MATCHES`: A set era below this is not fitted (default: `50`)
- `RANKING_SET_TABLE`: JSON override for the curated set table (optional)
- `RANKING_PRERELEASE_TYPES`: Tournament types that count toward the set they preview (default: `Pre-Rift`)
- `RANKING_PRERELEASE_LEAD_DAYS`: How far before a release a prerelease may sit (default: `14`)

Venues and scenes:

- `RANKING_VENUE_TOP_PLAYERS`: Players denormalised onto a `VENUE#` item,
  ordered by matches played there (default: `25`)
- `RANKING_SCENE_RESOLUTION`: Louvain resolution for a **re-clustering**
  (default: `1`, the measured stability optimum). Read only by
  `scene-recluster.sh` - a refit never clusters; it reads the stored
  assignment.
- `RANKING_SCENE_MAP_TOP_VENUES`: Venues denormalised onto a `COMPONENT#` item
  for the scene map, ordered by matches of that component played there
  (default: `5`). A page-weight knob rather than a modelling one - the item is
  read in full on every map load, and this is the bulk of its size. See
  "Giving a connected component a place on a map".

## Tests

```bash
npm test --workspace=scraper   # vitest
```

The rating model's tests are worth knowing about by name, because they pin the
properties the design rests on rather than its surface:

- `rankingModel.test.ts` - a known-answer fit (a strict dominance order comes out
  in order, symmetric about the anchor, with the unbeaten player the *least*
  certain), the event-tier weighting mechanism (neutral by default, an unknown
  tier never defaults low, a weighted tier narrows the posterior without
  changing the order, and a tier with no events in the window cannot change the
  fit at all),
  **two disconnected clusters proving the prior stops them floating**, bye
  rejection by every route a bye id can reach a fact row, and uncertainty
  narrowing monotonically with evidence while never exceeding the prior.
- `rankingCommunities.test.ts` - the case against components as a scene
  primitive, as assertions: two cliques joined by **one** match are one
  component and two communities, Louvain's labelling is deterministic (an
  order-dependent scene label would reshuffle in the UI between identical runs),
  the reported modularity agrees with an independent evaluation of the same
  labelling, and the partition-agreement metrics score a relabelling as
  identical.
- `rankingScenes.test.ts` - the persisted scene assignment: a store belongs to
  exactly one scene with a purity attached, a scene id **survives a
  re-clustering** that changes the membership (overlap-carried, which is the
  whole reason the assignment is persisted) while a genuinely new scene gets a
  new id, a geocode is never a venue id, a refit with no assignment publishes
  null scenes rather than clustering on the fly, and `componentId` keeps its
  meaning throughout.
- `rankingSceneMap.test.ts` - locating a scene: the centroid is weighted by
  play rather than by venue, it is a **spherical** mean (so a scene straddling
  the antimeridian lands next to its stores rather than in the Gulf of
  Guinea), the spread is published beside the pin, and each of the three
  refusals yields nulls rather than a plausible coordinate - no located venue,
  half a coordinate pair, and an antipodal cancellation. The component walk is
  exercised too, because the venue tallies the centroid is computed from are a
  by-product of that loop.
- `rankingSets.test.ts` - set partitioning, including that an unpublished
  boundary stays unpublished and that filling one in splits the era.
- `rankingStore.test.ts` - the storage shape against a real throwaway SQLite
  file: idempotency, rank-key pruning, zero-padded rank ordering, the confidence
  verdict, and that **profile counts agree with the match log**.

`npm run lint` is broken repo-wide (there is no `eslint.config.*`); it is not
this pass's doing.
