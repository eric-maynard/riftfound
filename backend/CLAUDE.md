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
│   ├── ranking.ts        # Ranking/rating schemas + confidence gate
│   └── sets.ts           # Set catalogue (discovered ids + published boundaries)
├── routes/
│   ├── events.ts         # /api/events endpoints
│   ├── rankings.ts       # /api/rankings
│   ├── players.ts        # /api/players/*
│   └── sets.ts           # /api/sets
├── adapters/
│   ├── dynamoAdapter.ts          # Events/shops in DynamoDB
│   ├── rankingStore.ts           # RankingStore interface
│   ├── rankingDynamoAdapter.ts   # Real derived ranking items
│   └── rankingFixtureAdapter.ts  # In-memory stand-in for dev/tests
└── services/
    ├── eventService.ts   # Query logic with Haversine filtering
    ├── rankingService.ts # Confidence, ranks, coverage derivation
    └── geocodingService.ts  # Photon API + geocache table
```

## API Endpoints

- `GET /api/events` - List events with filtering
  - Query params: `page`, `limit`, `city`, `state`, `country`, `search`, `eventType`
  - Location filtering: `lat`, `lng`, `radiusKm`
  - `calendarMode=true`: Returns all events in 3-month range, ignores pagination
- `GET /api/events/:id` - Single event
- `GET /api/events/info` - Scrape stats (last updated, total count)
- `GET /api/events/geocode?q=` - Geocode city/zip for location filtering
- `GET /api/rankings` - Leaderboard page for one `scope` (`all`, `set:<id>`,
  `component:<id>`, `set:<id>#component:<id>`), plus coverage and the component list
- `GET /api/players/:playerId` - Profile, per-set ratings, component info
- `GET /api/players/:playerId/matches` - Paginated match log with opponents
- `GET /api/players/:playerId/ratings?scope=` - Rating time series for the chart
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

The contract carries no "is this rating publishable" flag, so `models/ranking.ts`
derives one from `gamesPlayed` / `uncertainty` (`CONFIDENCE`) and the API returns
`provisional` + `provisionalReason`. Ranks are dense over *rated* players only;
a provisional player gets `rank: null`. `componentSize` gates comparability.

## Database

- Dual support: SQLite (dev) and PostgreSQL (prod)
- `useSqlite()` helper checks `DB_TYPE` env var
- SQLite lacks trig functions, so Haversine filtering done in JS for SQLite mode
- PostgreSQL uses native `acos/cos/sin/radians` for efficient distance queries

## Geocoding

- Uses Photon API (self-hosted OSM geocoder)
- Results cached in `geocache` table to avoid repeated lookups
- `PHOTON_URL` env var configures endpoint
