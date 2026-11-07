const {
  loadData,
  normalizeCode,
  getStopTime,
  timeToMinutes
} = require("./data");
const { planJourneys: planWithData } = require("./journey-planner");
const { findNearbyStations: findStationsNearby } = require("./nearby-stations");
const {
  getHomeDestinationCycle,
  getHomeDestinationRecommendation: recommendHomeDestination
} = require("./home-destination");

const data = loadData();
const {
  trains,
  stops,
  stations,
  stationNames,
  stationInfo,
  trainInfo,
  routes,
  trainsAtStation,
  summary,
  getStationName,
  findDirectTrains,
  getTrainRoute
} = data;

function printStats() {
  console.log(`Loaded ${trains.length} train records`);
  console.log(`Loaded ${stops.length} station stops`);
  console.log(`Loaded ${stations.length} stations`);
  console.log(`Indexed ${routes.size} train routes`);
  console.log(`Indexed ${trainsAtStation.size} station codes`);
}

function main() {
  printStats();

  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "validate") {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (command === "nearby") {
    const [latitudeText, longitudeText, radiusText, limitText] = args.slice(1);
    if (latitudeText === undefined || longitudeText === undefined) {
      console.log(
        "\nUsage: node index.js nearby <latitude> <longitude> [radius_km] [limit]"
      );
      return;
    }

    const nearby = findNearbyStations(
      latitudeText.trim() ? Number(latitudeText) : NaN,
      longitudeText.trim() ? Number(longitudeText) : NaN,
      {
        ...(radiusText === undefined
          ? {}
          : { radiusKm: radiusText.trim() ? Number(radiusText) : NaN }),
        ...(limitText === undefined
          ? {}
          : { limit: limitText.trim() ? Number(limitText) : NaN })
      }
    );
    if (nearby.length === 0) {
      console.log("No railway stations with valid coordinates found within the radius.");
    } else {
      console.table(nearby);
    }
    return;
  }

  if (command === "home") {
    const [
      fromCode,
      departureDateTime,
      maxTransfersText,
      bufferText,
      manualStationCode
    ] = args.slice(1);
    if (!fromCode || !departureDateTime || maxTransfersText === undefined) {
      console.log(
        "\nUsage: node index.js home <from_code> <YYYY-MM-DDTHH:mm> " +
        "<max_transfers> [minimum_transfer_buffer_minutes] [NIIJ|GNSL|DI]"
      );
      return;
    }

    console.log(JSON.stringify(getHomeDestinationRecommendation({
      fromCode,
      departureDateTime,
      maxTransfers: maxTransfersText.trim() ? Number(maxTransfersText) : NaN,
      ...(bufferText === undefined
        ? {}
        : {
          minimumTransferBufferMinutes: bufferText.trim()
            ? Number(bufferText)
            : NaN
        }),
      ...(manualStationCode === undefined ? {} : { manualStationCode })
    }), null, 2));
    return;
  }

  if (command === "journey") {
    const [fromCode, toCode, departureDateTime, maxTransfersText, bufferText] = args.slice(1);
    if (!fromCode || !toCode || !departureDateTime || maxTransfersText === undefined) {
      console.log(
        "\nUsage: node index.js journey <from_code> <to_code> " +
        "<YYYY-MM-DDTHH:mm> <max_transfers> [minimum_transfer_buffer_minutes]"
      );
      return;
    }

    const result = planJourneys({
      fromCode,
      toCode,
      departureDateTime,
      maxTransfers: Number(maxTransfersText),
      ...(bufferText === undefined
        ? {}
        : { minimumTransferBufferMinutes: Number(bufferText) })
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "route") {
    const trainNumber = args[1];
    if (!trainNumber) {
      console.log("\nUsage: node index.js route <train_number>");
      return;
    }

    const result = getTrainRoute(trainNumber);
    if (!result) {
      console.log(`\nTrain ${trainNumber} not found.`);
      return;
    }

    console.log(`\nTrain ${result.number}: ${result.name}`);
    console.log(`${result.source} -> ${result.destination}`);
    console.log(`Runs: ${result.runsDays || "Unknown"}`);
    console.table(result.stops);
    return;
  }

  if (command === "station") {
    const code = normalizeCode(args[1]);
    if (!code) {
      console.log("\nUsage: node index.js station <station_code>");
      return;
    }

    const services = trainsAtStation.get(code) || [];
    console.log(`\nStation: ${getStationName(code)} (${code})`);
    console.log(`Scheduled stop records: ${services.length}`);
    console.table(
      services.map(service => ({
        train: service.trainNumber,
        trainName: trainInfo.get(service.trainNumber)?.name || "",
        sequence: service.stop.seq,
        arrival: getStopTime(service.stop, "arrival"),
        departure: getStopTime(service.stop, "departure"),
        day: service.stop.day
      }))
    );
    return;
  }

  let from;
  let to;
  if (command === "direct") {
    from = normalizeCode(args[1]);
    to = normalizeCode(args[2]);
  } else {
    from = normalizeCode(args[0] || "DR");
    to = normalizeCode(args[1] || "TLA");
  }

  if (!from || !to) {
    console.log("\nUsage: node index.js direct <from_code> <to_code>");
    return;
  }

  console.log(
    `\nDirect trains: ${getStationName(from)} (${from}) -> ` +
    `${getStationName(to)} (${to})\n`
  );
  const results = findDirectTrains(from, to);
  if (results.length === 0) {
    console.log("No matching direct trains found in this dataset.");
  } else {
    console.table(results);
    console.log(`Found ${results.length} matching train records.`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("Train Finder error:", error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  ...data,
  planJourneys,
  findNearbyStations,
  getHomeDestinationRecommendation,
  getHomeDestinationCycle,
  normalizeCode,
  getStopTime,
  timeToMinutes,
  data
};

function planJourneys(request) {
  return planWithData(data, request);
}

function findNearbyStations(latitude, longitude, options) {
  return findStationsNearby(
    [...data.stationInfo.values()],
    latitude,
    longitude,
    options
  );
}

function getHomeDestinationRecommendation(request) {
  return recommendHomeDestination(data, request);
}
