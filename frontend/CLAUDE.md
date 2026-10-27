# Frontend

React + Vite calendar UI on port 5173.

## Structure

```
src/
├── App.tsx               # Routes: / (calendar), /events/:id, /rankings,
│                         #   /rankings/players/:id, plus /ranking/* redirects
├── index.css             # Dracula theme + FullCalendar overrides + rankings/chart styles
├── components/
│   ├── Layout.tsx        # Mode switch + persistent calendar mount
│   ├── ModeSwitch.tsx    # The mark itself, switching Event View / Rankings
│   ├── EventFilters.tsx  # Format dropdown, distance dropdown, location search
│   ├── EventTooltip.tsx  # Hover card for events
│   ├── SceneSelect.tsx   # Searchable scene (connected-component) picker
│   ├── SetPills.tsx      # Set scope as a segmented control
│   ├── RecordBar.tsx     # W-L-D counts with a filled record bar
│   ├── FormStrip.tsx     # Recent form as lettered result pips
│   ├── DayEventsModal.tsx  # The "+N more" day list on phones
│   ├── EventTrophyLink.tsx # The trophy on a day-list row
│   ├── HowRankingWorks.tsx # "How rankings work", at the foot of the page
│   └── RatingChart.tsx   # Inline-SVG rating-over-time chart
├── pages/
│   ├── CalendarPage.tsx  # Main view with FullCalendar
│   ├── EventDetailPage.tsx # Event info, standings, pairings, roster
│   ├── RankingPage.tsx   # Ladder, scene summary, sparse/empty states
│   └── PlayerPage.tsx    # Summary block, chart, per-set breakdown, match history
├── lib/
│   ├── ranking.ts        # Pure helpers (scope, formatting, record, chart geometry)
│   └── tournament.ts     # Pure helpers for the event page
├── services/
│   └── api.ts            # API client functions
└── types/
    ├── event.ts          # TypeScript interfaces
    ├── ranking.ts
    └── tournament.ts
```

## Sections

The two sections are **Event View** (`/`) and **Rankings** (`/rankings`).

`Layout` renders the mode switch and mounts `CalendarPage` itself, hiding it
with `hidden` on Rankings instead of unmounting it - so the calendar's events,
caches, filters and geolocation survive a switch.

The switch *is* the site mark: the looking glass for Event View, the trophy for
Rankings, on one track with a thumb sliding under the active side and the other
desaturated. It replaces the earlier text tab bar. While Rankings is unlisted
(`SHOW_SECTION_TABS` false in `Layout.tsx`) the plain logo stands in instead, so
a deploy cannot reveal the section by accident; set
`localStorage.riftfoundRankingTabs = 'on'` to preview the switch, or follow
`?preview=rankings` - the older `?preview=ranking` is still honoured, because
that link was handed out before the rename, and `?preview=off` clears it. On
phones it leaves the fixed corner and sits in the page flow, because unlike the
bare logo it is navigation and must not be hidden.

The routes went plural with the section, matching the API's `/api/rankings`.
`/ranking` and `/ranking/players/:id` were handed out as live links, so
`App.tsx` keeps them resolving: `LegacyRankingRedirect` forwards the whole tail
plus the query string and hash to the plural path.
`CalendarPage` takes an `active` prop and calls FullCalendar's `updateSize()`
when it comes back into view. Each tab remembers its own query string, so a
shared calendar URL and the Rankings set/scene selection both survive the
round trip.

### Rankings
- Defaults to a *scene* (connected component), never a global ladder: ratings
  only compare players who have played each other.
- A rating below the confidence gate is not printed; the player reads
  **`Unranked`** and nothing else. The reason is the `title` on that word
  (`provisionalExplanation`), never inline prose - the page reports, it does not
  explain itself at every row.
- The exposition lives in `HowRankingWorks` at the *foot* of the page, headed
  "How rankings work", with a link to the engine source. Its anchor id stays
  `#how-ranking-works` through the rename: the id was handed out as a live deep
  link, and a heading is not an address. Short hints carry the same facts where
  the concepts appear: the scene picker's `?` and the dotted-underlined "Rating"
  and "Margin" column headers.
- The scene picker is searchable (`SceneSelect`): ~194 components and growing,
  so it copies the calendar's location autocomplete rather than inventing a
  second idiom. Filtering is a pure function in `lib/ranking.ts`
  (`sceneOptions` / `filterSceneOptions`) so it is tested without a DOM.
- Positions are suppressed entirely when the scope mixes scenes or the scene is
  too small - with a banner saying why.
- Empty and sparse states are the primary design, not a fallback.
- **Density is modelled on op.gg and lolchess; their tier furniture is not.**
  One summary block instead of a row of equal-weight tiles, a filled coverage
  meter instead of a bare count, a ladder row carrying position, player, rating,
  margin and volume on one line, and the set scope as a segmented control. There
  is no tier ramp and no invented precision: the headline is a rating with a
  real `±`, and a rating below the gate prints `Unranked` and nothing else. The
  top three carry *ordinal* emphasis only - heavier, brighter - because being
  first in a scene is a fact and a medal ramp would be a fiction.
- **The margin bar** (`marginScale` / `marginBar`) draws each rating ± its
  uncertainty on one axis shared by the whole page, so overlapping bars read as
  "not separated yet". Suppressed below three rated rows and hidden under
  600px: a bar with nothing beside it is decoration.
- **The games gate** (`gateProgress`) shows recorded games against the published
  threshold beside `Unranked`. A count of evidence is not a rating, so it leaks
  nothing the gate withholds.
- **Result colour is never the only signal.** Every win, loss and draw carries a
  letter - the form pips, the match row's badge, the Bo3 chips, the W-L-D counts
  - so both pages survive being read in greyscale. The record bar's segments are
  separated by a 2px gap in the track colour, because the win green and the loss
  red are only 2.29:1 against one another.
- The player page's record is computed from *loaded* matches, so the bar always
  carries a caption saying which ("All 6 loaded matches", "First 25 of 40").
- A **map of the 390 known venues** is the likely next feature. Match rows carry
  their `data-shop-id`, and both pages are a flat column of sibling sections, so
  a venues panel drops in without disturbing the layout.
- `RATING_ANCHOR` (1200) mirrors the engine's `ELO_ORIGIN`. Nothing else in the
  frontend hardcodes a rating value; the chart's axis is fitted to the data.

### Event page (`/events/:externalId`)
- Reached from the **trophy** on a day list, and only ever shown where it leads
  somewhere: `GET /api/events/tournament-availability?ids=…` (50 ids a call) and
  **`hasTournament`**, never `hasResults`. A results capture can exist with
  `status: 'none'` - a finished event whose organiser never ran pairings through
  Riot's software - and that page has nothing on it.
- Order follows UVS's own event page: event info, then standings, pairings and
  who was there. The difference is that theirs renders "No standings available"
  for events we hold the standings to.
- **Four shapes, all designed, none a fallback.** Played (standings + pairings +
  field); **upcoming** - `roster` with `results: null`, which is the
  strength-of-field preview and the most interesting state an unplayed event
  has; `trimmed: true`, where `rounds` is empty and `standings` is whole;
  and `status: 'none'`, where the event happened and nothing was recorded.
- **Three rating states, not two.** `rated` prints the number; `provisional`
  prints `Unranked` (never the withheld figure - these endpoints null it out);
  `known: false` prints **`No record yet`**, because the engine has never seen
  that player and telling them they are "unranked" claims they failed a bar they
  never stood at. At launch that is most of a field: 15 of 22 on the live event
  this was built against.
- Names link to `/rankings/players/:playerId` **only when `known`**. An unknown
  player has no profile, so `/api/players/:id` 404s and the link would be a dead
  end; those names render as plain text beside "No record yet".
- **Strength of field never prints a bare mean.** The rated subset is
  systematically the regulars, so the number always carries `ratedShare`'s
  story - "1,219 mean, across the 7 rated players of 14" - and the three groups
  are counted in words beside the ranking page's coverage meter.
- **Finality is read off the round, or off the capture - never off a match.**
  Riot leaves matches reading `IN_PROGRESS` inside rounds it has `FINALIZED`
  (21 of 22 on the live event). `openMatches` is a data-quality signal, not a
  gate. A drawn match arrives as **`TIE`**, not `DRAW`.
- Pairings are sorted into table order (the capture returns 7, 6, 4, 3, 2, 1, 5)
  and a bye is printed once: it arrives twice, as a synthesised `bye: true`
  match *and* in `byes`.
- A Bo3's third game slot arrives pre-created with `winnerTeamId: null`, so
  `playedGames` drops it rather than inventing a game that never happened.
- Standings and roster are `.table-scroll` tables with a `min-width`, so they
  scroll inside their panel and never drag the page sideways; everything else
  restacks. Verified at 390px: 16px gutters, no page-level horizontal scroll.
- **Empty states are one line.** No explanation of our plumbing, no corpus
  statistics; the reason, where there is one, is the hover hint on the line
  (`trimmedReason`, `NOT_FINAL_REASON`). The one qualifier kept is that a roster
  shown without recorded games counts towards nothing.
- Pure logic lives in `lib/tournament.ts` and is tested without a DOM - the
  five contract warnings above each have a test.

### The trophy affordance
- `EventTrophyLink` renders inside FullCalendar's `eventContent`, because the
  desktop "+N more" popover is drawn by FullCalendar and that is the only way
  into it. One renderer therefore covers both day lists. CSS then confines it to
  `.fc-popover`: availability is fetched one day list at a time, so a trophy in
  the grid cell would light only on days whose list had already been opened.
- `DayEventsModal` is the phone path and renders it as a *sibling* of the event
  button inside a coloured band - a link inside a button is invalid markup. The
  band is 44px tall so the trophy is a real touch target.
- FullCalendar's `eventClick` is one delegated **native** listener on the view
  element, so a React `stopPropagation` is far too late. The anchor stops the
  native event itself and routes by hand; modified clicks fall through to the
  real `href` so "open in new tab" still works.
- **Ink `#21222c`**, the app's own darkest surface read as dark grey. Measured
  against each composited chip colour: `#bd93f9` 6.55:1, `#ff79c6` 6.62:1,
  `#73d393` 8.62:1, `#6272a4` **3.36:1** - the slate "Other" chip is the binding
  case, and nothing lighter clears the 3:1 graphics floor there (even pure black
  only reaches 4.46:1). On the page ground the same ink is 1.40:1, which is why
  this affordance can only live on a coloured chip. Hover and focus keep the ink
  and add a ring in it: white would *drop* it to 2.26:1 on lavender, and the
  site's cyan focus ring reaches 1.63:1 there.
- It always carries an accessible name ("Standings and roster for <event>").

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
- **The Rankings surfaces are solid hex, not `rgba()` tints**, declared once on
  `.ranking-page, .player-page` (`--row-win`, `--pip-loss`, `--chip-draw`,
  `--meter-track`...). A tint's real colour depends on what it sits on, so the
  same chip measured over the page ground and over a panel gives two different
  ratios - and measuring ink against the un-composited tint of the same hue
  manufactures a false pass. Each token is the composite over
  `--color-bg-tertiary`, taken once, so a chip keeps its measured ratio when it
  moves from a panel onto a tinted match row.
- When changing any of these, measure. Walk the DOM, composite every ancestor
  background, and check the real ratio - an eyeball is not a measurement.
- FullCalendar heavily customized via CSS variables
- Fixed cell height (110px) for uniform grid
- Tooltip z-index 10000 (above FullCalendar popover)

## API Integration

- `getEvents({ calendarMode: true, lat, lng, radiusKm, eventType })`
- Frontend uses miles, converts to km before API call (`miles * 1.60934`)
- `geocodeCity(query)` for location search
