const EARTH_MEAN_RADIUS_KM = 6371.0088;
const DEFAULT_RADIUS_KM = 50;
const DEFAULT_LIMIT = 5;

function coordinate(value, name, min, max) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`${name} must be a finite number from ${min} to ${max}`);
  }
  return parsed;
}

function stationCoordinate(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value.trim())
      : NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function haversineDistanceKm(latitude1, longitude1, latitude2, longitude2) {
  const lat1 = coordinate(latitude1, "latitude1", -90, 90);
  const lon1 = coordinate(longitude1, "longitude1", -180, 180);
  const lat2 = coordinate(latitude2, "latitude2", -90, 90);
  const lon2 = coordinate(longitude2, "longitude2", -180, 180);
  const toRadians = degrees => degrees * Math.PI / 180;
  const deltaLatitude = toRadians(lat2 - lat1);
  const deltaLongitude = toRadians(lon2 - lon1);
  const haversine = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
    Math.cos(toRadians(lat2)) *
    Math.sin(deltaLongitude / 2) ** 2;
  const centralAngle = 2 * Math.atan2(
    Math.sqrt(haversine),
    Math.sqrt(Math.max(0, 1 - haversine))
  );
  return EARTH_MEAN_RADIUS_KM * centralAngle;
}

function findNearbyStations(stations, latitude, longitude, options = {}) {
  if (!Array.isArray(stations)) {
    throw new TypeError("stations must be an array");
  }
  const originLatitude = coordinate(latitude, "latitude", -90, 90);
  const originLongitude = coordinate(longitude, "longitude", -180, 180);
  const radiusKm = options.radiusKm ?? DEFAULT_RADIUS_KM;
  if (typeof radiusKm !== "number" || !Number.isFinite(radiusKm) || radiusKm < 0) {
    throw new RangeError("radiusKm must be a finite non-negative number");
  }
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer from 1 to 100");
  }

  const matches = [];
  for (const station of stations) {
    if (!station || typeof station !== "object") continue;
    const lat = stationCoordinate(station.lat, -90, 90);
    const lon = stationCoordinate(station.lon, -180, 180);
    if (lat === null || lon === null) continue;

    const exactDistance = haversineDistanceKm(
      originLatitude,
      originLongitude,
      lat,
      lon
    );
    if (exactDistance <= radiusKm) {
      matches.push({
        code: String(station.code ?? "").trim().toUpperCase(),
        name: String(station.name ?? "").trim(),
        distanceKm: Number(exactDistance.toFixed(3)),
        exactDistance
      });
    }
  }

  return matches
    .sort((a, b) => a.exactDistance - b.exactDistance || a.code.localeCompare(b.code))
    .slice(0, limit)
    .map(({ exactDistance, ...station }) => station);
}

module.exports = {
  DEFAULT_RADIUS_KM,
  DEFAULT_LIMIT,
  haversineDistanceKm,
  findNearbyStations
};
