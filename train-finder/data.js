const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const DATA_DIR = path.join(__dirname, "..", "data", "out");
const ENRICHED_DATA_DIR = path.join(DATA_DIR, "station-enrichment", "production");
const ENRICHED_STATIONS_FILE = "stations.enriched.csv";
const SCHEMAS = {
  trains: [
    "number", "name", "type", "type_label", "runs_days", "source_code",
    "source", "dest_code", "destination", "distance_km", "travel_time",
    "num_stops"
  ],
  stops: [
    "train_number", "seq", "station_code", "station_name", "day",
    "arrival", "departure", "halt_min", "distance_km"
  ],
  stations: ["code", "name", "lat", "lon"]
};
const MAX_EXAMPLES = 10;

function normalizeCode(code) {
  return String(code ?? "").trim().toUpperCase();
}

function normalizeTrainNumber(number) {
  return String(number ?? "").trim();
}

function timeToMinutes(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

function getStopTime(stop, field) {
  return String(stop?.[field] ?? "").trim();
}

function addExample(list, value) {
  if (list.length < MAX_EXAMPLES) list.push(value);
}

function readCSV(dataDir, filename, schema) {
  const filePath = path.join(dataDir, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Dataset file not found: ${filePath}`);
  }

  let rows;
  try {
    rows = parse(fs.readFileSync(filePath, "utf8"), {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true
    });
  } catch (error) {
    throw new Error(`Could not parse ${filePath}: ${error.message}`);
  }

  if (rows.length === 0) {
    throw new Error(`Dataset file is empty: ${filePath}`);
  }

  const headers = rows[0].map(header => String(header).trim());
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicateHeaders.length) {
    throw new Error(
      `Dataset file ${filePath} has duplicate columns: ${[...new Set(duplicateHeaders)].join(", ")}`
    );
  }
  const missingHeaders = schema.filter(header => !headers.includes(header));
  if (missingHeaders.length) {
    throw new Error(
      `Dataset file ${filePath} is missing required columns: ${missingHeaders.join(", ")}`
    );
  }

  const malformedRows = [];
  const records = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    if (row.length !== headers.length) {
      malformedRows.push({
        record: index,
        issue: `Expected ${headers.length} columns, received ${row.length}`
      });
      continue;
    }

    const record = Object.fromEntries(headers.map((header, i) => [header, row[i]]));
    Object.defineProperty(record, "__recordNumber", { value: index });
    records.push(record);
  }

  return { records, malformedRows };
}

function numericOrNull(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function createDataLayer(records, parserIssues = {}) {
  const malformedRows = { trains: 0, stops: 0, stations: 0 };
  const malformedRowKeys = {
    trains: new Set(),
    stops: new Set(),
    stations: new Set()
  };
  const malformedExamples = [];
  const duplicateTrainExamples = [];
  let duplicateTrainCount = 0;
  const conflictingRunDays = [];
  let conflictingRunDaysCount = 0;
  const duplicateStationExamples = [];
  let duplicateStationCount = 0;
  const duplicateStopExamples = [];
  let duplicateStopCount = 0;
  const unknownStationExamples = [];
  const unknownStationCodeSet = new Set();
  let unknownStationReferenceCount = 0;
  const missingCoordinateExamples = [];
  let missingCoordinateCount = 0;
  const invalidCoordinateExamples = [];
  let invalidCoordinateCount = 0;
  const incompleteEndpointRoutes = [];
  const unindexableRoutes = [];

  for (const name of Object.keys(malformedRows)) {
    const issues = parserIssues[name] || [];
    malformedRows[name] += issues.length;
    for (const issue of issues) {
      malformedRowKeys[name].add(issue.record);
      addExample(malformedExamples, { file: name, ...issue });
    }
  }

  function recordMalformed(file, record, issue) {
    if (!malformedRowKeys[file].has(record)) {
      malformedRows[file]++;
      malformedRowKeys[file].add(record);
    }
    addExample(malformedExamples, { file, record, issue });
  }

  const cleanTrains = [];
  const trainsByNumber = new Map();
  for (const [index, raw] of (records.trains || []).entries()) {
    const recordNumber = raw.__recordNumber ?? index + 1;
    const number = normalizeTrainNumber(raw.number);
    if (!number) {
      recordMalformed("trains", recordNumber, "Missing train number");
      continue;
    }

    const train = { ...raw, number };
    cleanTrains.push(train);
    if (!trainsByNumber.has(number)) trainsByNumber.set(number, []);
    trainsByNumber.get(number).push(train);
  }

  const ambiguousTrainNumbers = new Set();
  for (const [number, matches] of trainsByNumber) {
    if (matches.length < 2) continue;
    ambiguousTrainNumbers.add(number);
    const runDays = [...new Set(matches.map(train => String(train.runs_days ?? "").trim()))];
    duplicateTrainCount++;
    addExample(duplicateTrainExamples, { number, records: matches.length });
    if (runDays.length > 1) {
      conflictingRunDaysCount++;
      addExample(conflictingRunDays, { number, runDays });
    }
  }

  const cleanStations = [];
  const stationsByCode = new Map();
  for (const [index, raw] of (records.stations || []).entries()) {
    const recordNumber = raw.__recordNumber ?? index + 1;
    const code = normalizeCode(raw.code);
    if (!code) {
      recordMalformed("stations", recordNumber, "Missing station code");
      continue;
    }

    let lat = numericOrNull(raw.lat);
    let lon = numericOrNull(raw.lon);
    const invalid = (lat !== null && (lat < -90 || lat > 90)) ||
      (lon !== null && (lon < -180 || lon > 180)) ||
      (String(raw.lat ?? "").trim() && lat === null) ||
      (String(raw.lon ?? "").trim() && lon === null);
    if (invalid) {
      invalidCoordinateCount++;
      addExample(invalidCoordinateExamples, { code, lat: raw.lat ?? "", lon: raw.lon ?? "" });
      lat = null;
      lon = null;
    }
    if (lat === null || lon === null) {
      missingCoordinateCount++;
      addExample(missingCoordinateExamples, {
        code,
        missingLat: lat === null,
        missingLon: lon === null
      });
    }

    const station = { ...raw, code, name: String(raw.name ?? "").trim(), lat, lon };
    cleanStations.push(station);
    if (!stationsByCode.has(code)) stationsByCode.set(code, []);
    stationsByCode.get(code).push(station);
  }

  const duplicateStationCodeSet = new Set();
  for (const [code, matches] of stationsByCode) {
    if (matches.length < 2) continue;
    duplicateStationCodeSet.add(code);
    duplicateStationCount++;
    addExample(duplicateStationExamples, { code, records: matches.length });
  }

  const validStops = [];
  const stopsByTrainAndSequence = new Map();
  for (const [index, raw] of (records.stops || []).entries()) {
    const recordNumber = raw.__recordNumber ?? index + 1;
    const trainNumber = normalizeTrainNumber(raw.train_number);
    const stationCode = normalizeCode(raw.station_code);
    const sequenceText = String(raw.seq ?? "").trim();
    const seq = Number(sequenceText);
    const dayText = String(raw.day ?? "").trim();
    const day = Number(dayText);
    const issues = [];

    if (!trainNumber) issues.push("Missing train number");
    if (!stationCode) issues.push("Missing station code");
    if (!/^\d+$/.test(sequenceText) || !Number.isSafeInteger(seq) || seq < 1) {
      issues.push("Invalid stop sequence");
    }
    if (!/^\d+$/.test(dayText) || !Number.isSafeInteger(day) || day < 1) {
      issues.push("Invalid journey day");
    }
    for (const field of ["arrival", "departure"]) {
      const time = String(raw[field] ?? "").trim();
      if (time && timeToMinutes(time) === null) {
        issues.push(`Invalid ${field} time`);
      }
    }
    if (issues.length) {
      for (const issue of issues) recordMalformed("stops", recordNumber, issue);
      continue;
    }

    const stop = {
      ...raw,
      train_number: trainNumber,
      seq,
      station_code: stationCode,
      station_name: String(raw.station_name ?? "").trim(),
      day,
      arrival: String(raw.arrival ?? "").trim() || null,
      departure: String(raw.departure ?? "").trim() || null
    };
    validStops.push(stop);
    if (!stopsByTrainAndSequence.has(trainNumber)) {
      stopsByTrainAndSequence.set(trainNumber, new Map());
    }
    const bySequence = stopsByTrainAndSequence.get(trainNumber);
    if (!bySequence.has(seq)) bySequence.set(seq, []);
    bySequence.get(seq).push(stop);

    if (!stationsByCode.has(stationCode)) {
      unknownStationReferenceCount++;
      if (!unknownStationCodeSet.has(stationCode)) {
        unknownStationCodeSet.add(stationCode);
        addExample(unknownStationExamples, { code: stationCode, trainNumber, sequence: seq });
      }
    }
  }

  const duplicateStopTrainNumbers = new Set();
  for (const [trainNumber, bySequence] of stopsByTrainAndSequence) {
    for (const [sequence, matches] of bySequence) {
      if (matches.length < 2) continue;
      duplicateStopTrainNumbers.add(trainNumber);
      duplicateStopCount++;
      addExample(duplicateStopExamples, {
        trainNumber,
        sequence,
        records: matches.length
      });
    }
  }
  const unindexableTrainNumbers = new Set([
    ...ambiguousTrainNumbers,
    ...duplicateStopTrainNumbers
  ]);

  const metadataByNumber = new Map();
  for (const [number, matches] of trainsByNumber) {
    if (matches.length === 1) metadataByNumber.set(number, matches[0]);
  }

  const routeStops = new Map();
  for (const stop of validStops) {
    if (ambiguousTrainNumbers.has(stop.train_number) ||
        duplicateStopTrainNumbers.has(stop.train_number)) continue;
    if (!routeStops.has(stop.train_number)) routeStops.set(stop.train_number, []);
    routeStops.get(stop.train_number).push(stop);
  }

  const routes = new Map();
  for (const number of metadataByNumber.keys()) routes.set(number, []);
  for (const [number, route] of routeStops) {
    route.sort((a, b) => a.seq - b.seq);
    routes.set(number, route);
  }

  const stationInfo = new Map();
  const stationNames = new Map();
  for (const [code, matches] of stationsByCode) {
    if (matches.length !== 1) continue;
    stationInfo.set(code, matches[0]);
    stationNames.set(code, matches[0].name);
  }

  const trainsAtStation = new Map();
  for (const [trainNumber, route] of routes) {
    for (let stopIndex = 0; stopIndex < route.length; stopIndex++) {
      const stop = route[stopIndex];
      if (!trainsAtStation.has(stop.station_code)) {
        trainsAtStation.set(stop.station_code, []);
      }
      trainsAtStation.get(stop.station_code).push({ trainNumber, stopIndex, stop });
    }
  }

  const trainInfo = new Map(metadataByNumber);
  const incompleteTrainNumbers = new Set();
  for (const [number, route] of routes) {
    if (unindexableTrainNumbers.has(number)) continue;
    const train = trainInfo.get(number);
    const first = route[0];
    const last = route[route.length - 1];
    const issues = [];
    if (!first || !last) {
      issues.push("Route has no stops");
    } else {
      if (!first.station_code || !last.station_code) issues.push("Missing route endpoint station code");
      const sourceCode = normalizeCode(train?.source_code);
      const destinationCode = normalizeCode(train?.dest_code);
      if (!sourceCode) {
        issues.push("Missing origin in train metadata");
      } else if (sourceCode !== first.station_code) {
        issues.push("Origin differs from train metadata");
      }
      if (!destinationCode) {
        issues.push("Missing destination in train metadata");
      } else if (destinationCode !== last.station_code) {
        issues.push("Destination differs from train metadata");
      }
    }
    if (issues.length) {
      incompleteTrainNumbers.add(number);
      addExample(incompleteEndpointRoutes, { trainNumber: number, issues });
    }
  }
  for (const number of ambiguousTrainNumbers) {
    addExample(unindexableRoutes, {
      trainNumber: number,
      issues: duplicateStopTrainNumbers.has(number)
        ? ["Duplicate train metadata", "Duplicate stop sequence"]
        : ["Duplicate train metadata; route was not indexed"]
    });
  }
  for (const number of duplicateStopTrainNumbers) {
    if (!ambiguousTrainNumbers.has(number)) {
      addExample(unindexableRoutes, {
        trainNumber: number,
        issues: ["Duplicate stop sequence; route was not indexed"]
      });
    }
  }

  const allTrainNumbers = new Set([
    ...trainsByNumber.keys(),
    ...stopsByTrainAndSequence.keys()
  ]);
  for (const number of allTrainNumbers) {
    if (ambiguousTrainNumbers.has(number) || duplicateStopTrainNumbers.has(number)) continue;
    if (!routes.has(number) || routes.get(number).length === 0) {
      incompleteTrainNumbers.add(number);
      addExample(incompleteEndpointRoutes, { trainNumber: number, issues: ["Route has no stops"] });
    }
  }

  const summary = {
    recordCounts: {
      trains: (records.trains || []).length + (parserIssues.trains || []).length,
      stops: (records.stops || []).length + (parserIssues.stops || []).length,
      stations: (records.stations || []).length + (parserIssues.stations || []).length
    },
    indexedCounts: {
      trains: trainInfo.size,
      routes: routes.size,
      stations: stationInfo.size,
      stationsWithStops: trainsAtStation.size
    },
    malformedRows,
    malformedExamples,
    duplicateTrainNumbers: {
      count: duplicateTrainCount,
      examples: duplicateTrainExamples
    },
    conflictingRunDays: {
      count: conflictingRunDaysCount,
      examples: conflictingRunDays
    },
    duplicateStationCodes: {
      count: duplicateStationCount,
      examples: duplicateStationExamples
    },
    duplicateStops: {
      count: duplicateStopCount,
      examples: duplicateStopExamples
    },
    unknownStationCodes: {
      count: unknownStationCodeSet.size,
      references: unknownStationReferenceCount,
      examples: unknownStationExamples
    },
    missingCoordinates: {
      count: missingCoordinateCount,
      examples: missingCoordinateExamples
    },
    invalidCoordinates: {
      count: invalidCoordinateCount,
      examples: invalidCoordinateExamples
    },
    coordinateCounts: {
      withCoordinates: cleanStations.filter(station => station.lat !== null && station.lon !== null).length,
      withoutCoordinates: cleanStations.filter(station => station.lat === null || station.lon === null).length
    },
    incompleteEndpointRoutes: {
      count: incompleteTrainNumbers.size,
      examples: incompleteEndpointRoutes
    },
    unindexableRoutes: {
      count: unindexableTrainNumbers.size,
      examples: unindexableRoutes
    }
  };

  function getStationName(code) {
    const normalized = normalizeCode(code);
    return stationNames.get(normalized) || normalized;
  }

  function findDirectTrains(fromCode, toCode) {
    const from = normalizeCode(fromCode);
    const to = normalizeCode(toCode);
    if (!from || !to || from === to) return [];

    const results = [];
    for (const candidate of trainsAtStation.get(from) || []) {
      const route = routes.get(candidate.trainNumber);
      const toIndex = route.findIndex((stop, index) =>
        index > candidate.stopIndex && stop.station_code === to
      );
      if (toIndex === -1) continue;

      const train = trainInfo.get(candidate.trainNumber);
      results.push({
        number: candidate.trainNumber,
        name: train?.name || "Unknown train",
        source: getStationName(route[0]?.station_code),
        destination: getStationName(route[route.length - 1]?.station_code),
        boardAt: getStationName(from),
        getDownAt: getStationName(to),
        departure: getStopTime(candidate.stop, "departure"),
        arrival: getStopTime(route[toIndex], "arrival"),
        stopsBetween: toIndex - candidate.stopIndex - 1,
        runsDays: train?.runs_days || ""
      });
    }

    return results.sort((a, b) => {
      const timeA = timeToMinutes(a.departure);
      const timeB = timeToMinutes(b.departure);
      if (timeA === null) return 1;
      if (timeB === null) return -1;
      return timeA - timeB;
    });
  }

  function getTrainRoute(trainNumber) {
    const number = normalizeTrainNumber(trainNumber);
    const route = routes.get(number);
    if (!route) return null;

    const train = trainInfo.get(number);
    return {
      number,
      name: train?.name || "Unknown train",
      source: getStationName(route[0]?.station_code),
      destination: getStationName(route[route.length - 1]?.station_code),
      runsDays: train?.runs_days || "",
      stops: route.map(stop => ({
        sequence: stop.seq,
        stationCode: stop.station_code,
        station: getStationName(stop.station_code) || stop.station_name,
        arrival: getStopTime(stop, "arrival"),
        departure: getStopTime(stop, "departure"),
        day: stop.day,
        distanceKm: stop.distance_km
      }))
    };
  }

  return {
    trains: cleanTrains,
    stops: validStops,
    stations: cleanStations,
    stationNames,
    stationInfo,
    trainInfo,
    routes,
    trainsAtStation,
    summary,
    getStationName,
    findDirectTrains,
    getTrainRoute
  };
}

function loadData(dataDir = DATA_DIR) {
  const parserResults = {};
  const records = {};
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    const useEnrichedStations = name === "stations" &&
      dataDir === DATA_DIR &&
      fs.existsSync(path.join(ENRICHED_DATA_DIR, ENRICHED_STATIONS_FILE));
    const file = useEnrichedStations
      ? readCSV(ENRICHED_DATA_DIR, ENRICHED_STATIONS_FILE, schema)
      : readCSV(dataDir, `${name}.csv`, schema);
    records[name] = file.records;
    parserResults[name] = file.malformedRows;
  }
  return createDataLayer(records, parserResults);
}

module.exports = {
  DATA_DIR,
  createDataLayer,
  loadData,
  normalizeCode,
  normalizeTrainNumber,
  timeToMinutes,
  getStopTime
};
