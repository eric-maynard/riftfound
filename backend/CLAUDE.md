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
- `GET /api/players/:playerId` - Profile, per-set ratings, component info
- `GET /api/players/:playerId/matches` - Paginated match log with opponents
- `GET /api/players/:playerId/ratings?scope=` - Rating time series for the chart;
  empty for a player who is provisional in that scope (the series would
  reconstruct the withheld rating)
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
exist is never "rated" (`no-rating`), and a provisional verdict always carries a
reason. The engine's reason names are its own (`too-uncertain`,
`component-too-small`) and are translated into this API's three.

**A provisional player's rating number never leaves the backend.** Every
endpoint that could carry one returns `rating: null` with `provisional: true`
and a reason - `/api/rankings` rows, `/api/players/:id` and each entry of its
`setRatings` map, `/api/players/search`, and `/api/events/:id/tournament`. The
rule is that a rating below the bar is *not published*, and a number in the JSON
is published whatever a renderer does with it: it is one devtools tab away and
it is in anyone's scrape. The frontend prints "Unranked" for the same rows, but
that is rendering, not access control.

What stays is everything that explains the state: `uncertainty`, `gamesPlayed`,
`matchesPlayed` and `gamesUntilRated`. A margin and a game count are not a
position - they are what lets a page say "three more games" instead of just
asserting a verdict.

`/api/players/:id/ratings` returns **no points at all** when the player is
provisional in that scope (`pointsWithheld: true` distinguishes that from a
player who simply has no history, which is `points: []` too). The engine writes
a history point per day of play whatever the verdict and
`PlayerRatingPoint.rating` is always a number, so the last point of a withheld
series *is* the withheld rating: serving it while nulling the headline would
withhold nothing. Points with null ratings would be a chart of nothing, so the
verdict travels instead and the chart explains itself.

Ordering, ranks and coverage are computed over the ratings **before** anything
is withheld (`publish()` is the last step in `getRankings`), so suppression can
never move a rank or shift a count. Ranks are dense over *rated* players only; a
provisional player gets `rank: null`. `componentSize` gates comparability
separately - the engine's `component-too-small` is a comparison problem, not an
evidence one, and this API expresses it as `comparable: false` rather than as a
withheld rating.

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
  leaves matches `IN_PROGRESS` inside `FINALIZED` rounds) - read the round's.
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

**The confidence gate**, as everywhere else: `rating: null` whenever
`provisional` is true, so a withheld rating is never sent and the page prints
"Unranked". The ranking endpoints hold the same line (see "The confidence gate"
above), so the two can never disagree about one player - they used to.
`uncertainty`, `gamesPlayed` and `gamesUntilRated` are always carried (a width
is not a position), and `known: false` distinguishes "the engine has never seen
this player" from "below the bar".

Profiles are fetched with one `RankingStore.getPlayers()` BatchGet for the whole
field - never a GetItem per player.

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

## Database

- Dual support: SQLite (dev) and PostgreSQL (prod)
- `useSqlite()` helper checks `DB_TYPE` env var
- SQLite lacks trig functions, so Haversine filtering done in JS for SQLite mode
- PostgreSQL uses native `acos/cos/sin/radians` for efficient distance queries

## Geocoding

- Uses Photon API (self-hosted OSM geocoder)
- Results cached in `geocache` table to avoid repeated lookups
- `PHOTON_URL` env var configures endpoint
