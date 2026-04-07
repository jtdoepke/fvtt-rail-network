// ============================================================================
// RAIL NETWORK ENGINE — Pure computation functions (no Foundry dependency)
// ============================================================================

const SECONDS_PER_HOUR = 3600;
const _SECONDS_PER_DAY = 86400;

// ---------------------------------------------------------------------------
// Unit conversion helpers
// ---------------------------------------------------------------------------

/** Miles per unit for supported distance strings (case-insensitive lookup). */
const MILES_PER_UNIT = new Map();
for (const k of ["mi", "mile", "miles"]) MILES_PER_UNIT.set(k, 1);
for (const k of ["km", "kilometer", "kilometers", "kilometre", "kilometres"]) MILES_PER_UNIT.set(k, 1 / 1.60934);
for (const k of ["ft", "foot", "feet"]) MILES_PER_UNIT.set(k, 1 / 5280);
for (const k of ["m", "meter", "meters", "metre", "metres"]) MILES_PER_UNIT.set(k, 1 / 1609.34);

/**
 * Parse a speed-unit string into { distPerHour, distUnit } where distUnit is
 * a key in MILES_PER_UNIT.  Returns null for unrecognised strings.
 */
function parseSpeedUnits(raw) {
  const s = String(raw).trim().toLowerCase();
  // mph-family → miles/hour
  if (/^(mph|mi\/h|mi\/hr|miles?\/(hour|hr)|miles?\s+per\s+hour)$/.test(s)) return { perHour: 1, distUnit: "mi" };
  // km/h-family → km/hour
  if (/^(km\/h|kph|kmh|km\/hr|kmph|kilomet(?:er|re)s?\/(hour|hr)|kilomet(?:er|re)s?\s+per\s+hour)$/.test(s))
    return { perHour: 1, distUnit: "km" };
  // ft/s-family → feet/second
  if (/^(ft\/s|ft\/sec|feet?\/(second|sec)|feet?\s+per\s+second)$/.test(s)) return { perHour: 3600, distUnit: "ft" };
  // m/s-family → meters/second
  if (/^(m\/s|m\/sec|met(?:er|re)s?\/(second|sec)|met(?:er|re)s?\s+per\s+second)$/.test(s))
    return { perHour: 3600, distUnit: "m" };
  return null;
}

/**
 * Convert an actor's travel speed + scene grid config into pixels-per-hour.
 *
 * @param {number} speed         - Actor travel speed value (e.g. 30)
 * @param {string} speedUnits    - Actor speed units (e.g. "mph", "km/h")
 * @param {number} gridSize      - Scene grid size in pixels (e.g. 100)
 * @param {number} gridDistance   - World distance per grid square (e.g. 46)
 * @param {string} gridUnits     - Scene grid distance units (e.g. "mi", "km")
 * @returns {number|null} Pixels per hour, or null if conversion is impossible
 */
export function convertSpeedToPixelsPerHour(speed, speedUnits, gridSize, gridDistance, gridUnits) {
  if (!speed || speed <= 0 || !gridSize || gridSize <= 0 || !gridDistance || gridDistance <= 0) return null;

  const parsed = parseSpeedUnits(speedUnits);
  if (!parsed) return null;

  // Convert speed to distance-per-hour in the speed's native distance unit
  const nativeDistPerHour = speed * parsed.perHour;

  // Convert native distance to miles, then miles to grid units
  const speedMilesPerUnit = MILES_PER_UNIT.get(parsed.distUnit);
  const gridKey = String(gridUnits).trim().toLowerCase();
  const gridMilesPerUnit = MILES_PER_UNIT.get(gridKey);
  if (speedMilesPerUnit == null || gridMilesPerUnit == null) return null;

  // nativeDistPerHour in miles, then from miles to grid units
  const distPerHourInGridUnits = (nativeDistPerHour * speedMilesPerUnit) / gridMilesPerUnit;

  // grid units → pixels
  return distPerHourInGridUnits * (gridSize / gridDistance);
}

/**
 * Convert a pixel distance to world distance using the scene grid settings.
 *
 * @param {number} pixelDist   - Distance in pixels
 * @param {number} gridSize    - Pixels per grid square
 * @param {number} gridDistance - World distance per grid square
 * @returns {number} Distance in world units
 */
export function pixelDistanceToWorldDistance(pixelDist, gridSize, gridDistance) {
  if (!gridSize || gridSize <= 0) return 0;
  return (pixelDist / gridSize) * gridDistance;
}

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
 * Find the closest point pair between two path arrays, where at least one
 * point in the pair must be an endpoint (first or last) of its segment.
 * This prevents false matches on parallel tracks that run close together
 * before converging at a station.
 *
 * @param {Array} pathA - First path array
 * @param {Array} pathB - Second path array
 * @returns {{ indexA: number, indexB: number, distance: number }}
 */
export function findClosestEndpointPair(pathA, pathB) {
  let best = { indexA: 0, indexB: 0, distance: Infinity };

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  const check = (iA, iB) => {
    const d = dist(pathA[iA], pathB[iB]);
    if (d < best.distance) best = { indexA: iA, indexB: iB, distance: d };
  };

  const endpointsA = [0, pathA.length - 1];
  const endpointsB = [0, pathB.length - 1];

  // A's endpoints vs all of B
  for (const iA of endpointsA) {
    for (let iB = 0; iB < pathB.length; iB++) check(iA, iB);
  }
  // All of A vs B's endpoints (skip combos already checked above)
  for (let iA = 1; iA < pathA.length - 1; iA++) {
    for (const iB of endpointsB) check(iA, iB);
  }

  return best;
}

/**
 * Extract and orient a sub-path traveling from entryIndex to exitIndex.
 * If entryIndex > exitIndex, the sub-path is reversed with hoursFromPrev
 * shifted correctly (same logic as reversePath).
 *
 * The first station in the result gets hoursFromPrev set to 0 since it
 * is the new path start.
 *
 * @param {Array} path - Full segment path
 * @param {number} entryIndex - Index where travel enters this segment
 * @param {number} exitIndex - Index where travel exits this segment
 * @returns {Array} Oriented sub-path
 */
export function orientAndSlicePath(path, entryIndex, exitIndex) {
  if (entryIndex === exitIndex) {
    const node = path[entryIndex];
    if ("station" in node) return [{ ...node, hoursFromPrev: 0 }];
    return [{ ...node }];
  }

  let subPath;
  if (entryIndex < exitIndex) {
    // Forward slice
    subPath = path.slice(entryIndex, exitIndex + 1).map((n) => ({ ...n }));
  } else {
    // Reverse slice: extract then reverse with hoursFromPrev shift
    const slice = path.slice(exitIndex, entryIndex + 1);
    subPath = reversePath(slice);
  }

  // Ensure first station has hoursFromPrev = 0
  for (const node of subPath) {
    if ("station" in node) {
      node.hoursFromPrev = 0;
      break;
    }
  }

  return subPath;
}

/**
 * Resolves a route's path from chained segments with inline fallbacks.
 * Checks temporal availability (effectiveStart/End) and chains active segments.
 *
 * Segments are joined by finding the closest endpoint pair between consecutive
 * segments (at least one of the two matched points must be an endpoint of its
 * segment). This auto-detects travel direction through each segment and supports
 * T-junctions where a segment connects mid-way along another.
 *
 * At junction points, if both segments have a station node, the station with
 * the higher dwellMinutes is kept (max dwell rule).
 *
 * @param {Array} segments - Ordered segment configs with path arrays
 * @param {number} worldTime - Current world time for temporal filtering
 * @returns {Array} Unified path array of station and waypoint nodes
 */
export function resolveRoutePath(segments, worldTime) {
  // Collect temporally active segment paths
  const activePaths = [];
  for (const seg of segments) {
    const start = seg.effectiveStart ?? null;
    const end = seg.effectiveEnd ?? null;
    if (start !== null && worldTime < start) break;
    if (end !== null && worldTime >= end) break;

    const segPath = seg.path ?? [];
    if (segPath.length > 0) activePaths.push(segPath);
  }

  if (activePaths.length === 0) return [];
  if (activePaths.length === 1) return activePaths[0].map((n) => ({ ...n }));

  // Orient the first segment by looking ahead to the second segment.
  // If the junction is at the very start (index 0) of the first segment,
  // reverse it so the junction moves to the end — otherwise the entire
  // segment would be truncated. For junctions at the end or mid-path,
  // keep the segment as-is (the loop handles truncation for T-junctions).
  const firstPair = findClosestEndpointPair(activePaths[0], activePaths[1]);
  let result;
  if (firstPair.indexA === 0) {
    result = orientAndSlicePath(activePaths[0], activePaths[0].length - 1, 0);
  } else {
    result = activePaths[0].map((n) => ({ ...n }));
  }
  let lastSegStartIdx = 0;

  for (let s = 1; s < activePaths.length; s++) {
    const segB = activePaths[s];

    // Find closest endpoint pair between the tail of accumulated path
    // (the most recently appended segment) and all of segment B
    const tail = result.slice(lastSegStartIdx);
    const pair = findClosestEndpointPair(tail, segB);

    // Map tail-relative index back to result-absolute index
    const junctionInResult = lastSegStartIdx + pair.indexA;
    const junctionInB = pair.indexB;

    // Truncate accumulated path at junction (T-junction support)
    if (junctionInResult < result.length - 1) {
      result = result.slice(0, junctionInResult + 1);
    }

    // Orient B: entry is junctionInB, exit is whichever end is farther
    const distToStart = junctionInB;
    const distToEnd = segB.length - 1 - junctionInB;
    const exitInB = distToEnd >= distToStart ? segB.length - 1 : 0;
    const orientedB = orientAndSlicePath(segB, junctionInB, exitInB);

    // Merge junction point: apply max dwell rule
    const junctionNode = result[result.length - 1];
    const bFirstNode = orientedB[0];
    if ("station" in junctionNode && "station" in bFirstNode) {
      const maxDwell = Math.max(junctionNode.dwellMinutes ?? 0, bFirstNode.dwellMinutes ?? 0);
      junctionNode.dwellMinutes = maxDwell;
    }

    // Append B (skip first node — it's the junction duplicate)
    lastSegStartIdx = result.length;
    for (let i = 1; i < orientedB.length; i++) {
      result.push(orientedB[i]);
    }
  }

  // The first station is the departure point — zero its dwell so the
  // train departs on schedule rather than waiting at the origin.
  for (const node of result) {
    if ("station" in node) {
      node.dwellMinutes = 0;
      break;
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
  return events.filter((evt) => {
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
 * @param {number|null} [pixelsPerHour=null] - When provided, travel time is
 *   derived from pixel distance instead of hoursFromPrev (actor-speed mode).
 * @returns {{ legs: Array, totalJourneySeconds: number }}
 */
export function buildRouteSegments(path, pixelsPerHour = null) {
  const legs = [];
  let currentLeg = null;

  for (const node of path) {
    const isStation = "station" in node;

    if (isStation) {
      if (currentLeg) {
        // Close the current leg: this station is the endpoint
        currentLeg.endStation = node;
        currentLeg.points.push({ x: node.x, y: node.y });

        // Compute cumulative pixel distances first (needed for both modes)
        let cumDist = 0;
        currentLeg.cumDistances = [0];
        for (let i = 1; i < currentLeg.points.length; i++) {
          const dx = currentLeg.points[i].x - currentLeg.points[i - 1].x;
          const dy = currentLeg.points[i].y - currentLeg.points[i - 1].y;
          cumDist += Math.sqrt(dx * dx + dy * dy);
          currentLeg.cumDistances.push(cumDist);
        }
        currentLeg.totalPixelDist = cumDist;

        // Derive travel time: actor-speed mode vs manual hoursFromPrev
        if (pixelsPerHour > 0) {
          currentLeg.travelSeconds = (cumDist / pixelsPerHour) * SECONDS_PER_HOUR;
        } else {
          currentLeg.travelSeconds = (node.hoursFromPrev ?? 0) * SECONDS_PER_HOUR;
        }

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
 * Accepts cron-based schedule patterns (new format). Each pattern specifies
 * timing, route numbers, direction, and segments.
 *
 * @param {number} worldTime - Current world time in seconds
 * @param {Array<{ cron: string, routeNumbers?: string[], direction?: string, segments?: Array }>} schedulePatterns
 * @param {number} maxJourneySeconds - Maximum journey duration (for lookback window)
 * @param {Function} [calendarDecomposer] - Optional (worldTime) → { minute, hour, dayOfMonth, month, dayOfWeek }
 * @returns {Array<{ departureTime, elapsed, routeNum, direction, segments }>} Sorted by most recent first
 */
export function findAllActiveDepartures(worldTime, schedulePatterns, maxJourneySeconds, calendarDecomposer) {
  const results = [];
  const lookbackSeconds = maxJourneySeconds;
  const startTime = worldTime - lookbackSeconds;

  for (let pi = 0; pi < schedulePatterns.length; pi++) {
    const pattern = schedulePatterns[pi];
    const hasCalendaria = !!calendarDecomposer;
    const parsed = parseCronExpression(pattern.cron, hasCalendaria);
    const offset = parsed.offset || 0;

    // Iterate through candidate departure times in the lookback window.
    // We check each minute boundary from startTime to worldTime.
    // Optimization: step by matching minutes within each hour.

    // Determine the range of absolute hours to check
    const firstHour = Math.floor(Math.max(0, startTime) / SECONDS_PER_HOUR);
    const lastHour = Math.floor(worldTime / SECONDS_PER_HOUR);

    for (let absHour = firstHour; absHour <= lastHour; absHour++) {
      // Check hour match (adjusted for offset in non-Calendaria mode)
      const adjustedHour = absHour - offset;
      if (!hasCalendaria && !parsed.hour.match(adjustedHour)) continue;

      // For Calendaria mode, check hour within the day (0-23)
      if (hasCalendaria) {
        const hourInDay = absHour % 24;
        if (!parsed.hour.match(hourInDay)) continue;
      }

      // Check minutes 0-59 for this hour
      for (let minute = 0; minute < 60; minute++) {
        if (!parsed.minute.match(minute)) continue;

        const departureTime = absHour * SECONDS_PER_HOUR + minute * 60;
        if (departureTime > worldTime) continue;
        if (departureTime < Math.max(0, startTime)) continue;

        // Calendaria: check day/month/weekday
        if (hasCalendaria) {
          const cal = calendarDecomposer(departureTime);
          if (!parsed.dayOfMonth.match(cal.dayOfMonth)) continue;
          if (!parsed.month.match(cal.month)) continue;
          if (!parsed.dayOfWeek.match(cal.dayOfWeek)) continue;
        }

        const elapsed = worldTime - departureTime;

        // Resolve route number from the pattern's routeNumbers array.
        // For patterns with multiple departure hours, map by minute+hour match index.
        const routeNum = pattern.routeNumbers?.[0] ?? "?";

        results.push({
          departureTime,
          elapsed,
          routeNum,
          tripIndex: pi,
          direction: pattern.direction ?? "outbound",
          segments: pattern.segments,
        });
      }
    }
  }

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
 * @param {Object} route - Route config (schedule array of trips)
 * @param {number} worldTime - Current world time
 * @param {Array} allEvents - All stored events
 * @param {Object} [opts] - Options
 * @param {Function} [opts.pathResolver] - (segments, worldTime) → path array. Required for Drawing-based segments.
 * @param {Function} [opts.calendarDecomposer] - (worldTime) → { minute, hour, dayOfMonth, month, dayOfWeek }
 * @param {number|null} [opts.pixelsPerHour] - When set, derive travel time from pixel distance (actor-speed mode).
 * @returns {Array<{ routeId, departureTime, routeNum, name, x, y, atStation, delayed }>}
 */
export function computeDesiredTokens(route, worldTime, allEvents, opts = {}) {
  const normalized = normalizeSchedule(route);
  const { pathResolver, calendarDecomposer, pixelsPerHour, singleSegmentResolver } = opts;
  const isWander = normalized.type === "wander";

  const activeEvents = getActiveEvents(allEvents, normalized.id, worldTime);

  // closeLine → no departures
  if (activeEvents.some((e) => e.type === "closeLine")) return [];

  // We need a max journey time for the lookback window.
  // Compute it from the first trip's path as an estimate, then refine per-departure.
  // Use a generous default if no path resolves.
  let maxJourneySeconds = 24 * SECONDS_PER_HOUR; // default 24h lookback

  if (isWander && normalized.network?.maxHours > 0) {
    maxJourneySeconds = normalized.network.maxHours * SECONDS_PER_HOUR;
  }

  // Cache resolved path+legs by segments+direction key
  const pathCache = new Map();
  const resolveTrip = (segments, direction) => {
    const key = JSON.stringify(segments) + "|" + (direction ?? "outbound");
    if (pathCache.has(key)) return pathCache.get(key);

    let path;
    if (pathResolver) {
      path = pathResolver(segments, worldTime);
    } else {
      // Fallback: resolve from inline paths
      path = resolveRoutePath(segments, worldTime);
    }

    if (!path || path.length < 2) {
      pathCache.set(key, null);
      return null;
    }

    const directedPath = applyDirection(path, direction);
    const result = buildRouteSegments(directedPath, pixelsPerHour ?? null);
    if (result.legs.length === 0) {
      pathCache.set(key, null);
      return null;
    }

    pathCache.set(key, result);
    return result;
  };

  if (!isWander) {
    // Try to get a better maxJourneySeconds from the first resolvable trip
    for (const trip of normalized.schedule) {
      const resolved = resolveTrip(trip.segments, trip.direction);
      if (resolved) {
        maxJourneySeconds = Math.max(maxJourneySeconds, resolved.totalJourneySeconds);
      }
    }
  }

  // Find scheduled departures across all trips
  const scheduled = findAllActiveDepartures(worldTime, normalized.schedule, maxJourneySeconds, calendarDecomposer);

  // Extra departures (from events) need legs for the default path (fixed routes only)
  let extras = [];
  if (!isWander) {
    const firstTrip = normalized.schedule[0];
    const defaultResolved = firstTrip ? resolveTrip(firstTrip.segments, firstTrip.direction) : null;
    extras = defaultResolved
      ? findExtraDepartures(activeEvents, worldTime, defaultResolved.legs).map((dep) => ({
          ...dep,
          routeNum: "X",
          direction: firstTrip.direction,
          segments: firstTrip.segments,
        }))
      : [];
  }

  const allDepartures = [...scheduled, ...extras];

  const results = [];

  // Resolve the segment path resolver for wandering routes
  const wanderResolver = isWander
    ? (segmentId) => {
        if (singleSegmentResolver) return singleSegmentResolver(segmentId);
        // Fallback: look for inline paths in the network segments
        // (used by tests that pass segment paths directly)
        const segConfig = normalized.network?.segments;
        if (!segConfig) return null;
        // segConfig is array of segment IDs; no inline paths available
        return null;
      }
    : null;

  for (const dep of allDepartures) {
    let legs, totalJourneySeconds;

    if (isWander) {
      const walkResult = computeWanderingWalk(
        normalized.network,
        dep.departureTime,
        normalized.id,
        wanderResolver,
        pixelsPerHour ?? null,
        dep.tripIndex ?? 0,
      );
      if (!walkResult || walkResult.legs.length === 0) continue;
      legs = walkResult.legs;
      totalJourneySeconds = walkResult.totalJourneySeconds;
    } else {
      const resolved = resolveTrip(dep.segments, dep.direction);
      if (!resolved) continue;
      legs = resolved.legs;
      totalJourneySeconds = resolved.totalJourneySeconds;
    }

    const { skip, adjustedElapsed } = applyEvents(activeEvents, dep.departureTime, dep.elapsed, legs, worldTime);
    if (skip) continue;

    const pos = getTrainPosition(legs, totalJourneySeconds, adjustedElapsed);
    if (!pos) continue;

    const routeNum = dep.startStationName ? "X" : (dep.routeNum ?? "?");
    const isDelayed = activeEvents.some((e) => e.type === "delay" && e.target.departureTime === dep.departureTime);

    results.push({
      routeId: normalized.id,
      departureTime: dep.departureTime,
      tripIndex: dep.tripIndex ?? 0,
      routeNum,
      x: pos.x,
      y: pos.y,
      atStation: pos.atStation,
      delayed: isDelayed,
    });
  }

  return results;
}

// ============================================================================
// PATH DIRECTION — reverse and round-trip path transforms
// ============================================================================

/**
 * Compute compass direction labels for a path based on start/end station positions.
 * Returns an object with labels for outbound, return, and roundtrip directions.
 *
 * @param {Array} path - Resolved path array with station nodes
 * @returns {{ outbound: string, return: string, roundtrip: string } | null}
 */
export function getPathCompassLabels(path) {
  if (!path || path.length < 2) return null;

  const stations = path.filter((n) => "station" in n);
  if (stations.length < 2) return null;

  const first = stations[0];
  const last = stations[stations.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;

  // Foundry canvas: y increases downward, so positive dy = south
  const angle = Math.atan2(-dy, dx) * (180 / Math.PI); // -dy to flip to compass (N = up)

  const compassDir = (deg) => {
    // Normalize to 0-360
    const a = ((deg % 360) + 360) % 360;
    if (a >= 337.5 || a < 22.5) return "E";
    if (a >= 22.5 && a < 67.5) return "NE";
    if (a >= 67.5 && a < 112.5) return "N";
    if (a >= 112.5 && a < 157.5) return "NW";
    if (a >= 157.5 && a < 202.5) return "W";
    if (a >= 202.5 && a < 247.5) return "SW";
    if (a >= 247.5 && a < 292.5) return "S";
    return "SE";
  };

  const fwd = compassDir(angle);
  const rev = compassDir(angle + 180);

  return {
    outbound: fwd,
    return: rev,
    roundtrip: `${fwd}/${rev}`,
  };
}

/**
 * Reverses a resolved path array, shifting hoursFromPrev values so that
 * travel times between stations remain correct in the new direction.
 *
 * @param {Array} path - Ordered array of station/waypoint nodes
 * @returns {Array} Reversed path with corrected hoursFromPrev
 */
export function reversePath(path) {
  const reversed = [...path].reverse();

  // Collect original station hoursFromPrev in order.
  // In the original: origStations[k].hoursFromPrev = travel time from station k-1 to k.
  // In reversed: travel from reversed station j to j+1 = travel from
  //   origStation[n-1-j] to origStation[n-2-j] = origStation[n-1-j].hoursFromPrev.
  // So reversed station j+1 gets hoursFromPrev = origStations[n-1-j].hoursFromPrev.
  // Equivalently: reversedHours[j] for j>=1 = origStations[n-j].hoursFromPrev.
  const origStations = path.filter((n) => "station" in n);
  const n = origStations.length;
  const reversedHours = [0];
  for (let j = 1; j < n; j++) {
    reversedHours.push(origStations[n - j].hoursFromPrev ?? 0);
  }

  let stationIdx = 0;
  return reversed.map((node) => {
    if ("station" in node) {
      const newNode = { ...node, hoursFromPrev: reversedHours[stationIdx] };
      stationIdx++;
      return newNode;
    }
    return { ...node };
  });
}

/**
 * Apply a direction transform to a resolved path.
 *
 * @param {Array} path - Resolved path array
 * @param {string} direction - "outbound", "return", or "roundtrip"
 * @returns {Array} Transformed path
 */
export function applyDirection(path, direction) {
  if (!direction || direction === "outbound") return path;
  if (direction === "return") return reversePath(path);
  if (direction === "roundtrip") {
    const rev = reversePath(path);
    // Drop the first station of the reversed path (it's the same as the last
    // station of the outbound path — the turnaround point). The outbound's
    // last station provides the dwell time at the turnaround.
    return [...path, ...rev.slice(1)];
  }
  return path;
}

// ============================================================================
// CRON PARSER — schedule expression parsing and matching
// ============================================================================

/**
 * Parse a single cron field string into a matcher function.
 *
 * Supports: *, N, N,N, N-N, N/S, N-N/S, * /S
 *
 * @param {string} field - Cron field expression
 * @param {object} [opts] - Options
 * @param {number} [opts.implicitStep] - For bare numbers, wrap with this step
 *   (e.g., implicitStep=24 makes "6" behave like "6/24")
 * @returns {{ match: (value: number) => boolean, step?: number, start?: number }}
 */
export function parseCronField(field, opts = {}) {
  const { implicitStep } = opts;
  field = String(field).trim();

  // Wildcard: *
  if (field === "*") {
    return { match: () => true };
  }

  // Step from wildcard: */S
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    return { match: (v) => v % step === 0, step, start: 0 };
  }

  // Comma-separated values: N,N,N (no step)
  if (field.includes(",") && !field.includes("/")) {
    const values = new Set(field.split(",").map(Number));
    if (implicitStep) {
      return {
        match: (v) => {
          for (const val of values) {
            if ((((v - val) % implicitStep) + implicitStep) % implicitStep === 0 && v >= val) return true;
          }
          return false;
        },
        step: implicitStep,
      };
    }
    return { match: (v) => values.has(v) };
  }

  // Range: N-N or N-N/S
  if (field.includes("-")) {
    const [rangePart, stepPart] = field.split("/");
    const [lo, hi] = rangePart.split("-").map(Number);
    const step = stepPart ? Number(stepPart) : 1;
    return {
      match: (v) => v >= lo && v <= hi && (v - lo) % step === 0,
      step,
      start: lo,
    };
  }

  // Step: N/S
  if (field.includes("/")) {
    const [startStr, stepStr] = field.split("/");
    const start = Number(startStr);
    const step = Number(stepStr);
    return {
      match: (v) => (((v - start) % step) + step) % step === 0 && v >= start,
      step,
      start,
    };
  }

  // Bare number: N
  const num = Number(field);
  if (implicitStep) {
    return {
      match: (v) => (((v - num) % implicitStep) + implicitStep) % implicitStep === 0 && v >= num,
      step: implicitStep,
      start: num,
    };
  }
  return { match: (v) => v === num, start: num };
}

/**
 * Parse a full cron expression.
 *
 * Without Calendaria (2-3 fields): "minute hour [offset]"
 * With Calendaria (5 fields): "minute hour day-of-month month day-of-week"
 *
 * @param {string} expr - Cron expression string
 * @param {boolean} hasCalendaria - Whether Calendaria fields are present
 * @returns {object} Parsed cron with field matchers and offset
 */
export function parseCronExpression(expr, hasCalendaria = false) {
  const parts = String(expr).trim().split(/\s+/);

  if (hasCalendaria && parts.length >= 5) {
    return {
      minute: parseCronField(parts[0]),
      hour: parseCronField(parts[1]),
      dayOfMonth: parseCronField(parts[2]),
      month: parseCronField(parts[3]),
      dayOfWeek: parseCronField(parts[4]),
      offset: 0,
    };
  }

  // Non-Calendaria: hour field uses implicitStep=24
  return {
    minute: parseCronField(parts[0]),
    hour: parseCronField(parts[1], { implicitStep: 24 }),
    offset: parts[2] != null ? Number(parts[2]) : 0,
  };
}

/**
 * Generate a human-readable description of a cron expression.
 *
 * @param {string} expr - Cron expression string
 * @param {boolean} hasCalendaria - Whether Calendaria fields are present
 * @param {object} [calendarInfo] - Optional calendar metadata for readable names
 * @param {string[]} [calendarInfo.weekdayNames] - Weekday names (0-indexed)
 * @param {string[]} [calendarInfo.monthNames] - Month names (0-indexed)
 * @returns {string} Human-readable description
 */
export function describeCronExpression(expr, hasCalendaria = false, calendarInfo) {
  const parts = String(expr).trim().split(/\s+/);

  const describeField = (field) => {
    field = String(field).trim();
    if (field === "*") return null;
    if (field.startsWith("*/")) return { every: Number(field.slice(2)) };
    if (field.includes("/")) {
      const [s, st] = field.split("/");
      return { start: Number(s), every: Number(st) };
    }
    if (field.includes(",")) return { values: field.split(",").map(Number) };
    if (field.includes("-")) {
      const [lo, hi] = field.split("-").map(Number);
      return { range: [lo, hi] };
    }
    return { value: Number(field) };
  };

  const pad = (n) => String(n).padStart(2, "0");
  const minDesc = describeField(parts[0]);
  const hourDesc = describeField(parts[1]);
  const minVal = minDesc?.value ?? 0;

  let timeStr = "";

  if (hourDesc === null && minDesc === null) {
    timeStr = "Every minute";
  } else if (hourDesc === null) {
    if (minDesc?.every) timeStr = `Every ${minDesc.every} minutes`;
    else timeStr = `At minute ${minVal}`;
  } else if (hourDesc?.value != null) {
    // In non-Calendaria mode, a bare hour is implicitly daily (implicitStep=24)
    const prefix = !hasCalendaria ? "Daily at" : "At";
    timeStr = `${prefix} ${pad(hourDesc.value)}:${pad(minVal)}`;
  } else if (hourDesc?.values) {
    timeStr = `At ${hourDesc.values.map((h) => `${pad(h)}:${pad(minVal)}`).join(" and ")}`;
  } else if (hourDesc?.every) {
    const days = hourDesc.every / 24;
    if (Number.isInteger(days) && days > 1) {
      const startHour = hourDesc.start ?? 0;
      timeStr = `At ${pad(startHour)}:${pad(minVal)} every ${days} days`;
    } else if (hourDesc.every === 24) {
      const startHour = hourDesc.start ?? 0;
      timeStr = `Daily at ${pad(startHour)}:${pad(minVal)}`;
    } else {
      timeStr = `At :${pad(minVal)} every ${hourDesc.every} hours`;
    }
  } else if (hourDesc?.range) {
    timeStr = `At :${pad(minVal)} from hour ${hourDesc.range[0]} to ${hourDesc.range[1]}`;
  }

  if (!hasCalendaria || parts.length < 5) {
    const offset = parts[2] != null ? Number(parts[2]) : 0;
    if (offset > 0) timeStr += ` (offset ${offset}h)`;
    return timeStr;
  }

  // Calendaria fields
  const dayDesc = describeField(parts[2]);
  const monthDesc = describeField(parts[3]);
  const wdayDesc = describeField(parts[4]);

  const constraints = [];

  if (wdayDesc != null) {
    const names = calendarInfo?.weekdayNames;
    if (wdayDesc.values) {
      const labels = names ? wdayDesc.values.map((v) => names[v] ?? v) : wdayDesc.values;
      constraints.push(`on ${labels.join(", ")}`);
    } else if (wdayDesc.value != null) {
      const label = names ? (names[wdayDesc.value] ?? wdayDesc.value) : wdayDesc.value;
      constraints.push(`on ${label}`);
    } else if (wdayDesc.every) {
      constraints.push(`every ${wdayDesc.every} weekdays`);
    }
  }

  if (dayDesc != null) {
    if (dayDesc.value != null) constraints.push(`on day ${dayDesc.value}`);
    else if (dayDesc.values) constraints.push(`on days ${dayDesc.values.join(", ")}`);
    else if (dayDesc.every) constraints.push(`every ${dayDesc.every} days`);
  }

  if (monthDesc != null) {
    const names = calendarInfo?.monthNames;
    if (monthDesc.values) {
      const labels = names ? monthDesc.values.map((v) => names[v] ?? v) : monthDesc.values;
      constraints.push(`in ${labels.join(", ")}`);
    } else if (monthDesc.value != null) {
      const label = names ? (names[monthDesc.value] ?? monthDesc.value) : monthDesc.value;
      constraints.push(`in ${label}`);
    }
  }

  return constraints.length ? `${timeStr} ${constraints.join(", ")}` : timeStr;
}

// ============================================================================
// SCHEDULE NORMALIZATION — backward compatibility
// ============================================================================

/**
 * Normalize a route's schedule from old format to new cron-based format.
 * Idempotent — already-normalized routes pass through unchanged.
 *
 * @param {object} route - Route configuration object
 * @returns {object} Route with normalized schedule (new object, original not mutated)
 */
export function normalizeSchedule(route) {
  if (Array.isArray(route.schedule)) return route;

  const sched = route.schedule ?? {};
  const hours = sched.departureHours ?? [];
  const interval = sched.intervalDays ?? 1;
  const offset = sched.startDayOffset ?? 0;
  const routeNums = route.routeNumbers ?? [];
  const segments = route.segments ?? [];

  const entries = hours.map((hour, i) => {
    let cronHour;
    if (interval === 1) {
      cronHour = String(hour);
    } else {
      cronHour = `${hour}/${interval * 24}`;
    }
    const cronOffset = offset * 24;
    const cron = cronOffset > 0 ? `0 ${cronHour} ${cronOffset}` : `0 ${cronHour}`;

    return {
      cron,
      routeNumbers: routeNums[i] != null ? [routeNums[i]] : [],
      direction: "outbound",
      segments: segments.map((s) => ({ ...s })),
    };
  });

  if (entries.length === 0) {
    entries.push({
      cron: "0 6",
      routeNumbers: [],
      direction: "outbound",
      segments: segments.map((s) => ({ ...s })),
    });
  }

  const { schedule: _, routeNumbers: __, segments: ___, ...rest } = route;
  return { ...rest, schedule: entries };
}

// ============================================================================
// WANDERING ROUTES — PRNG utilities
// ============================================================================

/**
 * Mulberry32 seeded PRNG. Returns a function that produces the next
 * pseudo-random float in [0, 1) on each call.
 *
 * @param {number} seed - Integer seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive a deterministic integer seed from departure time, route ID, and optional trip index.
 *
 * @param {number} departureTime - Seconds since epoch
 * @param {string} routeId - Route identifier
 * @param {number} [tripIndex=0] - Trip index within the route schedule
 * @returns {number}
 */
export function hashSeed(departureTime, routeId, tripIndex = 0) {
  let hash = departureTime;
  for (let i = 0; i < routeId.length; i++) {
    hash = ((hash << 5) - hash + routeId.charCodeAt(i)) | 0;
  }
  // Mix in trip index so different trips at the same departure time get different walks
  hash = ((hash << 5) - hash + tripIndex) | 0;
  return hash;
}

/**
 * Choose from options using weights and a PRNG.
 * Only options present in weightMap are eligible.
 *
 * @param {Array<string>} options - Available choices
 * @param {Object<string, number>} weightMap - Weight per option (key=option name)
 * @param {() => number} rng - PRNG function returning [0, 1)
 * @returns {string|null} Chosen option, or null if no eligible options
 */
export function weightedChoice(options, weightMap, rng) {
  const eligible = options.filter((o) => (weightMap[o] ?? 0) > 0);
  if (eligible.length === 0) return null;

  const totalWeight = eligible.reduce((sum, o) => sum + weightMap[o], 0);
  let r = rng() * totalWeight;
  for (const opt of eligible) {
    r -= weightMap[opt];
    if (r <= 0) return opt;
  }
  return eligible[eligible.length - 1];
}

/**
 * Build a network adjacency graph from segment paths.
 * Every station in every segment becomes a graph node. Edges connect
 * consecutive stations within each segment, bidirectionally.
 *
 * Cross-segment connections: for each segment's start/end points, finds
 * the nearest point in any other segment. If that point is a station,
 * the stations are linked by name. If it's a non-station waypoint, a
 * synthetic zero-dwell junction node is inserted.
 *
 * @param {Array<string>} segmentIds - Segment IDs in the network
 * @param {Function} pathResolver - (segmentId) => path array for a single segment
 * @returns {{ adjacency: Map<string, Array<{segmentId, targetStation, cost, fromIndex, toIndex}>>,
 *             paths: Map<string, Array> }}
 */
export function buildNetworkGraph(segmentIds, pathResolver) {
  const adjacency = new Map();
  const paths = new Map();

  const ensureNode = (name) => {
    if (!adjacency.has(name)) adjacency.set(name, []);
  };

  const addEdge = (from, to, segmentId, cost, fromIndex, toIndex) => {
    ensureNode(from);
    adjacency.get(from).push({ segmentId, targetStation: to, cost, fromIndex, toIndex });
  };

  // Phase 1: Build intra-segment edges between consecutive stations
  const resolvedPaths = new Map();
  for (const segId of segmentIds) {
    const path = pathResolver(segId);
    if (!path || path.length === 0) continue;

    const stations = [];
    for (let i = 0; i < path.length; i++) {
      if ("station" in path[i]) stations.push({ index: i, node: path[i] });
    }
    if (stations.length < 2) {
      // Single station or no stations — skip
      if (stations.length === 1) ensureNode(stations[0].node.station);
      continue;
    }

    resolvedPaths.set(segId, path);
    paths.set(segId, path);

    for (let s = 0; s < stations.length - 1; s++) {
      const a = stations[s];
      const b = stations[s + 1];
      const cost = b.node.hoursFromPrev ?? 0;
      addEdge(a.node.station, b.node.station, segId, cost, a.index, b.index);
      addEdge(b.node.station, a.node.station, segId, cost, b.index, a.index);
    }
  }

  // Phase 2: Cross-segment connections at endpoints
  // For each segment's start/end points, find nearest point in other segments
  const segEntries = [...resolvedPaths.entries()];
  for (let i = 0; i < segEntries.length; i++) {
    const [segIdA, pathA] = segEntries[i];
    const endpoints = [0, pathA.length - 1];

    for (const epIdx of endpoints) {
      const ep = pathA[epIdx];
      // Only look for connections if this endpoint is a station
      // (non-station endpoints are unusual but possible)
      let epStationName = "station" in ep ? ep.station : null;

      let bestDist = Infinity;
      let bestSegId = null;
      let bestPointIdx = -1;

      for (let j = 0; j < segEntries.length; j++) {
        if (i === j) continue;
        const [segIdB, pathB] = segEntries[j];

        for (let k = 0; k < pathB.length; k++) {
          const d = Math.hypot(ep.x - pathB[k].x, ep.y - pathB[k].y);
          if (d < bestDist) {
            bestDist = d;
            bestSegId = segIdB;
            bestPointIdx = k;
          }
        }
      }

      if (bestSegId === null) continue;

      const bestPath = resolvedPaths.get(bestSegId);
      const bestPoint = bestPath[bestPointIdx];
      const bestIsStation = "station" in bestPoint;

      if (bestIsStation) {
        // The nearest point is a station in another segment.
        // If epStationName matches bestPoint.station, they're already linked
        // (same station name across segments → edges already merged via name).
        // If names differ, they're close but distinct — no auto-link needed.
        continue;
      }

      // T-junction: endpoint meets a non-station waypoint in another segment.
      // Insert a synthetic junction node and split the other segment.
      if (!epStationName) continue; // Can't link if our endpoint has no station either

      const junctionName = `_junction_${Math.round(bestPoint.x)}_${Math.round(bestPoint.y)}`;

      // Check if this junction already exists
      if (adjacency.has(junctionName)) {
        // Just add edge from our station to the existing junction
        addEdge(epStationName, junctionName, segIdA, 0, epIdx, epIdx);
        addEdge(junctionName, epStationName, segIdA, 0, epIdx, epIdx);
        continue;
      }

      ensureNode(junctionName);

      // Link our station to the junction
      addEdge(epStationName, junctionName, segIdA, 0, epIdx, epIdx);
      addEdge(junctionName, epStationName, segIdA, 0, epIdx, epIdx);

      // Split the other segment at bestPointIdx
      // Find the stations immediately before and after the junction point
      const stationsInBest = [];
      for (let k = 0; k < bestPath.length; k++) {
        if ("station" in bestPath[k]) stationsInBest.push({ index: k, node: bestPath[k] });
      }

      // Find which station pair the junction falls between
      let prevStation = null;
      let nextStation = null;
      for (let s = 0; s < stationsInBest.length; s++) {
        if (stationsInBest[s].index > bestPointIdx) {
          nextStation = stationsInBest[s];
          if (s > 0) prevStation = stationsInBest[s - 1];
          break;
        }
        prevStation = stationsInBest[s];
      }
      if (!prevStation && !nextStation) continue;

      // Remove the existing edge between prevStation and nextStation
      // and replace with edges through the junction
      if (prevStation && nextStation) {
        const prevName = prevStation.node.station;
        const nextName = nextStation.node.station;

        // Remove old edges between prev and next for this segment
        const filterEdge = (edges, target, segId) =>
          edges.filter((e) => !(e.targetStation === target && e.segmentId === segId));

        adjacency.set(prevName, filterEdge(adjacency.get(prevName) ?? [], nextName, bestSegId));
        adjacency.set(nextName, filterEdge(adjacency.get(nextName) ?? [], prevName, bestSegId));

        // Estimate cost split proportionally by index distance
        const origEdge = { cost: nextStation.node.hoursFromPrev ?? 0 };
        const totalIdxSpan = nextStation.index - prevStation.index;
        const splitRatio = totalIdxSpan > 0 ? (bestPointIdx - prevStation.index) / totalIdxSpan : 0.5;
        const costBefore = origEdge.cost * splitRatio;
        const costAfter = origEdge.cost * (1 - splitRatio);

        addEdge(prevName, junctionName, bestSegId, costBefore, prevStation.index, bestPointIdx);
        addEdge(junctionName, prevName, bestSegId, costBefore, bestPointIdx, prevStation.index);
        addEdge(junctionName, nextName, bestSegId, costAfter, bestPointIdx, nextStation.index);
        addEdge(nextName, junctionName, bestSegId, costAfter, nextStation.index, bestPointIdx);
      } else if (prevStation) {
        const prevName = prevStation.node.station;
        addEdge(prevName, junctionName, bestSegId, 0, prevStation.index, bestPointIdx);
        addEdge(junctionName, prevName, bestSegId, 0, bestPointIdx, prevStation.index);
      } else if (nextStation) {
        const nextName = nextStation.node.station;
        addEdge(junctionName, nextName, bestSegId, 0, bestPointIdx, nextStation.index);
        addEdge(nextName, junctionName, bestSegId, 0, nextStation.index, bestPointIdx);
      }
    }
  }

  return { adjacency, paths };
}

/**
 * A* shortest-path on the station graph.
 * Returns the ordered list of edge traversals from start to end.
 *
 * @param {Map<string, Array>} adjacency - From buildNetworkGraph
 * @param {string} startStation - Starting station name
 * @param {string} endStation - Destination station name
 * @param {Function} [heuristic] - (stationA, stationB) => estimated cost. Defaults to 0 (Dijkstra).
 * @returns {Array<{segmentId, fromIndex, toIndex}>|null} Edge traversals, or null if unreachable
 */
export function aStar(adjacency, startStation, endStation, heuristic) {
  if (!adjacency.has(startStation) || !adjacency.has(endStation)) return null;
  const h = heuristic ?? (() => 0);

  // Open set as a simple array (fine for small graphs)
  const gScore = new Map([[startStation, 0]]);
  const fScore = new Map([[startStation, h(startStation, endStation)]]);
  const cameFrom = new Map(); // station → { parentStation, edge }
  const open = new Set([startStation]);
  const closed = new Set();

  while (open.size > 0) {
    // Pick node with lowest fScore
    let current = null;
    let bestF = Infinity;
    for (const node of open) {
      const f = fScore.get(node) ?? Infinity;
      if (f < bestF) {
        bestF = f;
        current = node;
      }
    }

    if (current === endStation) {
      // Reconstruct path
      const edges = [];
      let node = endStation;
      while (cameFrom.has(node)) {
        const { parentStation, edge } = cameFrom.get(node);
        edges.unshift(edge);
        node = parentStation;
      }
      return edges;
    }

    open.delete(current);
    closed.add(current);

    const neighbors = adjacency.get(current) ?? [];
    for (const edge of neighbors) {
      if (closed.has(edge.targetStation)) continue;

      const tentativeG = (gScore.get(current) ?? Infinity) + edge.cost;
      const prevG = gScore.get(edge.targetStation) ?? Infinity;

      if (tentativeG < prevG) {
        cameFrom.set(edge.targetStation, {
          parentStation: current,
          edge: { segmentId: edge.segmentId, fromIndex: edge.fromIndex, toIndex: edge.toIndex, cost: edge.cost },
        });
        gScore.set(edge.targetStation, tentativeG);
        fScore.set(edge.targetStation, tentativeG + h(edge.targetStation, endStation));
        open.add(edge.targetStation);
      }
    }
  }

  return null; // unreachable
}

/**
 * Convert an A* edge list into a unified travel path with waypoints.
 * Extracts sub-paths from each segment, reversing if needed, and
 * concatenates them (dropping duplicate junction nodes, applying max-dwell).
 *
 * @param {Array<{segmentId, fromIndex, toIndex}>} edges - From aStar()
 * @param {Map<string, Array>} segmentPaths - From buildNetworkGraph().paths
 * @returns {Array} Unified path array of station and waypoint nodes
 */
export function buildPathFromEdges(edges, segmentPaths) {
  if (edges.length === 0) return [];

  let unified = null;

  for (const edge of edges) {
    const fullPath = segmentPaths.get(edge.segmentId);
    if (!fullPath) continue;

    const subPath = orientAndSlicePath(fullPath, edge.fromIndex, edge.toIndex);
    if (subPath.length === 0) continue;

    if (!unified) {
      unified = subPath.map((n) => ({ ...n }));
      // Zero first station's dwell
      if ("station" in unified[0]) unified[0].dwellMinutes = 0;
      continue;
    }

    // Join: drop duplicate junction node, apply max-dwell
    const lastUnified = unified[unified.length - 1];
    const firstNew = subPath[0];

    if ("station" in lastUnified && "station" in firstNew) {
      // Max-dwell rule at junction
      lastUnified.dwellMinutes = Math.max(lastUnified.dwellMinutes ?? 0, firstNew.dwellMinutes ?? 0);
      // Skip the duplicate first node of the new sub-path
      for (let i = 1; i < subPath.length; i++) {
        unified.push({ ...subPath[i] });
      }
    } else {
      // No station overlap — just append
      for (const node of subPath) {
        unified.push({ ...node });
      }
    }
  }

  return unified ?? [];
}

/**
 * Compute a wandering walk through a rail network.
 * Uses seeded PRNG for deterministic random choices at each station.
 * At each station, picks a destination from weights, routes via A*,
 * and traverses the full path to get there.
 *
 * @param {Object} network - Network config
 * @param {string} network.startStation - Starting station name
 * @param {Array<string>} network.segments - Available segment IDs
 * @param {number} network.maxHours - Maximum journey duration (0 = indefinite)
 * @param {Object} network.weights - Per-station destination weights
 * @param {number} departureTime - Departure timestamp (part of PRNG seed)
 * @param {string} routeId - Route ID (part of PRNG seed)
 * @param {Function} pathResolver - (segmentId) => path array
 * @param {number|null} [pixelsPerHour=null] - Actor-speed mode
 * @returns {{ legs: Array, totalJourneySeconds: number }}
 */
export function computeWanderingWalk(
  network,
  departureTime,
  routeId,
  pathResolver,
  pixelsPerHour = null,
  tripIndex = 0,
) {
  const graph = buildNetworkGraph(network.segments, pathResolver);
  const rng = mulberry32(hashSeed(departureTime, routeId, tripIndex));

  // Pre-compute reachable stations from startStation via BFS
  const reachable = new Set();
  const bfsQueue = [network.startStation];
  while (bfsQueue.length > 0) {
    const node = bfsQueue.shift();
    if (reachable.has(node)) continue;
    reachable.add(node);
    for (const edge of graph.adjacency.get(node) ?? []) {
      if (!reachable.has(edge.targetStation)) bfsQueue.push(edge.targetStation);
    }
  }

  const maxSeconds = network.maxHours > 0 ? network.maxHours * SECONDS_PER_HOUR : Infinity;
  let currentStation = network.startStation;
  let accumulatedPath = null;
  let estimatedSeconds = 0;

  // Safety cap for indefinite routes: don't generate more than 10000 hops
  const maxHops = 10000;
  let hops = 0;

  while (hops < maxHops) {
    // Find eligible destinations: in weights, reachable, not current station
    const eligible = Object.keys(network.weights).filter(
      (s) => s !== currentStation && reachable.has(s) && network.weights[s] > 0,
    );
    if (eligible.length === 0) break;

    const destination = weightedChoice(eligible, network.weights, rng);
    if (!destination) break;

    // Route from current to destination via A*
    const edges = aStar(graph.adjacency, currentStation, destination);
    if (!edges || edges.length === 0) break;

    // Build the sub-path for this walk segment
    const subPath = buildPathFromEdges(edges, graph.paths);
    if (subPath.length < 2) break;

    // Estimate travel time for this hop from edge costs + dwell
    let hopSeconds = 0;
    for (const edge of edges) {
      hopSeconds += (edge.cost ?? 0) * SECONDS_PER_HOUR;
    }
    // Add dwell times from intermediate stations in the sub-path
    for (const node of subPath) {
      if ("station" in node) hopSeconds += (node.dwellMinutes ?? 0) * 60;
    }

    // Check if adding this hop would exceed maxHours (always allow first hop)
    if (accumulatedPath && estimatedSeconds + hopSeconds > maxSeconds) break;

    if (accumulatedPath) {
      // Join to accumulated path — drop duplicate junction
      const lastNode = accumulatedPath[accumulatedPath.length - 1];
      const firstNew = subPath[0];

      if ("station" in lastNode && "station" in firstNew) {
        lastNode.dwellMinutes = Math.max(lastNode.dwellMinutes ?? 0, firstNew.dwellMinutes ?? 0);
        for (let i = 1; i < subPath.length; i++) {
          accumulatedPath.push({ ...subPath[i] });
        }
      } else {
        for (const node of subPath) {
          accumulatedPath.push({ ...node });
        }
      }
    } else {
      accumulatedPath = subPath.map((n) => ({ ...n }));
      // Zero first station's dwell (departure point)
      if ("station" in accumulatedPath[0]) accumulatedPath[0].dwellMinutes = 0;
    }

    estimatedSeconds += hopSeconds;
    currentStation = destination;
    hops++;
  }

  if (!accumulatedPath || accumulatedPath.length < 2) {
    return { legs: [], totalJourneySeconds: 0 };
  }

  return buildRouteSegments(accumulatedPath, pixelsPerHour ?? null);
}
