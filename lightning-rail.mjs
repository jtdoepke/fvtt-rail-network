// ============================================================================
// LIGHTNING RAIL SYSTEM FOR FOUNDRY VTT (v13+)
// ============================================================================

const SECONDS_PER_HOUR = 3600;

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
const SECONDS_PER_DAY = 86400;

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
