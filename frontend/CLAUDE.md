# Frontend

React + Vite calendar UI on port 5173.

## Structure

```
src/
├── App.tsx               # Routes: / (calendar), /events/:id
├── index.css             # Dracula theme + FullCalendar overrides
├── components/
│   ├── Layout.tsx        # Minimal wrapper (no header/footer)
│   ├── EventFilters.tsx  # Format dropdown, distance dropdown, location search
│   └── EventTooltip.tsx  # Hover card for events
├── pages/
│   ├── CalendarPage.tsx  # Main view with FullCalendar
│   └── EventDetailPage.tsx
├── services/
│   └── api.ts            # API client functions
└── types/
    └── event.ts          # TypeScript interfaces
```

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
