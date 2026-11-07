# Train Finder

The Node.js data layer and schedule-based journey planner can be used through a small HTTP API. The server binds to `127.0.0.1` by default and does not provide live train-running information.

## Start the API

```powershell
npm start
```

By default, the API listens on `http://127.0.0.1:3000`. Set `PORT` to choose another port. To explicitly bind to a different interface, set `HOST`; the default remains localhost.

All responses use JSON. Errors have the shape:

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "maxTransfers must be a non-negative integer."
  }
}
```

The schedule is static data. `GET /api/health` reports `liveRunningStatus: false`; no endpoint claims that a train is currently running on time or in service.

## `GET /api/health`

Returns basic process/data status.

```http
GET /api/health
```

```json
{
  "status": "ok",
  "dataLoaded": true,
  "liveRunningStatus": false
}
```

## `GET /api/stations/nearest`

Finds coordinate-bearing stations near client-provided coordinates. The client must obtain or request location permission itself; Node.js does not access GPS. Stations with missing or invalid dataset coordinates are ignored. If none are within the radius, `stations` is an empty array.

```http
GET /api/stations/nearest?lat=19.076&lon=72.878&radiusKm=25&limit=5
```

```json
{
  "stations": [
    { "code": "EXM", "name": "Example Station", "distanceKm": 3.42 }
  ]
}
```

`radiusKm` defaults to 50 and `limit` defaults to 5 (maximum 100). A client with uncertain GPS accuracy can present the returned candidates for a user to select instead of automatically treating the nearest result as certain.

## `POST /api/route/recommend`

Accepts an explicit origin station code or origin coordinates. Coordinates resolve to the nearest station with valid coordinates within `originRadiusKm` (default 50 km); the response includes the selected origin and candidate stations. If no station is found, the API responds with `422 NO_ORIGIN_STATION_IN_RANGE`. A client can instead send the station code chosen by the user.

Required: `departureDateTime` in local `YYYY-MM-DDTHH:mm` format and non-negative integer `maxTransfers`. `minimumTransferBufferMinutes` is optional (planner default: 10). `manualDestinationCode` optionally pins the destination to `NIIJ`, `GNSL`, or `DI`.

```json
{
  "originStationCode": "VGLJ",
  "departureDateTime": "2026-10-28T08:00",
  "maxTransfers": 2,
  "minimumTransferBufferMinutes": 10
}
```

Alternatively, send client coordinates:

```json
{
  "originCoordinates": { "latitude": 25.45, "longitude": 78.56 },
  "originRadiusKm": 30,
  "departureDateTime": "2026-10-28T08:00",
  "maxTransfers": 2,
  "manualDestinationCode": "GNSL"
}
```

The response contains the selected station, comparison arrival times, elapsed time, and ordered scheduled train legs. Each leg includes full train endpoints, boarding/deboarding station and times, ride/wait durations, and interchange details when present.

```json
{
  "status": "recommended",
  "selectedStation": { "code": "NIIJ", "name": "Nilaje" },
  "reason": "default-nilaje",
  "origin": {
    "code": "VGLJ",
    "name": "VIRANGANA LAKSHMIBAI JHANSI JN",
    "resolution": { "method": "station-code", "stationCode": "VGLJ" }
  },
  "departureDateTime": "2026-10-28T08:00",
  "arrivalTime": "2026-10-29T07:23",
  "totalElapsedMinutes": 1403,
  "transfers": 1,
  "legs": [
    {
      "trainNumber": "12618",
      "trainName": "MANGLADWEEP EXP",
      "trainSource": "HAZRAT NIZAMUDDIN JN",
      "trainSourceCode": "NZM",
      "trainDestination": "ERNAKULAM JN",
      "trainDestinationCode": "ERS",
      "boardAt": { "code": "VGLJ", "name": "VIRANGANA LAKSHMIBAI JHANSI JN" },
      "departureTime": "2026-10-28T12:08",
      "getDownAt": { "code": "PNVL", "name": "PANVEL" },
      "arrivalTime": "2026-10-29T06:30",
      "waitingTimeMinutes": 248,
      "rideTimeMinutes": 1102
    },
    {
      "trainNumber": "61010",
      "trainName": "ROHA-DIVA MEMU",
      "trainSource": "ROHA",
      "trainSourceCode": "ROHA",
      "trainDestination": "DIVA",
      "trainDestinationCode": "DIVA",
      "boardAt": { "code": "PNVL", "name": "PANVEL" },
      "departureTime": "2026-10-29T06:50",
      "getDownAt": { "code": "NIIJ", "name": "NILAJE" },
      "arrivalTime": "2026-10-29T07:23",
      "interchange": {
        "station": { "code": "PNVL", "name": "PANVEL" },
        "previousTrainArrivalTime": "2026-10-29T06:30",
        "nextTrainDepartureTime": "2026-10-29T06:50",
        "waitMinutes": 20
      },
      "waitingTimeMinutes": 20,
      "rideTimeMinutes": 33
    }
  ],
  "comparisonArrivalTimes": {
    "NIIJ": "2026-10-29T07:23",
    "GNSL": "2026-10-29T15:18",
    "DI": "2026-10-29T13:25"
  },
  "timeSavedMinutes": 0,
  "earlierArrivalThresholdMinutes": 60,
  "manualOverride": false
}
```

## `POST /api/route/select-station`

Cycles from the currently selected home destination in the fixed order **Nilaje (`NIIJ`) → Ghansoli (`GNSL`) → Dombivli (`DI`) → Nilaje** and recalculates the itinerary for the next destination. It accepts the same origin/time/transfer fields as `/api/route/recommend` and additionally requires `currentDestinationCode`.

```json
{
  "originStationCode": "VGLJ",
  "departureDateTime": "2026-10-28T08:00",
  "maxTransfers": 2,
  "currentDestinationCode": "NIIJ"
}
```

The response uses the same route shape as the recommendation endpoint and adds:

```json
{
  "manualDestinationSelection": {
    "previous": { "code": "NIIJ", "name": "Nilaje" },
    "selected": { "code": "GNSL", "name": "Ghansoli" }
  }
}
```

## Compact widget responses

The compact widget endpoints return a deterministic, versioned payload without titles, summaries, comparison cards, elapsed home-travel estimates, or live-running claims. They use the same request fields and recommendation logic as the corresponding `/api/route/*` endpoints.

- `POST /api/widget/recommend`
- `POST /api/widget/select-station`

The response contains the selected station, a `stationCycleButton.nextStation`, and ordered train legs. Each leg includes the train number/name, full scheduled train source and destination, boarding/deboarding station and local date-time, and (after the first leg) interchange station and wait in minutes. `routeAvailable` is `false` with an empty `legs` array when no schedule route is available.

The small `dataFreshness` field identifies the static schedule dataset. `liveRunningData` is always `false`; dataset update time is unavailable.

Widget request example:

```json
{
  "originStationCode": "VGLJ",
  "departureDateTime": "2026-10-28T08:00",
  "maxTransfers": 2
}
```

Representative compact response:

```json
{
  "schemaVersion": "1.0",
  "selectedStation": { "code": "NIIJ", "name": "Nilaje" },
  "stationCycleButton": {
    "nextStation": { "code": "GNSL", "name": "Ghansoli" }
  },
  "routeAvailable": true,
  "legs": [
    {
      "trainNumber": "12618",
      "trainName": "MANGLADWEEP EXP",
      "train": {
        "source": "HAZRAT NIZAMUDDIN JN",
        "sourceCode": "NZM",
        "destination": "ERNAKULAM JN",
        "destinationCode": "ERS"
      },
      "boardAt": {
        "code": "VGLJ",
        "name": "VIRANGANA LAKSHMIBAI JHANSI JN"
      },
      "departureTime": "2026-10-28T12:08",
      "getDownAt": { "code": "PNVL", "name": "PANVEL" },
      "arrivalTime": "2026-10-29T06:30"
    },
    {
      "trainNumber": "61010",
      "trainName": "ROHA-DIVA MEMU",
      "train": {
        "source": "ROHA",
        "sourceCode": "ROHA",
        "destination": "DIVA",
        "destinationCode": "DIVA"
      },
      "boardAt": { "code": "PNVL", "name": "PANVEL" },
      "departureTime": "2026-10-29T06:50",
      "getDownAt": { "code": "NIIJ", "name": "NILAJE" },
      "arrivalTime": "2026-10-29T07:23",
      "interchange": {
        "station": { "code": "PNVL", "name": "PANVEL" },
        "waitMinutes": 20
      }
    }
  ],
  "dataFreshness": {
    "source": "static-schedule-dataset",
    "freshness": "update-time-unavailable",
    "liveRunningData": false
  }
}
```

The widget cycles by calling `POST /api/widget/select-station` with the same origin/time/transfer inputs plus the destination currently displayed as `currentDestinationCode`. Each call advances one position: `NIIJ` → `GNSL` → `DI` → `NIIJ`, recalculates the itinerary, and returns the next station in `stationCycleButton.nextStation`. This endpoint honors the selected destination rather than applying the automatic recommendation again.

## Run tests

```powershell
npm test
```
