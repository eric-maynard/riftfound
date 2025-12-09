# Scraper Notes

## Source: https://locator.riftbound.uvsgames.com/events

### Architecture
- Next.js app with React Server Components (RSC)
- No public REST/GraphQL API found
- Data embedded in SSR HTML via `__next_f.push()` streaming
- Individual event pages load async (not useful for bulk scraping)

### Data Extraction Strategy
1. Fetch `/events?page=N` (25 events per page)
2. Parse HTML with cheerio - find `a[href^="/events/"]` links
3. Extract concatenated text from each card
4. Parse text using regex patterns

### Text Format (concatenated, no delimiters)
```
[Upcoming|Ended]TitleMonthDD,YYYYTime(UTC)[NPlayers]FormatLocation,CCOrganizerPrice
```
Example: "UpcomingTuesday Evening Nexus NightsDec 9, 20255:00 AM (UTC)1 PlayersConstructedCanterbury, NZTCG Collector NZFree Event"

### Parsing Logic
1. Strip status badge (Upcoming/Ended)
2. Find date pattern `[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}`
3. Title = everything before date
4. Extract time `\d{1,2}:\d{2}\s*(AM|PM)?\s*\(?UTC\)?`
5. Skip player count `\d+\s*Players?`
6. Extract format: Constructed|Sealed|Draft|Multiplayer
7. Extract price from end: `Free Event` or `(NZ|A|US|C)?\$\d+(\.\d{2})?`
8. Split remaining as: `Location, CC` + `OrganizerName`

### Pagination
- 25 events per page, ~30k total (~1223 pages)
- `?page=1`, `?page=2`, etc.

### Rate Limiting
- 500ms delay between page requests
- Default: scrape 20 pages (500 events)
