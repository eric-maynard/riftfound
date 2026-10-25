# Frontend

React + Vite calendar UI on port 5173.

## Structure

```
src/
├── App.tsx               # Routes: / (calendar), /events/:id, /ranking, /ranking/players/:id
├── index.css             # Dracula theme + FullCalendar overrides + ranking/chart styles
├── components/
│   ├── Layout.tsx        # Section tabs + persistent calendar mount
│   ├── SectionTabs.tsx   # Events / Ranking selector
│   ├── EventFilters.tsx  # Format dropdown, distance dropdown, location search
│   ├── EventTooltip.tsx  # Hover card for events
│   └── RatingChart.tsx   # Inline-SVG rating-over-time chart
├── pages/
│   ├── CalendarPage.tsx  # Main view with FullCalendar
│   ├── EventDetailPage.tsx
│   ├── RankingPage.tsx   # Leaderboard, coverage, sparse/empty states
│   └── PlayerPage.tsx    # Profile, chart, per-set breakdown, match log
├── lib/
│   └── ranking.ts        # Pure helpers (scope, formatting, chart geometry)
├── services/
│   └── api.ts            # API client functions
└── types/
    ├── event.ts          # TypeScript interfaces
    └── ranking.ts
```

## Sections

`Layout` renders the Events/Ranking tab bar and mounts `CalendarPage` itself,
hiding it with `hidden` on the Ranking tab instead of unmounting it - so the
calendar's events, caches, filters and geolocation survive a tab switch.
`CalendarPage` takes an `active` prop and calls FullCalendar's `updateSize()`
when it comes back into view. Each tab remembers its own query string, so a
shared calendar URL and the ranking page's set/scene selection both survive the
round trip.

### Ranking
- Defaults to a *scene* (connected component), never a global ladder: ratings
  only compare players who have played each other.
- A rating below the confidence gate is not printed; the player is listed under
  "Not yet rated" with the reason and how far off they are.
- Positions are suppressed entirely when the scope mixes scenes or the scene is
  too small - with a banner saying why.
- Empty and sparse states are the primary design, not a fallback.

### RatingChart
- Single-series inline SVG, no chart library, no legend box.
- Uncertainty is drawn as a band (an error bar for a one-point series), never hidden.
- The x-axis spans the whole backfill window and the y-axis has a minimum span,
  so a two-point series reads as sparse rather than dramatic.
- Crosshair + tooltip on hover, the same readout on keyboard focus, and a
  "Show values" table twin so no value is gated behind hovering.
- Series colour `#9085e9` - the validated dark-mode violet step that clears 3:1
  on the card surface (the app's `#bd93f9` does not).

## Key Components

### CalendarPage
- Uses FullCalendar with `dayGridPlugin`
- Defaults to San Francisco, CA 25mi on load
- Tries browser geolocation, falls back to SF if denied
- Events displayed as "Time | Shop Name"
- Navigation restricted to 3-month window via `validRange`
- `fixedWeekCount={false}` prevents extra rows

### EventFilters
- Format: dropdown (All, Constructed, Sealed, Draft, Multiplayer)
- Distance: dropdown (Any, 5mi, 10mi, 25mi, 50mi, 100mi)
- Location: text input + "Use my current location" link
- Active filter shown as pill with Clear button

## Styling

- Dracula color scheme (purple #bd93f9, cyan #8be9fd, pink #ff79c6)
- FullCalendar heavily customized via CSS variables
- Fixed cell height (110px) for uniform grid
- Tooltip z-index 10000 (above FullCalendar popover)

## API Integration

- `getEvents({ calendarMode: true, lat, lng, radiusKm, eventType })`
- Frontend uses miles, converts to km before API call (`miles * 1.60934`)
- `geocodeCity(query)` for location search
