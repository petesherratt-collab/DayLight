# Adversarial log

## Round 0 — Initial build

### Working assumptions

- One plan and one day at a time
- British pounds as the default currency
- Manually entered places and travel estimates
- No account, live maps, recommendations, or external services
- Local browser storage is sufficient for the first version

### Challenges already identified

1. The day-span calculation treats the first activity's travel allowance as part of the day, but later travel is represented before each corresponding activity. This model is simple but may not match every user's mental model.
2. An itinerary can extend past midnight, but the display wraps to the following morning without explicitly labelling it “next day.”
3. A user cannot create several named plans or export one for another person.
4. Costs use GBP rather than a selectable currency.
5. Confirmation prevents easy accidental replacement, but there is no undo history.

### Status

Accepted as ordinary first-version constraints. Suitable targets for later adversarial rounds.

## Round 1 — Scheduling integrity and hostile saved state

### Attack surface

- Overlapping activities that are not adjacent by finishing time
- Stops that finish after midnight
- A later-starting stop that finishes before an earlier, longer stop
- Missing, malformed, or manually edited `localStorage` data
- Browsers where storage access throws

### Findings

1. **High — non-adjacent overlaps were missed.** With stops at 09:00–13:00, 10:00–10:30, and 11:00, the third stop was compared only with the second and incorrectly shown as conflict-free.
2. **Medium — day span could be understated.** The calculation used the final stop by start-time order, even when an earlier stop ended later.
3. **Medium — after-midnight endings were ambiguous.** A 23:00 stop lasting two hours displayed an end time of 01:00 without saying that it was the following day.
4. **Medium — hostile saved data could stop rendering.** Invalid times, missing strings, non-finite numbers, or a throwing storage implementation were trusted during load.

### Changes made

- Conflict detection now checks the latest-ending prior activity, so nested overlaps cannot hide a clash.
- Day span now uses the latest actual end time.
- End times crossing midnight now include `(+1 day)` (or the applicable larger offset).
- Loaded activities and plan details are normalized, bounded, and invalid activities are discarded.
- Failed storage reads no longer attempt another potentially throwing storage operation.

### Remaining product decisions

- Start times still describe one calendar day. There is no way to deliberately schedule a new stop after midnight; adding a day-offset control would be a larger model and UI change.
- Travel remains modelled as time before the destination activity.
- Persistence is still best-effort and has no export, undo, or multi-plan support.

## Round 2 — Recovery from destructive actions

### Attack surface

- Accidentally removing a single stop
- Confirming a full clear and immediately regretting it
- Replacing a real itinerary with the example plan
- Making new edits after a destructive action and then using a stale undo

### Changes made

- Removing a stop, clearing all stops, and loading the example now retain a one-step in-memory snapshot.
- A visible undo action restores both plan details and activities.
- Any later edit invalidates the snapshot so undo cannot silently discard newer work.
- Undo is deliberately session-only; reloading the page commits the currently saved state.

### Remaining product decisions

- There is still no multi-step history, export/import, or multi-plan support.
- A dedicated plan manager would need a larger persistence and navigation model.

## Round 3 — Live maps, forecast, travel modes, radius, and cost ranking

### Attack surface

- Invalid or malicious cached coordinates in `localStorage`
- Starting-point-only plans and single-marker map bounds
- Map-library, geocoding, tile, or weather outages
- Locations that cannot be geocoded
- Same-day versus out-of-range forecasts
- Cost sorting while chronological clash detection remains active
- Equal-cost stops, route-mode URL construction, and HTML-like activity names

### Findings

1. **High — a one-point map crashed before weather advice ran.** Leaflet's feature-group bounds calculation attempted to include the radius circle before its projection was ready.
2. **High — hostile saved coordinates bypassed the earlier saved-state protections.** Out-of-range latitude/longitude values added by the map feature were accepted during load.
3. **Medium — the map dependency loaded before the core application.** A slow or unavailable CDN could delay an otherwise offline-capable planner.
4. **Medium — failed geocoding was too quiet.** Unmapped stops were skipped without identifying them in the result message.
5. **Low — equal-cost stops received different cost ranks.** Rank was based on array position instead of distinct cost bands.

### Changes made

- Map viewport fitting now uses marker coordinates only and handles a single point with an explicit centred view.
- Cached coordinates are normalized, range-checked, and tied to the location query that produced them.
- Leaflet and its stylesheet are loaded only after the user selects **Update map & weather**, keeping the core planner independent of the CDN.
- The map result names every starting point or stop that could not be located.
- Equal costs now share a rank while cost sorting remains independent from chronological conflict detection.

### Verification

- **12/12 local browser checks passed:** hostile-state normalization, bounded diameter, saved-stop recovery, sample replacement, totals, descending cost order, per-stop route modes, form submission, HTML injection resistance, overlap detection, and new travel-mode directions.
- **4/4 live-service checks passed after the single-point fix:** geocoding completion, lazy Leaflet load, marker render, and same-day weather advice.
- The live retest used a one-location plan specifically to cover the previously failing boundary.

### Remaining product and service risks

- Travel buttons provide mode-specific Google Maps routes, but the planner does not compare live duration, fare, parking, or accessibility data inside the page.
- Public map, geocoding, directions, and forecast services can be unavailable or change their usage policies. The planner degrades to manual planning and outbound direction links.
- Google Maps waypoint limits vary by platform, so very large itineraries may not open with every stop in one route.
- Straight-line radius checks describe geographic spread, not road, rail, cycling, or walking distance.
- Forecast advice is deliberately lightweight and should not be treated as a safety warning system.

## Round 4 — Nearby discovery without a hard boundary cliff

### User challenge

- A strict search boundary can hide useful options that are only marginally outside the designated area.
- Options need spatial context rather than an unstructured recommendation list.

### Changes made

- Added a category-based nearby-options menu using OpenStreetMap place data.
- Searches cover a selected core radius plus exactly 22% and label every outer-band result “just outside.”
- Core and extended boundaries use distinct map styling and a visible legend.
- The result mix reserves space for outer-band options so a dense inner area cannot hide them all.
- Party profiles cover distinct scoring behaviours for solo travellers, couples, small groups, families, older visitors, large groups, and celebration groups.
- Users can explicitly prefer closer options or widen discovery reach; the interface states that this affects discovery ordering and does not add multi-day itinerary support.
- Family profiles share the same evidence-based ranking regardless of the children's genders; the labels describe the party without applying gender stereotypes.
- Suitability ordering uses only available place type, accessibility, toilet, reservation, distance, and similar map tags, and the interface states that this is not a guarantee.
- A selected option can prefill the itinerary form, including its known coordinates, without adding it silently.
- The existing lazy Leaflet loader is reused, preserving the offline core planner.
- Browser location is optional and requested only after the user selects **Use my location**.

### Remaining product and service risks

- Nearby discovery depends on Nominatim, Overpass, OpenStreetMap tiles, and the Leaflet CDN.
- Place data does not verify opening hours, availability, price, quality, or accessibility.
- The 22% allowance is straight-line distance beyond a radius, not an administrative boundary or travel-time calculation.

## Round 5 — Cross-tab persistence conflicts

### Finding

- **High — a stale tab could silently overwrite a newer plan.** Each tab held an isolated in-memory copy and previously saved it without checking whether another tab had updated browser storage.

### Changes made

- Persisted plans now carry a monotonically increasing revision.
- Every save compares the current stored value with the last value observed by that tab and refuses a blind overwrite when they differ.
- The app listens for cross-tab storage changes and presents an explicit choice to load the newer plan or keep the current tab's plan.
- Either choice preserves the displaced version under a timestamped recovery key before completing the overwrite.
- Same-revision races are detected by comparing the serialized stored value, not revision numbers alone.

## Round 6 — Place discovery versus live events

### Finding

- **High — nearby discovery could be mistaken for a “what’s on” service.** The app had no live events source and queried only relatively permanent OpenStreetMap places, while the selected itinerary date did not affect those discovery results.

### Changes made

- Discovery is now explicitly labelled **Find nearby places** and explains that it does not provide live events or ticket listings.
- Results expose available `opening_hours`, website, contact phone, and direct OpenStreetMap source links.
- Opening hours are labelled as community-maintained data that users must verify rather than treated as authoritative availability.
- Suggested-stop notes carry available OSM hours and the venue website into the itinerary form.
- No event results are fabricated in the absence of an explicit event provider.

## Round 7 — Overnight ordering, bounded recovery, and API restraint

### Findings

1. **High — post-midnight starts sorted before evening activities.** Start times had no day component, so a 01:00 stop followed neither a 20:00 dinner nor a 22:30 show.
2. **Medium/High — conflict backups could exhaust storage.** Timestamped recovery keys were unbounded, while resolving a conflict required another successful storage write.
3. **Medium — failed geocodes were repeatedly queried.** A `null` result was indistinguishable from a location that had never been requested.
4. **Medium — discovery radius trusted mutable DOM state.** A modified select value could produce an excessive Overpass radius and Leaflet circle.

### Changes made

- Activities can explicitly start on the plan day or the next day. Absolute start minutes now drive sorting, conflict checks, day-span calculation, card labels, per-stop directions, and whole-route ordering.
- Cross-tab conflict recovery retains at most three timestamped backups, removes the oldest first, and downloads the displaced JSON as a recovery file if quota still prevents a backup.
- Unsuccessful Nominatim lookups are cached by normalized query for one hour within the session; cached misses do not issue another request or incur the rate-limit pause.
- Nearby searches accept only the three radii exposed by the interface before calling Overpass or drawing a map boundary.

## Round 8 — Usable recovery and reserved location labels

### Accepted findings

1. **High UX — recovery copies were inaccessible to ordinary users.** Backups existed only as browser-storage keys with no application interface.
2. **Medium — repaired state could overwrite the primary immediately.** Damaged records were backed up and normalized, but initial rendering then saved the reduced state without a user decision.
3. **Low — “Current location” could be geocoded as literal text.** Editing the geolocation label cleared its coordinates, after which the reserved phrase could be sent to Nominatim.

### Changes made

- Added an in-app recovery manager that lists copy type and stop count and supports restore, JSON download, and deletion.
- Damaged-state loading now pauses all automatic saves. The original remains primary until the user restores a valid copy or explicitly selects **Use repaired plan**.
- Restoring a copy preserves the displaced primary version first; malformed copies remain downloadable but cannot be activated automatically.
- “Current location” is a reserved label accepted only while coordinates from **Use my location** are present.

### Rejected finding

- The claim that directions use plaintext HTTP was rejected: `directionsUrl()` already builds the canonical `https://www.google.com/maps/dir/` URL with `api=1`.
