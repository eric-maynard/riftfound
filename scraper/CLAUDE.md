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

### Why page HTML and not GraphQL

Both facts are embedded, public and unauthenticated, in the Next.js RSC flight
payload of the event detail page:

```
GET https://playriftbound.com/en-US/events/<tournamentId>
```

`<tournamentId>` is our `external_id` with the `prb-` prefix stripped. The JSON
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
disconnected round robins: both centre on 1500 to within 0.1 points, both keep
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
| scope directory | `RANKING_INDEX` | `RANKING_INDEX` |
| match-log marker | `RANKING_LOG#<eventId>` | `RANKING_LOG#<eventId>` |

`scope` is `all`, `set:<id>`, `component:<id>` or `set:<id>#component:<id>`.

- **A player page is one Query** on `PLAYER#<uuid>`: profile, chart and match log
  arrive together, separated by their SK prefixes.
- **A leaderboard is one item per player**, not a page of entries, so an
  SK-ascending Query on `RANKING#<scope>` *is* rank order. The rank is
  zero-padded to six digits for precisely that reason - unpadded, "10" sorts
  before "2".
- **The board header is in its own partition** (`RANKING_META#<scope>`) rather
  than as a `META` row inside the board, so a reader Querying a board never has
  to filter a non-player item out of the results.
- **`COMPONENT#` and `SET#` exist so the region selector and `/api/sets` are one
  Query each**, instead of inferring the lists by scanning players.
- **The two catalogues are enumerable; the per-player items are not.** `SET#<id>`
  and `COMPONENT#<id>` carry GSI1 keys - `GSI1PK: 'SET'` / `'COMPONENT'`,
  `GSI1SK: '<PARTITION>#<id>'` - so the whole catalogue is **one Query** with no
  scan and no new index (GSI1 already exists and projects ALL). A single shared
  partition per catalogue is right because there are a handful of sets ever and
  components number in the dozens.

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

### Metrics

```bash
cd scripts/metrics
./ranking-metrics.sh connectivity --remote   # measure the co-play graph
./ranking-metrics.sh validate --remote       # held-out accuracy + knob sweeps
./ranking-metrics.sh bar --remote            # what each publishing bar admits
./ranking-metrics.sh fit --remote            # dry-run refit (writes nothing)
./ranking-metrics.sh all --file sample.ndjson  # analyse a captured regional sample
```

All read-only. The `--file` form takes NDJSON of `{externalId, results, roster}`
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
  only), also with its own 15-minute budget. It reads the `prb-` event rows in a
  -21/+2 day window off GSI1, BatchGets the *metadata* of the fact rows to see
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
- `PLAYRIFTBOUND_RESULTS_MAX_EVENTS_PER_RUN`: Event pages fetched per run (default: `250`)
- `PLAYRIFTBOUND_RESULTS_LOOKBACK_DAYS`: How far back to look for finished events awaiting a results capture (default: `21`)
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
- `RANKING_DRIFT_ELO_PER_SQRT_DAY`: Wiener drift allowance (default: `4`)
- `RANKING_OBSERVATION_LEVEL`: `game-shared` | `game` | `match` (default: `game-shared`)
- `RANKING_WEIGHT_SCALE`: Total weight of one match (default: `1`)
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

## Tests

```bash
npm test --workspace=scraper   # vitest
```

The rating model's tests are worth knowing about by name, because they pin the
properties the design rests on rather than its surface:

- `rankingModel.test.ts` - a known-answer fit (a strict dominance order comes out
  in order, symmetric about 1500, with the unbeaten player the *least* certain),
  **two disconnected clusters proving the prior stops them floating**, bye
  rejection by every route a bye id can reach a fact row, and uncertainty
  narrowing monotonically with evidence while never exceeding the prior.
- `rankingSets.test.ts` - set partitioning, including that an unpublished
  boundary stays unpublished and that filling one in splits the era.
- `rankingStore.test.ts` - the storage shape against a real throwaway SQLite
  file: idempotency, rank-key pruning, zero-padded rank ordering, the confidence
  verdict, and that **profile counts agree with the match log**.

`npm run lint` is broken repo-wide (there is no `eslint.config.*`); it is not
this pass's doing.
