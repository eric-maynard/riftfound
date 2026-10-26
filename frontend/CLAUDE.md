# Frontend

React + Vite calendar UI on port 5173.

## Structure

```
src/
├── App.tsx               # Routes: / (calendar), /events/:id, /ranking, /ranking/players/:id
├── index.css             # Dracula theme + FullCalendar overrides + ranking/chart styles
├── components/
│   ├── Layout.tsx        # Mode switch + persistent calendar mount
│   ├── ModeSwitch.tsx    # The mark itself, switching Events / Ranking
│   ├── EventFilters.tsx  # Format dropdown, distance dropdown, location search
│   ├── EventTooltip.tsx  # Hover card for events
│   ├── SceneSelect.tsx   # Searchable scene (connected-component) picker
│   ├── HowRankingWorks.tsx # The ranking explanation, at the foot of the page
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

`Layout` renders the mode switch and mounts `CalendarPage` itself, hiding it
with `hidden` on the Ranking section instead of unmounting it - so the
calendar's events, caches, filters and geolocation survive a switch.

The switch *is* the site mark: the looking glass for Events, the trophy for
Ranking, on one track with a thumb sliding under the active side and the other
desaturated. It replaces the earlier text tab bar. While Ranking is unlisted
(`SHOW_SECTION_TABS` false in `Layout.tsx`) the plain logo stands in instead, so
a deploy cannot reveal the section by accident; set
`localStorage.riftfoundRankingTabs = 'on'` to preview the switch. On phones it
leaves the fixed corner and sits in the page flow, because unlike the bare logo
it is navigation and must not be hidden.
`CalendarPage` takes an `active` prop and calls FullCalendar's `updateSize()`
when it comes back into view. Each tab remembers its own query string, so a
shared calendar URL and the ranking page's set/scene selection both survive the
round trip.

### Ranking
- Defaults to a *scene* (connected component), never a global ladder: ratings
  only compare players who have played each other.
- A rating below the confidence gate is not printed; the player reads
  **`Unranked`** and nothing else. The reason is the `title` on that word
  (`provisionalExplanation`), never inline prose - the page reports, it does not
  explain itself at every row.
- The exposition lives in `HowRankingWorks` at the *foot* of the page
  (`#how-ranking-works`), with a link to the engine source. Short hints carry
  the same facts where the concepts appear: the scene picker's `?` and the
  dotted-underlined "Rating" column header.
- The scene picker is searchable (`SceneSelect`): ~194 components and growing,
  so it copies the calendar's location autocomplete rather than inventing a
  second idiom. Filtering is a pure function in `lib/ranking.ts`
  (`sceneOptions` / `filterSceneOptions`) so it is tested without a DOM.
- Positions are suppressed entirely when the scope mixes scenes or the scene is
  too small - with a banner saying why.
- Empty and sparse states are the primary design, not a fallback.
- `RATING_ANCHOR` (1200) mirrors the engine's `ELO_ORIGIN`. Nothing else in the
  frontend hardcodes a rating value; the chart's axis is fitted to the data.

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
- **Contrast tokens.** `--color-text-muted` is `#a0aede`, not Dracula's
  `#6272a4`: the original scored 2.39:1 on `--color-bg` and 3.36:1 on
  `--color-bg-tertiary`, so every secondary label on the site failed WCAG AA.
  The new value clears 4.5:1 on every surface it sits on (5.15 / 7.22 / 4.64 on
  the `.row-emphasis` tint). `--color-text-muted-lifted` (`#b8c3ec`) is the same
  role on the lightest surface, `--color-bg-secondary` `#44475a`, and on the
  tinted chips. `--color-border` keeps `#6272a4`: a hairline is not text.
- `--color-red-text` (`#ffacac`) is red *as text*; `--color-red` `#ff5555` is
  3.59:1 on the page ground. Likewise `--color-green-text` for the win chip.
- A chip's ink must contrast with its own tint, not with the page: the W/L chips
  used the saturated hue on an 18% wash of the same hue.
- When changing any of these, measure. Walk the DOM, composite every ancestor
  background, and check the real ratio - an eyeball is not a measurement.
- FullCalendar heavily customized via CSS variables
- Fixed cell height (110px) for uniform grid
- Tooltip z-index 10000 (above FullCalendar popover)

## API Integration

- `getEvents({ calendarMode: true, lat, lng, radiusKm, eventType })`
- Frontend uses miles, converts to km before API call (`miles * 1.60934`)
- `geocodeCity(query)` for location search
