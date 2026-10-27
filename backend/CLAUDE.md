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
  `component:<id>`, `set:<id>#component:<id>`), plus coverage and the component list
- `GET /api/players/:playerId` - Profile, per-set ratings, component info.
  **Never 404s for a well-formed id**: a player the engine has never seen comes
  back as a `no-rating` profile with `known: false` (see "Never seen is not
  absent")
- `GET /api/players/:playerId/matches` - Paginated match log with opponents
- `GET /api/players/:playerId/ratings?scope=` - Rating time series for the
  chart. Served for a provisional player; empty only below the display floor
  (`pointsWithheld: true`), where every point is still the prior
- `GET /api/players/search?q=` - Display-name search (min 2 chars, capped, `noindex`)
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
  `X-Robots-Tag: noindex, nofollow`, like the player routes.
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
