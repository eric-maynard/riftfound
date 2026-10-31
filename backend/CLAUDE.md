# Backend

Express.js API server on port 3001.

## Structure

```
src/
├── index.ts              # Server entry point
├── config/
│   ├── database.ts       # SQLite/PostgreSQL connection (uses DB_TYPE env)
│   └── env.ts            # Zod-validated environment config
├── models/
│   ├── event.ts          # Event schema + EventQuerySchema for API params
│   ├── ranking.ts        # Ranking/rating schemas + confidence gate (resolveVerdict)
│   ├── tournament.ts     # Tournament-fact schemas + response shapes
│   └── sets.ts           # Set catalogue (discovered ids + published boundaries)
├── routes/
│   ├── events.ts         # /api/events endpoints
│   ├── tournaments.ts    # /api/events/* tournament facts (mounted first)
│   ├── rankings.ts       # /api/rankings
│   ├── players.ts        # /api/players/*
│   └── sets.ts           # /api/sets
├── adapters/
│   ├── dynamoAdapter.ts             # Events/shops in DynamoDB
│   ├── rankingStore.ts              # RankingStore interface
│   ├── rankingDynamoAdapter.ts      # Real derived ranking items
│   ├── playerNameIndex.ts           # Display-name matcher + the published index's reader
│   ├── rankingFixtureAdapter.ts     # In-memory stand-in for dev/tests
│   ├── tournamentStore.ts           # TournamentStore interface
│   ├── tournamentDynamoAdapter.ts   # Real RESULTS#/ROSTER# fact items
│   └── tournamentFixtureAdapter.ts  # In-memory stand-in for dev/tests
└── services/
    ├── eventService.ts   # Query logic with Haversine filtering
    ├── rankingService.ts # Confidence, ranks, coverage derivation
    ├── tournamentService.ts # Facts joined to ratings, strength of field
    └── geocodingService.ts  # Photon API + geocache table
```

## API Endpoints

- `GET /api/events` - List events with filtering
  - Query params: `page`, `limit`, `city`, `state`, `country`, `search`, `eventType`
  - Location filtering: `lat`, `lng`, `radiusKm`
  - `calendarMode=true`: Returns all events in 3-month range, ignores pagination
- `GET /api/events/:id` - Single event
- `GET /api/events/:externalId/tournament` - One event's standings, pairings and
  roster, with each player's rating attached (see "Tournament facts")
- `GET /api/events/tournament-availability?ids=a,b,c` - which of up to 50 events
  have anything to show, for the calendar's trophy affordance
- `GET /api/events/info` - Scrape stats (last updated, total count)
- `GET /api/events/geocode?q=` - Geocode city/zip for location filtering
- `GET /api/rankings` - Leaderboard page for one `scope` (`all`, `set:<id>`,
  `component:<id>`, `scene:<id>`, `set:<id>#component:<id>`,
  `set:<id>#scene:<id>`), plus coverage and the component list. `scene:<id>`
  is the one scope the engine did **not** write a partition for - it is a
  filter over a pool's board, and it carries a `scene` header beside the
  `component` one (see "A scene board is a filter, not a fit")
- `GET /api/rankings/map` - Every scene with a place, for the map of scenes.
  One GSI1 Query over the engine's whole `COMPONENT#` catalogue, no
  parameters. Located and unlocated scenes come back in **separate lists**
  (see "The scene map")
- `GET /api/players/:playerId` - Profile, per-set ratings, component info.
  **Never 404s for a well-formed id**: a player the engine has never seen comes
  back as a `no-rating` profile with `known: false` (see "Never seen is not
  absent")
- `GET /api/players/:playerId/matches` - Paginated match log with opponents
- `GET /api/players/:playerId/ratings?scope=` - Rating time series for the
  chart. Served for a provisional player; empty only below the display floor
  (`pointsWithheld: true`), where every point is still the prior
- `GET /api/players/search?q=` - Display-name search over **every** player, from
  the engine's published name index (min 2 chars, capped at 25, no cursor,
  `noindex`). Carries `coverage`, which says what the search compared - see
  "Searching for a player"
- `GET /api/sets` - Set eras from the engine's own `SET#<id>` items (one GSI1
  Query), which are authoritative for names and boundaries and include eras
  with no play yet. Falls back to discovering ids from player profiles when
  that index is absent, in which case `name`/`releaseDate` come back null -
  the hand table in `models/sets.ts` keys on names (`radiance`) while the
  engine emits era ids (`s4`), so it matches nothing on its own.

## Ranking data

The scraper's rating engine writes derived items into the same DynamoDB table
(`PLAYER#<uuid>/PROFILE`, `.../RATING#<scope>#<date>`, `.../MATCH#<ts>#<id>`,
`RANKING#<scope>`). The API only reads them, through `RankingStore`:

- `DB_TYPE=dynamodb` -> `rankingDynamoAdapter` (the real items)
- anything else -> `rankingFixtureAdapter` (an in-memory launch-shaped dataset)
- `RANKING_SOURCE=auto|dynamodb|fixture` forces either one

### The confidence gate

The engine writes its **own** verdict onto each item - `provisional`,
`provisionalReason`, `gamesUntilRated`, per scope (the profile and every entry
of its per-set map) - decided against thresholds measured from the posterior SD
distribution it fitted. That verdict is the authority. `resolveVerdict()` in
`models/ranking.ts` prefers it and falls back to `assessConfidence()`
(`CONFIDENCE` = 8 games / 120 sigma / 8 players, the same numbers) only for an
item that carries none, which is the case for the leaderboard rows - the engine
only writes a row for a rated player - and for anything written before the
verdict shipped. Two things hold whichever source wins: a rating that does not
exist is never "rated", and a provisional verdict always carries a reason. The
engine's reason names are its own (`too-uncertain`, `component-too-small`) and
are translated into this API's three.

**`no-rating` means no evidence, and nothing else.** That had drifted, and the
drift was a live bug. A refit that wrote 27,318 profiles left a known player
with **6 recorded games and a fitted sigma of ~100** reporting
`provisionalReason: 'no-rating'` - two games off the bar, described as if the
engine had never seen them. It mattered beyond wording: the frontend branches on
this field, and `too-few-games` is what draws the "6 / 8 games" progress meter
while `no-rating` draws nothing, so exactly the players who were closest to
being rated got no progress indicator at all.

Two fall-throughs produced it, and both are closed in `models/ranking.ts`:

1. `assessConfidence()` tested `rating === null` **first**, so any player whose
   rating attribute was absent got `no-rating` regardless of their game count.
   The order is now evidence-first: with games recorded, the reason is
   `too-few-games` or `uncertainty-too-wide`, and `no-rating` is reserved for an
   id with no games *and* no rating. The absence of a number is not the absence
   of evidence.
2. `resolveVerdict()` passed the engine's own `no-rating` straight through.
   The engine is authoritative about *that* it withheld a rating, but it cannot
   be right that there is "no rating" for a player whose rating we are holding,
   so a stated `no-rating` is discarded in favour of the derived reason whenever
   a rating exists.

All three states are pinned end to end and at the model level: never seen ->
`no-rating` with `known: false`; known and short of the bar -> `too-few-games`
with the games left to go; known with games but a wide margin ->
`uncertainty-too-wide` with `gamesUntilRated: 0`, because a meter counting down
to nothing is worse than no meter.

### A rating is published with its uncertainty

**Every rating is published, together with its margin.** `/api/rankings` rows,
`/api/players/:id` and each entry of its `setRatings` map,
`/api/players/search`, `/api/players/:id/ratings` and
`/api/events/:id/tournament` all carry `rating` *and* `uncertainty`, whether or
not the player has cleared the gate.

This reverses an earlier rule that nulled `rating` whenever `provisional` was
true. That rule was wrong twice over. It produced a column of "Unranked" that
read as a broken page rather than as a considered answer - and it withheld the
wrong thing. The honest answer to "how much should I trust this number?" is the
number **and** its margin; an absence answers nothing and leaves a reader
unable to weigh anything. So the margin now carries the honesty the word was
carrying:

- `uncertainty` is **load-bearing, not decorative.** It is the only signal that
  separates a settled rating from an unsettled one, so it must be present
  wherever a rating is. The pairing is enforced structurally in
  `publishableRating()` (`services/rankingService.ts`) - the single boundary
  every published rating passes through - and a rating whose margin is missing
  is not published, because a number without its margin is exactly the bare
  figure the margin was meant to qualify.
- `provisional`, `provisionalReason` and `gamesUntilRated` still travel, and
  still say in words that the player has no *position* yet.

**What is still withheld: a rating that is merely the prior.**
`RANKING_MIN_GAMES_TO_PUBLISH` (default **3**, `DEFAULT_MIN_GAMES_TO_PUBLISH` in
`models/ranking.ts`) is a **display floor** on recorded games, and it is a
different threshold from the rank gate - conflating the two is the mistake to
avoid. Measured posterior SD by games played, against a prior SD of 150:

| games | median SD | share under 120 |
|---|---|---|
| 1-2 | 130 | 0.7% |
| 3-4 | 122 | 15.4% |
| 5-7 | 107 | 87.3% |
| 8-9 | 97 | 95.1% |

At one or two games the posterior has barely moved off the prior, so publishing
it means publishing 1200-with-noise and calling it a rating. By three it has at
least responded to results. The floor is the point where the figure starts
carrying information instead of echoing the prior - not an arbitrary number, and
it is published in the payload (`coverage.minGamesToPublishRating`,
`field.minGamesToPublishRating`) so a page can explain itself.

So there are two independent thresholds:

| | threshold | what it decides |
|---|---|---|
| **display floor** | 3 recorded games | whether the *number* is shown |
| **rank gate** (`CONFIDENCE`) | 8 games, sigma <= 120, component >= 8 | whether the player holds a *position* |

A player at 3-7 games therefore shows a rating with its margin and
`rank: null`. Below the floor, `rating: null` with `uncertainty` and the counts
still carried, so the state is still explainable.

**A consumer that collapses the two into one word gets caught by its own
page.** The event page counted the field in two groups off `field.ratedPlayers`
and `provisionalPlayers + unknownPlayers`, which on
`prb-117397899890353177` read "3 Rated, 10 Unranked" over a roster printing
**six** ratings: three of the ten were between the two thresholds and had their
number printed beside the word saying they had none. The counts were both
correct - the pairing was not. That page counts three groups now, off the
players rather than off `field`, because `provisionalPlayers` is not "has a
number": a known player with two recorded games is provisional *and* below the
display floor. `field` publishes `minGamesToPublishRating` beside
`minGamesForRating` precisely so a page can tell the two apart, and
`frontend/CLAUDE.md` carries the rest of that repair.

`/api/players/:id/ratings` **serves its points** for a provisional player. It
used to withhold them because the last point reconstructed the withheld
headline; the headline is published now, so there is nothing left to
reconstruct. The only thing that still withholds a series is the display floor,
on the same grounds as the headline - below it the curve is the prior rather
than a record of play - and `pointsWithheld` is the field that tells "there is
history you cannot see yet" from "there is no history". It is false for a
provisional player and true only below the floor.

Ordering, ranks and coverage are computed over the ratings **before** anything
is withheld (`publish()` is the last step in `getRankings`), so no display rule
can move a rank or shift a count. That sequencing survived the change above
unaltered, and `rankingApi.test.ts` pins it - a rank or an average that came out
differently because of a display rule would be a different answer rather than a
safer one.

Ranks are dense over the rows that **earn a position** (`earnsPosition` in
`models/ranking.ts`): settled, with a number, and in a scene of at least
`CONFIDENCE.minComponentSize`. A provisional player gets `rank: null`.

**Positions are assigned on every scope, Global included.** They used to come
back on the global board only by accident - nothing here gated on `comparable`,
so the numbers were computed, and the client then dropped the whole column
whenever the scope mixed scenes. That is now a deliberate decision in one
place: a weakly identified order is reported with its caveat rather than
withheld. The scene-size gate moved with it, from the scope onto the **row**,
which is what keeps the promise that a player who would get no position in
their own scene does not get one by being put on a bigger page - 29 of the live
board's 6,117 rated players are in that state. The engine's own per-row
`suppressPosition` is deliberately not read for this: on a global board it is
true for **all** 6,117 rows (the scope ORs a scope-wide flag into every one), so
it carries no per-player information; `componentSize`, which the row also
carries, does.

`LeaderboardEntry.sceneComparable` publishes that per-row verdict. It says the
row's *own* order is real and nothing more. **Nothing says a comparison between
two scenes is**, because nothing in the data does: a scene is a connected
component of the co-play graph, so a game between two of them would merge them,
and measured on production **0 of 56,257 recorded games cross a scene** (800 of
800 same-scene over a stratified sample of 90 players' match logs, 777
opponents resolved) across 1,235 scenes. The event-type corpus has no RC/RCQ
tier to link them - it is Nexus Night, Pre-Rift and Other - so every scene's
level rests on the 1,200 prior alone. That caveat is deliberately **copy**
rather than a number: the engine's `crossComponentUncertainty` widens the
margin by a median of 1.2 rating points (ratio 1.011) because the model pins a
4,654-player scene's mean to ±2.2 off the prior, so publishing it would assert
that a cross-scene comparison is 1% less certain than one between players who
have actually played.

A component's own `comparable: false` is still served on the scope - the
engine's `component-too-small` is a comparison problem, not an evidence one, and
the rating is published either way.

### A scene board is a filter, not a fit

`GET /api/rankings?scope=scene:<id>`, `getSceneRankings` in
`services/rankingService.ts`. **This is what a scene's pin, its picker row and
an event page's scene line all link at now.**

**The bug.** *"when i click peninsula in the map i expect it to go to that
scene but its on like northw est community ..."* - and that is exactly what the
code did. A scene's pin linked to `component:<the pool those players sit in>`,
and a pool's `regionLabel` is the modal city name of a reachability closure, so
a San Francisco scene opened a board headed `North West Community Development
Council`, which is a **Singapore** CDC label. Each half was honest and the pair
was indefensible.

**Why a filter.** The engine's storage contract says it outright: *"Scenes do
not add a scope: the player profile and every ladder row carry `sceneId` /
`sceneLabel` so a board can be filtered by scene without a new ladder."* So a
scene board is the scene's rows taken out of **one pool's board** and re-ranked
among themselves. Nothing is re-fitted, no rating moves, `componentId` keeps its
meaning permanently, and `crossComponentUncertainty` is still claimed only for a
connected component. The statistical point is that a scene's players are a
**subset of one component**: they were on one scale before the filter and still
are after it, which is precisely what a cross-component board is not. The
engine writes no `RANKING#scene:<id>` item and this change did not ask it to -
`isStoredScope()` is the guard that keeps `Scope.raw` from being used as a key
for one.

**Grammar.** Six shapes now: `all`, `set:<id>`, `component:<id>`, `scene:<id>`,
`set:<id>#component:<id>`, `set:<id>#scene:<id>`. `component:` and `scene:`
together is a **400**: a scene names its own pool off the engine's `SCENE#`
item, so a caller offering both is either repeating itself or disagreeing with
the engine, and quietly preferring one is how a link lands on a board nobody
asked for. A scene scope is also refused on `/api/players/:id/ratings`, because
a rating curve comes from the fit and nothing fits a scene - served empty it
would read as "no history" rather than "not a thing this has a history for".

**What it costs, per request.** One `GetItem` on `SCENE#<sceneId>` for the pool
(~1 read unit), then that pool's board **in full**. It cannot be a `Limit`ed
Query with a `FilterExpression`, and that is not a performance note - it is the
correctness bug this API has already shipped once: **`Limit` caps the items
examined before the filter, not the matches** (see "Searching for a player"),
so on a ~6,000-row board in rank order a `Limit` of 25 returns the scene's best
players and calls it the scene. A `FilterExpression` is also declined: it saves
no capacity, and `RANKING#<scope>` may be a page item holding an `entries`
array with no top-level `sceneId`, so `sceneId = :id` would discard a whole
board. The filter runs in memory over the expanded records, on **`sceneId` and
`componentId` both** - a multi-pool scene's rows would otherwise arrive from two
components at once off a set-wide partition, which is the cross-scale board
this design exists to avoid.

Derived - not measured, and it says so - from two figures that were: the live
global board holds **6,117 rated rows** with a **97.4%** giant component share,
and the one read-unit measurement on a comparable partition is **46 units for
1,235 `COMPONENT#` items** (~305 bytes an item). So a scene board reads ~2MB
over 2-3 Query pages, around **250 eventually-consistent read units**, against
~46 for the whole scene map and ~2 for a 25-row page of a stored board. Note it
is ~6,000 rows *whichever* pool is asked for: the engine writes at most
`RANKING_MAX_COMPONENT_LADDERS` (50) component ladders and only for pools of at
least `minComponentSize`, so most of the 1,235 pools have no `component:`
partition and the read falls back to the set-wide board - which is the giant
component plus 2.6%. `SCENE_BOARD_MAX_ROWS` (20,000, 3.2x the current board)
bounds it, and past the cap the answer reports `coverageComplete: false` rather
than truncating silently, because the partition is in rank order and what is
lost is the scene's low-rated tail. Re-measure with `scripts/metrics/` against
production before treating these as anything but arithmetic.

The route inherits `cacheRanking` (300s browser / 3600s edge) because it *is*
`/api/rankings` - deliberately, rather than a `/scene/:id` of its own, which
would have had to opt in. CloudFront's `/api/*` policies carry `default_ttl =
0`, so a route that forgets the header is uncached at the edge and pays this
read per visitor. One other honest wart: **page two of a scene board costs the
same pool read as page one**, because the filtered list lives for one request
and the cursor is an offset into it. It is left that way rather than papered
over with `Limit` + filter, and in practice it almost never happens - a scene's
rated population is tens of players against a page size of 25.

**What was declined, with its price.** A stored `RANKING#scene:<id>` board in
the engine would make this ~2 read units. Per refit it costs one row per rated
player per scene plus one `RANKING_META#` header per scene; scenes partition
players by home store, so ~6,100 rows and ~1,123 headers - about **7,200 extra
writes on a refit that already writes ~27,000 profiles and ~17,000 rating
points**, ~15% more write traffic, plus a scraper change and a refit before a
single scene board exists. The storage contract already hands this decision to
the API ("whether scenes deserve ladders of their own is a decision to take
with the API rather than by writing them"), and at this read volume behind an
hour of edge cache the filter is cheaper. If `SCENE_BOARD_MAX_ROWS` ever binds,
that is the trade to revisit - not a bigger cap.

**Ranks: a dense re-rank inside the scene.** `rank` is 1..N over the scene's
own rows that earn a position, not the pool's numbers with the other scenes' rows
cut out - a board opening on `#37` and climbing in gaps is the pool's board with
holes in it, not "this scene's ladder". It is safe because the restriction is
**order-preserving**: the rows are a subset of one component sorted on the same
posterior mean, so the scene's order can never contradict the pool's about who
is ahead of whom. `LeaderboardEntry.poolRank` carries the pool's own number
beside it - the engine's `rank` off the row it wrote, not a figure re-derived
here - so a reader sees both and can check one against the other ("2nd in
Peninsula, 37th in the pool"). It is null on every stored scope, where `rank`
already *is* the board's position.

**The gate is unchanged and still measures the component.** `earnsPosition`
tests `isComparable(componentSize)`, and `CONFIDENCE.minComponentSize` is a
threshold on the **pool**: a 3-store scene inside a 2,000-player pool gets
positions, and a 40-player scene whose pool is 6 gets none. Re-pointing it at
the scene's own `playerCount` would be a different claim about identifiability,
measured from nothing, and it is not made. `coverage.minComponentSize` is
published unchanged so the page quotes the right number - the frontend's old
wording, "a position needs a scene of at least 8 players, and this one has 3",
is the mistake this avoids.

**A scene whose players span more than one pool.** `SCENE#` carries
`componentCount` precisely so this can be told rather than smoothed over. The
board holds the rows of the **modal** pool only, and the header says so:
`singlePool: false`, `componentCount`, and `omittedPoolRows` - how many of the
scene's rated rows are on another board. Be precise about which claim that
qualifies: the rows shown are all in one pool, so **their order is real** and
`comparable` is unaffected. What is incomplete is the board's *coverage of the
scene*. Mixing the pools would be the cross-scale board the ladder already
declines to call a placement, and it is not done.

**Coverage comes from the scene, not from the board.** The board holds a row
only for a rated player, so it structurally cannot say how many people play in
the scene; the `SCENE#` item can, and `coverage.totalPlayers` is its
`playerCount` - the same figure the event page's scene line prints, so the two
agree.

**Three absences, all 200, none an error.** No `SCENE#` item for the id
(`known: false`), no pool (`componentId: null`, board named and empty), and no
scene reader on the store at all. Each is also the state of a healthy deploy
whose engine has not refitted since the assignment was accepted, and a shared
`?scene=` link must not die for a deploy order - same rule as "Never seen is not
absent".

**The pool board is untouched and still reachable.** `component:<id>` serves
exactly what it always did, `scene` is null on it, and it carries no `poolRank`
column. It is the honest answer to "who else is on this scale", so the scene
board links to it ("See the whole rating pool") - it is simply no longer the
thing a scene link lands on.

### The scene map

`GET /api/rankings/map` answers "where are the competitive scenes" in one
request, and the shape of the answer is the whole of its honesty.

**It reads `SCENE#`, not `COMPONENT#`, and that was a bug fix rather than a
refactor.** The endpoint used to serve the component catalogue under
scene-shaped field names. A component is a reachability closure of the co-play
graph - one travelling player welds two cities into one permanently - so the
measured result was a map whose list read `Karlsruhe, Deutschland` and
`Paris, France`, with `Peninsula`, `South Bay` and the other 1,121 real,
named scenes **not selectable anywhere on it**; and a `?scene=<sceneId>` link,
the only kind the event page can build, resolved to the unfiltered world view
because the ids came from a different partition. The event page and the player
profiles were already on scenes; the map and the picker were the two surfaces
left behind.

**One Query plus one GetItem, no parameters.** The engine's `SCENE#<sceneId>`
items carry GSI1 keys, so the whole directory is a single Query against one
partition - 1,123 scenes on the live assignment, the same order as the 1,235
components it replaced (**46 read units**, measured against production on
2026-10-27) and therefore the same cost. The GetItem is the engine's scope
directory, for `coverage.unassignedVenues` / `unassignedPlayers`: see "What is
in no scene" below. No scan, no profile fetches, no leaderboard pages. It takes
no bounding box and no zoom on purpose: this is one cached answer every reader
shares, and a viewport parameter would fragment the edge cache into a key per
pan for a payload a browser can filter itself. `cacheRanking` applies, because
the directory only moves when the engine refits.

**A scene is not a rating scale, and the payload keeps them apart.** A scene
entry carries `componentId`, `componentSize` and `componentCount` - the **pool**
holding most of its home players - and `comparable` is
`isComparable(componentSize)`, a statement about that pool's board rather than
about the scene's own player count. A caller presents the two as two facts;
the frontend's `sceneLadderNote` is that sentence and the picker's row meta
says "ladder shared with 3 other scenes". `componentId: null` is a normal
value - nobody who plays there has been replayed - and means the scene's board
comes back empty, not that the scene is defective.

A scene's pin now links at **its own board** (`scope=scene:<id>`), which it did
not when this endpoint was written: it linked at `component:<id>`, and the
measured consequence was a San Francisco scene opening a ladder headed `North
West Community Development Council`. Nothing in the paragraph above changed to
allow that - a scene board is this pool's board *filtered* - and the pool link
is still published, under its own name. See "A scene board is a filter, not a
fit".

**What is in no scene.** A catalogue of scenes cannot express an absence: a
store whose regulars only ever play visitors fails the engine's intra-scene
play-share gate and is simply not in the directory, so there is nothing for a
page to render. 38 venues and 172 of 39,390 players on the live assignment; 97
venues and 527 of 63,951 on the 2026-10-31 proposal. The figures therefore ride
on `coverage`, off the engine's scope directory (`getSceneCoverage`, one
GetItem, ~1 read unit on an already edge-cached route), and they are **null**
rather than 0 for an engine that does not publish them - 0 would claim every
store is placed. They travel even when the directory is empty, which is the one
state in which they are the only numbers there are.

**The place is read, never derived here.** A component has no coordinates of
its own; they live on the per-player `MATCH#` items, and there is no index from
a component to its matches, so locating 1,235 scenes at request time would be a
walk of the derived data. The engine does it during its replay, where every
coordinate and every component membership is already in hand, and writes the
answer onto the catalogue item - see scraper/CLAUDE.md, "Giving a connected
component a place on a map", for the derivation and for why it is a
match-weighted *spherical* centroid with a spread published beside it.

**A centroid is arithmetic; a place is a claim, and they are not the same
thing.** This is the part of the endpoint that cost the most to get right,
and - usefully - it is the part the move to scenes mostly retires.

The whole distribution `SCENE_CENTROID_MAX_KM` was measured on is a
distribution over **components**, and the pathological entries are pathological
because a component has no geometric bound: the largest (5,254 players, 325
venues) centres 360km out in the Gulf of Thailand and a 2,138-player one
centres 2,080km into the Pacific.

**A scene is diameter-capped, so it cannot do that.** Every store in one is
within `--max-diameter` (30km) of every other, and a weighted mean of mutually
within-30km points lies within 30km of each of them - so the centroid is at most
~30km from the scene's own nearest venue, against a 100km gate. Measured on the
2026-10-31 production proposal the largest scene extent in the corpus is
**29.9km**, and 0 of 1,432 proposed scenes (and 0 of 1,123 live ones) are
`dispersed`. The 20 scenes holding 40% of recorded players that used to come off
the map were components, and they are gone with the component keying.

The gate is kept, not deleted, and `SCENE_CENTROID_MAX_KM`'s comment says why:
`--max-diameter` is a knob an operator can raise, and `--method louvain` is
still the engine's default and has no diameter bound at all. A gate that never
fires costs one comparison per scene.

`spreadKm` does **not** separate those cases, which is the trap: a 448km spread
centred on Germany is a national scene whose centre has stores all around it,
while a 1,858km spread centred on water is not a location. The figure that does
separate them is the distance from the centroid to the scene's **nearest own
venue**, and `SCENE_CENTROID_MAX_KM` (100) is the gate - measured, with the
whole distribution in its comment in `models/ranking.ts`. The histogram has its
gap exactly there: 4 scenes in the 50-100km band against 10 in the 100-250km
band with ten times the players.

Be clear about the price, because it is not small: **20 scenes holding 40% of
recorded players come off the map.** They are `dispersed: true` in `unlocated`,
keeping `spreadKm`, `nearestVenueKm` and `topVenues`, so the page lists them,
explains them with the distance that caused it, and the map draws their actual
venues when one is selected. A pin in the Pacific would not have been a better
answer.

**Located and unlocated are separate lists, and neither is an error.**
`scenes` is what a map draws; `unlocated` is every scene whose own venues carry
no coordinates **or** whose centroid failed the gate above. They are split
rather than mixed-with-nulls so a caller cannot render an unlocated scene by
forgetting a null check, and `dispersed` tells the two reasons apart - "we do
not know where this is" and "this is not in one place" read completely
differently. Nothing is placed at a guessed point, and the two tempting
fallbacks are both refused in `getSceneMap`:

- *the region label's city.* `regionLabel` is a modal city name - a production
  component reads `Rockhampton, Australia` with no geocoded event behind it -
  so forward-geocoding it would present a city centre with the same authority
  as a venue-weighted centroid, and spend a Mapbox call per scene to do it.
- *`0, 0`.* A coordinate is only ever read as a pair, in the adapter, so a
  half-written item reports unlocated rather than landing in the Gulf of
  Guinea.

**Deploy the scraper first.** Production's 1,123 `SCENE#` items exist and were
rewritten by a refit as recently as 2026-10-31, and they carry **no place
fields and no `componentId`** - the engine that writes them is the change beside
this one. So an API deployed ahead of the scraper serves 1,123 scenes that are
all unlocated and all unlinked, and the page honestly says so ("1,123 scenes,
none of them locatable") for up to `RANKING_REFIT_INTERVAL_HOURS` (24). That is
the same discipline every other null here follows and it is not a failure
state - but it is a worse map than the one it replaces, so the order is: deploy
the scraper, let one refit run, then the API and the frontend.

**"We cannot tell" is not "nothing is located".** `coverage.catalogueUnavailable`
is true when the catalogue could not be read at all - a store with no catalogue
reader, or an engine that has never refitted - and the page renders a different
sentence for it. Reporting "0 of 0 scenes" there would claim there are no
scenes. This is the live state until the scraper is redeployed and refits:
the `COMPONENT#` items exist and carry no place fields yet, so every scene
comes back unlocated and the map says so.

`coverage` counts the **whole** catalogue rather than the drawn subset -
`locatedScenes` against `totalScenes`, `locatedPlayers` against `totalPlayers` -
because the ratio between them is the caveat the page prints, and it cannot be
derived from a list that has already been filtered.

`getComponent(componentId)` is the other access pattern on the `COMPONENT#`
items, which is why `listSceneCatalogue` survives the move: one GetItem for a
caller that already holds the id, ~1 read unit against this Query's ~46. The
event page's rating-pool line is that caller - see "An event's scene" - and it
is optional on the store for the same reason this is. `getScene(sceneId)` is the
matching read on `SCENE#`, and it shares `listSceneDirectory`'s mapping
verbatim, so a scene named on an event page and the same scene drawn on the map
can never read two different labels, or two different places, off one item.

`listSceneDirectory` is **optional** on `RankingStore`, like `listSetCatalogue`
and `listSceneCatalogue`, and for the same reason: those items only became
enumerable once they carried GSI1 keys. A store without it, or one whose Query
fails, reports `catalogueUnavailable` rather than a 500 - a map is not worth
taking a page down for. An **empty** directory reports the same thing, and that
is deliberate: no `SCENE#` item exists until an operator has accepted a
re-clustering *and* a refit has run since, and "0 of 0 scenes" would claim there
are none.

Note what this deliberately does **not** change: `listComponents` still
summarises the scenes on the global board's first page, which is what the
ladder's picker wants and is a different question at a different cost. The two
reads are separate on purpose.

### Searching for a player

`GET /api/players/search?q=` reads the engine's published display-name index
(`PLAYER_SEARCH` / `SHARD#<nnn>`; see scraper/CLAUDE.md, "The display-name
index") and matches it in memory. `adapters/playerNameIndex.ts` is the matcher,
`adapters/rankingDynamoAdapter.ts` holds the loaded index between invocations.

**It did not. It was a capped Scan, and that was not a performance note - it
was a correctness bug the whole way through.** `Limit` on a Scan caps the items
*examined before the filter*, not the matches, so four pages of 500 looked at
2,000 raw items and returned whatever had matched by then. Measured against
production on 2026-10-29:

| | |
|---|---|
| items in the table | **441,214** |
| `PROFILE` rows | **40,979** |
| items one query examined | 2,000 |
| `PROFILE` rows among them | **178** |
| **share of players searched** | **0.43%** |
| read units per query | **203.5** |

The visible symptom is what this section exists to record, because the previous
wording ("a capped Scan until a GSI can be batched with other infrastructure
work") described it as a known limitation and it was not a limitation, it was
an endpoint that answered wrongly. Search was **anti-correlated with
relevance**:

```
sealsmasher  -> 1 result   (found: 1st in scan order)
Dromex13     -> 1 result   (found: 2nd)
illusionz    -> 0 results  (rated, on the public leaderboard)
tpcstld      -> 0 results  (rated, 1,380 +/- 97, 8 games, on the leaderboard)
```

So the two players the ladder *does* list were unfindable and the two it does
not were findable. And an empty `data` could not be read, because
`searchPlayers` returned a bare array: "no player by that name" and "the 0.43%
this query examined contained nobody" were the same response. That is how the
ladder page printed "No player by that name." over players it was rendering on
the board beside the search box.

**What it costs now.** The index is held in module scope for
`SEARCH_INDEX_TTL_MS` (15 minutes), so the steady-state query is the BatchGet
for the hits it is about to publish and nothing else - ~10 keys, **~5 read
units**, against 203.5 for a 0.43% answer. A cold Lambda additionally reads the
8 shards, ~1.2MB of gzip, ~150 read units eventually-consistent: so even the
pathological case where every request lands cold is cheaper per query than the
Scan it replaces, with 100% coverage instead of 0.43%. Concurrent cold requests
share one load. `/api/rankings`'s ~16 units is the yardstick.

**No full-table Scan per query, in either path.** The index path is one Query
on one base-table partition. The fallback path is still a bounded scan, and it
exists only for the window before the engine's next refit publishes the shards -
it reports `coverage.complete: false` so that answer is never passed off as a
complete one, and `playerSearch.test.ts` pins that no Scan is issued once the
index exists.

**Substring search is kept, and that is why this is not a GSI.** A GSI answers
`begins_with` and nothing else. Measured over 8,000 real display names from the
live ladder, of every 2-to-4 character substring that occurs in a name a
whole-name prefix index finds **14.8%** and a word-prefix index **17.3%** -
the corpus is dominated by single-token handles, so whitespace tokenisation
buys 2.5 percentage points. A prefix index would have fixed all four failures
above, which are exact names, and would have quietly stopped answering
`smasher` for `SealSmasher`. The scraper doc has the rest of the comparison,
including the write cost of a GSI and the fact that **no Terraform change was
needed at all** - so there is no plan/apply/refit ordering to get right and no
window where the code wants an index that does not exist yet.

**Results are ranked now, which is what makes a cap of 25 enough.** Scan order
is no order at all: the old endpoint returned whichever ten matches it reached
first and threw away the rest without comparing them. `scoreNameMatch` ranks
exact name, then name prefix, then word prefix, then name substring, then tag
line - a tag line last because it is short and shared (`NA1` is thousands of
players) and must never outrank a name hit. Ties break on the shorter display
name, then lexicographically, then on `playerId`, so one URL has exactly one
answer - which an edge-cached route requires, or two origin hits give two
orders.

**`coverage` travels with the hits**, for the reason `catalogueUnavailable`
does on the scene map: a filtered list cannot be read honestly without knowing
what it was filtered from. `complete`, `searchedPlayers`, `matched`,
`truncated` and `maxResults`, so the page prints "showing the closest 25 of 112"
or "only some players could be searched" instead of one sentence that is wrong
two ways out of three.

#### The privacy consequence, stated rather than glossed

Completing the index **does** make the player corpus easier to enumerate
through this endpoint than a 0.43% scan did. That is a real consequence of
fixing the bug and the cap was never designed as the guard - it was doing the
job by accident. Four things answer for it, and only the first two are new:

- **A route-specific cap of 25** (`PLAYER_SEARCH_MAX_RESULTS`), below
  `MAX_PAGE_LIMIT`'s 100. A person picking a player from a list does not scroll
  100 names, and the 25 are now the *best* 25.
- **No cursor.** There is no pagination on this route, so the capped set is
  everything a caller can get for a needle, however many times they ask. This
  is the actual guard; the cap is the size of it.
- Minimum two characters, unchanged: a one-character query matches a large
  fraction of 40,979 players in response to no information at all.
- `X-Robots-Tag: noindex, nofollow` and the general rate limiter (100
  requests/minute per IP), both unchanged.

And the measurement that puts it in proportion, because it is the one that
would otherwise be missing: **`/api/rankings` is already a bulk export of the
rated corpus.** It is cursor-paginated with a limit of 100 and no cap on pages,
and while this change was being measured it returned **8,000 distinct players'
display names and tag lines in 80 public requests** - `illusionz#1337` and
`tpcstld#NA1` among them. So the names search can now find were already
enumerable; what search could not do was find one of them on purpose. The
index does not create the export surface. If bulk export of the rated board
is itself unwanted, the place for that is `/api/rankings`'s pagination, not
here - and it is a separate decision from this one.

**The index is never served to a reader.** It is read inside the Lambda. The
rejected alternative was publishing it to S3 behind the existing CloudFront and
filtering client-side - instant, free per query, and it would hand every reader
of the ladder page a 1.2MB gzipped file of every player's name. See
scraper/CLAUDE.md, "Privacy of the derived ratings", for that decision in full;
the short version is that this codebase already treats aggregation as a change
in kind even when every underlying fact is public, and a roster handed to every
visitor is the aggregation step.

### Never seen is not absent

`/api/players/:id` **does not 404 for a well-formed id**. An id the engine has
no item for comes back 200 with every number null, the verdict `no-rating`,
`gamesUntilRated: CONFIDENCE.minGames` and **`known: false`** - the same field,
with the same meaning, that `TournamentPlayer.known` already carried. A
malformed id is still a 400.

It used to 404, and three things were wrong with that:

1. **The API contradicted itself.** For one id off a live upcoming event's
   roster, `/api/players/:id/matches` answered 200 with `data: []` and
   `/api/players/:id/ratings` answered 200 with `points: []` and
   `provisionalReason: 'no-rating'`, while `/api/players/:id` answered 404.
   A resource whose two sub-resources exist is not absent.
2. **A bookmarked link changed meaning.** Most of a field is `known: false` -
   15 of 22 on one live event, 5 of 5 on another - and every one of those
   players gets a profile the moment the engine next sees them. Under the 404
   that URL was dead and then alive; the `no-rating` profile is the same page
   throughout and simply fills in.
3. **Enumeration had to branch.** Anything listing a field can now point at
   every player uniformly instead of asking first whether the link would 404.

Nothing the 404 carried is lost - it moved into a field, which is where this API
already puts that distinction - and nothing is asserted that is not known: the
body says "no rating here for this id", exactly as the sibling endpoints do, and
never that a player exists. The reading is the same as `points: []`: a 404 is
about the resource, and the resource is this API's answer about an id, which it
always has.

What the frontend does with that is a separate decision from what the API owes.
Linking only `known` players is still right - "No record yet" is a dead end for
a reader who clicked a name - and a page reached by a bookmark should read
`known` rather than a status code to tell "no record yet" from "no such player".

## Tournament facts

The scraper's third pass stores, per event, who registered and what happened:
`RESULTS#<externalId>` / `SK: RESULTS#<externalId>` and `ROSTER#<externalId>` /
`SK: ROSTER#<externalId>` (the sort key repeats the prefix - that is the
scraper's shape). Both are **immutable captures** and both denormalise the event
context (`eventStartDate`, `eventType`, `playFormat`, `shopExternalId`,
lat/lon), because the event rows age out after 60-90 days while the facts carry
no TTL. The API only reads them, through `TournamentStore`, selected by exactly
the same rule as `RankingStore`:

- `DB_TYPE=dynamodb` -> `tournamentDynamoAdapter` (the real items)
- anything else -> `tournamentFixtureAdapter`
- `RANKING_SOURCE=auto|dynamodb|fixture` forces either one (one knob for both
  stores: the tournament endpoints are useless without the rating profiles)

PostgreSQL is absent rather than half-supported, on the same grounds as the
scraper's `supportsEventFacts()`. SQLite *does* hold facts on the scraper side
(`event_results` / `event_rosters`), but the API has no SQLite reader for them,
so `./dev.sh` falls to the fixture - as the ranking endpoints already do.

### `GET /api/events/:externalId/tournament`

One response shaped so a page renders event info -> tournament details ->
Standings / Pairings / Roster top to bottom with nothing re-derived client-side:

- `event` - the denormalised context off whichever fact exists, plus
  `tournamentId` (the `prb-` prefix stripped; null for a UVS-only event).
- `results` - null when no capture exists. `status` is `final` / `partial` /
  `none`; `none` means the organizer never ran pairings through Riot's software
  (~29% of finished events) and is a fact, not an error. `trimmed: true` means
  the pairings were dropped to keep the item under DynamoDB's 400KB limit, so
  `rounds` is empty while `standings` is complete. `standings[]` carry Riot's
  Swiss tiebreakers and the resolved `player`; `rounds[].matches[].sides[]`
  carry the per-game detail and a compact `player`. `byes[]` resolves
  `byeTeamIds` to names. Match `status` is **not** a finality signal (Riot
  leaves matches `IN_PROGRESS` inside `FINALIZED` rounds - 676 of 722 live
  matches, and every `COMPLETED` one of the other 46 is a bye) - read the
  round's. Three things the capture carries awkwardly are normalised here
  rather than by each consumer: see "One shape per fact" below.
- `scene` - which connected component this event belongs to. **Always
  present**, carrying its own reason when there is none (see "An event's
  scene").
- `roster` - null when none was captured. `source: 'registrants'` carries
  `registeredAt` per entry; `source: 'participants'` is a post-event recovery
  and has none.
- `players` - every distinct player across both facts, enriched, in standings
  order where there is one and registration order otherwise.
- `field` - strength of field over the **rated** players only, with
  `ratedSample` / `ratedShare` / `totalPlayers` alongside, so an average over 3
  of 24 can never be read as describing the field. Both averages are null when
  nothing cleared the bar.

200 with the roster alone is normal and common: that is the strength-of-field
preview for an event that has not happened yet. 404 only when the event has
**neither** fact.

**Ratings are published with their margins**, as everywhere else: `rating` and
`uncertainty` travel together for every player in the field, provisional or not,
and only a rating below the display floor is held back (see "A rating is
published with its uncertainty"). The ranking endpoints hold the same line, so
the two can never disagree about one player - they used to. `gamesPlayed` and
`gamesUntilRated` are always carried, and `known: false` distinguishes "the
engine has never seen this player" from "seen, but no position yet".

Profiles are fetched with one `RankingStore.getPlayers()` BatchGet for the whole
field - never a GetItem per player.

**Each player carries their own scene, beside their own region.**
`TournamentPlayer.sceneId` / `sceneLabel` is the scene the engine assigned to
that player's **home venue**, and it is what a roster's place column should
print. The other two place fields on the row are the reasons why:
`regionLabel` is the player's home city, so a column of it names as many places
as the field has home stores - on `prb-117397899890353177` six known players
carried `Redwood City, CA` x3, `San Carlos, California` x2 and
`Sunnyvale, California`, where the scene answer is `Peninsula` x5 and
`South Bay` x1 - and `componentId` is a connected component that spans several
scenes, so its label names none of them in particular. They are read off the
same `PLAYER#<id>/PROFILE` items the BatchGet above already fetches, so this
costs **no extra read**.

Both are null for a player whose home venue is in no scene: **196 of 7,411
sampled production profiles, 2.6%**, against 99.9% that carry a `regionLabel`.
So "has a region, has no scene" is a normal state and `enrich()` does **not**
fall back from one to the other - a `sceneLabel ?? regionLabel` would put a
city back under a column headed Scene, silently, on exactly those rows.

### An event's scene

`detail.scene` answers "which scene is this event in", and it is read off **the
venue the event was held at**. The engine assigns a scene to a *store* (see
scraper/CLAUDE.md, "Geographic scenes"), and an event carries a
`shopExternalId`, so `resolveScene` in `services/tournamentService.ts` is a
`GetItem` on `VENUE#<shopExternalId>` plus, when that store has a scene, one
more on `SCENE#<sceneId>` for the scene's own size. ~2 read units, on a route
already edge-cached for 15 minutes, and the second is skipped whenever the
store has no scene.

**It used to tally the components of the players who attended, and that was
wrong in a way a reader could see.** A component is a connected component of
the co-play graph, reachability is a transitive closure, and so one travelling
player welds two cities into one component *permanently* - no amount of
coverage separates them again. Measured on production, `ce3da9bead6` held 1,688
players across 110 venues with a 1,514km spread, carried the label `New York,
New York`, and had all five of its busiest venues in California. So a shop in
Redwood City, CA displayed **"Scene: New York, New York"** on its own event
page. The venue's scene is bounded to 30km by construction and cannot do that.

**`componentId` still means a connected component, and still travels.** That is
deliberate, not leftover: `crossComponentUncertainty` is only correct for a
connected component, because the floating rating offset it corrects for is a
property of reachability and nothing else, so `comparable` has to stay a
statement about the component. The tally is also free - the profiles were
fetched for the field anyway, and `componentSize` is denormalised onto every
one. Two facts therefore travel side by side: *this event was held in the
Peninsula scene*, and *these players' ratings are on one scale with these
others'*. The ladder the page links to is the **scene's** now
(`scope=scene:<id>`), which is that component's board filtered to the scene -
so `componentId` is no longer what either link is built from, and is still what
the second of those two facts is made of. See "A scene board is a filter, not a
fit".

**Four statuses, and only one of them prints a line.** `no-matches` (nothing
was paired here), `no-venue` (games, but no resolved store - a Riot organiser
`shopMatch.ts` never tied to a shop row), `unassigned` (the store is known and
has no scene **yet** - the normal value, since no venue has one until an
operator accepts a re-clustering, and a store whose cluster fails the
rankability gate keeps none afterwards), and `scene`. `getVenue` and `getScene`
are optional on `RankingStore` on the same terms as `getComponent`, and a
missing method or a failed read reports `unassigned` rather than a 500 - a
whole event page is not worth losing for one line on it. Note the direction:
a reader that cannot answer for a store reports "no scene known", never
`no-venue`, which would claim the event has no store when it names one.

One consequence worth knowing, because it is an improvement rather than a
regression: the scene no longer depends on the replay. An event whose players
the engine has not placed yet still names its scene, and only the ladder link
is withheld.

**The roster is deliberately not counted** in the *component* half. A player
who signed up and never sat down contributed no edge, so this event is no
evidence about which component they are in - they may be in another, or in
none, never having been replayed. On one live upcoming event 15 of 22 of the
field were `known: false`; on another, 5 of 5. `matchPlayers` publishes the set
the answer was taken over. (The scene half is immune to all of this: it is a
property of the store.)

**The pairings are the witness, and the standings are the fallback.** A bye is
already out of `matches` (it is the absence of a match and contributes no
edge). For a `trimmed: true` capture, where the rounds were dropped to stay
under the 400KB item limit and the standings stayed whole, a non-zero Swiss
record is the only remaining witness. The one case that misses is a player
whose whole tournament was byes - Riot scores a bye as a match win - which is
left as a stated imprecision rather than guessed at, because it only arises on
an event large enough to have been trimmed, where it does not occur.

**`componentCount` is published because unanimity is not guaranteed, and the
hole is worth knowing.** The event's matches connect the players they *pair*,
not all of them - one round of eight players is four disjoint edges, so a short
event's own pairing graph need not be connected - and the engine places a
player from the history it last replayed, so a capture newer than the last
refit can leave two players here carrying the components they had before it.
Measured against production, both are rare: **7 played events across 2 scenes,
5 to 53 players each, every one unanimous** (`componentCount: 1`), which is
consistent with 0 of 56,257 recorded games crossing a scene. So the dominant
component is named, ties break on the id, and `playersInScene /
placedPlayers` is what lets a page qualify the claim instead of asserting it.

**The scene's name comes off the scene, never off a player and no longer off
the component.** `PlayerRecord.regionLabel` is the *player's* home region: on
the live board, component `c2e62a47563` holds players labelled `Central
Singapore Community Development Council, 01`, `North West …, 03`,
`South West …, 05` and `South East …, 04` - four names for one scene, two to
four of them turning up on any one event. So naming a scene from whoever
attended would give it a different name on every event page. The component's
own label is no better for this purpose, because a component spans several
scenes and its modal city is therefore a name for none of them in particular -
which is how `New York, New York` ended up on a Californian shop.

The name is read off `SCENE#<sceneId>`, falling back to the copy the engine
denormalises onto the `VENUE#` item - they are written from one assignment so
they agree, and preferring the scene's means one scene cannot be named two ways
across two event pages. `null` is normal for a scene whose stores are not
reverse-geocoded, and `getScene` missing or failing reports the scene with no
size rather than a 500. `getComponent` is still read, at ~1 read unit, for the
**component's** own label - it answers "what is this rating pool called",
which is a different and still-useful question.

**Known drift, not introduced here:** `/api/rankings`'s `component.regionLabel`
and `components[]` come from `listComponents()`, which reads whichever
*player's* label the global board's first page happened to carry, so the ladder
can head a scene with a different name than `/api/rankings/map` and this
endpoint give the same scene (`ce3da9bead6` read `Simi Valley, CA` on the
ladder and `New York, New York` on the map on 2026-10-27). The engine also
writes a third label on `RANKING_META#component:<id>`, a modal over the
**rated** members only. The catalogue item's is the one over all members and is
the one to converge on.

No route changed, so `cacheTournamentFacts` (300 / 900) still applies
unaltered - the scene rides the response it was added to.

### One shape per fact

The capture is Riot's, and three of its shapes each cost a consumer a rendering
bug. All three are now decided once, in `tournamentService.toResults`, so no
reader has to re-learn them. Every figure below was measured against live
production captures (30 events, 722 matches, 1,444 sides, 87 rounds).

**A drawn match is `TIE`, and this API publishes `draw`.**
`TournamentMatchSide.outcome` is normalised to the vocabulary
`/api/players/:id/matches` has always used - `win` / `loss` / `draw`, plus
`unknown` for a word this API does not cover - and `rawOutcome` carries Riot's
verbatim value beside it. Measured vocabulary: `WIN` 686, `LOSS` 686, **`TIE`
72**, `DRAW` **zero**. On `prb-117293942130857502` round 2 both sides came back
`TIE` over a 1-1 whose own standings rows read `matchDraws: 1` and 4 match
points, so a consumer matching on `DRAW` printed "no result" over a draw the
same capture had already counted - one capture telling two stories.
`normaliseOutcome()` in `models/ranking.ts` is the single word table, shared
with `rankingDynamoAdapter`, so a draw cannot be spelled two ways in one API.
Both `TIE` and `DRAW` map, because the feed that produced one can produce the
other on Riot's next deploy. Anything unlisted - `FORFEIT`, `DISQUALIFIED`,
`NO_SHOW` - becomes `unknown` rather than a guess: a forfeit is
administratively a loss, but recording it as one would be this API inventing a
result it was not given, which is the same mistake in the other direction.
`null` still means the capture carried no outcome at all, which is a different
thing from a word we could not read.

**A bye leaves once, in `round.byes`.** Riot publishes every bye twice - in
`byeTeamIds` *and* as a synthesised match (`bye-<teamId>-r<n>`, `bye: true`,
the empty half a `bye-opponent-…` team with no player, no table, pre-created
games nobody won). Serving both printed every bye player twice. `byes` is the
half that survives, because a bye is the *absence* of a match: it has no table,
no games and no opponent, and `matches` is for pairings that were played. Of 87
live rounds, 42 carried a bye and all 42 agreed exactly across the two shapes,
so nothing is lost; a bye that somehow arrived *only* as a match is folded into
`byeTeamIds` rather than discarded, because silently losing a bye would be worse
than the duplicate was. `TournamentMatch.bye` stays in the type and is **always
false** - it is the assertion, not a field to branch on - and no `bye-` prefixed
match or team id leaves the API.

**The pairings leave in table order.** The store returns capture order, which is
whatever Riot's software did: round 1 of `prb-117293942130857502` arrives
7, 6, 4, 3, 2, 1, 5, and 21 of 87 live rounds are out of order. `tableNumber` is
the capture's own ordering field, so the API sorts by it (match id as the
tiebreak) and every consumer gets one order - the same argument as normalising
the outcome. `standings[]` were already sorted by rank; `players[]` is standings
order then registration order.

### `GET /api/events/tournament-availability?ids=a,b,c`

One BatchGet over both fact keys of every id, with a metadata-only projection
(`PK, status, playerCount, roundCount`), so the day list can decide on a trophy
for ~20 events without transferring their standings. Capped at 50 ids, Zod
validated, duplicates collapsed, and **every requested id comes back** so the
caller needs no null handling.

`hasResults` is content-bearing: a capture with `status: 'none'` holds nothing,
so it reports `hasResults: false` with `resultsStatus: 'none'`. `hasTournament`
(`hasResults || hasRoster`) is the single field a trophy should read - a trophy
leading to an empty page is worse than no trophy.

### Mount order

`routes/tournaments.ts` is mounted on `/api/events` **before** `routes/events.ts`
so `/tournament-availability` matches as a literal before the events router's
`/:id` can swallow it. Everything it does not match falls through untouched;
`tournamentApi.test.ts` pins that with `/api/events/info`.

### Privacy

These endpoints serve a public page listing named individuals, which is a
decision already taken (see the scraper's "Privacy of the derived ratings").
The posture here:

- **Only what the page needs.** `playerId` (Riot's stable UUID, and the link
  target for `/ranking/players/:playerId`), display name, tag line, the rating
  fields, and the facts themselves. No emails - the scraper never stored any.
- **No bulk export.** The detail endpoint serves one event; the availability
  endpoint answers yes/no for ids the caller already has. Both are
  `X-Robots-Tag: noindex, nofollow`, like the player routes. Note where this
  claim does and does not hold across the whole API: `/api/players/search` is a
  capped lookup with no cursor, but `/api/rankings` *is* cursor-paginated over
  the rated board with no page cap, and 8,000 players' names came back from it
  in 80 public requests on 2026-10-29. See "Searching for a player".
- **Nothing player-identifying is logged** - counts only, same rule as the
  scraper passes.
- **Identity is the UUID, never a display name.** A roster entry with no
  `playerId` is dropped rather than shown under a name that cannot be joined.

## Caching

Every GET here answers the same thing for every reader - no sessions, no
cookies, no personalisation anywhere - so the only question a cache header has
to answer is how often the underlying thing changes. `middleware/cacheControl.ts`
holds four answers and `noStore` for the two routes that must never be cached:

| routes | cadence it follows | `max-age` / `s-maxage` |
|---|---|---|
| `/api/rankings`, `/api/players/*`, `/api/sets` | the engine refits daily | 300 / **3600** |
| `/api/events/:id/tournament`, `/api/events/tournament-availability` | the scraper runs hourly | 300 / **900** |
| `/api/events`, `/api/events/info`, `/api/events/:id` | the scraper runs hourly | 60 / **300** |
| `/api/events/geocode*` | a city does not move | 3600 / **86400** |
| `/api/events/:id/visit`, `/api/health` | - | `no-store` |

**The TTLs live here, not in Terraform.** CloudFront's `/api/*` cache policies
carry `default_ttl = 0`, so a response that says nothing about caching is not
cached: the code that knows the cadence decides, and a new endpoint is
uncached until it opts in. The consequence is that these headers *are* the
mechanism - a route that stops sending `s-maxage` silently goes back to one
Lambda invocation and a full round of DynamoDB reads per visitor, which is why
`rankingApi.test.ts` and `tournamentApi.test.ts` assert them beside the
responses they qualify rather than in a block of their own (this suite already
sits near the general rate limiter's per-process ceiling, so a test that costs
a request is a test that breaks another one).

Three decisions worth keeping:

- **A deterministic 4xx keeps its freshness; a throw does not.** "Invalid
  scope" and "no tournament facts for this event" are *answers* - the second is
  the common case for most events - and answering them from the edge is the
  point of having one. `errorHandler` stamps `no-store` on anything that
  reaches it, because a transient pinned at the edge for an hour is a small
  outage rather than a saving.
- **`cacheGeocode` is mounted after `geocodeLimiter`, never before.** The
  limiter answers 429 itself, so a header set ahead of it would ride that 429
  and CloudFront would serve one throttled caller's rejection to everyone for a
  day.
- **`stale-while-revalidate` is for the browser.** CloudFront does not
  implement it; Chromium does, which turns a back/forward navigation into an
  instant render plus a background refresh. A bonus where it lands, never the
  mechanism.

The edge TTLs are deliberately far shorter than the cadences they track. An
hour against a daily refit is a rounding error on the freshness and still
collapses a traffic spike to one origin hit an hour; a day would let a whole
refit go unseen for a whole day, and "the ladder did not move when the engine
ran" is a worse failure than any amount of money it would save.

### What a cache miss costs

Measured against production, which is why the ranking routes got the longest
TTL: `/api/rankings` was **four** DynamoDB round trips and ~66 read units for
one page - a Query for the page, a second Query over the 200-row coverage
sample, and then `listComponents` doing a third Query plus an unconditional
100-key BatchGet (~50 of those units) to re-read attributes the first Query had
already returned. That BatchGet is conditional now, on the same
`needsHydration` reasoning `getRankings` uses, which takes the endpoint to ~16
units and three round trips before any caching applies.

`/api/players/search` used to be the worst of them and is now among the
cheapest: **203.5 read units** per query for an answer over 0.43% of players,
against **~5** for an answer over all of them once the name index is loaded
(~150 once per container per 15 minutes to load it). The arithmetic is in
"Searching for a player"; the thing to watch is that the index stays cached -
a regression that read the shards per query would be correct, invisible to
every functional test, and ~30x the reads.

`/api/events/tournament-availability` is the other one to watch: 50 ids is a
100-key BatchGet, and BatchGet rounds *each key* up to 4KB, so ~50 read units
whether the events have facts or not. The calendar sweeps every visible event
on every page load, so that endpoint's edge TTL is doing more work than its
size suggests.

## Database

- Dual support: SQLite (dev) and PostgreSQL (prod)
- `useSqlite()` helper checks `DB_TYPE` env var
- SQLite lacks trig functions, so Haversine filtering done in JS for SQLite mode
- PostgreSQL uses native `acos/cos/sin/radians` for efficient distance queries

## Geocoding

- Uses Photon API (self-hosted OSM geocoder)
- Results cached in `geocache` table to avoid repeated lookups
- `PHOTON_URL` env var configures endpoint
