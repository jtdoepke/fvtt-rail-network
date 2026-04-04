// ============================================================================
// RAIL NETWORK ENGINE — Pure computation functions (no Foundry dependency)
// ============================================================================

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

/**
 * Converts a Foundry Drawing's geometry + flags into an engine path array.
 * Pure function — no Foundry API calls, operates on plain data.
 *
 * @param {{ x: number, y: number, shape: { points: number[] }, flags: Object }} doc
 * @returns {Array} Path nodes: station { station, x, y, hoursFromPrev?, dwellMinutes? } or waypoint { x, y }
 */
export function drawingToPath(doc) {
  const points = doc.shape.points;
  const flags = doc.flags?.["rail-network"] ?? {};
  const stations = flags.stations ?? [];

  // Build lookup: pointIndex → station metadata
  const stationByIndex = new Map();
  for (const s of stations) {
    stationByIndex.set(s.pointIndex, s);
  }

  const path = [];
  const numPoints = points.length / 2;

  for (let i = 0; i < numPoints; i++) {
    const x = doc.x + points[i * 2];
    const y = doc.y + points[i * 2 + 1];
    const meta = stationByIndex.get(i);

    if (meta) {
      const node = { station: meta.name, x, y, dwellMinutes: meta.dwellMinutes ?? 0 };
      if (meta.hoursFromPrev != null) node.hoursFromPrev = meta.hoursFromPrev;
      path.push(node);
    } else {
      path.push({ x, y });
    }
  }

  return path;
}

/**
 * Resolves a route's path from chained segments with inline fallbacks.
 * Checks temporal availability (effectiveStart/End) and chains active segments.
 *
 * @param {Array} segments - Ordered segment configs with path arrays
 * @param {number} worldTime - Current world time for temporal filtering
 * @returns {Array} Unified path array of station and waypoint nodes
 */
export function resolveRoutePath(segments, worldTime) {
  const result = [];

  for (const seg of segments) {
    // Check temporal availability
    const start = seg.effectiveStart ?? null;
    const end = seg.effectiveEnd ?? null;
    if (start !== null && worldTime < start) break; // this and all subsequent segments inactive
    if (end !== null && worldTime >= end) break;     // expired

    const segPath = seg.path ?? [];
    if (segPath.length === 0) continue;

    if (result.length > 0) {
      // Chain: drop the first node of this segment (duplicate junction point)
      // but preserve the dwell from the PREVIOUS segment's last station
      const prevLast = result[result.length - 1];
      const segFirst = segPath[0];

      // If both are stations at the same position, keep the previous one's dwell
      // and skip the duplicate
      if ("station" in segFirst && "station" in prevLast &&
          segFirst.x === prevLast.x && segFirst.y === prevLast.y) {
        // prevLast already has the dwell from the arriving segment — just skip segFirst
        for (let i = 1; i < segPath.length; i++) {
          result.push(segPath[i]);
        }
      } else {
        // Not a matching junction — append all
        for (const node of segPath) {
          result.push(node);
        }
      }
    } else {
      for (const node of segPath) {
        result.push(node);
      }
    }
  }

  return result;
}

/**
 * Filters events to those active for a given route at a given world time.
 * An event is active when: (startTime ?? 0) <= worldTime AND (endTime == null || worldTime < endTime)
 *
 * @param {Array} events - All stored events
 * @param {string} routeId - Route to filter for
 * @param {number} worldTime - Current world time
 * @returns {Array} Active events for this route
 */
export function getActiveEvents(events, routeId, worldTime) {
  return events.filter(evt => {
    if (evt.target.routeId !== routeId) return false;
    const start = evt.startTime ?? 0;
    if (worldTime < start) return false;
    if (evt.endTime != null && worldTime >= evt.endTime) return false;
    return true;
  });
}

/**
 * Finds synthetic departures from extraDeparture events.
 * An extra departure starts from a named station partway along the route.
 *
 * @param {Array} activeEvents - Active events (already filtered by getActiveEvents)
 * @param {number} worldTime - Current world time
 * @param {Array} legs - Precomputed legs from buildRouteSegments
 * @returns {Array<{ departureTime, elapsed, startStationName, startLegIndex }>}
 */
export function findExtraDepartures(activeEvents, worldTime, legs) {
  const results = [];

  for (const evt of activeEvents) {
    if (evt.type !== "extraDeparture") continue;
    if (worldTime < evt.startTime) continue;

    const stationName = evt.target.stationName;
    const elapsed = worldTime - evt.startTime;

    // Find which leg index starts at this station
    let startLegIndex = -1;
    let remainingJourney = 0;

    for (let i = 0; i < legs.length; i++) {
      if (legs[i].startStation.station === stationName) {
        startLegIndex = i;
        // Compute remaining journey from this station
        for (let j = i; j < legs.length; j++) {
          remainingJourney += legs[j].dwellSeconds + legs[j].travelSeconds;
        }
        break;
      }
    }

    if (startLegIndex === -1) continue; // station not found
    if (elapsed >= remainingJourney) continue; // journey complete

    results.push({
      departureTime: evt.startTime,
      elapsed,
      startStationName: stationName,
      startLegIndex,
    });
  }

  return results;
}

/**
 * Computes the effective delay in hours for a delay event at a given world time,
 * accounting for recovery via endTime or recoveryRate.
 *
 * @param {{ delayHours: number, startTime: number, endTime?: number, recoveryRate?: number }} event
 * @param {number} worldTime
 * @returns {number} Effective delay in hours (>= 0)
 */
export function computeEffectiveDelay(event, worldTime) {
  const elapsed = Math.max(0, worldTime - event.startTime);

  // recoveryRate takes precedence
  if (event.recoveryRate != null) {
    const recovered = (elapsed / SECONDS_PER_HOUR) * event.recoveryRate;
    return Math.max(0, event.delayHours - recovered);
  }

  // Recovery via endTime: linear decrease
  if (event.endTime != null) {
    const window = event.endTime - event.startTime;
    if (window <= 0) return 0;
    const fraction = Math.min(1, elapsed / window);
    return Math.max(0, event.delayHours * (1 - fraction));
  }

  // Permanent delay
  return event.delayHours;
}

/**
 * Builds station-to-station legs from a resolved path array.
 * Each leg contains waypoint coordinates, cumulative distances, and timing.
 *
 * @param {Array} path - Ordered array of station and waypoint nodes.
 *   Station: { station: string, x, y, hoursFromPrev?, dwellMinutes? }
 *   Waypoint: { x, y }
 * @returns {{ legs: Array, totalJourneySeconds: number }}
 */
export function buildRouteSegments(path) {
  const legs = [];
  let currentLeg = null;

  for (const node of path) {
    const isStation = "station" in node;

    if (isStation) {
      if (currentLeg) {
        // Close the current leg: this station is the endpoint
        currentLeg.endStation = node;
        currentLeg.points.push({ x: node.x, y: node.y });
        currentLeg.travelSeconds = (node.hoursFromPrev ?? 0) * SECONDS_PER_HOUR;

        // Compute cumulative pixel distances
        let cumDist = 0;
        currentLeg.cumDistances = [0];
        for (let i = 1; i < currentLeg.points.length; i++) {
          const dx = currentLeg.points[i].x - currentLeg.points[i - 1].x;
          const dy = currentLeg.points[i].y - currentLeg.points[i - 1].y;
          cumDist += Math.sqrt(dx * dx + dy * dy);
          currentLeg.cumDistances.push(cumDist);
        }
        currentLeg.totalPixelDist = cumDist;

        legs.push(currentLeg);
      }

      // Start a new leg from this station
      currentLeg = {
        startStation: node,
        dwellSeconds: (node.dwellMinutes ?? 10) * 60,
        points: [{ x: node.x, y: node.y }],
        cumDistances: null,
        totalPixelDist: 0,
        travelSeconds: 0,
        endStation: null,
      };
    } else {
      // Waypoint — append to current leg
      if (currentLeg) {
        currentLeg.points.push({ x: node.x, y: node.y });
      }
    }
  }

  // Compute total journey time: sum of dwell + travel for all legs
  // The last station's dwell is NOT included (no leg starts from it)
  let totalJourneySeconds = 0;
  for (const leg of legs) {
    totalJourneySeconds += leg.dwellSeconds + leg.travelSeconds;
  }

  return { legs, totalJourneySeconds };
}

/**
 * Calculates a train's position given precomputed legs and elapsed seconds since departure.
 *
 * @param {Array} legs - From buildRouteSegments().legs
 * @param {number} totalJourneySeconds - From buildRouteSegments().totalJourneySeconds
 * @param {number} elapsedSeconds - Seconds since departure
 * @returns {{ x: number, y: number, atStation: string|null } | null} - null if journey complete or not started
 */
export function getTrainPosition(legs, totalJourneySeconds, elapsedSeconds) {
  if (elapsedSeconds < 0) return null;
  if (elapsedSeconds >= totalJourneySeconds) return null;

  let clock = 0;

  for (const leg of legs) {
    // Phase 1: Dwell at the start station
    if (elapsedSeconds < clock + leg.dwellSeconds) {
      return {
        x: leg.startStation.x,
        y: leg.startStation.y,
        atStation: leg.startStation.station,
      };
    }
    clock += leg.dwellSeconds;

    // Phase 2: Travel through waypoints to the next station
    if (elapsedSeconds < clock + leg.travelSeconds) {
      const travelElapsed = elapsedSeconds - clock;
      const fraction = leg.travelSeconds > 0 ? travelElapsed / leg.travelSeconds : 1;
      const targetDist = fraction * leg.totalPixelDist;

      // Walk the cumulative distance array to find the interpolated position
      for (let i = 1; i < leg.cumDistances.length; i++) {
        if (targetDist <= leg.cumDistances[i]) {
          const segStart = leg.cumDistances[i - 1];
          const segLen = leg.cumDistances[i] - segStart;
          const subFraction = segLen > 0 ? (targetDist - segStart) / segLen : 0;

          return {
            x: leg.points[i - 1].x + (leg.points[i].x - leg.points[i - 1].x) * subFraction,
            y: leg.points[i - 1].y + (leg.points[i].y - leg.points[i - 1].y) * subFraction,
            atStation: null,
          };
        }
      }

      // Numerical edge case — place at end of leg
      const last = leg.points[leg.points.length - 1];
      return { x: last.x, y: last.y, atStation: null };
    }
    clock += leg.travelSeconds;
  }

  // At final station
  const lastLeg = legs[legs.length - 1];
  return {
    x: lastLeg.endStation.x,
    y: lastLeg.endStation.y,
    atStation: lastLeg.endStation.station,
  };
}

/**
 * Finds ALL active departures for a route at the given world time.
 *
 * @param {number} worldTime - Current world time in seconds
 * @param {{ intervalDays: number, startDayOffset: number, departureHours: number[] }} schedule
 * @param {number} maxJourneySeconds - Total journey duration
 * @returns {Array<{ departureTime: number, elapsed: number }>} Sorted by most recent first
 */
export function findAllActiveDepartures(worldTime, schedule, maxJourneySeconds) {
  const currentDay = Math.floor(worldTime / SECONDS_PER_DAY);
  const lookbackDays = Math.ceil(maxJourneySeconds / SECONDS_PER_DAY) + 1;
  const hours = [...schedule.departureHours].sort((a, b) => b - a); // descending
  const results = [];

  for (let dayOffset = 0; dayOffset <= lookbackDays; dayOffset++) {
    const checkDay = currentDay - dayOffset;
    if (checkDay < 0) continue;

    // Is this a run day?
    const cycleDelta = checkDay - (schedule.startDayOffset ?? 0);
    const mod = ((cycleDelta % schedule.intervalDays) + schedule.intervalDays) % schedule.intervalDays;
    if (mod !== 0) continue;

    for (const hour of hours) {
      const departureTime = checkDay * SECONDS_PER_DAY + hour * SECONDS_PER_HOUR;
      if (departureTime > worldTime) continue; // hasn't departed yet

      const elapsed = worldTime - departureTime;
      if (elapsed >= 0 && elapsed < maxJourneySeconds) {
        results.push({ departureTime, elapsed });
      }
    }
  }

  // Sort by most recent (smallest elapsed) first
  results.sort((a, b) => a.elapsed - b.elapsed);
  return results;
}

/**
 * Finds the elapsed seconds at which a train arrives at a named station.
 * Walks legs chronologically summing dwell + travel times.
 *
 * @param {Array} legs - From buildRouteSegments().legs
 * @param {string} stationName - Station to find
 * @returns {number|null} Elapsed seconds at arrival, or null if station not found
 */
export function findStationArrivalTime(legs, stationName) {
  let clock = 0;
  for (const leg of legs) {
    if (leg.startStation.station === stationName) return clock;
    clock += leg.dwellSeconds + leg.travelSeconds;
    if (leg.endStation.station === stationName) return clock;
  }
  return null;
}

/**
 * Applies active events to a departure's elapsed time.
 * Handles destroy, delay, halt, and blockTrack event types.
 *
 * @param {Array} activeEvents - Events already filtered by getActiveEvents
 * @param {number} departureTime - This departure's timestamp
 * @param {number} elapsed - Raw elapsed seconds since departure
 * @param {Array} legs - From buildRouteSegments().legs
 * @param {number} worldTime - Current world time
 * @returns {{ skip: boolean, adjustedElapsed: number, stationClamp: string|null }}
 */
export function applyEvents(activeEvents, departureTime, elapsed, legs, worldTime) {
  let adjustedElapsed = elapsed;
  let stationClamp = null;

  for (const evt of activeEvents) {
    switch (evt.type) {
      case "destroy":
        if (evt.target.departureTime === departureTime) {
          return { skip: true, adjustedElapsed: 0, stationClamp: null };
        }
        break;

      case "delay":
        if (evt.target.departureTime === departureTime) {
          const delaySeconds = computeEffectiveDelay(evt, worldTime) * SECONDS_PER_HOUR;
          adjustedElapsed = Math.max(0, adjustedElapsed - delaySeconds);
        }
        break;

      case "halt":
        if (evt.target.departureTime === departureTime) {
          const arrivalTime = findStationArrivalTime(legs, evt.target.stationName);
          if (arrivalTime !== null && adjustedElapsed > arrivalTime) {
            adjustedElapsed = arrivalTime;
            stationClamp = evt.target.stationName;
          }
        }
        break;

      case "blockTrack": {
        const arrivalTime = findStationArrivalTime(legs, evt.target.stationName);
        if (arrivalTime !== null && adjustedElapsed > arrivalTime) {
          adjustedElapsed = arrivalTime;
          stationClamp = evt.target.stationName;
        }
        break;
      }
    }
  }

  return { skip: false, adjustedElapsed, stationClamp };
}

/**
 * Computes the desired token state for a single route at a given world time.
 * Pure function — no Foundry API calls.
 *
 * @param {Object} route - Route config (segments, schedule, tokenPrototype, routeNumbers)
 * @param {number} worldTime - Current world time
 * @param {Array} allEvents - All stored events
 * @returns {Array<{ routeId, departureTime, name, x, y, atStation, texture, width, height }>}
 */
export function computeDesiredTokens(route, worldTime, allEvents) {
  const path = resolveRoutePath(route.segments, worldTime);
  if (path.length < 2) return [];

  const { legs, totalJourneySeconds } = buildRouteSegments(path);
  if (legs.length === 0) return [];

  const activeEvents = getActiveEvents(allEvents, route.id, worldTime);

  // closeLine → no departures
  if (activeEvents.some(e => e.type === "closeLine")) return [];

  // Find scheduled + extra departures
  const scheduled = findAllActiveDepartures(worldTime, route.schedule, totalJourneySeconds);
  const extras = findExtraDepartures(activeEvents, worldTime, legs);
  const allDepartures = [...scheduled, ...extras];

  const results = [];
  const proto = route.tokenPrototype;
  const hours = route.schedule.departureHours;

  for (const dep of allDepartures) {
    const { skip, adjustedElapsed } = applyEvents(activeEvents, dep.departureTime, dep.elapsed, legs, worldTime);
    if (skip) continue;

    const pos = getTrainPosition(legs, totalJourneySeconds, adjustedElapsed);
    if (!pos) continue; // journey complete

    // Determine route number: match departure hour index to routeNumbers
    let routeNum;
    if (dep.startStationName) {
      // Extra departure — no route number mapping, use route ID
      routeNum = "X";
    } else {
      const depHour = ((dep.departureTime % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
      const hourIdx = hours.indexOf(depHour);
      routeNum = (route.routeNumbers && hourIdx >= 0) ? route.routeNumbers[hourIdx] : "?";
    }

    results.push({
      routeId: route.id,
      departureTime: dep.departureTime,
      name: `Route ${routeNum} -- ${proto.name}`,
      x: pos.x,
      y: pos.y,
      atStation: pos.atStation,
      texture: proto.texture,
      width: proto.width,
      height: proto.height,
    });
  }

  return results;
}
