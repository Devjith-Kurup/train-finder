const { normalizeCode } = require("./data");
const { planJourneys } = require("./journey-planner");

const HOME_DESTINATIONS = [
  { code: "NIIJ", name: "Nilaje" },
  { code: "GNSL", name: "Ghansoli" },
  { code: "DI", name: "Dombivli" }
];
const DEFAULT_EARLIER_ARRIVAL_MINUTES = 60;

function getHomeDestinationCycle(stationCode) {
  const code = normalizeCode(stationCode);
  const index = HOME_DESTINATIONS.findIndex(destination => destination.code === code);
  if (index === -1) {
    throw new RangeError("stationCode must be NIIJ, GNSL, or DI");
  }
  const next = HOME_DESTINATIONS[(index + 1) % HOME_DESTINATIONS.length];
  return { ...next };
}

function getHomeDestinationRecommendation(data, request) {
  if (!request || typeof request !== "object") {
    throw new TypeError("A home-destination request is required");
  }

  const fromCode = normalizeCode(request.fromCode);
  if (!fromCode) throw new TypeError("Origin station code is required");

  const threshold = request.earlierArrivalThresholdMinutes ??
    DEFAULT_EARLIER_ARRIVAL_MINUTES;
  if (!Number.isSafeInteger(threshold) || threshold < 0 || threshold > 1440) {
    throw new RangeError("earlierArrivalThresholdMinutes must be an integer from 0 to 1440");
  }

  const manualStationCode = request.manualStationCode === undefined ||
    request.manualStationCode === null ||
    String(request.manualStationCode).trim() === ""
    ? null
    : normalizeCode(request.manualStationCode);
  if (
    manualStationCode !== null &&
    !HOME_DESTINATIONS.some(destination => destination.code === manualStationCode)
  ) {
    throw new RangeError("manualStationCode must be NIIJ, GNSL, or DI");
  }

  const routeResults = new Map();
  for (const destination of HOME_DESTINATIONS) {
    const result = planJourneys(data, {
      ...request,
      fromCode,
      toCode: destination.code,
      maxResults: 1
    });
    routeResults.set(destination.code, result);
  }

  const bestJourneys = new Map();
  for (const [code, result] of routeResults) {
    bestJourneys.set(code, result.journeys[0] || null);
  }

  const arrivalTimes = Object.fromEntries(
    HOME_DESTINATIONS.map(destination => [
      destination.code,
      bestJourneys.get(destination.code)?.arrivalTime || null
    ])
  );
  const truncatedDestinations = HOME_DESTINATIONS
    .filter(destination => routeResults.get(destination.code).search.truncated)
    .map(destination => destination.code);
  const baseline = bestJourneys.get("NIIJ");
  let selected = HOME_DESTINATIONS[0];
  let reason = "default-nilaje";
  let status = "recommended";

  if (manualStationCode !== null) {
    selected = HOME_DESTINATIONS.find(
      destination => destination.code === manualStationCode
    );
    reason = "manual-override";
    status = "manual-override";
  } else if (truncatedDestinations.length > 0) {
    reason = baseline
      ? "search-incomplete"
      : "no-baseline-route-search-incomplete";
    status = "search-incomplete";
  } else if (!baseline) {
    reason = "no-baseline-route";
    status = "no-baseline-route";
  } else {
    const qualifyingAlternatives = HOME_DESTINATIONS.slice(1)
      .filter(destination => {
        const alternative = bestJourneys.get(destination.code);
        return alternative &&
          baseline.totalElapsedMinutes - alternative.totalElapsedMinutes >= threshold;
      })
      .sort((a, b) =>
        bestJourneys.get(a.code).totalElapsedMinutes -
          bestJourneys.get(b.code).totalElapsedMinutes ||
        HOME_DESTINATIONS.findIndex(destination => destination.code === a.code) -
          HOME_DESTINATIONS.findIndex(destination => destination.code === b.code)
      );

    if (qualifyingAlternatives.length > 0) {
      selected = qualifyingAlternatives[0];
      reason = "alternative-arrives-at-least-threshold-earlier";
    }
  }

  const selectedJourney = bestJourneys.get(selected.code);
  const baselineMinutes = baseline?.totalElapsedMinutes ?? null;
  const selectedMinutes = selectedJourney?.totalElapsedMinutes ?? null;
  const timeSavedMinutes = baselineMinutes === null || selectedMinutes === null
    ? null
    : baselineMinutes - selectedMinutes;

  return {
    status,
    selectedStation: { ...selected },
    reason,
    fromCode,
    departureDateTime: request.departureDateTime,
    earlierArrivalThresholdMinutes: threshold,
    comparisonArrivalTimes: arrivalTimes,
    timeSavedMinutes,
    recommendedItinerary: selectedJourney,
    manualOverride: manualStationCode !== null,
    search: {
      truncatedDestinations,
      destinations: Object.fromEntries(
        HOME_DESTINATIONS.map(destination => [
          destination.code,
          routeResults.get(destination.code).search
        ])
      )
    }
  };
}

module.exports = {
  HOME_DESTINATIONS,
  DEFAULT_EARLIER_ARRIVAL_MINUTES,
  getHomeDestinationCycle,
  getHomeDestinationRecommendation
};
