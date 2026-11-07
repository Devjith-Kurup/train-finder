const { normalizeCode, timeToMinutes } = require("./data");

const MINUTES_PER_DAY = 24 * 60;
const DEFAULT_TRANSFER_BUFFER_MINUTES = 10;
const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_MAX_EXPANSIONS = 20000;
const MAX_EXPANSIONS = 100000;
const MAX_QUEUED_STATES = 50000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseLocalDateTime(value, fieldName) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(
    String(value ?? "").trim()
  );
  if (!match) {
    throw new TypeError(`${fieldName} must use local YYYY-MM-DDTHH:mm format`);
  }

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    throw new TypeError(`${fieldName} is not a valid local date and time`);
  }

  return Math.floor(date.getTime() / 60000) + hour * 60 + minute;
}

function formatLocalDateTime(minutes) {
  const date = new Date(Math.floor(minutes / MINUTES_PER_DAY) * 86400000);
  const hour = Math.floor(minutes % MINUTES_PER_DAY / 60);
  const minute = minutes % 60;
  const pad = value => String(value).padStart(2, "0");

  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(hour)}:${pad(minute)}`;
}

function getWeekday(dayNumber) {
  return WEEKDAYS[new Date(dayNumber * 86400000).getUTCDay()];
}

function parseRunDays(value) {
  const text = String(value ?? "").trim();
  if (text.toLowerCase() === "daily") return new Set(WEEKDAYS);
  if (!text) return null;

  const days = text.split(",").map(day => {
    const normalized = day.trim();
    return WEEKDAYS.find(weekday =>
      weekday.toLowerCase() === normalized.toLowerCase()
    );
  });
  if (days.some(day => !day)) return null;
  return new Set(days);
}

function validateInteger(value, name, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
}

class MinHeap {
  constructor(compare) {
    this.items = [];
    this.compare = compare;
  }

  get size() {
    return this.items.length;
  }

  push(value) {
    const items = this.items;
    items.push(value);
    let index = items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(items[parent], value) <= 0) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = value;
  }

  pop() {
    const items = this.items;
    const first = items[0];
    const last = items.pop();
    if (items.length && last !== undefined) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= items.length) break;
        const child = right < items.length &&
          this.compare(items[right], items[left]) < 0 ? right : left;
        if (this.compare(items[child], last) >= 0) break;
        items[index] = items[child];
        index = child;
      }
      items[index] = last;
    }
    return first;
  }

  compact(keep) {
    this.items = this.items.filter(keep);
    for (let index = Math.floor(this.items.length / 2) - 1; index >= 0; index--) {
      const value = this.items[index];
      let current = index;
      while (true) {
        const left = current * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length &&
          this.compare(this.items[right], this.items[left]) < 0 ? right : left;
        if (this.compare(this.items[child], value) >= 0) break;
        this.items[current] = this.items[child];
        current = child;
      }
      this.items[current] = value;
    }
  }
}

function journeySignature(legs) {
  return legs.map(leg =>
    `${leg.trainNumber}:${leg.boardSequence}-${leg.getOffSequence}`
  ).join("|");
}

function compareJourneys(a, b) {
  const interchangeWaitA = a.legs.reduce(
    (total, leg) => total + (leg.interchangeWaitMinutes ?? 0),
    0
  );
  const interchangeWaitB = b.legs.reduce(
    (total, leg) => total + (leg.interchangeWaitMinutes ?? 0),
    0
  );
  const firstDepartureA = parseLocalDateTime(a.legs[0].boardingTime, "boardingTime");
  const firstDepartureB = parseLocalDateTime(b.legs[0].boardingTime, "boardingTime");

  return a.totalElapsedMinutes - b.totalElapsedMinutes ||
    a.transfers - b.transfers ||
    interchangeWaitA - interchangeWaitB ||
    firstDepartureA - firstDepartureB ||
    journeySignature(a.legs).localeCompare(journeySignature(b.legs));
}

function stateSummary(state, requestedAt) {
  const firstDeparture = state.legs.length === 0
    ? requestedAt
    : parseLocalDateTime(state.legs[0].boardingTime, "boardingTime");
  return {
    readyAt: state.readyAt,
    legCount: state.legs.length,
    interchangeWait: state.legs.reduce(
      (total, leg) => total + (leg.interchangeWaitMinutes ?? 0),
      0
    ),
    firstDeparture,
    signature: journeySignature(state.legs)
  };
}

function compareStateSummaries(a, b) {
  return a.readyAt - b.readyAt ||
    a.legCount - b.legCount ||
    a.interchangeWait - b.interchangeWait ||
    a.firstDeparture - b.firstDeparture ||
    a.signature.localeCompare(b.signature);
}

function stateKey(state) {
  return [
    state.stationCode,
    state.readyAt,
    [...state.usedTrains].sort().join(","),
    [...state.visitedStations].sort().join(","),
    state.legs.length
  ].join("|");
}

function planJourneys(data, request) {
  if (!data || !(data.routes instanceof Map) ||
      !(data.trainsAtStation instanceof Map) ||
      !(data.trainInfo instanceof Map)) {
    throw new TypeError("A Train Finder data layer is required");
  }
  if (!request || typeof request !== "object") {
    throw new TypeError("A journey request is required");
  }

  const fromCode = normalizeCode(request.fromCode);
  const toCode = normalizeCode(request.toCode);
  if (!fromCode || !toCode) {
    throw new TypeError("Origin and destination station codes are required");
  }
  if (fromCode === toCode) {
    throw new RangeError("Origin and destination must be different stations");
  }

  const requestedAt = parseLocalDateTime(request.departureDateTime, "departureDateTime");
  const maxTransfers = request.maxTransfers;
  validateInteger(maxTransfers, "maxTransfers", {
    min: 0,
    max: Number.MAX_SAFE_INTEGER - 1
  });
  const transferBuffer = request.minimumTransferBufferMinutes ??
    DEFAULT_TRANSFER_BUFFER_MINUTES;
  validateInteger(transferBuffer, "minimumTransferBufferMinutes", {
    min: 0,
    max: 1440
  });
  const maximumInterchangeWait = request.maximumInterchangeWaitMinutes;
  if (maximumInterchangeWait !== undefined) {
    validateInteger(maximumInterchangeWait, "maximumInterchangeWaitMinutes", {
      min: 0,
      max: Number.MAX_SAFE_INTEGER
    });
  }
  const maxResults = request.maxResults ?? DEFAULT_MAX_RESULTS;
  validateInteger(maxResults, "maxResults", { min: 1, max: 100 });
  const maxExpandedStates = request.maxExpandedStates ?? DEFAULT_MAX_EXPANSIONS;
  validateInteger(maxExpandedStates, "maxExpandedStates", {
    min: 1,
    max: MAX_EXPANSIONS
  });

  const rejected = {
    missingDepartureTime: 0,
    missingArrivalTime: 0,
    unsupportedRunDays: 0,
    invalidRideDuration: 0,
    maximumInterchangeWait: 0
  };
  const runDaysCache = new Map();
  const nextDepartureCache = new Map();

  function stationName(code, stop, fallback) {
    const station = data.stationInfo.get(code);
    return station?.name || stop?.station_name || fallback || code;
  }

  function getRunsDays(trainNumber, train) {
    if (!runDaysCache.has(trainNumber)) {
      runDaysCache.set(trainNumber, parseRunDays(train?.runs_days));
    }
    return runDaysCache.get(trainNumber);
  }

  function nextDeparture(trainNumber, train, boardStop, earliestMinutes) {
    const departureMinutes = timeToMinutes(boardStop.departure);
    if (departureMinutes === null) {
      rejected.missingDepartureTime++;
      return null;
    }

    const runDays = getRunsDays(trainNumber, train);
    if (!runDays) {
      rejected.unsupportedRunDays++;
      return null;
    }

    const offsetDays = boardStop.day - 1;
    const earliestDay = Math.floor(earliestMinutes / MINUTES_PER_DAY) - offsetDays;
    const cacheKey = [
      trainNumber,
      boardStop.seq,
      earliestMinutes,
      transferBuffer
    ].join(":");
    if (nextDepartureCache.has(cacheKey)) return nextDepartureCache.get(cacheKey);

    const threshold = earliestMinutes;
    for (let offset = 0; offset < 7; offset++) {
      const serviceDay = earliestDay + offset;
      if (!runDays.has(getWeekday(serviceDay))) continue;

      const departure = serviceDay * MINUTES_PER_DAY +
        offsetDays * MINUTES_PER_DAY + departureMinutes;
      if (departure < threshold) continue;

      const result = { departure, serviceDay };
      nextDepartureCache.set(cacheKey, result);
      return result;
    }

    nextDepartureCache.set(cacheKey, null);
    return null;
  }

  const maximumLegs = maxTransfers + 1;
  const minimumLegsToDestination = new Map([[toCode, 0]]);
  const stopMinimumLegs = new Map();
  for (let iteration = 0; iteration < maximumLegs; iteration++) {
    const nextMinimumLegs = new Map(minimumLegsToDestination);
    for (const [trainNumber, route] of data.routes) {
      let suffixMinimum = Infinity;
      for (let stopIndex = route.length - 1; stopIndex >= 0; stopIndex--) {
        const stop = route[stopIndex];
        const laterMinimum = suffixMinimum;
        const stationMinimum = minimumLegsToDestination.get(stop.station_code);
        if (stationMinimum !== undefined) {
          suffixMinimum = Math.min(suffixMinimum, stationMinimum);
        }
        if (laterMinimum !== Infinity) {
          const currentMinimum = nextMinimumLegs.get(stop.station_code);
          const candidateMinimum = laterMinimum + 1;
          if (currentMinimum === undefined || candidateMinimum < currentMinimum) {
            nextMinimumLegs.set(stop.station_code, candidateMinimum);
          }
        }
      }
    }
    let changed = false;
    for (const [stationCode, minimum] of nextMinimumLegs) {
      if (minimumLegsToDestination.get(stationCode) !== minimum) {
        changed = true;
        break;
      }
    }
    minimumLegsToDestination.clear();
    for (const [stationCode, minimum] of nextMinimumLegs) {
      minimumLegsToDestination.set(stationCode, minimum);
    }
    if (!changed) break;
  }
  for (const [trainNumber, route] of data.routes) {
    const stopMinimums = [];
    let suffixMinimum = Infinity;
    for (let stopIndex = route.length - 1; stopIndex >= 0; stopIndex--) {
      const stop = route[stopIndex];
      stopMinimums[stopIndex] = suffixMinimum === Infinity
        ? Infinity
        : suffixMinimum + 1;
      const stationMinimum = minimumLegsToDestination.get(stop.station_code);
      if (stationMinimum !== undefined) {
        suffixMinimum = Math.min(suffixMinimum, stationMinimum);
      }
    }
    stopMinimumLegs.set(trainNumber, stopMinimums);
  }

  const queue = new MinHeap((a, b) =>
    a.readyAt - b.readyAt || a.legs.length - b.legs.length
  );
  queue.push({
    stationCode: fromCode,
    readyAt: requestedAt,
    legs: [],
    visitedStations: new Set([fromCode]),
    usedTrains: new Set(),
    queued: true
  });
  const initialState = queue.items[0];
  const bestStates = new Map();
  bestStates.set(stateKey(initialState), {
    state: initialState,
    summary: stateSummary(initialState, requestedAt),
    queued: true
  });
  let liveQueuedStates = 1;
  const journeys = [];
  const resultSignatures = new Set();
  let expandedStates = 0;
  let truncated = false;
  let queueLimitPruned = 0;

  function recordJourney(legs, arrival) {
    const signature = journeySignature(legs);
    if (resultSignatures.has(signature)) return;
    resultSignatures.add(signature);
    journeys.push({
      fromCode,
      toCode,
      departureTime: formatLocalDateTime(requestedAt),
      arrivalTime: formatLocalDateTime(arrival),
      totalElapsedMinutes: arrival - requestedAt,
      transfers: legs.length - 1,
      legs
    });
    journeys.sort(compareJourneys);
    if (journeys.length > maxResults) journeys.pop();
  }

  while (queue.size > 0) {
    if (expandedStates >= maxExpandedStates) {
      truncated = true;
      break;
    }
    const state = queue.pop();
    const key = stateKey(state);
    const stateEntry = bestStates.get(key);
    if (!stateEntry || stateEntry.state !== state) continue;
    if (stateEntry.queued) {
      stateEntry.queued = false;
      liveQueuedStates--;
    }
    stateEntry.state = null;
    const latestResult = journeys[journeys.length - 1];
    if (journeys.length === maxResults && latestResult &&
        state.readyAt > requestedAt + latestResult.totalElapsedMinutes) {
      break;
    }

    expandedStates++;
    const transfersUsed = state.legs.length;
    if (transfersUsed > maxTransfers) continue;

    const candidates = data.trainsAtStation.get(state.stationCode) || [];
    for (const candidate of candidates) {
      const trainNumber = candidate.trainNumber;
      if (state.usedTrains.has(trainNumber)) continue;
      const train = data.trainInfo.get(trainNumber);
      const route = data.routes.get(trainNumber);
      if (!train || !route || candidate.stopIndex >= route.length) continue;

      const boardStop = route[candidate.stopIndex];
      const stopMinimums = stopMinimumLegs.get(trainNumber);
      if (
        !stopMinimums ||
        stopMinimums[candidate.stopIndex] > maximumLegs - state.legs.length
      ) {
        continue;
      }
      const isFirstLeg = state.legs.length === 0;
      const earliestDeparture = isFirstLeg
        ? state.readyAt
        : state.readyAt + transferBuffer;
      const departureInstance = nextDeparture(
        trainNumber,
        train,
        boardStop,
        earliestDeparture
      );
      if (!departureInstance) continue;
      const boardingAt = departureInstance.departure;
      if (!isFirstLeg && boardingAt <= state.readyAt) continue;
      const waitMinutes = boardingAt - state.readyAt;
      if (
        !isFirstLeg &&
        maximumInterchangeWait !== undefined &&
        waitMinutes > maximumInterchangeWait
      ) {
        rejected.maximumInterchangeWait++;
        continue;
      }

      for (let stopIndex = candidate.stopIndex + 1; stopIndex < route.length; stopIndex++) {
        const getOffStop = route[stopIndex];
        const arrivalClock = timeToMinutes(getOffStop.arrival);
        if (arrivalClock === null) {
          rejected.missingArrivalTime++;
          continue;
        }

        const arrival = departureInstance.serviceDay * MINUTES_PER_DAY +
          (getOffStop.day - 1) * MINUTES_PER_DAY + arrivalClock;
        if (arrival <= boardingAt) {
          rejected.invalidRideDuration++;
          continue;
        }

        const boardName = stationName(
          boardStop.station_code,
          boardStop,
          data.getStationName?.(boardStop.station_code)
        );
        const getOffName = stationName(
          getOffStop.station_code,
          getOffStop,
          data.getStationName?.(getOffStop.station_code)
        );
        const firstStop = route[0];
        const lastStop = route[route.length - 1];
        const fullSource = stationName(
          firstStop?.station_code,
          firstStop,
          train.source
        );
        const fullDestination = stationName(
          lastStop?.station_code,
          lastStop,
          train.destination
        );
        const leg = {
          trainNumber,
          trainName: train.name || "Unknown train",
          trainSource: fullSource,
          trainSourceCode: firstStop?.station_code || normalizeCode(train.source_code),
          trainDestination: fullDestination,
          trainDestinationCode: lastStop?.station_code || normalizeCode(train.dest_code),
          boardingStation: { code: boardStop.station_code, name: boardName },
          boardingTime: formatLocalDateTime(boardingAt),
          getOffStation: { code: getOffStop.station_code, name: getOffName },
          arrivalTime: formatLocalDateTime(arrival),
          waitingTimeMinutes: waitMinutes,
          interchangeWaitMinutes: isFirstLeg ? null : waitMinutes,
          rideTimeMinutes: arrival - boardingAt,
          boardSequence: boardStop.seq,
          getOffSequence: getOffStop.seq
        };
        const legs = [...state.legs, leg];

        if (getOffStop.station_code === toCode) {
          recordJourney(legs, arrival);
          break;
        }
        if (state.visitedStations.has(getOffStop.station_code)) continue;
        if (legs.length >= maxTransfers + 1) continue;
        const remainingLegs = maximumLegs - legs.length;
        const stationMinimum = minimumLegsToDestination.get(getOffStop.station_code);
        if (stationMinimum === undefined || stationMinimum > remainingLegs) {
          continue;
        }

        const nextState = {
          stationCode: getOffStop.station_code,
          readyAt: arrival,
          legs,
          visitedStations: (() => {
            const result = new Set(state.visitedStations);
            result.add(getOffStop.station_code);
            return result;
          })(),
          usedTrains: (() => {
            const result = new Set(state.usedTrains);
            result.add(trainNumber);
            return result;
          })()
        };
        const nextKey = stateKey(nextState);
        const existingState = bestStates.get(nextKey);
        const nextSummary = stateSummary(nextState, requestedAt);
        if (
          existingState &&
          compareStateSummaries(existingState.summary, nextSummary) <= 0
        ) {
          continue;
        }
        if (existingState) {
          if (!existingState.queued) liveQueuedStates++;
          existingState.queued = false;
          bestStates.set(nextKey, {
            state: nextState,
            summary: nextSummary,
            queued: true
          });
          queue.push(nextState);
          if (queue.size > liveQueuedStates * 2 + 1000) {
            queue.compact(candidateState => {
              const entry = bestStates.get(stateKey(candidateState));
              return entry?.state === candidateState && entry.queued;
            });
          }
          continue;
        }
        if (liveQueuedStates >= MAX_QUEUED_STATES) {
          truncated = true;
          queueLimitPruned++;
          continue;
        }
        bestStates.set(nextKey, {
          state: nextState,
          summary: nextSummary,
          queued: true
        });
        queue.push(nextState);
        liveQueuedStates++;
      }
    }
  }

  return {
    journeys,
    search: {
      expandedStates,
      truncated,
      exhaustive: !truncated,
      queueLimitPruned,
      rejected
    }
  };
}

module.exports = {
  DEFAULT_TRANSFER_BUFFER_MINUTES,
  planJourneys,
  parseRunDays,
  parseLocalDateTime,
  formatLocalDateTime
};
