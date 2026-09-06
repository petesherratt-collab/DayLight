# Daylight

A small, dependency-free day-out planner designed as an iteration and adversarial-review project.

## Run it

Open `index.html` in a modern browser. No installation, build command, or account is required. The itinerary planner works offline; live maps, weather, directions, and nearby-place discovery need an internet connection.

The planner supports:

- Basic plan details and dated itineraries
- Activities with times, durations, travel allowance, cost, category, and notes
- Automatic chronological ordering
- Timing-clash detection, including travel time
- Clear next-day labels for activities that finish after midnight
- Explicit next-day start selection for late-night itineraries, used consistently by sorting, clash checks, and routes
- Editing, removing, clearing, and loading an example itinerary
- One-step undo after removing, clearing, or replacing stops
- Automatic local browser storage
- Cross-tab change detection with explicit conflict recovery instead of silent overwrites
- Bounded conflict backups with a recovery-file download fallback when browser storage is full
- An in-app recovery manager for previewing, restoring, downloading, and deleting fallback copies
- Responsive desktop and mobile layouts
- An OpenStreetMap route overview with a configurable diameter in miles
- Public transport, car, bicycle, and walking directions via Google Maps
- Live weather advice for trips up to 15 days ahead
- Cost ranking alongside chronological itinerary order
- A mapped nearby-place menu that includes and clearly labels places up to 22% beyond the chosen core radius
- Available OpenStreetMap opening hours, venue websites, phone details, and direct source links with verification warnings
- Allowlisted nearby-search radii and session-level caching of unsuccessful geocoding queries
- Distinct recommendation profiles for solo travellers, couples, small groups, families, older visitors, large groups, and celebration groups
- Closer-option and wider-area discovery ordering for the single-day itinerary

Plan data remains in the browser's `localStorage`. If another tab changes the plan, the app asks which version to keep and preserves a recovery copy before overwriting either version. Clearing browser site data will remove the saved plan and its recovery copies. The core planner works offline; map actions send place names or an optional browser location to OpenStreetMap services, and forecast coordinates to Open-Meteo. Direction buttons open Google Maps.

If damaged saved data is detected, automatic saving pauses before the primary copy is replaced. The user can inspect recovery copies, download the original JSON, restore a valid copy, or explicitly continue with the repaired plan.

Nearby discovery returns relatively permanent places from OpenStreetMap. It does not currently search a live events or ticketing source, so it cannot determine which concerts, temporary exhibitions, markets, or other date-specific events are on. Community-maintained venue details can be incomplete or outdated and should be verified through the linked venue or OSM source.

## Good adversarial questions

- What happens when an activity ends after midnight?
- Should travel time belong to the activity before or after a journey?
- Is a single currency assumption acceptable?
- How should an unscheduled activity be represented?
- Can the planner distinguish a tight connection from an actual clash?
- What happens when local storage is disabled or full?
- Should clearing or replacing a plan be undoable?

These limitations are deliberately visible so future rounds can challenge and evolve the product.
