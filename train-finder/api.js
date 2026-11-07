const http = require("node:http");
const { URL } = require("node:url");
const { loadData, normalizeCode } = require("./data");
const { findNearbyStations } = require("./nearby-stations");
const {
  getHomeDestinationCycle,
  getHomeDestinationRecommendation
} = require("./home-destination");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 64 * 1024;
const DESTINATION_CODES = new Set(["NIIJ", "GNSL", "DI"]);

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sendJson(response, status, body) {
  const content = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
    "cache-control": "no-store"
  });
  response.end(content);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", chunk => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        tooLarge = true;
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new ApiError(413, "BODY_TOO_LARGE", "Request body exceeds 64 KiB."));
        return;
      }
      if (!body.trim()) {
        reject(new ApiError(400, "INVALID_JSON", "A JSON request body is required."));
        return;
      }
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new SyntaxError("JSON body must be an object");
        }
        resolve(parsed);
      } catch {
        reject(new ApiError(400, "INVALID_JSON", "Request body must be a JSON object."));
      }
    });
    request.on("error", error => reject(error));
  });
}

function parseNumericInput(value, name) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim())
  ) {
    throw new ApiError(400, "INVALID_INPUT", `${name} must be a finite number.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new ApiError(400, "INVALID_INPUT", `${name} must be a finite number.`);
  }
  return number;
}

function resolveOrigin(data, body) {
  const stationCode = body.originStationCode ??
    body.originStation?.code ??
    (typeof body.origin === "string"
      ? body.origin
      : body.origin?.stationCode ?? body.origin?.code);

  if (stationCode !== undefined && stationCode !== null &&
      String(stationCode).trim() !== "") {
    const code = normalizeCode(stationCode);
    const station = data.stationInfo.get(code);
    if (!station) {
      throw new ApiError(400, "UNKNOWN_ORIGIN_STATION", `Unknown origin station code: ${code}.`);
    }
    return {
      station,
      resolution: { method: "station-code", stationCode: code }
    };
  }

  const coordinates = body.originCoordinates ??
    (body.origin && typeof body.origin === "object" ? body.origin : null);
  const latitudeValue = coordinates?.latitude ?? coordinates?.lat;
  const longitudeValue = coordinates?.longitude ?? coordinates?.lon;
  if (!coordinates || latitudeValue === undefined || longitudeValue === undefined) {
    throw new ApiError(
      400,
      "ORIGIN_REQUIRED",
      "Provide originStationCode or originCoordinates with latitude and longitude."
    );
  }

  const latitude = parseNumericInput(latitudeValue, "originCoordinates.latitude");
  const longitude = parseNumericInput(longitudeValue, "originCoordinates.longitude");
  let candidates;
  try {
    candidates = findNearbyStations(
      [...data.stationInfo.values()],
      latitude,
      longitude,
      {
        radiusKm: body.originRadiusKm ?? 50,
        limit: body.originStationLimit ?? 5
      }
    );
  } catch (error) {
    throw new ApiError(400, "INVALID_INPUT", error.message);
  }
  if (candidates.length === 0) {
    throw new ApiError(
      422,
      "NO_ORIGIN_STATION_IN_RANGE",
      "No station with valid coordinates was found within the requested radius.",
      { candidates: [] }
    );
  }

  const station = data.stationInfo.get(candidates[0].code);
  return {
    station,
    resolution: {
      method: "nearest-coordinate",
      selectedBy: "nearest-distance",
      stationCode: station.code,
      candidates
    }
  };
}

function validateRecommendationFields(body) {
  if (typeof body.departureDateTime !== "string" || !body.departureDateTime.trim()) {
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "departureDateTime in local YYYY-MM-DDTHH:mm format is required."
    );
  }
  if (!Number.isSafeInteger(body.maxTransfers) || body.maxTransfers < 0) {
    throw new ApiError(400, "INVALID_INPUT", "maxTransfers must be a non-negative integer.");
  }
  if (
    body.minimumTransferBufferMinutes !== undefined &&
    (!Number.isSafeInteger(body.minimumTransferBufferMinutes) ||
      body.minimumTransferBufferMinutes < 0)
  ) {
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "minimumTransferBufferMinutes must be a non-negative integer."
    );
  }
  if (
    body.maximumInterchangeWaitMinutes !== undefined &&
    (!Number.isSafeInteger(body.maximumInterchangeWaitMinutes) ||
      body.maximumInterchangeWaitMinutes < 0)
  ) {
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "maximumInterchangeWaitMinutes must be a non-negative integer."
    );
  }
}

function toApiRecommendation(recommendation, origin) {
  const itinerary = recommendation.recommendedItinerary;
  const legs = itinerary?.legs.map((leg, index) => {
    const previous = index > 0 ? itinerary.legs[index - 1] : null;
    return {
      trainNumber: leg.trainNumber,
      trainName: leg.trainName,
      trainSource: leg.trainSource,
      trainSourceCode: leg.trainSourceCode,
      trainDestination: leg.trainDestination,
      trainDestinationCode: leg.trainDestinationCode,
      boardAt: leg.boardingStation,
      departureTime: leg.boardingTime,
      getDownAt: leg.getOffStation,
      arrivalTime: leg.arrivalTime,
      ...(previous
        ? {
          interchange: {
            station: previous.getOffStation,
            previousTrainArrivalTime: previous.arrivalTime,
            nextTrainDepartureTime: leg.boardingTime,
            waitMinutes: leg.interchangeWaitMinutes
          }
        }
        : {}),
      waitingTimeMinutes: leg.waitingTimeMinutes,
      rideTimeMinutes: leg.rideTimeMinutes
    };
  }) || [];

  return {
    status: recommendation.status,
    selectedStation: recommendation.selectedStation,
    reason: recommendation.reason,
    origin: {
      code: origin.station.code,
      name: origin.station.name,
      resolution: origin.resolution
    },
    departureDateTime: recommendation.departureDateTime,
    arrivalTime: itinerary?.arrivalTime ?? null,
    totalElapsedMinutes: itinerary?.totalElapsedMinutes ?? null,
    transfers: itinerary?.transfers ?? null,
    legs,
    comparisonArrivalTimes: recommendation.comparisonArrivalTimes,
    timeSavedMinutes: recommendation.timeSavedMinutes,
    earlierArrivalThresholdMinutes: recommendation.earlierArrivalThresholdMinutes,
    manualOverride: recommendation.manualOverride,
    search: recommendation.search
  };
}

function recommend(data, body, destinationOverride) {
  validateRecommendationFields(body);
  const origin = resolveOrigin(data, body);
  const manualStationCode = destinationOverride ??
    body.manualDestinationCode ??
    body.manualStationCode;
  if (
    manualStationCode !== undefined &&
    manualStationCode !== null &&
    !DESTINATION_CODES.has(normalizeCode(manualStationCode))
  ) {
    throw new ApiError(
      400,
      "INVALID_DESTINATION",
      "Destination must be NIIJ, GNSL, or DI."
    );
  }

  const recommendation = getHomeDestinationRecommendation(data, {
    fromCode: origin.station.code,
    departureDateTime: body.departureDateTime,
    maxTransfers: body.maxTransfers,
    ...(body.minimumTransferBufferMinutes === undefined
      ? {}
      : { minimumTransferBufferMinutes: body.minimumTransferBufferMinutes }),
    ...(body.maximumInterchangeWaitMinutes === undefined
      ? {}
      : { maximumInterchangeWaitMinutes: body.maximumInterchangeWaitMinutes }),
    ...(body.earlierArrivalThresholdMinutes === undefined
      ? {}
      : { earlierArrivalThresholdMinutes: body.earlierArrivalThresholdMinutes }),
    ...(manualStationCode === undefined || manualStationCode === null
      ? {}
      : { manualStationCode: normalizeCode(manualStationCode) })
  });
  return toApiRecommendation(recommendation, origin);
}

function toWidgetPayload(recommendation) {
  const nextStation = getHomeDestinationCycle(
    recommendation.selectedStation.code
  );
  const legs = recommendation.legs.map((leg, index) => ({
    trainNumber: leg.trainNumber,
    trainName: leg.trainName,
    train: {
      source: leg.trainSource,
      sourceCode: leg.trainSourceCode,
      destination: leg.trainDestination,
      destinationCode: leg.trainDestinationCode
    },
    boardAt: leg.boardAt,
    departureTime: leg.departureTime,
    getDownAt: leg.getDownAt,
    arrivalTime: leg.arrivalTime,
    ...(index > 0
      ? {
        interchange: {
          station: recommendation.legs[index - 1].getDownAt,
          waitMinutes: leg.interchange?.waitMinutes ?? null
        }
      }
      : {})
  }));

  return {
    schemaVersion: "1.0",
    selectedStation: recommendation.selectedStation,
    stationCycleButton: { nextStation },
    routeAvailable: legs.length > 0,
    legs,
    dataFreshness: {
      source: "static-schedule-dataset",
      freshness: "update-time-unavailable",
      liveRunningData: false
    }
  };
}

function createRequestHandler(data = loadData()) {
  return async function handleRequest(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, {
          status: "ok",
          dataLoaded: true,
          liveRunningStatus: false
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/stations/nearest") {
        const lat = url.searchParams.get("lat");
        const lon = url.searchParams.get("lon");
        if (lat === null || lon === null) {
          throw new ApiError(
            400,
            "INVALID_INPUT",
            "Query parameters lat and lon are required."
          );
        }
        const radiusValue = url.searchParams.get("radiusKm");
        const limitValue = url.searchParams.get("limit");
        let stations;
        try {
          stations = findNearbyStations(
            [...data.stationInfo.values()],
            parseNumericInput(lat, "lat"),
            parseNumericInput(lon, "lon"),
            {
              ...(radiusValue === null
                ? {}
                : { radiusKm: parseNumericInput(radiusValue, "radiusKm") }),
              ...(limitValue === null
                ? {}
                : { limit: parseNumericInput(limitValue, "limit") })
            }
          );
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(400, "INVALID_INPUT", error.message);
        }
        sendJson(response, 200, { stations });
        return;
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/api/route/recommend" ||
          url.pathname === "/api/route/select-station" ||
          url.pathname === "/api/widget/recommend" ||
          url.pathname === "/api/widget/select-station")
      ) {
        const body = await readJsonBody(request);
        let result;
        const isWidgetRequest = url.pathname.startsWith("/api/widget/");
        if (
          url.pathname === "/api/route/recommend" ||
          url.pathname === "/api/widget/recommend"
        ) {
          result = recommend(data, body);
        } else {
          const currentCode = normalizeCode(body.currentDestinationCode);
          if (!DESTINATION_CODES.has(currentCode)) {
            throw new ApiError(
              400,
              "INVALID_DESTINATION",
              "currentDestinationCode must be NIIJ, GNSL, or DI."
            );
          }
          const nextDestination = getHomeDestinationCycle(currentCode);
          result = recommend(data, body, nextDestination.code);
          result.manualDestinationSelection = {
            previous: {
              code: currentCode,
              name: currentCode === "NIIJ"
                ? "Nilaje"
                : currentCode === "GNSL"
                  ? "Ghansoli"
                  : "Dombivli"
            },
            selected: nextDestination
          };
        }
        if (isWidgetRequest) result = toWidgetPayload(result);
        sendJson(response, 200, result);
        return;
      }

      const pathExists = [
        "/api/health",
        "/api/stations/nearest",
        "/api/route/recommend",
        "/api/route/select-station",
        "/api/widget/recommend",
        "/api/widget/select-station"
      ].includes(url.pathname);
      if (pathExists) {
        sendJson(response, 405, {
          error: {
            code: "METHOD_NOT_ALLOWED",
            message: "HTTP method is not allowed for this endpoint."
          }
        });
        return;
      }

      sendJson(response, 404, {
        error: { code: "NOT_FOUND", message: "API endpoint not found." }
      });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof ApiError) {
        sendJson(response, error.status, {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details })
          }
        });
        return;
      }
      if (error instanceof TypeError || error instanceof RangeError) {
        sendJson(response, 400, {
          error: { code: "INVALID_INPUT", message: error.message }
        });
        return;
      }
      console.error("Train Finder API error:", error);
      sendJson(response, 500, {
        error: { code: "INTERNAL_ERROR", message: "An internal server error occurred." }
      });
    }
  };
}

function createApiServer(options = {}) {
  const data = options.data || loadData();
  return http.createServer(createRequestHandler(data));
}

if (require.main === module) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("PORT must be an integer from 0 to 65535");
  }
  const host = process.env.HOST || DEFAULT_HOST;
  const server = createApiServer();
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`Train Finder API listening at http://${host}:${address.port}`);
  });
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  createApiServer,
  createRequestHandler
};
