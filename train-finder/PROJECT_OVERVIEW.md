# Train Finder Backend — Project Overview

## 1. Purpose

Train Finder is a Node.js backend for loading a static railway timetable, looking up stations and train routes, searching scheduled journeys with transfers, choosing among three home-destination stations, and serving these capabilities through a small HTTP API.

The backend uses only scheduled dataset times. It does **not** retrieve GPS from the server, geocode stations, query live train status, or provide delay predictions.

## 2. Run and test

From the `train-finder` directory:

```powershell
npm start
npm test
```

The API binds to `127.0.0.1:3000` by default. Configure a different port with `PORT`, or explicitly configure the bind address with `HOST`. The current `npm test` command runs the built-in Node.js test runner; `csv-parse` is the only declared runtime dependency.

Useful command-line examples:

```powershell
node index.js validate
node index.js direct DR TNA
node index.js route 00087
node index.js station PNVL
node index.js journey TNA NIIJ 2026-10-28T07:00 2
node index.js home TNA 2026-10-28T07:00 2
node index.js nearby 19.0 73.0 25 5
```

The commands load the data layer on startup. Station codes are case-insensitive and normalized to uppercase. Train numbers remain strings, preserving leading zeros.

## 3. Dataset and loading

The loader in [data.js](./data.js) reads CSV files from `..\data\out` relative to the project directory:

| File | Records measured | Purpose |
|---|---:|---|
| `trains.csv` | 10,842 | Train metadata, endpoints, operating-day text, distance and advertised duration |
| `stops.csv` | 212,629 | Ordered station calls, journey-day offsets, arrival/departure clocks and stop distances |
| `stations.csv` | 8,608 | Station codes, names and optional coordinates |
| `schedules.jsonl` | 10,842 | Dated schedule-shaped records; **not loaded by the current runtime** |

`csv-parse` handles CSV parsing. The loader checks required headers, records malformed-width rows, normalizes station codes, parses stop sequence and journey day as positive integers, and converts coordinate values to numbers or `null`. Blank stop times are kept as `null`; they are not fabricated.

### Runtime indexes

The returned data-layer object exposes:

- `trainInfo`: train number → unique train metadata.
- `routes`: train number → complete valid ordered stop list. Stops sort numerically by `seq`.
- `stationInfo` / `stationNames`: normalized station code → station record or name.
- `trainsAtStation`: station code → route stop references with train number and route index.
- `findDirectTrains`, `getTrainRoute`, `getStationName`, and `summary`.
- `createDataLayer(records)` for constructing a data layer from records and `loadData(dataDir)` for loading CSVs.

Duplicate train metadata and duplicate `(train_number, seq)` records are excluded from route construction rather than silently merged. Referenced station codes without station metadata remain visible in validation counts.

## 4. Journey planning

[journey-planner.js](./journey-planner.js) implements a bounded best-first timetable search. It expands services from the current station using `trainsAtStation`, then follows later stops in each train’s ordered route. It returns journeys sorted by earliest destination arrival and then by fewer transfers.

The planner accepts:

- `fromCode`, `toCode`
- `departureDateTime`: local `YYYY-MM-DDTHH:mm`
- `maxTransfers`
- Optional `minimumTransferBufferMinutes` (default 10)
- Optional `maximumInterchangeWaitMinutes` (no default; applies only between legs)
- Optional result and search limits

It accounts for initial waiting, journey time, transfer waiting, and overnight travel. A departure at the requested time is allowed; a departure earlier than the current time or earlier than the transfer-ready time is not. It does not revisit stations or reuse a train in the same itinerary. If a necessary boarding departure or arrival time is blank, the connection is rejected and counted in search diagnostics.

Journeys are ranked by earliest arrival, fewest transfers, lowest total interchange waiting time, earliest first-train departure, and a stable itinerary signature. `maximumInterchangeWaitMinutes`, when supplied, rejects only transfer waits; initial waiting at the origin is not subject to it. Invalid values are rejected.

The planner precomputes destination-directed minimum-leg reachability, deduplicates structurally equivalent queued and expanded states, and stops a route at its first destination occurrence. These are safe lower-bound and exact-state optimizations; they do not merge states with different ready timestamps.

Search limits protect runtime and memory. Results include `search.truncated`, `search.exhaustive`, expansion/queue counts, and rejected-schedule counters. `search.exhaustive` is false whenever a search limit prunes work; a truncated search is not proof that no better journey exists.

### Schedule-day interpretation

The CSV’s `day` is a one-based journey-day offset from the train’s service-start date; it is **not** a weekday number. The first stop is day 1 in the supplied schedules, and later days mark overnight/multi-day travel. `runs_days` specifies the service-start weekday as `Daily` or comma-separated weekday names.

The supplied JSONL run dates were checked against `runs_days`: all 629,039 listed dates matched. However, the current data loader and planner use the CSV schedules and `runs_days`; they do not load or enforce the JSONL `run_dates`. The planner therefore models weekly service patterns rather than dated exceptions or a finite published run-date window. Treat such results as timetable estimates, especially for specials or limited-date services.

## 5. Home-destination recommendation

[home-destination.js](./home-destination.js) compares feasible arrivals at:

1. Nilaje (`NIIJ`) — default
2. Ghansoli (`GNSL`)
3. Dombivli (`DI`)

An alternative is selected automatically only when its scheduled arrival is at least 60 minutes earlier than the earliest feasible Nilaje arrival. If both alternatives qualify, the earlier one wins; a tie prefers Ghansoli. If Nilaje has no route, the result is a distinct `no-baseline-route` case rather than applying the comparison to a nonexistent arrival. A manual destination override remains selected even when it is not the automatic recommendation.

The manual cycle is `NIIJ → GNSL → DI → NIIJ`, exposed by `getHomeDestinationCycle`.

## 6. Nearest-station lookup

[nearby-stations.js](./nearby-stations.js) provides a standalone Haversine-distance lookup. The caller supplies latitude and longitude; the server does not access device GPS. Radius and result count are configurable. Stations with missing or invalid coordinates are skipped, and an empty array is returned when nothing is in range.

In the current dataset, **all 8,608 stations lack latitude and longitude**. Consequently, nearest-station lookup currently returns no station results unless the dataset is updated with real coordinates.

## 7. HTTP API

[api.js](./api.js) uses Node’s built-in HTTP server, avoiding a web-framework dependency. All API responses are JSON and errors use `{ "error": { "code": "...", "message": "..." } }`.

| Method and path | Function |
|---|---|
| `GET /api/health` | Reports process/data readiness and explicitly says live-running status is unavailable. |
| `GET /api/stations/nearest?lat=...&lon=...` | Returns nearby coordinate-bearing station candidates. Optional `radiusKm` and `limit`. |
| `POST /api/route/recommend` | Compares the three home destinations and returns the full recommendation and route details. |
| `POST /api/route/select-station` | Advances from `currentDestinationCode` to the next home destination and recalculates its route. |
| `POST /api/widget/recommend` | Returns the compact versioned widget payload. |
| `POST /api/widget/select-station` | Cycles the selected station and returns a recalculated compact widget payload. |

Recommendation requests require `departureDateTime` and `maxTransfers`, and accept either `originStationCode` or `originCoordinates`. Coordinate resolution selects the nearest station with valid coordinates within `originRadiusKm` (default 50 km); clients can instead submit a station code explicitly. The transfer buffer and optional maximum interchange wait are configurable.

The compact widget response contains schema version, selected station, next station for the cycle button, ordered train legs, and static-schedule freshness/live-status metadata. It intentionally excludes comparison cards and home travel estimates. The representative response is in [test/fixtures/widget-recommendation.json](./test/fixtures/widget-recommendation.json).

## 8. Dataset validation snapshot

The current validation run reports:

| Check | Result |
|---|---:|
| Malformed train, stop, or station rows | 0 |
| Duplicate train numbers | 0 |
| Duplicate station codes | 0 |
| Duplicate stop sequence keys | 0 |
| Stop references to unknown train/station codes | 0 |
| Train endpoint-code or stop-count mismatches | 0 |
| Stations with valid coordinate pairs | 0 of 8,608 |
| Blank station-master names | 26 |
| Blank stop names | 118 |
| Interior stop rows with a missing arrival or departure time | 18 |
| Trains that revisit a station code in their ordered route | 58 (400 additional calls) |

The 400 repeated station calls are not duplicate sequence records; they may reflect loops or repeated calls and are preserved in route order. Blank arrival/departure fields are expected at route endpoints, but some interior timetable rows also lack one or both times. The planner rejects the affected connection portions rather than guessing.

The dataset includes no update timestamp that the application can expose. Schedule results may be stale; they must not be presented as live departure boards, delay information, or operational guarantees.

## 9. Tests and coverage

Tests use Node’s built-in `node:test` runner and cover the data layer, planner, home-destination selection, nearest-station lookup, and HTTP API. Run all tests with `npm test`.

The suite includes focused synthetic fixtures for edge cases and API behavior. The datasummary-layer tests also load the supplied CSV dataset for record counts, route indexing and validation- assertions. Synthetic tests validate algorithm behavior; they are not evidence that every real-world route or service is operationally valid.

## 10. Project files

- [data.js](./data.js) — CSV loading, validation and reusable indexes.
- [journey-planner.js](./journey-planner.js) — date-aware scheduled journey search.
- [home-destination.js](./home-destination.js) — automatic home destination and manual cycle.
- [nearby-stations.js](./nearby-stations.js) — coordinate validation and Haversine lookup.
- [api.js](./api.js) — HTTP server and JSON endpoints.
- [index.js](./index.js) — CLI and convenience exports.
- [test/](./test) — unit and API tests.
- [package.json](./package.json) — scripts and dependencies.
- [README.md](./README.md) — API endpoint reference and examples.