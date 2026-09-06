# Daylight development itinerary

**Status:** working roadmap  
**Baseline:** `ed0de9f` on `main`, 6 September 2026  
**Principle:** make one risk-reducing change at a time, prove it, then add product scope.

Daylight is already a usable dependency-free browser planner. Development should preserve that strength: no account, no backend, no build step, and no opaque framework unless evidence shows that one is necessary.

## Destination

A trustworthy, publicly usable day-out planner that:

- remains understandable as a small static application;
- handles third-party services honestly and politely;
- does not turn plan or map data into executable HTML;
- survives reloads and conflicting tabs without silent loss;
- allows ideas before the user has committed to a timetable;
- supports the user's choice of distance unit and currency;
- has enough automated coverage to make later changes safe.

## Route map

| Stop | Purpose | Deliverable | Exit condition |
| --- | --- | --- | --- |
| 0 | Freeze the baseline | Baseline checklist and manual smoke test | Current behaviour recorded before changes |
| 1 | Close narrow security gaps | Leaflet SRI and DOM-only map popups | External dependency and popup tests pass |
| 2 | Make live services civil and bounded | Shared request queue, persistent cache, timeouts | Repeated queries are cached; requests cannot hang indefinitely |
| 3 | Build a testable core | Pure planner functions separated from DOM wiring | Core timing, sorting, conflict and migration tests run locally |
| 4 | Add an ideas drawer | Unscheduled activities with an explicit scheduling action | Ideas persist but never enter timed calculations until scheduled |
| 5 | Add locale settings | Currency and miles/kilometres preferences | Display and calculations follow saved settings |
| 6 | Improve recovery and undo | Bounded multi-step history plus conflict comparison | Undo and cross-tab recovery remain distinct and tested |
| 7 | Publish a release candidate | GitHub Pages, privacy/service notes and release checklist | Fresh-browser acceptance test passes on desktop and mobile |

## Stop 0 — Baseline and guardrails

Before changing behaviour:

1. Record a manual smoke-test script covering:
   - create, edit, remove and undo an activity;
   - overnight ordering and clash detection;
   - reload persistence;
   - cross-tab conflict preservation;
   - recovery-copy restore and download;
   - nearby-place search, map, weather and directions.
2. Record which behaviours need network access and which remain available offline.
3. Add a licence before inviting reuse.
4. Decide whether the public demonstration is explicitly UK-first or internationally configurable. Do not describe fixed GBP/miles behaviour as a defect until that product decision is made.

**Exit condition:** the smoke test passes on the baseline commit and its result is recorded.

## Stop 1 — Narrow hardening

Keep this milestone deliberately small.

### Work

- Add the official Leaflet 1.9.4 SRI hashes and `crossorigin="anonymous"` to both dynamically loaded resources.
- Replace the itinerary marker's HTML string with DOM construction and `textContent`, matching the safer nearby-place popup implementation.
- Inventory every remaining `innerHTML` assignment and classify its inputs as constant, locally calculated, or externally supplied.
- Add a regression case containing HTML-like activity text, quotes and URL-shaped text.

### Acceptance criteria

- Leaflet loads when its bytes match and fails visibly when integrity validation fails.
- An activity name such as `<img src=x onerror=alert(1)>` is displayed only as text.
- No user-entered or OpenStreetMap-supplied string reaches an HTML parser.
- Directions still use `URL` and `URLSearchParams`; no manual query-string concatenation is introduced.

## Stop 2 — Geocoding and live-service reliability

Treat Nominatim and Overpass as limited donated infrastructure, not guaranteed application backends.

### Work

- Route all Nominatim calls, including area search, through one client-side queue enforcing at most one request per second.
- Add a bounded, versioned `localStorage` cache:
  - successful geocodes: longer expiry;
  - failed geocodes: short expiry;
  - maximum entry count with oldest-entry eviction;
  - invalid cache data ignored without blocking the planner.
- Do not attempt to set a browser `User-Agent`. When hosted, retain a normal identifying HTTP Referer and document the service dependency.
- Add `AbortController` timeouts to Nominatim, Overpass and weather requests.
- Distinguish timeout, rate-limit, no-result and offline messages where the browser provides enough evidence.
- Keep the Overpass query bounded. Use one controlled retry with backoff; do not rotate public endpoints indiscriminately.
- Explain that place queries leave the browser and must not contain confidential information.

### Acceptance criteria

- Repeating the same normalized query after reload performs no network request while its cached entry remains valid.
- Nine uncached lookups remain policy-compliant and progress is visible to the user.
- A stalled service terminates within the documented timeout.
- Cache corruption, quota exhaustion and unavailable storage degrade safely.
- Stored cache size remains bounded.

## Stop 3 — Testable planner core

The 1,350-line IIFE is workable today but makes the next features risky. Extract only logic that benefits from deterministic tests; do not rewrite the UI.

### Candidate pure functions

- activity normalization and state migration;
- absolute start-minute calculation;
- chronological and cost ordering;
- clash detection;
- distance and unit conversion;
- currency formatting inputs;
- geocode-cache normalization and eviction;
- scheduling-gap search for the future ideas drawer.

Use the platform's built-in test runner if practical. Avoid adding a large toolchain merely to test a static app.

### Acceptance criteria

- Tests cover same-day, after-midnight and next-day activities.
- Tests cover overlapping, adjacent and travel-time-separated stops.
- Malformed persisted state and old schema versions have deterministic outcomes.
- The baseline smoke test still passes.

## Stop 4 — Unscheduled ideas drawer

This is the first substantial product change. Do not make `startTime` nullable everywhere and hope existing calculations cope.

### Data model

Represent an entry explicitly as either:

- a **scheduled activity**, which has day offset and start time; or
- an **idea**, which has no scheduling fields and is excluded from ordering, clashes, routes and day-span calculations.

Use a schema version and a migration for existing stored plans.

### First release

- Add an idea with name and optional duration, location, estimated cost, category and notes.
- Edit, remove and persist ideas.
- Move an idea into the timetable by selecting a time manually.
- Offer “first available time” only after the deterministic gap-finding function is tested.
- Allow a scheduled activity to be returned to the drawer without losing descriptive fields.

### Acceptance criteria

- Ideas never generate false clashes or appear as route waypoints.
- Converting an idea to an activity is reversible.
- Existing saved plans migrate without visible change.
- Empty, malformed and duplicate records are handled deterministically.

## Stop 5 — Currency and distance preferences

Keep currency and distance independent: converting miles to kilometres is mathematical; changing a currency label must not pretend to convert monetary value.

### Work

- Add saved settings for distance unit and display currency.
- Format costs with `Intl.NumberFormat` using the selected currency.
- Convert distance displays and inputs consistently while retaining one canonical internal distance unit.
- Recalculate Overpass radii from the canonical unit.
- Change validation messages, summaries, example data labels and map annotations with the setting.

### Acceptance criteria

- Switching units does not change the geographic radius represented internally.
- Switching currency changes formatting only; existing amounts are not silently exchange-rate converted.
- Old saved plans default explicitly to GBP and miles.
- All fixed `£`, `GBP`, `mile` and `1609.344` usages are reviewed.

## Stop 6 — History and conflict comparison

Undo history and cross-tab recovery solve different problems and must remain separate.

### Work

- Replace the single snapshot with a bounded history of meaningful user actions.
- Define which actions create history entries; rendering, automatic saves and external-service results must not flood the stack.
- Clear or branch history explicitly when loading another tab's version or restoring a recovery copy.
- Add a human-readable conflict comparison: plan-detail changes, added/removed activities, and changed fields.
- Begin with choose-local or choose-external after comparison. Selective merging is a later feature unless a safe deterministic merge rule is designed.

### Acceptance criteria

- At least ten consecutive destructive edits can be undone in order.
- The history has a fixed size and does not grow without bound.
- Undo cannot silently overwrite a newer external revision.
- Both conflicting versions remain recoverable until the user makes an informed choice.

## Stop 7 — Public release candidate

### Work

- Enable GitHub Pages from `main` only after the hardening milestones are merged.
- Add a short privacy and external-services section to the visible application, not only the README.
- Verify OpenStreetMap attribution and service-policy wording.
- Test keyboard use, narrow mobile layout and visible focus states.
- Test a fresh browser, a returning browser with old state, offline mode and service failure.
- Tag the first public candidate rather than treating every `main` commit as a release.

### Release gate

- No known user-controlled HTML sink.
- All external requests are bounded, attributed and honestly described.
- State migration and recovery tests pass.
- The full smoke test passes from the hosted URL.
- Known limitations are current and specific.

## Working method

For every stop:

1. Open one focused issue or write a brief change contract.
2. Create one branch with the smallest coherent implementation.
3. Add or update tests before declaring the behaviour complete.
4. Run the baseline smoke test for affected features.
5. Record any discovered limitation in `ADVERSARIAL_LOG.md`.
6. Merge only when the stop's acceptance criteria are met.

Do not combine the ideas drawer, localisation and undo refactor in one branch. Each changes the state model, and separating them makes migrations and regressions attributable.

## Immediate next branch

`hardening/leaflet-sri-and-safe-popups`

Scope only:

- official Leaflet 1.9.4 SRI attributes;
- DOM-only itinerary marker popups;
- a concise manual regression fixture/check;
- corresponding adversarial-log entry.

Everything else in this itinerary waits until that branch is reviewed and merged.
