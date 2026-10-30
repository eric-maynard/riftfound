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
│   ├── SceneSelect.tsx   # Scene picker: a field that opens a list+map split pane
│   ├── SetScope.tsx      # Set scope as a segmented control
│   ├── TypeSelect.tsx    # Event-type picker with the chip colour dots
│   ├── RecordBar.tsx     # W-L-D counts with a filled record bar
│   ├── FormStrip.tsx     # Recent form as lettered result pips
│   ├── DayEventsModal.tsx  # The day list, as a dialog, on every width
│   ├── EventTrophyLink.tsx # The trophy on a day-list row
│   ├── RatingMoveNote.tsx  # A day's rating movement, with what it is made of
│   ├── SceneMap.tsx      # Leaflet canvas - pins on our own geometry basemap;
│   │                     #   page and mini variants
│   └── RatingChart.tsx   # Inline-SVG rating-over-time chart
├── pages/
│   ├── CalendarPage.tsx  # Main view with FullCalendar
│   ├── EventDetailPage.tsx # Event info, standings, pairings, roster
│   ├── RankingPage.tsx   # Ladder, scene summary, sparse/empty states
│   ├── ScenesPage.tsx    # The map of scenes, and the list that is its a11y twin
│   └── PlayerPage.tsx    # Summary block, chart, per-set breakdown, match history
├── lib/
│   ├── ranking.ts        # Pure helpers (scope, scene links, formatting, record, chart geometry)
│   ├── sceneMap.ts       # Pure helpers for the map (radii, bounds, copy, filter)
│   ├── tournament.ts     # Pure helpers for the event page, incl. its scene line
│   ├── calendarDates.ts  # FullCalendar date markers -> local dates
│   ├── calendarGrid.ts   # Day counts, the `+`'s name, hover-card placement
│   ├── eventColors.ts    # One chip colour per event type, measured
│   └── geolocation.ts    # "Use my current location" as a pure state machine
├── hooks/
│   └── useCurrentLocation.ts  # The browser half of it (permission, fix, name)
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
desaturated. Both marks are one composition - Riot's Riftbound swirl, inset in
a 174 canvas, with a small object laid over its open centre and pushed down and
to the right.

**The Rankings mark is generated from the Events mark**, by
`scripts/build-rankings-mark.py`, and that is the point rather than a
convenience. Three earlier versions redrew the swirl from Riot's published
artwork, and each one came out visibly different from `logo.png`'s - denser
blades, a nearly closed ring - while sitting next to it inside the same
control. The script instead lifts the swirl out of `logo.png` by hue and
saturation (blades are hue 31 at sat 1.0; the handle is hue 24 at 0.72; the
lens is unsaturated) and strokes a trophy over the result, so the two marks
share one swirl by construction and cannot drift apart again.

The trophy is placed on the lens's own measurements: 58px wide, centred
(100.5, 95), which is 41% of the 142px swirl at +14, +4 from its centre. **The composition is shared; the material is not.** A version that also
borrowed the lens's *drawing* - an unfilled grey outline - read as a trophy
made of glass, which is right for a spyglass and wrong for a cup. What the two
marks owe each other is placement and weight, not palette. The cup is solid
`#F2C230` with a `#C8891F` plinth, and every shape carries a `#4A2608`
contour: gold sits 15 degrees of hue from the swirl's `#EF7D01` and both are
fully saturated, so without that contour the cup dissolves into the blades at
36px. It is drawn at 68px, 48% of the swirl rather than the lens's 41%,
because a cup has handles, a stem and a plinth to keep legible where a lens
has one circle. Rebuild with:

```bash
cd frontend && python3 scripts/build-rankings-mark.py public/logo.png public/logo-rankings-v5.png
```

The asset filename is **versioned** because `deploy.sh frontend` only
invalidates `index.html`: an asset that changes without changing its name stays
cached at the edge and in browsers, which is why an earlier fix to this mark
looked like it had never shipped.

The switch replaces the earlier text tab bar. While Rankings is unlisted
(`SHOW_SECTION_TABS` false in `Layout.tsx`) the plain logo stands in instead, so
a deploy cannot reveal the section by accident; follow
`?preview=rankings` to see it - the older `?preview=ranking` is still honoured,
because that link was handed out before the rename, and `?preview=off` clears
it. **The URL is the whole switch**: an earlier version mirrored it into
`localStorage`, which turned the section on permanently for that browser after
a single visit, an opt-in nobody could find their way out of. Nothing is
persisted now, so `carryPreview` (`lib/preview.ts`) has to ride every internal
link - the mode switch, every back-link, every player and event link, and the
catch-all redirect. One surface that drops it strands the reader in an
unlisted section with no visible way back. On
phones it leaves the fixed corner and sits in the page flow, because unlike the
bare logo it is navigation and must not be hidden.

**Under 600px the two sides are labelled.** Two unlabelled 36px marks read as a
logo on a phone, not a control: there is no hover to lift the inactive side,
and the sliding thumb reads as decoration at that size - a first-time reader
could not tell it was a toggle. The targets were never the problem (both
measure 44x44 and `elementFromPoint` reaches the link at the centre and both
corners); the affordance was. Once the switch is out of the fixed corner it is
not competing with the calendar for width, so the names are simply shown, the
lavender wash moves from the sliding `::before` onto the active option itself -
a fixed `translateX(46px)` is wrong the moment the two sides stop being square
- and `aria-current` still carries the selected state. Measured over the real
composited ancestors: the active label `#f8f8f2` on `#5a5475` is **6.70:1**,
the inactive `--color-text-muted-lifted` on the `#3e4250` track **5.77:1**, and
the whole control is 255px inside a 390px viewport. Desktop is untouched.

The routes went plural with the section, matching the API's `/api/rankings`.
`/ranking` and `/ranking/players/:id` were handed out as live links, so
`App.tsx` keeps them resolving: `LegacyRankingRedirect` forwards the whole tail
plus the query string and hash to the plural path.
`CalendarPage` takes an `active` prop and calls FullCalendar's `updateSize()`
when it comes back into view. Each tab remembers its own query string, so a
shared calendar URL and the Rankings set/scene selection both survive the
round trip.

### Rankings
- **Opens on `Global`** - the scope that mixes every scene - and the reader
  picks a scene when they want positions. It used to auto-select the biggest
  comparable component by rewriting the URL; it does not any more, so a bare
  `/rankings` link is the same page for everyone. `pickDefaultComponent` is
  kept for the "which one scene would you show" question, and a shared
  `?region=` link still wins outright, because the page reads that parameter
  straight into the scope and nothing rewrites it.
- `Global` was called `Everywhere`, beside a heading that said `All scenes` -
  two names for one scope. One name now (`GLOBAL_SCENE_LABEL`), used by the
  picker, the heading and the coverage block alike.
- **Global has positions, and says what they rest on.** It used to drop its
  `#` column entirely, on the grounds that Global is never `comparable`. The
  grounds were sound and the conclusion was not: the order exists - the engine
  publishes a global board with ranks on it - and withholding an order that
  exists is not more honest than printing it with its caveat, especially on the
  page a reader lands on. A **position is a per-row fact** now, not a per-scope
  one: the API ranks over the whole rated population on every scope
  (`earnsPosition`), and the page draws the column whenever any loaded row
  holds a place (`hasPositions`). The old gate is unchanged where it belongs -
  8 games, ±120 - and the scene-size gate moved onto the row, so a player who
  would get no place in their own scene gets none globally either (29 of the
  live board's 6,117 rated players, all in scenes under 8).
- **The caveat moved; it did not go.** The cross-scene weakness is one the `±`
  does **not** carry: the margin is the posterior SD of a comparison *inside* a
  scene, and between two scenes there is no comparison for it to be about.
  Measured on production: **0 of 56,257 recorded games cross a scene** - which
  is definitional, since a scene is a connected component of the co-play graph
  and a game between two of them would merge them - over 1,235 scenes, 369 of
  them on the global ladder and 15 in its top 25. There is no RC/RCQ tier in
  the data to link them: the whole corpus is Nexus Night, Pre-Rift and Other.
  So every scene's level rests on the 1,200 prior and nothing else. Three
  surfaces carry that, all of them in the page's existing idiom:
  - the `#` header is a dotted-underlined `abbr` whose title is
    `GLOBAL_POSITION_HINT`, beside the thing it qualifies;
  - the banner is one line (`GLOBAL_POSITION_NOTICE`), replacing
    "No positions in Global — pick a scene", which now describes a page that
    does not exist. No paragraph, same as every other notice here;
  - the `Scene` column **stays**, beside the positions rather than instead of
    them, because seeing that #1 and #2 come from scenes that have never met
    *is* the caveat. Its cell hint is `sceneSizeHint` - the depth a place was
    earned among.
- **No cross-scene figure is published, and that was measured, not assumed.**
  Two candidates were rejected on the numbers. The engine's own
  `crossComponentUncertainty` widens the margin by a median of **1.2 rating
  points** on the live board (ratio 1.011), because the model pins a
  4,654-player scene's mean to ±2.2 off the prior - correct given the prior,
  and the prior is the untested part, so a `±96` beside a `±95` would read as
  "1% less certain" about a comparison nothing identifies at all. And a
  per-player "how connected is your scene" count is **zero for every player in
  the corpus**, so a column of it would be furniture. What varies between rows
  is scene size, which the `Scene` column already carries.
- The picker row reads `every scene at once`, not `not comparable`: a caveat met
  before the thing it qualifies was always the wrong place for it, and that
  wording described the positionless ladder. `GLOBAL_OPTION.comparable` stays
  **false** - it is the narrow statistical claim and it is still true; what
  changed is that the page no longer reads it as "print nothing".
- **Every player with a number gets their number**, with its margin beside it.
  Three states, decided once by `ratingDisplay` in `lib/ranking.ts` and used by
  the ladder, the event page and the player page alike:

  | state | prints | position |
  |---|---|---|
  | `rated` | `1,382 ±95` | `#3` |
  | `unsettled` | `1,204 ±156`, **muted** | `--` |
  | `none` | `Unranked` | `--` |

  The page used to print `Unranked` for everything but the first, which read
  as a broken page rather than an honest one and threw away a figure the
  engine was willing to stand behind. **The honesty rides on the margin now**:
  a `±156` beside a `±95` says "not settled" better than the word did, and it
  is a comparison a reader can make instead of a verdict they have to accept.
- The floor belongs to the API, not to us. Below about three recorded games
  the estimate has barely moved off the 1,200 prior - median posterior SD 130
  against a prior of 150 - so it would describe the average rather than the
  player, and the API sends `rating: null`. `ratingDisplay` therefore reads the
  *number*, never a game count, so the floor can move without this changing.
- **No position below the rank gate**, whatever the number says. 8 games,
  ±120, scene ≥8, computed server-side; the rank cell is a `--` and the
  position is never inferred from the rating. The dash carries *which* gate
  stopped it, because they are different kinds of thing: `ratingExplanation`
  for an evidence problem, `sceneTooSmallExplanation` for a comparison one -
  a settled rating in a scene too small to order anyone, where the number
  itself is not in question.
- The reason is the `title`, never inline prose - `ratingExplanation`, which
  says "Still settling - 3 more recorded games…" for an unsettled rating and
  the no-games sentence for `none`.
- **`ratingExplanation` and `gateProgress` distrust `provisionalReason`.** The
  API has sent `no-rating` for players who plainly have games, so both read the
  display state and the game counts first and let the reason string pick the
  wording only when it says something the numbers cannot - that the *margin*,
  not the volume, is what is holding the rating back.
- The exposition is the footer's "How Rankings Work" hover note (`Layout.tsx`),
  not a section on the page. Short hints carry the same facts where the
  concepts appear: the scene picker's `?` and the dotted-underlined "Rating"
  and "Margin" column headers.
- The scene picker (`SceneSelect`) is a **search field that opens a split
  pane**: a filterable list of every scene on one side, a map of them on the
  other, bound to each other. Scene names are places, so a reader who knows
  where they play but not what the engine's modal label calls it cannot type
  the answer - and a reader who knows the name should not have to hunt a map
  for it. Both, at once, driven by one state:
  - **typing filters both halves** - the pins are derived from the filtered
    rows, not filtered separately, so they cannot disagree - and the map refits
    to what is left, so typing `berlin` takes the map to Berlin.
  - **pointing at one lights the other.** A row hovered or walked onto with the
    arrow keys lifts its pin (`highlightedId`); a pin hovered lights and scrolls
    to its row (`onHighlight`). The marker is restyled in place rather than by
    rebuilding the layer - that is 1,286 markers and this runs on every pointer
    move.
  - **choosing in either half is the same choice**: one `onChange`, which is
    `updateParam(URL_PARAMS.REGION, ...)`. A pin and a row both set the scope
    and close the pane; focus returns to the field.
  - dismissal is Escape, a click outside, or a selection, and the field keeps
    focus through all three. A click on the basemap is **ignored** here (it
    clears the selection on the map *page*): the pane has a visible `Global`
    row and clearing by clicking the sea is an affordance nobody can see.
  - **the list is the control and the map is an aid.** The list keeps the
    combobox it always was - `role="listbox"`, `aria-activedescendant`,
    type-ahead, arrows, Enter, Escape - and it holds every scene, including the
    21 with no pin. Nothing is reachable only through the map.
  - This replaced a `By name | Map` pair of modes, which made a reader choose
    which half of one answer they wanted before seeing either. Before that, a
    `Ladder | Scene map` tab pair, which claimed the map was a second view of
    the ladder. Neither exists now.
- **The rows come from the scene catalogue, not from the ladder.**
  `sceneCatalogueOptions` builds them from `/api/rankings/map`, because
  `/api/rankings`' `components` is **41 scenes of 1,307** - whatever the global
  board's first page happened to touch - so the old picker could name 3% of the
  corpus. It is also the map's own source, which is what makes the two halves
  agree about which scenes exist *and* what they are called: the two sources
  name **16 of those 41 differently** (one is `Simi Valley, CA` on the ladder
  and `New York, New York` in the catalogue). One source inside the control.
  The ladder's 41 are still used for the few hundred milliseconds before the
  catalogue lands, so the list works immediately; the swap only adds rows.
  - The consequence worth knowing: for those 16, the **closed field and the
    page heading disagree**, because the heading reads `/api/rankings`. That is
    a real API bug and is out of scope; the fix belongs in `listComponents()`.
  - `selectedLabel` is the field's caption before the catalogue arrives, so a
    scene from a shared `?region=` link does not leave it blank.
- **150 rows are drawn at a time** (`LIST_CAP`), biggest scene first, with
  "N more, keep typing" in the footer - the same device as the map page's list.
  1,307 rows cost ~300ms to open and ~120ms a keystroke; 150 cost 150ms and
  61ms. The map is not capped, so a pin outside the drawn rows has no row to
  light up; its tooltip still names it and a click still picks it.
- **A scene with no pin says so on its row** (`no pin`, with the reason in its
  title), and the selected one says it under the map, where the pin would have
  been (`scenePinAbsence`). 21 of 1,307 scenes have no pin and they hold 41% of
  recorded players - Singapore, Toronto, New York, Paris - so a reader who
  picks one and watches nothing light up has been told the map lost it. It is
  **contextual, not standing copy**: there is no banner, and the pane explains
  itself through its structure instead.
- **The ladder does not pay for the map.** The canvas is `React.lazy`, so
  Leaflet's chunk, the basemap assets and `GET /api/rankings/map` all happen
  when the pane first opens and never on a ladder load. Measured: main bundle
  152.98KB gzipped before this pane, **154.07KB** after; the map chunk is
  46.82KB and the eager chunk contains no `leaflet` and no basemap geometry.
  The catalogue *fetch* is deliberately on the eager side - the list must not
  wait on a map library it does not use - and nothing in `SceneSelect` imports
  `lib/sceneMap.ts`, for the Rollup hoisting reason below.
- **Under 760px the pane is the list alone**, with "See these on the map" in
  the footer. A phone cannot show a list beside a map, and stacking them would
  push the control that actually picks a scene most of a screen down for a
  canvas where 1,286 pins sit under a fingertip. It is a render decision, not a
  CSS one: a `display:none` map still downloads Leaflet, fetches the basemap and
  measures itself wrong. Verified at 390px - no Leaflet request at all.
- Positions are suppressed entirely only when the **scene** is too small to
  order anyone - with a banner saying why. Mixing scenes no longer suppresses
  them; see "Global has positions" above.
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
  "not separated yet". **Unsettled rows are in the scale, and that is the
  point** - it is the thing carrying what the word `Unranked` used to carry,
  and their wide spans stretch the axis, which is what makes the contrast
  legible. The floor dropped from three rows to two: three was right when only
  settled rows drew bars, but the bars now do work on every row with a number
  and two spans are already a comparison. One span is still decoration, and so
  is a degenerate range. Hidden under 600px, where the `±` in the rating cell
  carries the same fact.
- **The games gate** (`gateProgress`) answers the one question an unsettled
  rating leaves open - how close am I - as recorded games against the published
  threshold. On the player page and the `Unranked` tail it is the pip meter; in
  a ladder row it is the Games cell reading `6/8` instead of `6`, because a row
  of pips on every line is noise. It says nothing for a player who has already
  played enough games (a full meter beside an unsettled rating reads as a
  contradiction) or one the API says is held back by its margin.
- **Result colour is never the only signal.** Every individual win, loss and
  draw carries a letter - the form pips, the match row's badge, the Bo3 chips -
  so both pages survive being read in greyscale. The record bar's segments are
  separated by a 2px gap in the track colour, because the win green and the
  loss red are only 2.29:1 against one another.
- **A record is written `2-1`, or `2-1-1` when a draw happened** - win-loss-draw
  in the notation a card player already reads, never `2W 1L` in coloured display
  type. The trailing `-0` is dropped rather than printed on every row: draws are
  rare (72 against 1,372 decisive sides) so a universal `-0` is noise. It is a
  figure, at figure size with tabular numerals, not the loudest thing on the
  block - the rating is. It satisfies the greyscale rule by itself, because
  numerals are not colour, but a screen reader announces it as "two dash one
  dash one", so the visible figure is `aria-hidden` and `recordSpoken` carries
  the name ("2 wins, 1 loss, 1 draw"). `formatRecord` / `recordSpoken` in
  `lib/ranking.ts` are shared by the player summary and the event page's
  standings column, which sits under a header reading "Record" beside one
  reading "Pts", so there is nothing for it to be mistaken for.
- The bar beside the record is **decorative** (`aria-hidden`): the figure and
  the win rate printed next to it already say everything it draws, so
  announcing it again would only repeat the row.
- The player page's record is computed from *loaded* matches, so the bar always
  carries a caption saying which ("All 6 loaded matches", "First 25 of 40").
- **The match log reports a rating movement per day, and there is no per-match
  one to report.** The engine is Whole-History Rating, not Elo: it is one global
  fit over every recorded match, its time axis is the **day** (one curve point
  per day played, tied to the next by a Wiener prior), and it never credits a
  match with a share of a result. So the log is grouped by day
  (`matchDays`), the day header carries the movement (`ratingMoves` →
  `RatingMoveNote`), and a day of four matches shows **one** figure rather than
  the same figure four times, which would be a four-fold overstatement a reader
  could not see through.
  - **Both ends of it are published, dated ratings** - the very points the chart
    above draws, already rounded by the engine - so the figure is arithmetic on
    numbers the reader can see, the log cannot disagree with the chart, and no
    API call was added. The join needs no date arithmetic either:
    `PlayerMatch.eventDate` and `RatingPoint.date` are both the engine's UTC day
    of the event's start.
  - **The house rule holds on a movement too.** The chip prints the rating
    *with* its margin, the breakdown prints the margin at both ends, and it says
    when the movement is smaller than the margin - a `+18` under a `±98` has
    separated nothing, which is the most useful thing there is to say about it.
    The first recorded day is measured from the 1,200 anchor and labelled as
    such, because that is a starting point rather than a day that was played.
  - **Three factors are deliberately not shown**, each on a measurement rather
    than on taste. An **event-tier multiplier**: the mechanism exists and ships
    neutral (every tier counts 1; zero matches exist above Nexus Night), so a
    line reading "×1.00" on every row is furniture. A **cross-scene
    adjustment**: a scene is a connected component of the co-play graph, so 0 of
    56,257 recorded games cross one and the term is zero for every match on the
    site. The **drift allowance** between two play days: real, but its knob is
    not identifiable from this data (held-out log loss is flat from 0.5 to 16),
    so publishing it would dress a prior belief as a measurement. `RatingMove`
    in `lib/ranking.ts` carries the full argument, and a test asserts the copy
    names none of them.
  - **A day with no point says nothing** - no dash. An unrated player has no
    published curve at all (the engine writes history only for rated players),
    and a dash would read as "the rating stood still". The chart above already
    says why in words.
  - **The breakdown is a disclosure, not a `title`.** A `title` does not exist
    on a phone and is not reliably keyboard-reachable, and this breakdown is the
    part that stops the figure being read as an Elo award. So it is a 44px
    button - tap, Enter/Space, hover or focus, Escape to dismiss - and the panel
    opens *inline*, because at 390px a positioned popover is what drags a page
    sideways. `EventTooltip` was not reused: it takes a calendar `Event` and a
    mouse position and is hover-only, so it fits neither the data nor the rule.
- **The event name in a match row links to that event's page**, in the site's own
  link colour rather than a quieter one of its own invention - there is no quiet
  link idiom here, and a link nobody can see is not a link. It is never a dead
  end by construction: the row exists because the engine replayed a *results
  capture* for that event, which is the same condition `hasTournament` tests
  before the calendar shows a trophy, so the `status: 'none'` events that would
  open an empty page can never appear in a match log. The date left the row
  when the day header took it.
- **The player page reads absence off the profile, not off an error.**
  `/api/players/:id` used to 404 for a player the engine has never seen, and
  the page turned that into its message; it answers 200 now, so the branch is
  `profile.known === false` and the page prints one line - "Unranked - no games
  by <name> have been recorded yet" with the reason as its hover hint - instead
  of a shell of dashes, an empty chart and an empty match list. A 404 is still honoured, because an older API deploy answers
  that way for the same player, and a malformed id is a 400 and a real error.
  A profile that arrives all-null with no `known` field at all - the shape an
  older deploy would send - lands in the same `rating === null` branch and
  reads `Unranked`, so no deploy order breaks the page. Both shapes verified in
  a browser.
- A **map of the 390 known venues** is the likely next feature. Match rows carry
  their `data-shop-id`, and both pages are a flat column of sibling sections, so
  a venues panel drops in without disturbing the layout. The map of *scenes*
  shipped first (`/rankings/map`, below), because the engine publishes a scene
  catalogue today and has written **zero** `VENUE#` items.
- `RATING_ANCHOR` (1200) mirrors the engine's `ELO_ORIGIN`. Nothing else in the
  frontend hardcodes a rating value; the chart's axis is fitted to the data.

### The scene map (`/rankings/map`)

Where the competitive scenes are, and the way into each one's ladder. Reached
from the **expand control on the map half of the scene picker's pane** - the
page is that map at full size, with the same selection carried in `?scene=`
(and on a phone, where the pane has no map half, from the link in its footer). Because it
is a drill-down rather than a tab, it carries "Back to the ladder" twice: above
the heading, where a reader who has just arrived looks, and at the foot under
60 rows of list.

- **A pin is derived, never inferred.** A scene is a connected component of the
  co-play graph and has no coordinates of its own; its pin is the
  match-weighted centroid of the venues *its own games* were played at,
  computed by the rating engine during its replay. Nothing in the frontend
  geocodes anything, and nothing positions a scene from its name.
- **A scene with no geocoded venue has no pin.** It is listed under the map
  instead, flagged `not on the map` in words, and the coverage line leads the
  page with how many of the scenes are drawn. A map showing 40 of 1,235 scenes
  is otherwise silently wrong about the world. The API sends the two
  populations as separate lists, so this is not a null check the page can
  forget.
- **A scene too spread out to have a centre has no pin either**, and this is
  the larger case. The API withholds a centroid that sits more than 100km from
  the scene's own nearest venue - measured, 20 of 1,302 production scenes, and
  they hold **40% of all recorded players**, including the two biggest, whose
  centres fall 360km into the Gulf of Thailand and 2,080km into the Pacific.
  Those arrive `dispersed: true` and are flagged `spans several regions` rather
  than `not on the map`, because the two are different facts: one is a gap in
  our geocoding, the other is a true statement about the scene. Selecting one
  draws its **venues** - the only honest picture of where it plays - and the
  coverage line names the count, since otherwise a reader sees "1,282 of 1,302
  scenes, 60% of players" and has no way to find the other 40%.
- **Two radii, two quantities, and they are never swapped.** Each scene is
  drawn twice: a **ground disc** whose radius is the scene's real `spreadKm`,
  which scales with zoom because it is a distance and is absent entirely for a
  single-venue scene; and a **pixel dot** sized by player count, which does not
  scale with zoom because a count is not a distance. Drawing population as a
  ground radius is how a map like this starts claiming a 4,654-player scene
  covers a continent. `sceneDotRadius` square-roots the count so *areas*
  compare - the measured corpus spans 2 to 4,654 players, a factor of 2,327,
  where a linear radius would put the smallest scene under one pixel.
- **The list is the accessibility surface, not a fallback.** The map is
  `role="application"` with a label pointing at the list, because 1,200
  unreachable SVG circles are worse than one honest label. Every scene is a
  focusable 44px button in the list, the selected row carries the same cyan the
  selected dot does, and both flags (`not on the map`, `too small to order`)
  are words rather than colour - the same rule the result pips follow.
- **The selection is in the URL** (`?scene=<componentId>`), so a view of one
  scene is shareable, and written with `replace` so panning does not fill the
  back button with a history entry per dot. The parameter name lives in
  `lib/ranking.ts` (`SCENE_MAP_PARAM`, with `sceneMapPath`) because this page
  is no longer its only writer - an event page links in with its own scene
  already selected, and two spellings of `scene` would be a link that selects
  nothing. Why `lib/ranking.ts` and not here: see the bundling note below.
- **Why Leaflet.** 42KB gzipped, no token, no WebGL, against Mapbox GL JS's
  ~800KB and a client-side token the frontend does not carry (the Mapbox token
  is server-side, behind `/api/events/geocode`, and should stay there). The
  page needs ~1,200 circles on a basemap, not vector tiles.
- **It is the one lazy route.** `React.lazy` in `App.tsx`, because it is the
  only page pulling in a library nobody else uses and it sits behind a preview
  flag - eager, it would put a map library in the bundle every *calendar*
  visitor downloads. Measured: the main bundle stays at 148.9KB gzipped and the
  map is a 47KB chunk fetched only when the page opens. (Re-measured
  2026-10-27 after the merges since: 151.88KB main, 47.23KB map.) The scene
  picker's pane is lazy for the same reason and shares that chunk, so there are
  two lazy importers of Leaflet and still none eager: 152.98KB main before the
  split pane, 154.07KB after, with the map chunk at 46.82KB.
- **Rollup hoists a shared module into the eager chunk whole**, which is the
  trap this route sets for anything outside it. The event page's scene line
  needed one path builder from `lib/sceneMap.ts`, and importing it put *all* of
  that module - its copy, its geometry, its coverage sentences - into the main
  bundle, +4.7KB gzipped, with nothing tree-shaken. So the links into a scene
  (`scenePath`, `sceneMapPath`, `SCENE_MAP_PARAM`) live in `lib/ranking.ts`
  instead, which already owns scopes: `lib/sceneMap.ts` stays lazy and the
  whole scene line costs **0.71KB** (152.59KB against the 151.88KB base).
  Import a map helper from an eager module and measure, or the lazy route
  quietly stops being one.
- **The basemap is geometry we serve ourselves, not tiles.** Coastlines and
  country outlines as one MultiPolygon, plus city labels: `public/basemap/`,
  built from Natural Earth (public domain, no key, no attribution required) by
  `scripts/build-basemap.py`. Rebuild with:

  ```bash
  cd frontend && python3 scripts/build-basemap.py \
      ne_110m_admin_0_countries.geojson ne_50m_populated_places_simple.geojson \
      public/basemap
  ```

  - **Minimal by construction.** Nobody picks a Riftbound scene by looking at a
    park. With our own geometry you cannot accidentally ship a road: the only
    things on the map are the things we drew.
  - **No quota and no cliff.** It replaced OpenStreetMap's raster tiles - 8-20
    requests per pan from a third party, on a usage policy that asks heavy
    consumers to self-host. (CARTO's keyless dark basemap, the first choice
    here, now serves tiles reading "API KEY REQUIRED" across every one of them;
    any keyless CDN basemap is one business decision away from the same.) Two
    static files on our own CloudFront: **land-v1.json 119KB raw / 39.5KB
    gzipped, places-v1.json 36KB / 16.6KB**, fetched once and cached.
  - **It themes instead of being fought.** The `filter: invert(1)
    hue-rotate(180deg)` that forced a light raster dark is gone; the land, the
    coastline and the labels are drawn in the app's own tokens, and the marker
    contrast measurements are untouched because nothing filters anything.
  - **Versioned filenames**, for the reason the Rankings mark is versioned:
    `deploy.sh frontend` only invalidates `index.html`.
  - **The geometry never enters a JS bundle.** It is `fetch`ed at runtime, not
    imported - an `import` of JSON is inlined by Rollup into the importing
    chunk. Verified: the eager chunk contains no `leaflet` and no coastline.
  - **Labels are thinned by zoom**, using Natural Earth's own `min_zoom`, with
    a floor of 2 so the world view is not unlabelled and a cap of 90 drawn at
    once. They are rebuilt for the visible bounds on `moveend`/`zoomend`.
  - **Scale choice**: countries at 110m, because at a 400px map a 50m coastline
    is the same shape at four times the bytes; places at 50m (1,251 cities)
    because 110m's 243 leave most of the map unlabelled at the zooms where
    someone is looking for their own scene. Simplified with Douglas-Peucker at
    0.1 degrees and rounded to 2 decimals - finer than the generalisation
    Natural Earth has already applied.
  - **Past zoom 9 there is nothing**: no imagery, and the densest city labels
    run out. So every fit clamps to `maxZoom: 9`, and the venue pins carry the
    local context. For picking a scene that is the right trade - the question
    is which city, not which street. Admin-1 outlines (US states, German
    Länder) are the cheap next step if the inside of a large country ever needs
    more.
- `VITE_MAP_TILE_URL` / `VITE_MAP_TILE_ATTRIBUTION` are still honoured and are
  now the **escape hatch rather than the plan**: set them and `SceneMap` draws
  raster tiles instead of the geometry, which is the route to a minimal Mapbox
  style (the project already pays Mapbox for geocoding) if the geometry ever
  proves too bare. That reintroduces a key and a per-request bill, so it is a
  decision to surface rather than take. They are the app's only
  `import.meta.env` use (`src/vite-env.d.ts`), both optional, neither a secret.
- Pure logic is in `lib/sceneMap.ts` and tested without a DOM, including that
  the dot scale is area-proportional, that the disc vanishes where there is no
  extent, and that the three coverage sentences are three different answers.

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
- **The same three rating states as the ladder, from the same
  `ratingDisplay`.** A number whenever the engine will quote one, muted when it
  is unsettled, `Unranked` only when there is none.
- **"No record yet" is gone.** The page used to keep a fourth state for
  `known: false`, on the reasoning that telling a first-time player they are
  "unranked" claims they failed a bar they never stood at. The reasoning was
  sound and the data was not: a 25-hour-stale engine reported `known: false`
  for 22 players whose games were rendered on the same page, so the phrase was
  lying more often than it was informing. After the refit - 27,318 profiles
  over 3,122 events, rated players 166 → 6,122 - that event reads 22 of 22
  known, 7 rated. The distinction is collapsed into `Unranked` everywhere, and
  `fieldComposition` counts two groups rather than three, because two legend
  rows both reading `Unranked` would be a puzzle rather than a breakdown.
- Names link to `/rankings/players/:playerId` **only when `known`**. The rule
  is unchanged; its justification moved. `/api/players/:id` used to 404 for an
  unknown player, so the link was a dead end. It answers **200** now, with
  every number null and a `known: false` on the profile - a resource whose
  `/matches` and `/ratings` already answered 200 is not absent, and such a
  player gets a real profile the moment the engine sees them, so the 404 made a
  bookmarked URL dead and then alive. The link is still withheld because the
  page would have nothing on it, and unknown names render as plain text beside
  `Unranked`. On a *pairing*, where there is no `known` flag, a name links when
  it carries a rating.
- **The page names the scene the event belongs to**, under the venue, with the
  scene's size and a link into its ladder (`component:<id>`, through
  `scenePath`) plus a `Map` link into `/rankings/map` with that scene already
  selected (`sceneMapPath`, which shares `ScenesPage`'s own `scene` parameter
  so one spelling cannot drift from the other).
  - **It is the venue's scene, which is a lookup rather than a guess.** The
    engine groups stores that are close enough together for their players to
    really play each other and assigns one scene to each store; this event was
    held at a store. The API reads it off that store and sends `scene` on
    `/api/events/:id/tournament`, so the page adds **no** request and derives
    nothing.
  - **This is a fix, not a refactor.** The line used to name the connected
    component of the players who played here, and reachability is a transitive
    closure - one travelling player merges two cities permanently. A measured
    production component held 1,688 players over 110 venues across 1,514km,
    was labelled `New York, New York`, and had all five of its busiest stores
    in California, so a shop in Redwood City read **"Scene: New York, New
    York"**. It now reads `Peninsula`.
  - **The name is the scene's and the link is the component's**, and the hint
    says both. A ladder is scoped to a `componentId` because that is what makes
    two ratings comparable; a scene does not define a rating scale, so there is
    no scene-scoped ladder to link at. Two facts, stated as two, rather than a
    link quietly asserting they are one. When the engine has placed nobody who
    played here there is no pool to link at, so the name renders as plain text
    and the `Map` link is withheld - the scene is still a fact about the store.
  - **The roster is not counted** in the component half, by the API and
    therefore here: a player who signed up and never sat down contributed no
    edge. The scene half is immune to it, being a property of the store.
  - **Three honest absences, and only one of them prints.** No recorded
    matches - an upcoming event, or one of the ~29% whose organiser never ran
    pairings - prints **nothing**: the page already says the event has no
    standings, and a line reading "no scene" where no game was played is the
    same absence twice. An event with no resolved store prints nothing either,
    for want of anything to attach the line to. A store that is **not in a
    scene yet** prints one muted `Not placed yet` with the reason on hover,
    because "this event has no scene" and "this store is not in a rankable
    scene yet" are different claims and only the second is true. That is also
    the common case today, and the hint says *why* rather than promising it
    will change: a scene is only drawn where the stores in it play each other
    enough to rank anybody, so some stores will never be in one - and it says
    the games here still count towards every ladder they belong to, because
    they do.
  - **A split rating pool is flagged, not smoothed over.** `componentCount > 1`
    adds a `mostly` chip - a word in the scene list's own flag idiom, never
    colour alone - whose hint says how many pools and why. It is reachable: an
    event's pairings connect the players they pair rather than all of them, and
    the engine places a player from the history it last replayed. Note it is a
    fact about the *pools*, not about the scene, which cannot be split: the
    store belongs to one scene by construction.
  - **The name is the scene's, never a player's and no longer the
    component's.** The API reads it off the engine's `SCENE#` item; a member's
    own `regionLabel` is their home region, and one 5,405-player scene's
    players carry four different ones, while a component's modal city is a
    name for several scenes and therefore for none of them. An unnamed scene
    falls back to `Scene <id>`, the way the ladder's picker does, rather than
    borrowing a city from whoever turned up or a label from the wider pool.
  - **The size is the scene's too.** `49 players · 4 rated · 3 stores`, from
    the scene - not this event's field, and not the component's, which spans
    several scenes and would overstate a scene by an order of magnitude.
  - **The roster table's column is `Scene` again, and its cells are scenes.**
    It was `Scene` with `player.regionLabel` in it - a home city, a different
    one per member of one scene - and was renamed to `Region` because that is
    what the cells were. The cells are `player.sceneLabel` now, so the reason
    for the rename is gone and the header goes back. The engine places a
    *store* in a scene and a player's scene is their home store's, so every
    cell is the same kind of thing as the line above it. On the reported page
    the column read `Redwood City, CA`, `San Carlos, California` and
    `Sunnyvale, California`; it reads `Peninsula` x5 and `South Bay` x1.
    - `TournamentPlayer.sceneId` / `sceneLabel` were added to carry it. They
      come off the `PLAYER#<id>/PROFILE` items the field's one BatchGet
      already fetches, so the column costs **no extra read**.
    - **A sceneless player never falls back to the city.** 2.6% of sampled
      production profiles carry a region and no scene, and a `??` would put a
      city back under this header on exactly those rows. The cell is the
      page's `--` with the reason on hover, and the reason is one of two: a
      known player's store is in no rankable scene, or the engine has never
      seen this player so there is no home store at all. Deliberately not a
      word - most of an upcoming event's roster is in the second state, and a
      phrase repeated down twelve rows is the "column of Unranked" failure
      this section has already been caught in once.
    - The standings table's sub-label under each name moved with it, for the
      same reason. It has no header to hang a hint on, so a player with no
      scene simply has no line there: an absent sub-label reads as nothing,
      where `--` under a name reads as missing data.
    - (`/rankings`' own `Scene` column still holds `regionLabel` and is left
      alone: it is load-bearing copy there with its own documented reasoning,
      and changing it is a separate decision.)
  - **The whole line is gated on `isRankingsPreview`** - a stricter rule than
    the player links on this page, which render for everyone. This page is
    reachable without the flag, the trophy that leads here is not, and a
    labelled row called "Scene" with two links into the section is an
    advertisement for it in a way a player's name is not. Both links go
    through `carryPreview`.
  - Measured at 390px: two rows, right edge 197px of 375; with the longest
    production label ("North West Community Development Council, 03") three
    rows reaching 342px inside a 359px panel, and no page-level horizontal
    scroll. Contrast over the real composited ancestors: name and `Map` cyan
    11.41:1, label and size summary 7.22:1, the `mostly` chip 7.09:1.
- **Strength of field is one word, and the word is measured.** The block used
  to print a mean at display size, a line of prose naming the players it was
  taken over ("1,219 mean, across the 7 rated players of 14"), a coverage meter
  and a median/top line. All four are gone and the measurement is why, not
  taste.
  - **Measured on production, events do not differ in strength.** Over all
    **11,946** events with a captured field (2026-09-25..2026-10-31, 48,173
    distinct players, 35,661 of them known to the engine), a one-way variance
    decomposition of rated players' ratings grouped by event gives
    **within-event SD 84.2, between-event SD 0.0, ICC 0.000**. The 418 events
    where *every* player in the field is rated make the same point with no
    sampling argument at all: their means have SD **30.4** against the
    **31.8** that drawing the same number of players from one pool predicts.
    So the variation the old mean was displaying was sampling noise, and three
    surfaces were spent on it.
  - **The bands are the measured quartiles.** Distribution of the event mean
    over events with a rated player (n=6,234): p05 1138, p25 1196, p50 1222,
    p75 1251, p95 1311. Over the pool that actually earns a band (rated sample
    >= 6, n=2,168): q1 **1203.7**, q2 **1220.3**, q3 **1239.1**. The edges are
    **1200 / 1220 / 1240**, rounded to tens because the published mean carries
    one decimal and the quartiles move by at most 6 points as the floor moves
    from 3 to 8 - they are a property of the corpus, not of the pool. Occupancy
    20 / 30 / 27 / 24%. Labels **Low / Medium / High / Very high**, in
    `FIELD_BAND_EDGES` / `FIELD_BAND_LABELS` (`lib/tournament.ts`).
  - **Below six rated players there is no band**, and the floor is derived
    rather than picked: a single rated player's published margin may be as wide
    as `maxUncertaintyForRating` (120), their share of a mean over `k` is that
    over `k`, so under `ceil(120 / 20) = 6` one person's uncertainty spans more
    than a whole band. `minRatedForBand` reads the gate off the payload so the
    floor follows it. The reported page is exactly that case - mean 1,276 over
    **3 rated of 13** - and reads `Not enough rated players` with the count in
    the hint instead of `Very high`.
  - **The word is a position in a distribution, and the hint says so.** With
    ICC 0.000 it cannot be a claim that this event was harder, so
    `FIELD_BAND_HINT` states the measurement. Printing the band with its caveat
    rather than withholding it is the call "Global has positions, and says what
    they rest on" already made.
- **The field counter said three where the table showed six, and now counts
  three groups.** It read "3 Rated &middot; 10 Unranked" over a roster printing
  **six** ratings, because one word covered two thresholds: the display floor
  (3 recorded games - whether a *number* appears) and the rank gate (8 games,
  +/-120, scene >= 8 - whether a *position* is held). Three of the ten sat
  between them, so the table printed their rating beside the word denying it.
  The legend is `Rated` / `Still settling` / `No rating yet`, three different
  answers rather than two rows that would both read `Unranked` - the thing the
  two-group version existed to avoid. **The counts come from
  `fieldComposition(detail.players)` through `ratingDisplay`**, the same
  function the table cells branch on, so counting the numbers in the table
  cannot give a different answer; `field.provisionalPlayers` would not, because
  a known player with two recorded games is provisional *and* has no number.
  `field.ratedPlayers` still agrees with the first group by construction and a
  test pins it.
- **The roster shows no `Checked in` and no `Signed up` column**, and the two
  absences are different. Check-in is a door state nothing else keeps and it
  told a reader of this page nothing. The sign-up time is **load-bearing
  data**: `acceptedTermsAt` reconstructs an event's whole signup curve from one
  snapshot, which is why the scraper fetches a roster once instead of polling,
  and a dated roster only exists on an event that has not started. So it is
  dropped from this **view** only - the scraper, the stored fact and
  `TournamentRosterEntry.registeredAt` are untouched, and `formatClock` still
  formats the capture line. `rosterColumns` offers `waitlist` alone.
- **Finality is read off the round, or off the capture - never off a match.**
  Riot leaves matches reading `IN_PROGRESS` inside rounds it has `FINALIZED`
  (21 of 22 on the live event). `openMatches` is a data-quality signal, not a
  gate. A drawn match now arrives as **`draw`**: the API normalises Riot's
  vocabulary to this one and keeps the verbatim word in `rawOutcome`. It used
  to arrive as `TIE` - 72 of 1,444 sides on the live corpus, `DRAW` never once
  - so `sideOutcome` matches both, case-insensitively, and reads an old capture
  and a new one the same way. `FORFEIT` / `DISQUALIFIED` / `NO_SHOW` are
  deliberately `unknown` rather than guessed at.
- Pairings arrive in table order now, sorted server-side; `orderedMatches` is a
  no-op re-sort, kept so the page never goes back to depending on upstream
  order. (21 of the corpus's 87 rounds used to be out of order, round 1 of the
  live event arriving 7, 6, 4, 3, 2, 1, 5.)
- A bye is printed once. It used to arrive **twice** - a synthesised
  `bye: true` match *and* `byes` - in 42 of 87 rounds; it comes in `byes` alone
  now, with no `bye-` prefixed id leaving the API. `unlistedByes` keeps the
  de-dupe anyway, because that is what makes the page correct under either
  shape and in either deploy order, and it guards every field against arriving
  `undefined` rather than empty.
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

### Getting into a day's events

Hovering a chip opens the hover card and that is how the grid is browsed -
deliberately kept. But a hover card is a bad place for a *link*: reaching it
means moving the pointer off the thing that opened it, and the card used to
close on exactly that move. On a day with a "+N more" link there was a way
round; on every other day the card's contents could not be clicked at all, and
nowhere could they be reached by keyboard, since a FullCalendar chip is a
`<div>` with no event `url` and so is not focusable.

Four routes in now, all of them opening the **same dialog**
(`DayEventsModal`): the `+` on a day cell, the "+N more" link, a tap on a
cell, a tap on its date. FullCalendar's own "+N more" popover is retired -
`moreLinkClick` returns `'none'` on every width. It was a second layout
answering the same question, it existed only on the minority of days that
overflow, and it was the sole reason the trophy needed a `display: none` on
the grid plus a carve-out to show it back inside `.fc-popover`. Both are gone,
and so is `.has-trophy`, which existed to let a chip's title shrink out of the
glyph's way.

#### The `+` on a day cell
- A real `<button>` on **every day that has events**, injected by
  `dayCellDidMount`. Not on empty days: a control that promises a list and
  opens an empty one is a broken promise, and 42 identical controls are what a
  screen reader has to read past to find the three that lead anywhere.
- **Its accessible name carries the count and the date in full** - "Show all 3
  events on Friday, November 7" (`dayListLabel`). A grid of buttons all named
  "+" is useless: announced on its own, a cell's numeral has nothing around it
  to say which day it means.
- **Built by hand, not through `dayCellContent`.** That hook's content is
  injected *inside* the `<a class="fc-daygrid-day-number">` FullCalendar wraps
  around it, and interactive content inside an anchor is invalid markup that
  announces as one confused control - the same reason `DayEventsModal` puts
  its trophy beside its row button rather than in it.
- **Absolutely positioned in `.fc-daygrid-day-frame`**, not a flex item in
  `.fc-daygrid-day-top`. Two reasons, both load-bearing: the day-top is where
  the cell is narrowest (at 390px a cell is ~51px and the numeral already owns
  2rem of it), and `.fc-day-other .fc-daygrid-day-top` is `opacity: .3`, which
  a child cannot climb out of. Out of flow it costs the grid nothing at any
  width; it sits in the day-top's band, above the first chip, so it steals no
  hover.
- **The day comes off the cell's `data-date`, never a closure.** FullCalendar
  re-renders the grid in place and may keep the same `<td>`s, in which case the
  mount hook does not fire again and a captured date would open the wrong day's
  list. `dayStringToLocalDate` parses it - with the `Date(y, m, d)`
  constructor, because `new Date('2025-11-07')` is UTC midnight by spec and
  reads back as the 6th west of UTC.
- The click `stopPropagation`s natively, because FullCalendar's `dateClick` is
  one delegated native listener and on touch it would open the list twice.
- **Hidden under 600px**, and the reason is width rather than input. There is
  no hover trap on a phone (`isMobile` withholds the card entirely) and the
  whole cell plus its date already open the list, so a third tap target in a
  51px cell buys nothing. The reader this leaves out is a desktop window
  narrowed under 600px, who keeps the mouse and is covered by the card's own
  footer instead.
- Cyan, matching the "+N more" link in the same cell because they open the same
  dialog. Measured on every ground a cell can have: 11.40:1 normal, 10.78:1
  other-month, 8.70:1 on today's composited lavender wash, 7.95:1 on its own
  hover tint.
- The "+N more" link **stays** on an overflowing day rather than yielding to
  the `+`. They are not rival doors - same dialog - and the link says what the
  `+` cannot: that this cell is hiding events, and how many. What absorbed what
  is that both of them absorbed the popover.

#### The hover card's footer
- The card keeps `pointer-events: none`. It is drawn over the pointer's own
  cell and its neighbours, so a card that swallowed the mouse would turn every
  chip behind it into a dead spot while it was open - and sweeping the pointer
  across the grid is the thing this calendar is for.
- **Only `.event-tooltip-actions` opts back in**: full card width, flush with
  the card's bottom edge (negative margins cancelling the 1rem padding), ~24px
  tall, about a dozen pixels above the cursor. The shortest reachable journey
  there is, and the smallest bite out of the grid. The honest cost: while a
  card is open, the one chip directly above the hovered one cannot be hovered
  without leaving the footer first. A fully interactive card would have taken
  a 300x150px bite instead.
- **Leaving a chip schedules the close, it does not perform it**
  (`HOVER_CARD_CLOSE_DELAY_MS`, 220ms). Entering another chip cancels and
  replaces; the footer holds it open.
- **The footer is read as a flag at schedule time, not as a cancel**, and that
  is not an accident: React synthesises `onMouseEnter` from the `mouseout` of
  the element being *left* when the thing being entered is also React-managed,
  while FullCalendar's `eventMouseLeave` rides the real `mouseleave` that the
  spec fires afterwards. The cancel therefore lands first, on a timer that does
  not exist yet, and the schedule after it wins. Asking "is the pointer on the
  footer" is immune to the ordering. This was observed, not reasoned about
  after the fact - the first version closed the card under a stationary
  pointer.
- `clampCardX` keeps the card inside the viewport beside the last column, and
  cannot slide it off the cursor: the clamp moves the centre by at most the
  overhang, and inside `margin` pixels of an edge the margin gives way instead.
  Both properties are tested.
- Leaving the Events section closes the card: this page is hidden, not
  unmounted, so a card left up by a pointer that never got a `mouseleave` would
  be waiting at last week's coordinates on the way back.

#### The day list (`DayEventsModal`)
- A real dialog: `role="dialog"`, `aria-modal`, labelled by its date header,
  focus in on open and back to the opener on close, Escape to dismiss (through
  the same `isCloseDisabled` guard the backdrop uses, so a mobile card on top
  of it closes first), and a visible close button.
- It is **the keyboard route to everything the hover card holds**, which is why
  the dialog treatment matters: every row and trophy in it is a real control in
  the tab order, reached from a real button in the grid.
- Each row renders the trophy as a *sibling* of the event button inside a
  coloured band - a link inside a button is invalid markup. The band is 44px
  tall; sized for touch, kept for the mouse.
- Clicking a row opens the event's visit URL on desktop, exactly as a grid chip
  does; on a phone it still raises the card on top of the list.

### The trophy affordance
- `EventTrophyLink` renders in a day-list row and nowhere else on the calendar.
- FullCalendar's `eventClick` is one delegated **native** listener on the view
  element, so a React `stopPropagation` is far too late. The anchor stops the
  native event itself and routes by hand; modified clicks fall through to the
  real `href` so "open in new tab" still works.
- **Ink `#21222c`**, the app's own darkest surface read as dark grey. Measured
  against each chip colour it sits on: `#bd93f9` 6.55:1, `#ff79c6` 6.62:1,
  `#73d393` 8.62:1, `#9ea8c7` 6.68:1. The slate "Other" chip used to be the
  binding case at **3.36:1** against the 3:1 graphics floor, with nothing
  lighter clearing it and even pure black reaching only 4.46:1 - which is why
  the chip itself was lightened rather than the ink. On the page ground the
  same ink is 1.40:1, which is why this affordance can only live on a coloured
  chip. Hover and focus keep the ink and add a ring in it: white would *drop*
  it to 2.26:1 on lavender, and the site's cyan focus ring reaches 1.63:1
  there.
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
- **Current location is the default**, 25mi, with San Francisco as the
  fallback it always was. The order on load is: a shared `?lat=&lng=` URL, then
  the reader's own position, then the last place they looked, then SF - and
  only the first of those outranks the position, because a shared link is a
  deliberate statement about where to look and a permission prompt firing over
  someone else's link is both a surprise and wrong. The decision is
  `shouldAutoLocate` in `lib/geolocation.ts`, pure and tested.
- **The fetch is not held behind the fix** when there is already a place to
  draw. A returning reader would otherwise sit in front of a blank calendar for
  as long as the prompt stayed open; the fix re-searches when it lands, and
  `sameSpot` drops that second request when they have not actually moved.
  `sameSpot` rounds to the share URL's own four decimal places, so a link
  shared from "near me" still reads as "near me" when its author reopens it.
- Events displayed as "Time | Shop Name"
- Navigation restricted to 3-month window via `validRange`
- `fixedWeekCount={false}` prevents extra rows
- **Dates from FullCalendar are not all the same thing.** The library works in
  *date markers* - a `Date` whose **UTC** fields carry the cell's wall-clock
  values - and converts them with `DateEnv.toDate` before handing most of them
  out. `dateClick` and `navLinkDayClick` arrive converted, as does the `start`
  on each of `moreLinkClick`'s `allSegs`; `moreLinkClick`'s own `date` does
  **not**. Read with local getters, a Nov 7 cell headed its day list "Fri,
  Nov 6" everywhere west of UTC. `lib/calendarDates.ts` holds the conversion
  (`dateMarkerToLocalDate`), the local-day key `getEventsForDate` compares on,
  and `dayStringToLocalDate` for a cell's `data-date` - all pure and all
  tested, including across a DST boundary, where a blind offset lands an hour
  out. Only the `moreLinkClick` path converts a marker; the other two must be
  left alone. All four routes funnel into one `openDayList`, so there is one
  source of truth for what a day contains.
- **Availability is swept over the whole visible range**, not one day list at a
  time. `CalendarPage` already loads every event for the range in one
  `calendarMode` request, so `loadAvailability` asks about all of them up
  front, chunked at the endpoint's documented 50 ids a call - one request for a
  25-mile month, four for 132 events, none per event, and never twice for the
  same id in a session. `displayEvents` is memoised so the sweep has a stable
  trigger. A failed batch puts its ids back, and opening a day list asks again
  as the retry path. **Both callers are gated on `isRankingsPreview`.** The
  retry used not to be, which meant an unflagged reader opening a day list sent
  requests about trophies they could never be shown - a trace of an unlisted
  section, which is exactly what the flag exists to prevent.

### EventFilters
- Format: dropdown (All, Constructed, Sealed, Draft, Multiplayer)
- Distance: dropdown (Any, 5mi, 10mi, 25mi, 50mi, 100mi)
- Location: text input + a **"Use my current location" button**
- Active filter shown as pill with Clear button

#### "Use my current location"

A real `<button>`, not the `<a href="#">` it used to be: it acts on this page
rather than going anywhere, so it answers Space as well as Enter, announces
itself as a control, and has no href for `carryPreview` to keep the preview
flag on. The wording for every state is decided by `locationControl` in
`lib/geolocation.ts` - pure, tested, and the only place any of these strings
live - while `hooks/useCurrentLocation.ts` owns the three impure things
(the permission store, `getCurrentPosition`, the reverse geocode). `CalendarPage`
holds the one copy of that state and feeds both the page-load default and this
button. There used to be **two** implementations, one per file, and they had
already drifted: the filters' copy searched from the coordinates reverse
geocoding handed *back* - the centre of the named city, not the reader, which
in a large metro moves them tens of miles on a control labelled "my current
location". The fix decides where to search; the lookup only decides what to
call it.

- **Denied is the state to get right.** A refused permission cannot be
  re-prompted from JavaScript, so a button that keeps saying "Use my current
  location" is a button that does nothing, repeatedly. The label therefore
  says **"Location blocked - how to allow"** before it is pressed, the button
  stays **pressable** anyway - only the browser's own site settings can undo
  it, and a reader who has just used them needs something to press; a disabled
  button is also skipped by a screen reader - and pressing it prints the
  instruction rather than failing silently. The press still calls
  `getCurrentPosition` first, which is free, prompts nobody, and locates
  outright anyone who has already unblocked us. `PermissionStatus.onchange` is
  watched too, so the label heals without a reload.
- **The one-click way back.** With a fix in hand and the filters pointing at a
  city the reader searched for, the label reads "Back to my current location".
  Before this there was no way back without a reload.
- **No prompt spam.** The automatic prompt fires once per browser
  (`geoAutoAsked` in settings) and never again; a granted permission is exempt,
  because reading one shows no prompt. How long "blocked" survives a reload
  depends on the browser, and the reasoning for not persisting it ourselves -
  a *dismissed* prompt is indistinguishable from a refusal - is in
  `lib/geolocation.ts`.
- **Withheld entirely where it could never work**: no `navigator.geolocation`,
  or `isSecureContext` false. The note then carries the reason, named by its
  cause - plain http fails with `PERMISSION_DENIED`, the same code a refusal
  gives, so without the secure-context check we would send that reader after a
  browser setting that is not the problem.
- **One live region** (`role="status"`, `aria-live="polite"`) carries both a
  failed geocode and the location control's news, and it is always in the DOM:
  a status element that appears with its text is an insertion, not an update,
  and screen readers routinely miss those. An empty block has no line box, so
  it costs no height while it waits. A geocode error wins the slot, because it
  answers what the reader just did.
- **In flight it is `aria-disabled`, not `disabled`**: "Locating..." can last
  ten seconds, and a disabled element loses focus, which would dump a keyboard
  reader back on `<body>` exactly when they are waiting for an answer.
- Measured: cyan ink `6.61:1` on the `#44475a` filter panel, the inert step
  `5.25:1`, the error line's `--color-red-text` `5.12:1` (the old
  `.filter-error` used `#ff5555`, which is **2.91:1** there). The site's pink
  link hover is **3.84:1** at this size and is not used; the border and an
  underline carry the hover instead. `.btn-search`'s `opacity: 0.5` is not used
  either - it composites the cyan to 2.91:1.
- At 390px the options row wraps, the button is a 44px target, and the longest
  label measures 226px inside a 268px row. Verified in Chromium across all
  eight states: no page-level horizontal scroll in any of them.

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
- **The event-type chips live in `lib/eventColors.ts`**, once, rather than in
  four copies with comments saying they had to match. Their ink is
  `--fc-event-text-color` / `.day-event-item`'s `--color-bg` `#363b43`:
  `#bd93f9` 4.67:1, `#ff79c6` 4.72:1, `#73d393` 6.15:1, `#9ea8c7` 4.77:1.
  `Other` was Dracula's "comment" slate `#6272a4`, which put its own label at
  **2.39:1** - and no ink could fix that, since pure black reaches only 4.46:1
  on it. So the chip moved: hue 226 held, saturation held at 27%, L 51% -> 70%,
  the same move `--color-text-muted` made away from the same original value,
  landing it in the 64-78% lightness band its three peers already occupy. The
  calendar's colour-dot legend and the hover card's type tag read the same map,
  so all three surfaces moved together; the dot was 3.36:1 as a graphic on
  `#21222c` and is 6.68:1 now. `--color-border` keeps `#6272a4` and the select
  chevrons drawn in it are untouched: a hairline is not text.
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
- Tooltip z-index 10000, above the day list's backdrop at the same level and
  the mobile card's at 10001

## API Integration

- `getEvents({ calendarMode: true, lat, lng, radiusKm, eventType })`
- Frontend uses miles, converts to km before API call (`miles * 1.60934`)
- `geocodeCity(query)` for location search
