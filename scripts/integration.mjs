// ============================================================================
// RAIL NETWORK — Foundry VTT Integration Layer
// ============================================================================

import {
  resolveRoutePath,
  buildRouteSegments,
  getTrainPosition,
  findAllActiveDepartures,
  getActiveEvents,
  computeEffectiveDelay,
  findExtraDepartures,
  drawingToPath,
  applyEvents,
  normalizeSchedule,
  applyDirection,
  parseCronExpression,
  describeCronExpression,
  getPathCompassLabels,
  findStationArrivalTime,
  convertSpeedToPixelsPerHour,
  pixelDistanceToWorldDistance,
  computeWanderingWalk,
} from "./engine.mjs";

const MODULE_ID = "rail-network";

// ---------------------------------------------------------------------------
// Drawing Cache
// ---------------------------------------------------------------------------

/** @type {Map<string, Array>} segmentId → path array */
const _pathCache = new Map();

/** Shared CSS for alternating table row contrast used across dialogs. */
const TABLE_ROW_STYLES = `
  .rail-table tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.06); }
  .rail-table tbody tr:nth-child(odd) { background: rgba(0, 0, 0, 0.15); }
  .rail-table input { background: rgba(0, 0, 0, 0.5); border: 1px solid rgba(255, 255, 255, 0.3); }
`;

/** @type {Map<string, {legs, totalJourneySeconds}>} "routeId::departureTime" → walk result */
const _wanderWalkCache = new Map();

/** @type {Map<string, {x: number, y: number}>} tokenId → intended position */
const _intendedPositions = new Map();

/** Interval ID for time playback (play-forward mode). */
let _timePlaybackInterval = null;

/**
 * Compute pixelsPerHour for a route if it uses actor-speed mode.
 * Returns null when the route uses manual hoursFromPrev or when
 * the actor/scene data is unavailable.
 */
function getPixelsPerHour(route) {
  if (!route.useActorSpeed) return null;
  const actor = game.actors?.get(route.actorId);
  const speed = actor?.system?.attributes?.travel?.speeds?.land;
  const speedUnits = actor?.system?.attributes?.travel?.units;
  const grid = canvas.scene?.grid;
  if (!speed || !speedUnits || !grid) return null;
  const pph = convertSpeedToPixelsPerHour(speed, speedUnits, grid.size, grid.distance, grid.units);
  if (!pph) {
    console.warn(
      `${MODULE_ID} | Route "${route.id}": useActorSpeed enabled but could not resolve speed ` +
        `(${speed} ${speedUnits}, grid: ${grid.distance} ${grid.units})`,
    );
  }
  return pph;
}

let _updating = false;
let _pendingWorldTime = null;
let _prevHookKeys = new Set();
let _currentHookKeys = null;
let _tagSegmentHandler = null;
let _tagSegmentHoverHandler = null;
let _tagSegmentHoverHighlight = null;
let _tagSegmentHoveredDrawing = null;
let _awaitingDrawTrack = false;
let _statusHandler = null;
let _statusHoverHandler = null;
let _statusHoverHighlight = null;
let _statusHoveredTarget = null;

const DELAYED_STATUS_ID = "rail-network-delayed";

async function setDelayedStatus(tokenDoc, active) {
  const token = canvas.tokens.get(tokenDoc.id);
  if (!token?.actor) return;
  const existing = token.actor.effects.find((e) => e.statuses.has(DELAYED_STATUS_ID));
  if (active && !existing) {
    await token.actor.createEmbeddedDocuments("ActiveEffect", [
      {
        name: "Delayed",
        img: "icons/svg/clockwork.svg",
        statuses: [DELAYED_STATUS_ID],
      },
    ]);
  } else if (!active && existing) {
    await existing.delete();
  }
}

function invalidateCache(segmentId) {
  if (segmentId) _pathCache.delete(segmentId);
  else _pathCache.clear();
  // Wandering walk cache depends on segment paths, so always clear it
  _wanderWalkCache.clear();
}

// ---------------------------------------------------------------------------
// Drawing-to-Path Bridge
// ---------------------------------------------------------------------------

/**
 * Resolve a route's full path, preferring Drawing geometry over inline paths.
 * Caches Drawing-derived paths for performance.
 */
function resolveRouteWithDrawings(route, worldTime) {
  const enrichedSegments = route.segments.map((seg) => {
    // Check cache first
    if (_pathCache.has(seg.segmentId)) {
      return { ...seg, path: _pathCache.get(seg.segmentId) };
    }

    // Look for a Drawing on the current scene with matching segmentId
    const drawing = canvas.drawings?.placeables?.find(
      (d) => d.document.flags?.[MODULE_ID]?.segmentId === seg.segmentId,
    );

    if (drawing) {
      const path = drawingToPath(drawing.document);
      _pathCache.set(seg.segmentId, path);
      return { ...seg, path };
    }

    // Fall back to inline path
    return seg;
  });

  return resolveRoutePath(enrichedSegments, worldTime);
}

// ---------------------------------------------------------------------------
// Custom Hook Firing + Socket Relay
// ---------------------------------------------------------------------------

function fireHook(hookName, ...args) {
  Hooks.callAll(`${MODULE_ID}.${hookName}`, ...args);

  if (game.user.isGM) {
    // Relay serializable args to non-GM clients
    const safeArgs = args.map((a) => {
      if (a && typeof a === "object" && a.constructor?.name?.includes("Document")) {
        return a.id; // send ID instead of document
      }
      return a;
    });
    game.socket.emit(`module.${MODULE_ID}`, { type: hookName, args: safeArgs });
  }
}

/** Fire a hook only once per unique key per updateAllTrains cycle. */
function fireHookOnce(hookName, key, ...args) {
  const fullKey = `${hookName}::${key}`;
  if (_currentHookKeys) _currentHookKeys.add(fullKey);
  if (_prevHookKeys.has(fullKey)) return;
  fireHook(hookName, ...args);
}

// ---------------------------------------------------------------------------
// Token Reconciliation
// ---------------------------------------------------------------------------

async function updateAllTrains(worldTime) {
  if (!game.user.isGM) return;
  if (!canvas?.scene) return;

  if (_updating) {
    _pendingWorldTime = worldTime;
    return;
  }
  _updating = true;
  _currentHookKeys = new Set();

  try {
    worldTime = worldTime ?? game.time.worldTime;
    const routes = game.settings.get(MODULE_ID, "routes");
    const allEvents = game.settings.get(MODULE_ID, "events");
    // Get existing managed tokens
    const existingTokens = canvas.scene.tokens.filter((t) => t.flags?.[MODULE_ID]?.managed);
    const existingByKey = new Map();
    for (const t of existingTokens) {
      const key = `${t.flags[MODULE_ID].routeId}::${t.flags[MODULE_ID].departureTime}::${t.flags[MODULE_ID].routeNum ?? ""}`;
      existingByKey.set(key, t);
    }

    // Build Calendaria decomposer if available
    let calendarDecomposer = null;
    const calApi = game.modules.get("calendaria")?.api;
    if (calApi) {
      try {
        const cal = calApi.getActiveCalendar();
        if (cal) {
          calendarDecomposer = (wt) => {
            const c = cal.timeToComponents(wt);
            return {
              minute: c.minute,
              hour: c.hour,
              dayOfMonth: (c.dayOfMonth ?? 0) + 1,
              month: (c.month ?? 0) + 1,
              dayOfWeek: calApi.dayOfWeek(c, cal),
            };
          };
        }
      } catch {
        /* Calendaria not ready */
      }
    }

    // Path resolver using Drawing cache
    const pathResolver = (segments, wt) => {
      const enriched = segments.map((seg) => {
        if (_pathCache.has(seg.segmentId)) {
          return { ...seg, path: _pathCache.get(seg.segmentId) };
        }
        const drawing = canvas.drawings?.placeables?.find(
          (d) => d.document.flags?.[MODULE_ID]?.segmentId === seg.segmentId,
        );
        if (drawing) {
          const path = drawingToPath(drawing.document);
          _pathCache.set(seg.segmentId, path);
          return { ...seg, path };
        }
        return seg;
      });
      return resolveRoutePath(enriched, wt);
    };

    // Compute desired state for all routes
    const allDesired = [];
    for (const route of routes) {
      const normalized = normalizeSchedule(route);

      // Look up the actor for this route
      const actor = game.actors.get(normalized.actorId);
      if (!actor) {
        if (normalized.actorId) {
          console.warn(`${MODULE_ID} | Route "${normalized.id}" references missing actor ${normalized.actorId}`);
        }
        continue;
      }
      const protoToken = actor.prototypeToken;

      const activeEvents = getActiveEvents(allEvents, normalized.id, worldTime);

      // closeLine → skip entirely
      if (activeEvents.some((e) => e.type === "closeLine")) {
        fireHookOnce(
          "routeClosed",
          normalized.id,
          normalized.id,
          activeEvents.find((e) => e.type === "closeLine"),
        );
        continue;
      }

      const isWander = normalized.type === "wander";

      // Resolve paths per trip, find max journey time
      const tripCache = new Map();
      const resolveTrip = (segments, direction) => {
        const key = JSON.stringify(segments) + "|" + (direction ?? "outbound");
        if (tripCache.has(key)) return tripCache.get(key);
        const path = pathResolver(segments, worldTime);
        if (!path || path.length < 2) {
          tripCache.set(key, null);
          return null;
        }
        const directedPath = applyDirection(path, direction);
        const result = buildRouteSegments(directedPath, getPixelsPerHour(normalized));
        if (result.legs.length === 0) {
          tripCache.set(key, null);
          return null;
        }
        tripCache.set(key, result);
        return result;
      };

      // Single-segment resolver for wandering routes (uses Drawing cache)
      const singleSegResolver = (segmentId) => {
        if (_pathCache.has(segmentId)) return _pathCache.get(segmentId);
        const drawing = canvas.drawings?.placeables?.find(
          (d) => d.document.flags?.[MODULE_ID]?.segmentId === segmentId,
        );
        if (drawing) {
          const path = drawingToPath(drawing.document);
          _pathCache.set(segmentId, path);
          return path;
        }
        return null;
      };

      let maxJourneySeconds = 24 * 3600;
      if (isWander && normalized.network?.maxHours > 0) {
        maxJourneySeconds = normalized.network.maxHours * 3600;
      } else if (!isWander) {
        for (const trip of normalized.schedule) {
          const resolved = resolveTrip(trip.segments, trip.direction);
          if (resolved) maxJourneySeconds = Math.max(maxJourneySeconds, resolved.totalJourneySeconds);
        }
      }

      const scheduled = findAllActiveDepartures(worldTime, normalized.schedule, maxJourneySeconds, calendarDecomposer);

      // Extra departures use first trip's path (fixed routes only)
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
      const nameTemplate = normalized.nameTemplate ?? "[[name]] [[routeNum]]";

      for (const dep of allDepartures) {
        let legs, totalJourneySeconds;

        if (isWander) {
          // Wandering route: compute walk per departure (unique seed)
          const wanderKey = `${normalized.id}::${dep.departureTime}::${dep.tripIndex ?? 0}`;
          let walkResult = _wanderWalkCache.get(wanderKey);
          if (!walkResult) {
            walkResult = computeWanderingWalk(
              normalized.network,
              dep.departureTime,
              normalized.id,
              singleSegResolver,
              getPixelsPerHour(normalized),
              dep.tripIndex ?? 0,
            );
            _wanderWalkCache.set(wanderKey, walkResult);
          }
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

        if (skip) {
          fireHook(
            "trainDestroyed",
            normalized.id,
            dep.departureTime,
            activeEvents.find((e) => e.type === "destroy" && e.target.departureTime === dep.departureTime),
          );
          continue;
        }

        const delayEvt = activeEvents.find((e) => e.type === "delay" && e.target.departureTime === dep.departureTime);
        if (delayEvt) {
          fireHookOnce(
            "trainDelayed",
            `${normalized.id}::${dep.departureTime}`,
            normalized.id,
            dep.departureTime,
            computeEffectiveDelay(delayEvt, worldTime),
            delayEvt,
          );
        }

        const blockEvt = activeEvents.find((e) => e.type === "blockTrack");
        if (blockEvt) {
          fireHookOnce(
            "trackBlocked",
            `${normalized.id}::${blockEvt.target.stationName}`,
            normalized.id,
            blockEvt.target.stationName,
            blockEvt,
          );
        }

        const pos = getTrainPosition(legs, totalJourneySeconds, adjustedElapsed);
        if (!pos) continue;

        const routeNum = dep.startStationName ? "X" : (dep.routeNum ?? "?");
        const tokenName = nameTemplate
          .replace("[[name]]", normalized.name || "Unnamed Route")
          .replace("[[actor]]", protoToken.name ?? actor.name)
          .replace("[[routeNum]]", routeNum);

        allDesired.push({
          routeId: normalized.id,
          departureTime: dep.departureTime,
          routeNum,
          name: tokenName,
          x: pos.x,
          y: pos.y,
          atStation: pos.atStation,
          delayed: !!delayEvt,
          actorId: normalized.actorId,
          width: protoToken.width ?? 1,
          height: protoToken.height ?? 1,
        });
      }
    }

    // Mark desired keys
    const desiredByKey = new Map();
    for (const d of allDesired) {
      desiredByKey.set(`${d.routeId}::${d.departureTime}::${d.routeNum ?? ""}`, d);
    }

    // Reconcile: create, move, delete
    const toCreate = [];
    const toMove = [];
    const toDelete = [];

    for (const [key, desired] of desiredByKey) {
      const existing = existingByKey.get(key);
      // Center the token on the path point (x,y is the token's top-left corner)
      const gridSize = canvas.grid?.size ?? 100;
      const halfW = (desired.width * gridSize) / 2;
      const halfH = (desired.height * gridSize) / 2;
      let x = desired.x - halfW;
      let y = desired.y - halfH;

      if (!existing) {
        const actor = game.actors.get(desired.actorId);
        if (actor) {
          const tokenDoc = await actor.getTokenDocument({
            x,
            y,
            actorLink: false,
            name: desired.name,
            flags: {
              [MODULE_ID]: {
                managed: true,
                routeId: desired.routeId,
                departureTime: desired.departureTime,
                routeNum: desired.routeNum,
                tripIndex: desired.tripIndex ?? 0,
              },
            },
          });
          toCreate.push({
            data: tokenDoc.toObject(),
            delayed: desired.delayed,
            routeId: desired.routeId,
            departureTime: desired.departureTime,
            atStation: desired.atStation,
          });
        }
      } else {
        // Update token name if it changed
        if (existing.name !== desired.name) {
          await existing.update({ name: desired.name });
        }

        // Check if movement needed
        const intended = _intendedPositions.get(existing.id) ?? { x: existing.x, y: existing.y };
        const dx = x - intended.x;
        const dy = y - intended.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist >= 1) {
          toMove.push({ tokenDoc: existing, x, y, dist, atStation: desired.atStation });
          _intendedPositions.set(existing.id, { x, y });
        }

        // Check station arrival
        if (desired.atStation) {
          fireHookOnce(
            "trainArrived",
            `${desired.routeId}::${desired.departureTime}::${desired.atStation}`,
            desired.routeId,
            desired.departureTime,
            desired.atStation,
            existing,
          );
        }
      }
    }

    for (const [key, existing] of existingByKey) {
      if (!desiredByKey.has(key)) {
        toDelete.push(existing.id);
        _intendedPositions.delete(existing.id);
        fireHook(
          "trainCompleted",
          existing.flags[MODULE_ID].routeId,
          existing.flags[MODULE_ID].departureTime,
          existing,
        );
      }
    }

    // Execute batch operations
    if (toCreate.length > 0) {
      const created = await canvas.scene.createEmbeddedDocuments(
        "Token",
        toCreate.map((c) => c.data),
      );
      for (let i = 0; i < created.length; i++) {
        const doc = created[i];
        _intendedPositions.set(doc.id, { x: doc.x, y: doc.y });
        if (toCreate[i].delayed) {
          await setDelayedStatus(doc, true);
        }
        fireHook("trainDeparted", toCreate[i].routeId, toCreate[i].departureTime, toCreate[i].atStation, doc);
      }
    }

    if (toDelete.length > 0) {
      await canvas.scene.deleteEmbeddedDocuments("Token", toDelete);
    }

    // Toggle delayed status on existing tokens
    for (const [key, desired] of desiredByKey) {
      const tokenDoc = existingByKey.get(key);
      if (!tokenDoc) continue;
      await setDelayedStatus(tokenDoc, desired.delayed);
    }

    // Animate moves
    const autoRotate = game.settings.get("core", "tokenAutoRotate");
    const useSequencer = game.modules.get("sequencer")?.active && typeof Sequence !== "undefined";

    for (const move of toMove) {
      if (move.dist > 2000) {
        // Teleport
        await move.tokenDoc.update({ x: move.x, y: move.y }, { animation: { duration: 0 } });
      } else if (useSequencer) {
        const placeable = canvas.tokens.get(move.tokenDoc.id);
        if (placeable) {
          await new Sequence().animation().on(placeable).moveTowards({ x: move.x, y: move.y }).moveSpeed(200).play();
        }
      } else {
        const context = { animation: { duration: 2000 } };
        if (autoRotate) {
          context.movement = { [move.tokenDoc.id]: { autoRotate: true } };
        }
        await move.tokenDoc.update({ x: move.x, y: move.y }, context);
      }
    }
  } finally {
    _prevHookKeys = _currentHookKeys;
    _currentHookKeys = null;
    _updating = false;
    if (_pendingWorldTime !== null) {
      const next = _pendingWorldTime;
      _pendingWorldTime = null;
      updateAllTrains(next);
    }
  }
}

// ---------------------------------------------------------------------------
// Settings Registration
// ---------------------------------------------------------------------------

function registerSettings() {
  game.settings.register(MODULE_ID, "routes", {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });

  game.settings.register(MODULE_ID, "events", {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });
}

// ---------------------------------------------------------------------------
// UI Helpers
// ---------------------------------------------------------------------------

function getCalendaria() {
  const calApi = game.modules.get("calendaria")?.api;
  if (!calApi) return null;
  try {
    const cal = calApi.getActiveCalendar();
    if (!cal) return null;
    return { api: calApi, cal };
  } catch {
    return null;
  }
}

function getCalendarInfo() {
  const c = getCalendaria();
  if (!c) return undefined;
  try {
    return {
      weekdayNames: c.cal.weekdaysArray.map((w) => w.name),
      monthNames: c.cal.monthsArray.map((m) => m.name),
    };
  } catch {
    return undefined;
  }
}

function formatWorldTime(t) {
  if (t == null) return "—";
  const c = getCalendaria();
  if (c) {
    try {
      const comp = c.cal.timeToComponents(t);
      return c.api.formatDate(
        {
          year: comp.year + (c.cal.years?.yearZero ?? 0),
          month: comp.month + 1,
          day: comp.dayOfMonth + 1,
          hour: comp.hour,
          minute: comp.minute,
        },
        "D MMMM YYYY, HH:mm",
      );
    } catch {
      /* fall through */
    }
  }
  const day = Math.floor(t / 86400);
  const hour = Math.floor((t % 86400) / 3600);
  const min = Math.floor((t % 3600) / 60);
  return `Day ${day}, ${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Route Status Tool — hit detection + info dialogs
// ---------------------------------------------------------------------------

function findManagedTokenAtPos(pos) {
  return (
    canvas.tokens?.placeables?.find((t) => {
      if (!t.document.flags?.[MODULE_ID]?.managed) return false;
      const b = t.bounds;
      return b && pos.x >= b.x && pos.x <= b.x + b.width && pos.y >= b.y && pos.y <= b.y + b.height;
    }) ?? null
  );
}

function findStationAtPos(pos, radius = 20) {
  for (const d of canvas.drawings?.placeables ?? []) {
    const stations = d.document.flags?.[MODULE_ID]?.stations;
    if (!stations?.length) continue;
    const doc = d.document;
    const points = doc.shape.points;
    for (const s of stations) {
      if (!s.name) continue;
      const sx = doc.x + points[s.pointIndex * 2];
      const sy = doc.y + points[s.pointIndex * 2 + 1];
      const dx = pos.x - sx;
      const dy = pos.y - sy;
      if (dx * dx + dy * dy <= radius * radius) {
        return { stationName: s.name, x: sx, y: sy, drawing: d, pointIndex: s.pointIndex };
      }
    }
  }
  return null;
}

function formatDuration(seconds) {
  if (seconds <= 0) return "now";
  const c = getCalendaria();
  const secsPerMin = c?.cal?.days?.secondsPerMinute ?? 60;
  const minsPerHour = c?.cal?.days?.minutesPerHour ?? 60;
  const secsPerHour = secsPerMin * minsPerHour;
  const h = Math.floor(seconds / secsPerHour);
  const m = Math.floor((seconds % secsPerHour) / secsPerMin);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "now";
}

/**
 * Find current leg index and next station for a train given its adjusted elapsed time.
 * Walks legs the same way getTrainPosition does.
 */
function findTrainLegInfo(legs, adjustedElapsed) {
  let clock = 0;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    // Dwell phase at start station
    if (adjustedElapsed < clock + leg.dwellSeconds) {
      return {
        legIndex: i,
        phase: "dwell",
        currentStation: leg.startStation.station,
        nextStation: leg.endStation.station,
      };
    }
    clock += leg.dwellSeconds;
    // Travel phase
    if (adjustedElapsed < clock + leg.travelSeconds) {
      return { legIndex: i, phase: "travel", currentStation: null, nextStation: leg.endStation.station };
    }
    clock += leg.travelSeconds;
  }
  // At final station
  const lastLeg = legs[legs.length - 1];
  return { legIndex: legs.length - 1, phase: "arrived", currentStation: lastLeg.endStation.station, nextStation: null };
}

async function showTrainInfoDialog(token) {
  const flags = token.document.flags?.[MODULE_ID];
  if (!flags) return;
  const { routeId, departureTime, routeNum, tripIndex } = flags;
  const worldTime = game.time.worldTime;
  const routes = game.settings.get(MODULE_ID, "routes");
  const allEvents = game.settings.get(MODULE_ID, "events");
  const route = routes.find((r) => r.id === routeId);

  if (!route) {
    ui.notifications.warn("Route not found for this train.");
    return;
  }

  const normalized = normalizeSchedule(route);
  const activeEvents = getActiveEvents(allEvents, routeId, worldTime);

  let legs;
  if (normalized.type === "wander") {
    // Wandering route: compute walk from network config
    const singleSegResolver = (segmentId) => {
      if (_pathCache.has(segmentId)) return _pathCache.get(segmentId);
      const drawing = canvas.drawings?.placeables?.find((d) => d.document.flags?.[MODULE_ID]?.segmentId === segmentId);
      if (drawing) {
        const path = drawingToPath(drawing.document);
        _pathCache.set(segmentId, path);
        return path;
      }
      return null;
    };
    const walkResult = computeWanderingWalk(
      normalized.network,
      departureTime,
      normalized.id,
      singleSegResolver,
      getPixelsPerHour(normalized),
      tripIndex ?? 0,
    );
    if (!walkResult || walkResult.legs.length === 0) return;
    legs = walkResult.legs;
  } else {
    // Fixed route: find matching trip by routeNum
    let matchedTrip = normalized.schedule.find((t) => t.routeNumbers?.includes(routeNum));
    if (!matchedTrip) matchedTrip = normalized.schedule[0];
    if (!matchedTrip) return;

    const path = resolveRouteWithDrawings({ segments: matchedTrip.segments }, worldTime);
    if (!path || path.length < 2) return;
    const directedPath = applyDirection(path, matchedTrip.direction);
    const result = buildRouteSegments(directedPath, getPixelsPerHour(normalized));
    if (result.legs.length === 0) return;
    legs = result.legs;
  }

  const elapsed = worldTime - departureTime;
  const { adjustedElapsed } = applyEvents(activeEvents, departureTime, elapsed, legs, worldTime);

  const legInfo = findTrainLegInfo(legs, adjustedElapsed);
  const finalStation = legs[legs.length - 1].endStation.station;
  const isDelayed = activeEvents.some((e) => e.type === "delay" && e.target.departureTime === departureTime);

  // Build status string
  let statusText;
  if (isDelayed && legInfo.currentStation) {
    statusText = `Delayed at ${legInfo.currentStation}`;
  } else if (legInfo.currentStation) {
    statusText = `At ${legInfo.currentStation}`;
  } else {
    statusText = "En route";
  }

  // Next stop ETA
  let nextStopHtml = "";
  if (legInfo.nextStation) {
    const arrivalTime = findStationArrivalTime(legs, legInfo.nextStation);
    if (arrivalTime != null) {
      const eta = arrivalTime - adjustedElapsed;
      nextStopHtml = `<tr><td><b>Next Stop</b></td><td>${legInfo.nextStation} (${formatDuration(Math.max(0, eta))})</td></tr>`;
    }
  }

  // Final destination ETA
  let finalHtml = "";
  if (finalStation !== legInfo.currentStation) {
    const finalArrival = findStationArrivalTime(legs, finalStation);
    if (finalArrival != null) {
      const eta = finalArrival - adjustedElapsed;
      finalHtml = `<tr><td><b>Destination</b></td><td>${finalStation} (${formatDuration(Math.max(0, eta))})</td></tr>`;
    }
  } else {
    finalHtml = `<tr><td><b>Destination</b></td><td>${finalStation} (arrived)</td></tr>`;
  }

  // All stations with arrival and departure times
  const stationRows = [];
  const chatStationRows = [];
  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li];
    const arrSec = findStationArrivalTime(legs, leg.startStation.station);
    const depSec = arrSec != null ? arrSec + leg.dwellSeconds : null;
    const isPast = arrSec != null && arrSec <= adjustedElapsed;
    const isCurrent = leg.startStation.station === legInfo.currentStation;
    const style = isCurrent ? "font-weight:bold;" : isPast ? "opacity:0.5;" : "";
    const marker = isCurrent ? " ◀" : "";
    const arrDisplay = li === 0 ? "—" : arrSec != null ? formatWorldTime(departureTime + arrSec) : "—";
    const depDisplay = depSec != null ? formatWorldTime(departureTime + depSec) : "—";
    stationRows.push(
      `<tr style="${style}"><td>${leg.startStation.station}${marker}</td><td>${arrDisplay}</td><td>${depDisplay}</td></tr>`,
    );
    chatStationRows.push(`<tr><td>${leg.startStation.station}</td><td>${arrDisplay}</td><td>${depDisplay}</td></tr>`);
  }
  // Final station (arrival only, no departure)
  const lastLeg = legs[legs.length - 1];
  const finalArr = findStationArrivalTime(legs, lastLeg.endStation.station);
  const isFinalCurrent = lastLeg.endStation.station === legInfo.currentStation;
  const finalStyle = isFinalCurrent ? "font-weight:bold;" : "";
  const finalMarker = isFinalCurrent ? " ◀" : "";
  stationRows.push(
    `<tr style="${finalStyle}"><td>${lastLeg.endStation.station}${finalMarker}</td><td>${finalArr != null ? formatWorldTime(departureTime + finalArr) : "—"}</td><td>—</td></tr>`,
  );
  chatStationRows.push(
    `<tr><td>${lastLeg.endStation.station}</td><td>${finalArr != null ? formatWorldTime(departureTime + finalArr) : "—"}</td><td>—</td></tr>`,
  );

  const scheduleTable = `
    <style>${TABLE_ROW_STYLES}</style>
    <table class="rail-table" style="width:100%;border-collapse:collapse;margin-top:4px;">
      <tr style="border-bottom:1px solid var(--color-border-light);"><th style="text-align:left;">Station</th><th style="text-align:left;">Arrival</th><th style="text-align:left;">Departure</th></tr>
      ${stationRows.join("")}
    </table>`;

  const content = `
    <table style="width:100%;border-collapse:collapse;">
      <tr><td><b>Train</b></td><td>${token.document.name}</td></tr>
      <tr><td><b>Route</b></td><td>${normalized.name || "Unnamed Route"}</td></tr>
      <tr><td><b>Status</b></td><td>${statusText}${isDelayed ? " ⏱" : ""}</td></tr>
      <tr><td><b>Departed</b></td><td>${formatWorldTime(departureTime)}</td></tr>
      ${nextStopHtml}
      ${finalHtml}
    </table>
    <hr style="margin:8px 0;">
    <details>
      <summary style="cursor:pointer;font-weight:bold;">Station Schedule</summary>
      ${scheduleTable}
    </details>
  `;

  const chatContent = `
    <h3>Train: ${token.document.name}</h3>
    <table style="width:100%;border-collapse:collapse;">
      <tr><td><b>Route</b></td><td>${normalized.name || "Unnamed Route"}</td></tr>
      <tr><td><b>Status</b></td><td>${statusText}${isDelayed ? " ⏱" : ""}</td></tr>
      <tr><td><b>Departed</b></td><td>${formatWorldTime(departureTime)}</td></tr>
      ${nextStopHtml}
      ${finalHtml}
    </table>
    <hr style="margin:8px 0;">
    <b>Station Schedule</b>
    <table style="width:100%;border-collapse:collapse;margin-top:4px;">
      <tr style="border-bottom:1px solid var(--color-border-light);"><th style="text-align:left;">Station</th><th style="text-align:left;">Arrival</th><th style="text-align:left;">Departure</th></tr>
      ${chatStationRows.join("")}
    </table>
  `;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: `Train: ${token.document.name}` },
    content,
    buttons: [
      { action: "chat", label: "Post to Chat" },
      { action: "close", label: "Close", default: true },
    ],
    rejectClose: false,
  });

  if (result === "chat") {
    ChatMessage.create({ content: chatContent });
  }
}

async function showStationInfoDialog(stationInfo) {
  const { stationName } = stationInfo;
  const worldTime = game.time.worldTime;
  const routes = game.settings.get(MODULE_ID, "routes");
  const allEvents = game.settings.get(MODULE_ID, "events");

  const trainsHere = [];
  const upcomingArrivals = [];
  const upcomingDepartures = [];

  for (const route of routes) {
    const normalized = normalizeSchedule(route);
    const actor = game.actors?.get(normalized.actorId);
    const activeEvents = getActiveEvents(allEvents, normalized.id, worldTime);
    if (activeEvents.some((e) => e.type === "closeLine")) continue;

    const isWander = normalized.type === "wander";

    // Build a single-segment resolver for wandering routes
    const wanderSegResolver = isWander
      ? (segmentId) => {
          if (_pathCache.has(segmentId)) return _pathCache.get(segmentId);
          const drawing = canvas.drawings?.placeables?.find(
            (d) => d.document.flags?.[MODULE_ID]?.segmentId === segmentId,
          );
          if (drawing) {
            const path = drawingToPath(drawing.document);
            _pathCache.set(segmentId, path);
            return path;
          }
          return null;
        }
      : null;

    // For wander routes, compute walks per active departure
    // For fixed routes, iterate trips and resolve segment paths
    const tripEntries = isWander ? [null] : normalized.schedule;

    for (const trip of tripEntries) {
      let legs, totalJourneySeconds, deps;

      if (isWander) {
        // Get all active departures from the schedule
        const maxJourney = (normalized.network?.maxHours || 24) * 3600;
        deps = findAllActiveDepartures(worldTime, normalized.schedule, maxJourney);

        // Process each active departure with its own wander walk
        for (const dep of deps) {
          const walkResult = computeWanderingWalk(
            normalized.network,
            dep.departureTime,
            normalized.id,
            wanderSegResolver,
            getPixelsPerHour(normalized),
            dep.tripIndex ?? 0,
          );
          if (!walkResult || walkResult.legs.length === 0) continue;

          const wLegs = walkResult.legs;
          const wTotal = walkResult.totalJourneySeconds;
          const stationArrival = findStationArrivalTime(wLegs, stationName);
          if (stationArrival == null) continue;

          const { adjustedElapsed, skip } = applyEvents(activeEvents, dep.departureTime, dep.elapsed, wLegs, worldTime);
          if (skip) continue;

          const pos = getTrainPosition(wLegs, wTotal, adjustedElapsed);
          if (pos?.atStation === stationName) {
            const routeNum = dep.routeNum ?? "?";
            const nameTemplate = normalized.nameTemplate ?? "[[name]] [[routeNum]]";
            const protoName = actor?.prototypeToken?.name ?? actor?.name ?? "Unknown";
            const tokenName = nameTemplate
              .replace("[[name]]", normalized.name || "Unnamed Route")
              .replace("[[actor]]", protoName)
              .replace("[[routeNum]]", routeNum);
            trainsHere.push({
              name: tokenName,
              route: normalized.name || "Unnamed Route",
              routeNum,
              direction: "wander",
            });
          }

          const routeNum = dep.routeNum ?? "?";
          const routeName = normalized.name || "Unnamed Route";

          if (stationArrival > 0 && adjustedElapsed < stationArrival && upcomingArrivals.length < 10) {
            const eta = stationArrival - adjustedElapsed;
            upcomingArrivals.push({
              route: routeName,
              routeNum,
              direction: "wander",
              arrivalTime: worldTime + eta,
              eta,
            });
          }

          // Determine dwell at this station
          const isFinalStop = wLegs[wLegs.length - 1].endStation?.station === stationName;
          let stationDwell = 0;
          if (!isFinalStop) {
            for (let li = 0; li < wLegs.length; li++) {
              if (wLegs[li].startStation.station === stationName) {
                stationDwell = wLegs[li].dwellSeconds;
                break;
              }
              if (wLegs[li].endStation.station === stationName && li + 1 < wLegs.length) {
                stationDwell = wLegs[li + 1].dwellSeconds;
                break;
              }
            }
          }
          const stationDepartureElapsed = stationArrival + stationDwell;
          if (!isFinalStop && adjustedElapsed < stationDepartureElapsed && upcomingDepartures.length < 10) {
            const eta = stationDepartureElapsed - adjustedElapsed;
            upcomingDepartures.push({
              route: routeName,
              routeNum,
              direction: "wander",
              departureTime: worldTime + eta,
              eta,
            });
          }
        }
        continue; // skip the fixed-route logic below
      }

      const path = resolveRouteWithDrawings({ segments: trip.segments }, worldTime);
      if (!path || path.length < 2) continue;
      const directedPath = applyDirection(path, trip.direction);
      ({ legs, totalJourneySeconds } = buildRouteSegments(directedPath, getPixelsPerHour(normalized)));
      if (legs.length === 0) continue;

      // Check if this trip's route passes through our station
      const stationArrival = findStationArrivalTime(legs, stationName);
      if (stationArrival == null) continue;

      // Check active departures for trains currently here
      deps = findAllActiveDepartures(worldTime, [trip], totalJourneySeconds);
      for (const dep of deps) {
        const { adjustedElapsed } = applyEvents(activeEvents, dep.departureTime, dep.elapsed, legs, worldTime);
        const pos = getTrainPosition(legs, totalJourneySeconds, adjustedElapsed);
        if (pos?.atStation === stationName) {
          const routeNum = dep.routeNum ?? "?";
          const nameTemplate = normalized.nameTemplate ?? "[[name]] [[routeNum]]";
          const protoName = actor?.prototypeToken?.name ?? actor?.name ?? "Unknown";
          const tokenName = nameTemplate
            .replace("[[name]]", normalized.name || "Unnamed Route")
            .replace("[[actor]]", protoName)
            .replace("[[routeNum]]", routeNum);
          trainsHere.push({
            name: tokenName,
            route: normalized.name || "Unnamed Route",
            routeNum,
            direction: trip.direction ?? "outbound",
          });
        }
      }

      // Determine if station is the final stop (no departure from final station)
      const isFinalStop = legs[legs.length - 1].endStation?.station === stationName;
      // Determine station departure time (arrival + dwell at that station)
      let stationDwell = 0;
      if (!isFinalStop) {
        for (let li = 0; li < legs.length; li++) {
          if (legs[li].startStation.station === stationName) {
            stationDwell = legs[li].dwellSeconds;
            break;
          }
          if (legs[li].endStation.station === stationName && li + 1 < legs.length) {
            stationDwell = legs[li + 1].dwellSeconds;
            break;
          }
        }
      }

      // Check already-departed trains approaching this station
      for (const dep of deps) {
        const { adjustedElapsed, skip } = applyEvents(activeEvents, dep.departureTime, dep.elapsed, legs, worldTime);
        if (skip) continue;

        const routeNum = dep.routeNum ?? "?";
        const routeName = normalized.name || "Unnamed Route";
        const dir = dep.direction ?? "outbound";

        // Train hasn't reached this station yet → upcoming arrival
        if (stationArrival > 0 && adjustedElapsed < stationArrival && upcomingArrivals.length < 10) {
          const eta = stationArrival - adjustedElapsed;
          upcomingArrivals.push({
            route: routeName,
            routeNum,
            direction: dir,
            arrivalTime: worldTime + eta,
            eta,
          });
        }

        // Train hasn't departed this station yet → upcoming departure
        const stationDepartureElapsed = stationArrival + stationDwell;
        if (!isFinalStop && adjustedElapsed < stationDepartureElapsed && upcomingDepartures.length < 10) {
          const eta = stationDepartureElapsed - adjustedElapsed;
          upcomingDepartures.push({
            route: routeName,
            routeNum,
            direction: dir,
            departureTime: worldTime + eta,
            eta,
          });
        }
      }

      // Forward search for upcoming arrivals/departures at this station (next 24h, limit 10 each)
      const forwardLimit = worldTime + 24 * 3600;
      const parsed = parseCronExpression(trip.cron, false);
      const offset = parsed.offset || 0;
      const currentHour = Math.floor(worldTime / 3600);
      const maxHour = Math.floor(forwardLimit / 3600);

      for (
        let absHour = currentHour;
        absHour <= maxHour && (upcomingArrivals.length < 10 || upcomingDepartures.length < 10);
        absHour++
      ) {
        const adjustedHour = absHour - offset;
        if (!parsed.hour.match(adjustedHour)) continue;
        for (let minute = 0; minute < 60; minute++) {
          if (!parsed.minute.match(minute)) continue;
          const depTime = absHour * 3600 + minute * 60;
          if (depTime <= worldTime) continue;
          const arrivalWorldTime = depTime + stationArrival;
          const routeNum = trip.routeNumbers?.[0] ?? "?";
          const routeName = normalized.name || "Unnamed Route";
          const dir = trip.direction ?? "outbound";

          // Arrival entry (skip if station is the origin — train starts here, doesn't "arrive")
          if (
            stationArrival > 0 &&
            arrivalWorldTime > worldTime &&
            arrivalWorldTime <= forwardLimit &&
            upcomingArrivals.length < 10
          ) {
            upcomingArrivals.push({
              route: routeName,
              routeNum,
              direction: dir,
              arrivalTime: arrivalWorldTime,
              eta: arrivalWorldTime - worldTime,
            });
          }

          // Departure entry (skip if station is the final stop — train terminates here)
          if (!isFinalStop) {
            const departWorldTime = depTime + stationArrival + stationDwell;
            if (departWorldTime > worldTime && departWorldTime <= forwardLimit && upcomingDepartures.length < 10) {
              upcomingDepartures.push({
                route: routeName,
                routeNum,
                direction: dir,
                departureTime: departWorldTime,
                eta: departWorldTime - worldTime,
              });
            }
          }

          break; // one departure per hour for this pattern
        }
      }
    }
  }

  // Sort by time
  upcomingArrivals.sort((a, b) => a.arrivalTime - b.arrivalTime);
  upcomingDepartures.sort((a, b) => a.departureTime - b.departureTime);

  // Build HTML
  let trainsHtml;
  if (trainsHere.length === 0) {
    trainsHtml = `<p style="opacity:0.6;">No trains currently at this station.</p>`;
  } else {
    const rows = trainsHere
      .map((t) => `<tr><td>${t.name}</td><td>${t.route} #${t.routeNum}</td><td>${t.direction}</td></tr>`)
      .join("");
    trainsHtml = `
      <table class="rail-table" style="width:100%;border-collapse:collapse;">
        <tr style="border-bottom:1px solid var(--color-border-light);"><th style="text-align:left;">Train</th><th style="text-align:left;">Route</th><th style="text-align:left;">Dir</th></tr>
        ${rows}
      </table>`;
  }

  let arrivalsHtml;
  if (upcomingArrivals.length === 0) {
    arrivalsHtml = `<p style="opacity:0.6;">No upcoming arrivals in the next 24 hours.</p>`;
  } else {
    const rows = upcomingArrivals
      .map(
        (u) =>
          `<tr><td>${u.route} #${u.routeNum}</td><td>${u.direction}</td><td>${formatWorldTime(u.arrivalTime)}</td><td>${formatDuration(u.eta)}</td></tr>`,
      )
      .join("");
    arrivalsHtml = `
      <table class="rail-table" style="width:100%;border-collapse:collapse;">
        <tr style="border-bottom:1px solid var(--color-border-light);"><th style="text-align:left;">Route</th><th style="text-align:left;">Dir</th><th style="text-align:left;">Arrives</th><th style="text-align:left;">ETA</th></tr>
        ${rows}
      </table>`;
  }

  let departuresHtml;
  if (upcomingDepartures.length === 0) {
    departuresHtml = `<p style="opacity:0.6;">No upcoming departures in the next 24 hours.</p>`;
  } else {
    const rows = upcomingDepartures
      .map(
        (u) =>
          `<tr><td>${u.route} #${u.routeNum}</td><td>${u.direction}</td><td>${formatWorldTime(u.departureTime)}</td><td>${formatDuration(u.eta)}</td></tr>`,
      )
      .join("");
    departuresHtml = `
      <table class="rail-table" style="width:100%;border-collapse:collapse;">
        <tr style="border-bottom:1px solid var(--color-border-light);"><th style="text-align:left;">Route</th><th style="text-align:left;">Dir</th><th style="text-align:left;">Departs</th><th style="text-align:left;">ETA</th></tr>
        ${rows}
      </table>`;
  }

  const sections = `
    <style>${TABLE_ROW_STYLES}</style>
    <h3 style="margin-top:0;">Trains Here</h3>
    ${trainsHtml}
    <h3>Upcoming Arrivals</h3>
    ${arrivalsHtml}
    <h3>Upcoming Departures</h3>
    ${departuresHtml}
  `;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: `Station: ${stationName}` },
    content: sections,
    buttons: [
      { action: "chat", label: "Post to Chat" },
      { action: "close", label: "Close", default: true },
    ],
    rejectClose: false,
  });

  if (result === "chat") {
    ChatMessage.create({ content: `<h3>Station: ${stationName}</h3>${sections}` });
  }
}

function buildSegmentOptions(selectedId) {
  const tagged = canvas.drawings?.placeables?.filter((d) => d.document.flags?.[MODULE_ID]?.segmentId) ?? [];
  return tagged
    .map((d) => {
      const sid = d.document.flags[MODULE_ID].segmentId;
      const sel = sid === selectedId ? " selected" : "";
      return `<option value="${sid}"${sel}>${sid}</option>`;
    })
    .join("");
}

/** Get station names for a given route by resolving its first trip's segment paths. */
function getRouteStationNames(route) {
  const normalized = normalizeSchedule(route);
  const firstTrip = normalized.schedule[0];
  if (!firstTrip?.segments) return [];
  const path = resolveRouteWithDrawings({ segments: firstTrip.segments }, game.time.worldTime);
  return path.filter((n) => n.station).map((n) => n.station);
}

/** Build departure time options from a route's cron-based schedule, formatted readably. */
function buildDepartureOptions(route, selectedTime) {
  const normalized = normalizeSchedule(route);
  const worldTime = game.time.worldTime;
  const currentDay = Math.floor(worldTime / 86400);
  const seen = new Set();
  const options = [];

  // For each trip, enumerate departures in a 3-day window around now
  for (const trip of normalized.schedule) {
    const parsed = parseCronExpression(trip.cron, false);
    const offset = parsed.offset || 0;
    const startHour = (currentDay - 1) * 24;
    const endHour = (currentDay + 2) * 24;

    for (let absHour = startHour; absHour < endHour; absHour++) {
      const adjustedHour = absHour - offset;
      if (!parsed.hour.match(adjustedHour)) continue;

      for (let minute = 0; minute < 60; minute++) {
        if (!parsed.minute.match(minute)) continue;
        const depTime = absHour * 3600 + minute * 60;
        if (seen.has(depTime)) continue;
        seen.add(depTime);
        const sel = depTime === selectedTime ? " selected" : "";
        options.push({ depTime, html: `<option value="${depTime}"${sel}>${formatWorldTime(depTime)}</option>` });
      }
    }
  }

  options.sort((a, b) => a.depTime - b.depTime);
  return options.map((o) => o.html).join("");
}

// ---------------------------------------------------------------------------
// Configuration export / import helpers
// ---------------------------------------------------------------------------

function buildConfigJson(includeSegments) {
  const routes = game.settings.get(MODULE_ID, "routes");
  const events = game.settings.get(MODULE_ID, "events");
  const data = { railNetwork: { version: 1, routes, events } };
  if (includeSegments) {
    data.railNetwork.scenes = {};
    for (const scene of game.scenes) {
      const tagged = scene.drawings.filter((d) => d.flags?.[MODULE_ID]?.segmentId);
      if (!tagged.length) continue;
      data.railNetwork.scenes[scene.name] = {
        segments: tagged.map((d) => ({
          segmentId: d.flags[MODULE_ID].segmentId,
          stations: d.flags[MODULE_ID].stations ?? [],
          drawing: {
            shape: { points: Array.from(d.shape.points) },
            x: d.x,
            y: d.y,
            strokeColor: d.strokeColor,
            strokeWidth: d.strokeWidth,
            fillType: d.fillType,
            fillColor: d.fillColor,
            fillAlpha: d.fillAlpha,
            bezierFactor: d.bezierFactor,
          },
        })),
      };
    }
  }
  return JSON.stringify(data, null, 2);
}

async function applyConfig(data) {
  if (!data?.railNetwork?.version) throw new Error("Invalid format: missing railNetwork.version");
  if (data.railNetwork.version !== 1) throw new Error(`Unsupported config version: ${data.railNetwork.version}`);

  const { routes = [], events = [], scenes } = data.railNetwork;
  if (!Array.isArray(routes)) throw new Error("routes must be an array");
  if (!Array.isArray(events)) throw new Error("events must be an array");

  // Warn about missing actor references
  for (const route of routes) {
    if (route.actorId && !game.actors.get(route.actorId)) {
      ui.notifications.warn(`Route "${route.name}": actor not found, clearing actorId.`);
      route.actorId = null;
    }
  }

  await game.settings.set(MODULE_ID, "routes", routes);
  await game.settings.set(MODULE_ID, "events", events);

  // Import scene segments if present
  if (scenes && typeof scenes === "object") {
    for (const [sceneName, sceneData] of Object.entries(scenes)) {
      const targetScene = game.scenes.find((s) => s.name === sceneName);
      if (!targetScene) {
        ui.notifications.warn(`Scene "${sceneName}" not found, skipping segments.`);
        continue;
      }
      const existingSegIds = new Set(
        targetScene.drawings.filter((d) => d.flags?.[MODULE_ID]?.segmentId).map((d) => d.flags[MODULE_ID].segmentId),
      );
      const toCreate = [];
      for (const seg of sceneData.segments ?? []) {
        if (existingSegIds.has(seg.segmentId)) continue;
        toCreate.push({
          ...seg.drawing,
          shape: { type: "p", ...seg.drawing.shape },
          flags: { [MODULE_ID]: { segmentId: seg.segmentId, stations: seg.stations } },
        });
      }
      if (toCreate.length) {
        await targetScene.createEmbeddedDocuments("Drawing", toCreate);
      }
    }
  }

  invalidateCache();
  updateAllTrains(game.time.worldTime);
}

// ---------------------------------------------------------------------------
// GM API — exposed at game.modules.get("rail-network").api
// ---------------------------------------------------------------------------

const api = {
  /** Force-update all train positions now. */
  refresh() {
    updateAllTrains(game.time.worldTime);
  },

  /** Delete all managed tokens and recreate them from scratch. Picks up actor prototype changes. */
  async hardRefresh() {
    if (!game.user.isGM || !canvas?.scene) return;
    const managed = canvas.scene.tokens.filter((t) => t.flags?.[MODULE_ID]?.managed);
    if (managed.length > 0) {
      await canvas.scene.deleteEmbeddedDocuments(
        "Token",
        managed.map((t) => t.id),
      );
    }
    _intendedPositions.clear();
    await updateAllTrains(game.time.worldTime);
    ui.notifications.info(`Rail Network: ${managed.length} token(s) recreated.`);
  },

  /** Log routes, active departures, tokens, and events to chat. */
  status() {
    const routes = game.settings.get(MODULE_ID, "routes");
    const events = game.settings.get(MODULE_ID, "events");
    const worldTime = game.time.worldTime;
    const managed = canvas.scene?.tokens?.filter((t) => t.flags?.[MODULE_ID]?.managed) ?? [];

    const lines = [`<h3>Rail Network Status</h3>`];
    lines.push(`<b>World Time:</b> ${worldTime} (${formatWorldTime(worldTime)})`);
    lines.push(`<b>Routes:</b> ${routes.length}`);
    lines.push(`<b>Active Events:</b> ${events.length}`);
    lines.push(`<b>Managed Tokens:</b> ${managed.length}`);

    for (const route of routes) {
      const normalized = normalizeSchedule(route);
      const active = getActiveEvents(events, normalized.id, worldTime);
      const actorName = normalized.actorId
        ? (game.actors.get(normalized.actorId)?.name ?? "Unknown Actor")
        : "No actor";

      // Show info for each trip
      let tripCount = 0;
      for (const trip of normalized.schedule) {
        const path = resolveRouteWithDrawings({ segments: trip.segments }, worldTime);
        if (path.length < 2) continue;
        const directedPath = applyDirection(path, trip.direction);
        const pph = getPixelsPerHour(normalized);
        const { legs, totalJourneySeconds } = buildRouteSegments(directedPath, pph);
        const stationNames = legs.map((l) => l.startStation.station);
        stationNames.push(legs[legs.length - 1].endStation.station);
        const desc = describeCronExpression(trip.cron, !!getCalendaria(), getCalendarInfo());
        const routeNums = trip.routeNumbers?.join(", ") || "?";
        const routeLabel = normalized.name || "Unnamed Route";
        if (tripCount === 0) lines.push(`<br><b>${routeLabel}</b> (${actorName}):`);
        lines.push(
          `&nbsp;&nbsp;#${routeNums} ${desc} (${trip.direction ?? "outbound"}): ${stationNames.join(" → ")} [${(totalJourneySeconds / 3600).toFixed(1)}h]`,
        );
        tripCount++;
      }

      if (tripCount === 0) {
        lines.push(`<br><b>${normalized.name || "Unnamed Route"}</b> (${actorName}): No active path`);
        continue;
      }

      // Count total active departures across all trips
      const pph = getPixelsPerHour(normalized);
      let maxJourney = 24 * 3600;
      for (const trip of normalized.schedule) {
        const path = resolveRouteWithDrawings({ segments: trip.segments }, worldTime);
        if (path.length >= 2) {
          const { totalJourneySeconds } = buildRouteSegments(applyDirection(path, trip.direction), pph);
          maxJourney = Math.max(maxJourney, totalJourneySeconds);
        }
      }
      const deps = findAllActiveDepartures(worldTime, normalized.schedule, maxJourney);
      lines.push(`&nbsp;&nbsp;Active departures: ${deps.length} | Events: ${active.length}`);
    }

    ChatMessage.create({ content: lines.join("<br>"), whisper: [game.user.id] });
  },

  /** List all routes with stations, journey times, and schedules. */
  routes() {
    return game.settings.get(MODULE_ID, "routes");
  },

  /** When does the next train leave on the given route? */
  nextDeparture(routeId) {
    const routes = game.settings.get(MODULE_ID, "routes");
    const route = routes.find((r) => r.id === routeId);
    if (!route) return null;

    const normalized = normalizeSchedule(route);
    const worldTime = game.time.worldTime;
    let best = null;

    // Search forward through hours for each trip pattern
    for (const trip of normalized.schedule) {
      const parsed = parseCronExpression(trip.cron, false);
      const offset = parsed.offset || 0;
      const currentHour = Math.floor(worldTime / 3600);

      // Check up to 7 days forward
      for (let absHour = currentHour; absHour < currentHour + 168; absHour++) {
        const adjustedHour = absHour - offset;
        if (!parsed.hour.match(adjustedHour)) continue;

        for (let minute = 0; minute < 60; minute++) {
          if (!parsed.minute.match(minute)) continue;
          const depTime = absHour * 3600 + minute * 60;
          if (depTime <= worldTime) continue;
          if (!best || depTime < best.departureTime) {
            best = { routeId, departureTime: depTime, inSeconds: depTime - worldTime };
          }
          break; // found earliest minute for this hour+pattern
        }
        if (best) break; // found one for this pattern
      }
    }
    return best;
  },

  /** Add an event, returns the event's auto-generated ID. */
  async addEvent(event) {
    const id = event.id ?? foundry.utils.randomID();
    const newEvent = { ...event, id };
    const events = game.settings.get(MODULE_ID, "events");
    await game.settings.set(MODULE_ID, "events", [...events, newEvent]);
    updateAllTrains(game.time.worldTime);
    return id;
  },

  /** Remove an event by ID. */
  async removeEvent(eventId) {
    const events = game.settings.get(MODULE_ID, "events");
    await game.settings.set(
      MODULE_ID,
      "events",
      events.filter((e) => e.id !== eventId),
    );
    updateAllTrains(game.time.worldTime);
  },

  /** List events, optionally filtered by route. */
  listEvents(routeId) {
    const events = game.settings.get(MODULE_ID, "events");
    if (routeId) return events.filter((e) => e.target.routeId === routeId);
    return events;
  },

  /** Clear events for a route, or all events if no routeId given. */
  async clearEvents(routeId) {
    if (routeId) {
      const events = game.settings.get(MODULE_ID, "events");
      await game.settings.set(
        MODULE_ID,
        "events",
        events.filter((e) => e.target.routeId !== routeId),
      );
    } else {
      await game.settings.set(MODULE_ID, "events", []);
    }
    updateAllTrains(game.time.worldTime);
  },

  /** Update an existing event by ID. */
  async updateEvent(eventId, event) {
    const events = game.settings.get(MODULE_ID, "events");
    const idx = events.findIndex((e) => e.id === eventId);
    if (idx === -1) {
      ui.notifications.warn(`Event "${eventId}" not found.`);
      return;
    }
    events[idx] = { ...event, id: eventId };
    await game.settings.set(MODULE_ID, "events", events);
    updateAllTrains(game.time.worldTime);
  },

  /** Convenience: delay a specific departure. Returns event ID. */
  async delayTrain(routeId, departureTime, delayHours, opts = {}) {
    return this.addEvent({
      type: "delay",
      target: { routeId, departureTime },
      startTime: opts.startTime ?? game.time.worldTime,
      endTime: opts.endTime ?? null,
      delayHours,
      recoveryRate: opts.recoveryRate,
      reason: opts.reason,
    });
  },

  /** Convenience: destroy (cancel) a specific departure. Returns event ID. */
  async destroyTrain(routeId, departureTime, opts = {}) {
    return this.addEvent({
      type: "destroy",
      target: { routeId, departureTime },
      startTime: opts.startTime ?? game.time.worldTime,
      endTime: opts.endTime ?? null,
      reason: opts.reason,
    });
  },

  /** Convenience: block all trains at a station. Returns event ID. */
  async blockTrack(routeId, stationName, opts = {}) {
    return this.addEvent({
      type: "blockTrack",
      target: { routeId, stationName },
      startTime: opts.startTime ?? game.time.worldTime,
      endTime: opts.endTime ?? null,
      reason: opts.reason,
    });
  },

  /** Add a route to the world settings. */
  async addRoute(route) {
    const routes = game.settings.get(MODULE_ID, "routes");
    if (!route.id) {
      route.id = foundry.utils.randomID();
    }
    if (routes.some((r) => r.id === route.id)) {
      ui.notifications.warn(`Route "${route.name ?? route.id}" already exists.`);
      return;
    }
    await game.settings.set(MODULE_ID, "routes", [...routes, route]);
    updateAllTrains(game.time.worldTime);
  },

  /** Update an existing route by ID (full replacement). */
  async updateRoute(routeId, route) {
    const routes = game.settings.get(MODULE_ID, "routes");
    const idx = routes.findIndex((r) => r.id === routeId);
    if (idx === -1) {
      ui.notifications.warn(`Route "${routeId}" not found.`);
      return;
    }
    routes[idx] = route;
    await game.settings.set(MODULE_ID, "routes", routes);
    invalidateCache();
    updateAllTrains(game.time.worldTime);
  },

  /** Remove a route and its associated events. */
  async removeRoute(routeId) {
    const routes = game.settings.get(MODULE_ID, "routes");
    await game.settings.set(
      MODULE_ID,
      "routes",
      routes.filter((r) => r.id !== routeId),
    );
    const events = game.settings.get(MODULE_ID, "events");
    await game.settings.set(
      MODULE_ID,
      "events",
      events.filter((e) => e.target.routeId !== routeId),
    );
    updateAllTrains(game.time.worldTime);
  },

  /** Create a Calendaria note that triggers a rail event. */
  async scheduleEvent(event, date) {
    if (!game.modules.get("calendaria")?.active) {
      ui.notifications.warn("Calendaria module is not active.");
      return;
    }
    await CALENDARIA.api.createNote({
      title: `Rail: ${event.type} — ${event.reason ?? event.target?.routeId ?? "event"}`,
      flagData: { railNetwork: event },
      date,
    });
  },

  /** Open the event management dialog (backward-compatible alias). */
  async eventDialog() {
    return api.eventListDialog();
  },

  /** Open a dialog to create or edit an event. */
  async eventEditDialog(eventId) {
    const routes = game.settings.get(MODULE_ID, "routes");
    if (routes.length === 0) {
      ui.notifications.warn("No routes configured.");
      return;
    }

    const existing = eventId ? game.settings.get(MODULE_ID, "events").find((e) => e.id === eventId) : null;
    const isEdit = !!existing;

    const routeOptions = routes
      .map((r) => {
        const sel = r.id === existing?.target?.routeId ? " selected" : "";
        return `<option value="${r.id}"${sel}>${r.name ?? r.id}</option>`;
      })
      .join("");

    const eventTypes = ["closeLine", "blockTrack", "delay", "destroy", "halt", "extraDeparture"];
    const typeOptions = eventTypes
      .map((t) => {
        const sel = t === existing?.type ? " selected" : "";
        return `<option value="${t}"${sel}>${t}</option>`;
      })
      .join("");

    const hasCalendaria = game.modules.get("calendaria")?.active;

    const formatTime = (t) => {
      if (t == null) return "none";
      return String(t);
    };

    // Build station and departure options for the initially selected route
    const selectedRoute = existing?.target?.routeId ? routes.find((r) => r.id === existing.target.routeId) : routes[0];
    const stationNames = selectedRoute ? getRouteStationNames(selectedRoute) : [];
    const stationOptions = stationNames
      .map((s) => {
        const sel = s === existing?.target?.stationName ? " selected" : "";
        return `<option value="${s}"${sel}>${s}</option>`;
      })
      .join("");
    const departureOptions = selectedRoute ? buildDepartureOptions(selectedRoute, existing?.target?.departureTime) : "";

    // Which fields are visible per event type
    // stationName: blockTrack, halt, extraDeparture
    // departureTime: delay, destroy, halt
    // delayHours + recoveryRate: delay
    const _selectedType = existing?.type ?? "closeLine";

    const content = `
      <style>
        .rail-event-field { transition: opacity 0.15s; }
        .rail-event-field.hidden { display: none; }
      </style>
      <form>
        <div class="form-group">
          <label>Route</label>
          <select name="routeId">${routeOptions}</select>
        </div>
        <div class="form-group">
          <label>Event Type</label>
          <select name="type">${typeOptions}</select>
        </div>
        <div class="form-group rail-event-field" data-field="stationName">
          <label>Station</label>
          <select name="stationName">
            <option value="">— select station —</option>
            ${stationOptions}
          </select>
        </div>
        <div class="form-group rail-event-field" data-field="departureTime">
          <label>Departure</label>
          <select name="departureTime">
            <option value="">— select departure —</option>
            ${departureOptions}
          </select>
        </div>
        <div class="form-group rail-event-field" data-field="delayHours">
          <label>Delay Hours</label>
          <input type="number" name="delayHours" step="0.1" value="${existing?.delayHours ?? ""}" placeholder="Hours to delay">
        </div>
        <div class="form-group rail-event-field" data-field="recoveryRate">
          <label>Recovery Rate</label>
          <input type="number" name="recoveryRate" step="0.1" value="${existing?.recoveryRate ?? ""}" placeholder="Hours recovered per hour (optional)">
        </div>
        <div class="form-group">
          <label>Start Time</label>
          <input type="text" name="startTime" value="${isEdit ? formatTime(existing.startTime) : "now"}" placeholder="'now', 'none', or world time seconds">
          <p class="hint" style="font-size:0.8em;opacity:0.7;margin:2px 0 0;">Current world time: ${game.time.worldTime} (${formatWorldTime(game.time.worldTime)})</p>
        </div>
        <div class="form-group">
          <label>End Time</label>
          <input type="text" name="endTime" value="${formatTime(existing?.endTime)}" placeholder="'none' for permanent, or world time seconds">
        </div>
        <div class="form-group">
          <label>Reason</label>
          <input type="text" name="reason" value="${existing?.reason ?? ""}" placeholder="Optional flavor text">
        </div>
        ${
          hasCalendaria && !isEdit
            ? `<div class="form-group">
          <label>Create Calendaria Note</label>
          <input type="checkbox" name="calendaria">
        </div>`
            : ""
        }
      </form>
    `;

    // Field visibility rules per event type
    const fieldVisibility = {
      closeLine: { stationName: false, departureTime: false, delayHours: false, recoveryRate: false },
      blockTrack: { stationName: true, departureTime: false, delayHours: false, recoveryRate: false },
      delay: { stationName: false, departureTime: true, delayHours: true, recoveryRate: true },
      destroy: { stationName: false, departureTime: true, delayHours: false, recoveryRate: false },
      halt: { stationName: true, departureTime: true, delayHours: false, recoveryRate: false },
      extraDeparture: { stationName: true, departureTime: false, delayHours: false, recoveryRate: false },
    };

    const result = await foundry.applications.api.DialogV2.wait({
      id: "rail-network-event-edit",
      window: { title: isEdit ? `Rail Network — Edit Event: ${eventId}` : "Rail Network — Create Event" },
      content,
      position: { width: 500, left: 200, top: 100 },
      render: (event, dialog) => {
        const scrollEl = dialog.element.querySelector(".window-content");
        if (scrollEl) {
          scrollEl.style.overflowY = "auto";
          scrollEl.scrollTop = 0;
        }

        const form = dialog.element.querySelector("form");
        if (!form) return;

        const updateFieldVisibility = () => {
          const type = form.querySelector('select[name="type"]').value;
          const rules = fieldVisibility[type] ?? {};
          form.querySelectorAll(".rail-event-field").forEach((el) => {
            const field = el.dataset.field;
            el.classList.toggle("hidden", !(rules[field] ?? false));
          });
        };

        // Toggle fields on event type change
        form.querySelector('select[name="type"]').addEventListener("change", updateFieldVisibility);

        // Rebuild station + departure options on route change
        form.querySelector('select[name="routeId"]').addEventListener("change", () => {
          const routeId = form.querySelector('select[name="routeId"]').value;
          const route = routes.find((r) => r.id === routeId);
          if (!route) return;

          const names = getRouteStationNames(route);
          const stationSel = form.querySelector('select[name="stationName"]');
          stationSel.innerHTML =
            '<option value="">— select station —</option>' +
            names.map((s) => `<option value="${s}">${s}</option>`).join("");

          const depSel = form.querySelector('select[name="departureTime"]');
          depSel.innerHTML = '<option value="">— select departure —</option>' + buildDepartureOptions(route);
        });

        // Set initial visibility
        updateFieldVisibility();
      },
      buttons: [
        {
          action: "save",
          label: isEdit ? "Save" : "Create Event",
          callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object,
        },
        { action: "cancel", label: "Cancel" },
      ],
    });

    if (result === "cancel" || !result) return;

    const parseTime = (val) => {
      if (!val || val === "none") return null;
      if (val === "now") return game.time.worldTime;
      return Number(val);
    };

    const event = {
      type: result.type,
      target: { routeId: result.routeId },
      startTime: parseTime(result.startTime),
      endTime: parseTime(result.endTime),
      reason: result.reason || undefined,
    };

    if (result.stationName) event.target.stationName = result.stationName;
    if (result.departureTime) event.target.departureTime = Number(result.departureTime);
    if (result.delayHours) event.delayHours = Number(result.delayHours);
    if (result.recoveryRate) event.recoveryRate = Number(result.recoveryRate);

    if (isEdit) {
      await api.updateEvent(eventId, event);
      ui.notifications.info(`Event "${eventId}" updated.`);
    } else {
      const newId = await api.addEvent(event);
      if (result.calendaria && hasCalendaria) {
        await api.scheduleEvent(event);
      }
      ui.notifications.info(`Rail event created: ${event.type} (${newId})`);
    }
  },

  /** Open a dialog listing all events with New/Edit/Delete actions. */
  async eventListDialog() {
    const events = game.settings.get(MODULE_ID, "events");

    let rows = "";
    for (const e of events) {
      const routes = game.settings.get(MODULE_ID, "routes");
      const targetRoute = routes.find((r) => r.id === e.target.routeId);
      const target = [targetRoute?.name || e.target.routeId];
      if (e.target.stationName) target.push(e.target.stationName);
      if (e.target.departureTime) target.push(formatWorldTime(e.target.departureTime));
      const details = [];
      if (e.delayHours) details.push(`delay: ${e.delayHours}h`);
      if (e.recoveryRate) details.push(`recovery: ${e.recoveryRate}/h`);
      if (e.reason) details.push(e.reason);

      rows += `
        <tr>
          <td>${e.type}</td>
          <td>${target.join(" / ")}</td>
          <td>${formatWorldTime(e.startTime)}</td>
          <td>${formatWorldTime(e.endTime)}</td>
          <td style="font-size:0.85em;">${details.join("; ") || "—"}</td>
          <td style="white-space:nowrap;">
            <button type="button" class="evt-edit" data-id="${e.id}">Edit</button>
            <button type="button" class="evt-delete" data-id="${e.id}">Delete</button>
          </td>
        </tr>`;
    }

    if (events.length === 0) {
      rows = `<tr><td colspan="6" style="text-align:center;font-style:italic;">No events.</td></tr>`;
    }

    const content = `
      <style>${TABLE_ROW_STYLES}</style>
      <table class="rail-table" style="width:100%;border-collapse:collapse;font-size:0.9em;">
        <thead>
          <tr style="border-bottom:1px solid var(--color-border-light);">
            <th style="text-align:left;">Type</th>
            <th style="text-align:left;">Target</th>
            <th>Start</th>
            <th>End</th>
            <th style="text-align:left;">Details</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    const result = await foundry.applications.api.DialogV2.wait({
      id: "rail-network-event-list",
      window: { title: "Rail Network — Event Manager" },
      content,
      position: { width: 700, left: 100, top: 50 },
      render: (event, dialog) => {
        const el = dialog.element;
        if (!el) return;

        el.querySelectorAll(".evt-edit").forEach((btn) => {
          btn.addEventListener("click", async () => {
            await dialog.close();
            await api.eventEditDialog(btn.dataset.id);
            api.eventListDialog();
          });
        });

        el.querySelectorAll(".evt-delete").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const confirmed = await foundry.applications.api.DialogV2.confirm({
              window: { title: "Confirm Delete" },
              content: `<p>Delete this event?</p>`,
            });
            if (!confirmed) return;
            await dialog.close();
            await api.removeEvent(btn.dataset.id);
            ui.notifications.info("Event deleted.");
            api.eventListDialog();
          });
        });
      },
      buttons: [
        {
          action: "new",
          label: "New Event",
          callback: () => "new",
        },
        { action: "close", label: "Close" },
      ],
    });

    if (result === "new") {
      await api.eventEditDialog();
      api.eventListDialog();
    }
  },

  /** Tag a Drawing as a track segment with station metadata. */
  async tagSegment(segmentId, stations, drawingId) {
    const drawing = drawingId ? canvas.scene.drawings.get(drawingId) : canvas.drawings.controlled[0]?.document;

    if (!drawing) {
      ui.notifications.warn("No Drawing selected or found.");
      return;
    }

    await drawing.setFlag(MODULE_ID, "segmentId", segmentId);
    await drawing.setFlag(MODULE_ID, "stations", stations);
    invalidateCache(segmentId);
    ui.notifications.info(`Tagged Drawing as segment: ${segmentId}`);
  },

  /** Edit an existing segment's station configuration. */
  async editSegment(segmentId) {
    const drawing = canvas.drawings?.placeables?.find((d) => d.document.flags?.[MODULE_ID]?.segmentId === segmentId);
    if (!drawing) {
      ui.notifications.warn(`Segment "${segmentId}" not found on this scene.`);
      return;
    }
    // Open setup dialog pre-populated with this Drawing
    return api.setupDialog(drawing.document);
  },

  /** Open the interactive segment setup dialog. */
  async setupDialog(preselectedDoc) {
    const doc = preselectedDoc ?? canvas.drawings.controlled[0]?.document;

    if (!doc) {
      ui.notifications.warn("Select a Drawing first (polygon polyline).");
      return;
    }

    const points = doc.shape.points;
    const numPoints = points.length / 2;
    const existingFlags = doc.flags?.[MODULE_ID] ?? {};
    const existingStations = existingFlags.stations ?? [];
    const stationMap = new Map(existingStations.map((s) => [s.pointIndex, s]));

    // Pre-compute absolute positions for each point
    const absPoints = [];
    for (let i = 0; i < numPoints; i++) {
      absPoints.push({
        x: Math.round(doc.x + points[i * 2]),
        y: Math.round(doc.y + points[i * 2 + 1]),
      });
    }

    // Pre-compute cumulative pixel distance from previous named station for each point
    const grid = canvas.scene?.grid;
    const gridUnits = grid?.units ?? "";
    const distFromPrevStation = new Array(numPoints).fill(null);
    let lastStationIdx = -1;
    let cumPixelDist = 0;
    for (let i = 0; i < numPoints; i++) {
      if (i > 0) {
        const dx = absPoints[i].x - absPoints[i - 1].x;
        const dy = absPoints[i].y - absPoints[i - 1].y;
        cumPixelDist += Math.sqrt(dx * dx + dy * dy);
      }
      const isStation = stationMap.has(i);
      if (isStation && lastStationIdx >= 0) {
        distFromPrevStation[i] = grid
          ? pixelDistanceToWorldDistance(cumPixelDist, grid.size, grid.distance)
          : cumPixelDist;
      }
      if (isStation) {
        lastStationIdx = i;
        cumPixelDist = 0;
      }
    }

    let pointRows = "";
    for (let i = 0; i < numPoints; i++) {
      const { x: absX, y: absY } = absPoints[i];
      const existing = stationMap.get(i);
      const name = existing?.name ?? "";
      const hours = existing?.hoursFromPrev ?? "";
      const dwell = existing?.dwellMinutes ?? "";
      const dist = distFromPrevStation[i];
      const distLabel = dist != null ? `${Math.round(dist)} ${gridUnits}` : "—";

      pointRows += `
        <tr data-point-index="${i}" data-point-x="${absX}" data-point-y="${absY}">
          <td>${i}</td>
          <td>(${absX}, ${absY})</td>
          <td style="opacity:0.7;font-size:0.9em;text-align:right;">${distLabel}</td>
          <td><input type="text" name="name_${i}" value="${name}" size="12" placeholder="Station name"></td>
          <td><input type="number" name="hours_${i}" value="${hours}" step="0.1" size="6" placeholder="Travel hrs"></td>
          <td><input type="number" name="dwell_${i}" value="${dwell}" step="1" size="4" placeholder="Minutes"></td>
        </tr>
      `;
    }

    const content = `
      <style>
        ${TABLE_ROW_STYLES}
        .rail-segment-table thead { position: sticky; top: 0; background: var(--color-cool-5); z-index: 1; }
        .rail-segment-table tbody tr:hover { background: rgba(255, 200, 0, 0.15); cursor: pointer; }
        .rail-segment-table input[type="text"]:not(:placeholder-shown) { font-weight: bold; }
      </style>
      <form>
        <div class="form-group">
          <label>Segment ID</label>
          <input type="text" name="segmentId" value="${existingFlags.segmentId ?? ""}" required
                 placeholder="e.g. sharn-wroat">
        </div>
        <table class="rail-segment-table rail-table">
          <thead>
            <tr><th>#</th><th>Position</th><th>Dist</th><th>Name</th><th>Hours from Prev</th><th>Dwell (min)</th></tr>
          </thead>
          <tbody>${pointRows}</tbody>
        </table>
      </form>
    `;

    const result = await foundry.applications.api.DialogV2.wait({
      id: "rail-network-tag-segment",
      window: { title: "Rail Network — Tag Segment" },
      content,
      position: { width: 700, height: 600, top: 50, left: 100 },
      render: (event, dialog) => {
        const el = dialog.element ?? dialog;
        const scrollEl =
          el.querySelector?.(".window-content") ?? el.closest?.(".application")?.querySelector(".window-content");
        if (scrollEl) {
          scrollEl.style.overflowY = "auto";
          scrollEl.scrollTop = 0;
        }

        const root = el.querySelector?.("form") ?? el;

        // Highlight point on map when hovering a row
        let highlightGraphic = null;
        root.querySelectorAll("tbody tr").forEach((row) => {
          row.addEventListener("mouseenter", () => {
            const px = Number(row.dataset.pointX);
            const py = Number(row.dataset.pointY);
            if (isNaN(px) || isNaN(py)) return;
            // Draw a temporary highlight circle on the canvas
            highlightGraphic = new PIXI.Graphics();
            highlightGraphic.beginFill(0xffcc00, 0.6);
            highlightGraphic.drawCircle(0, 0, 16);
            highlightGraphic.endFill();
            highlightGraphic.beginFill(0xffcc00, 0.2);
            highlightGraphic.drawCircle(0, 0, 40);
            highlightGraphic.endFill();
            highlightGraphic.position.set(px, py);
            canvas.controls.addChild(highlightGraphic);
          });
          row.addEventListener("mouseleave", () => {
            if (highlightGraphic) {
              highlightGraphic.destroy();
              highlightGraphic = null;
            }
          });
        });
      },
      buttons: [
        {
          action: "save",
          label: "Save",
          callback: (event, button) => {
            const fd = new foundry.applications.ux.FormDataExtended(button.form);
            return fd.object;
          },
        },
        { action: "cancel", label: "Cancel" },
      ],
    });

    if (result === "cancel" || !result) return;

    const segmentId = result.segmentId;
    const stations = [];
    for (let i = 0; i < numPoints; i++) {
      const name = result[`name_${i}`]?.trim();
      if (name) {
        const station = {
          pointIndex: i,
          name,
          dwellMinutes: Number(result[`dwell_${i}`]) || 0,
        };
        if (result[`hours_${i}`]) {
          station.hoursFromPrev = Number(result[`hours_${i}`]);
        }
        stations.push(station);
      }
    }

    await api.tagSegment(segmentId, stations, doc.id);
  },

  /** Open a dialog to create or edit a route. */
  async routeEditDialog(routeId) {
    const routes = game.settings.get(MODULE_ID, "routes");
    const existing = routeId ? routes.find((r) => r.id === routeId) : null;
    const isEdit = !!existing;
    const hasCalendaria = !!game.modules.get("calendaria")?.active;

    const segOptions = buildSegmentOptions();
    const normalized = existing ? normalizeSchedule(existing) : null;
    const trips = normalized?.schedule ?? [];

    // Resolve compass labels from a trip's segments
    function getCompassOpts(segments) {
      if (!segments?.length) return null;
      try {
        const path = resolveRouteWithDrawings({ segments }, game.time.worldTime);
        return getPathCompassLabels(path);
      } catch {
        return null;
      }
    }

    const defaultLabels = { outbound: "Outbound", return: "Return", roundtrip: "Round trip" };

    // Build trip block HTML for each existing trip
    function buildTripBlock(tripIdx, trip) {
      const routeNum = trip.routeNumbers?.[0] ?? "";
      const parts = (trip.cron ?? "0 6").split(/\s+/);
      const minute = parts[0] ?? "0";
      const hour = parts[1] ?? "6";
      const compass = getCompassOpts(trip.segments) ?? defaultLabels;
      const dirOpts = ["outbound", "return", "roundtrip"]
        .map((d) => {
          const label = compass[d] ?? defaultLabels[d];
          const sel = (trip.direction ?? "outbound") === d ? " selected" : "";
          return `<option value="${d}"${sel}>${label}</option>`;
        })
        .join("");

      // Calendaria fields or offset
      let extraFields;
      if (hasCalendaria) {
        const day = parts[2] ?? "*";
        const month = parts[3] ?? "*";
        const weekday = parts[4] ?? "*";
        extraFields = `
          <div style="flex:1;"><label>Day</label><input type="text" name="trip_${tripIdx}_day" value="${day}" placeholder="*"></div>
          <div style="flex:1;"><label>Month</label><input type="text" name="trip_${tripIdx}_month" value="${month}" placeholder="*"></div>
          <div style="flex:1;"><label>Weekday</label><input type="text" name="trip_${tripIdx}_weekday" value="${weekday}" placeholder="*"></div>`;
      } else {
        const offset = parts[2] ?? "0";
        extraFields = `
          <div style="flex:1;"><label>Offset</label><input type="text" name="trip_${tripIdx}_offset" value="${offset}" placeholder="0"></div>`;
      }

      // Build segment chain
      const segs = trip.segments ?? [];
      let segChain = "";
      for (let s = 0; s < segs.length; s++) {
        const seg = segs[s];
        const opts = segOptions.includes(`value="${seg.segmentId}"`)
          ? segOptions.replace(`value="${seg.segmentId}"`, `value="${seg.segmentId}" selected`)
          : `<option value="${seg.segmentId}" selected>${seg.segmentId}</option>` + segOptions;
        if (s > 0) segChain += `<span style="margin:0 4px;opacity:0.5;">→</span>`;
        segChain += `<select name="trip_${tripIdx}_seg_${s}" style="width:140px;">${opts}</select>`;
      }

      const desc = describeCronExpression(trip.cron ?? "0 6", hasCalendaria, getCalendarInfo());

      return `
        <div class="trip-block" data-trip="${tripIdx}" style="border:1px solid var(--color-border-light);border-radius:4px;padding:8px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <b>Trip ${tripIdx + 1}</b>
            <button type="button" class="remove-trip" data-trip="${tripIdx}" style="font-size:0.85em;">Remove</button>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
            <div style="flex:1;"><label>Route #</label><input type="text" name="trip_${tripIdx}_routeNum" value="${routeNum}" placeholder="101"></div>
            <div style="flex:1;"><label>Direction</label><select name="trip_${tripIdx}_dir">${dirOpts}</select></div>
            <div style="flex:1;"><label>Minute</label><input type="text" name="trip_${tripIdx}_min" value="${minute}" placeholder="0"></div>
            <div style="flex:1;"><label>Hour</label><input type="text" name="trip_${tripIdx}_hour" value="${hour}" placeholder="6"></div>
            ${extraFields}
          </div>
          <div style="margin-bottom:4px;">
            <label style="font-size:0.85em;">Segments:</label>
            <span class="seg-chain" style="display:inline-flex;align-items:center;flex-wrap:wrap;gap:2px;">${segChain}</span>
            <button type="button" class="add-trip-seg" data-trip="${tripIdx}" style="font-size:0.85em;margin-left:4px;">+ Segment</button>
          </div>
          <div class="trip-desc" style="font-size:0.85em;opacity:0.7;font-style:italic;">→ ${desc}</div>
        </div>`;
    }

    let tripBlocks = "";
    for (let t = 0; t < trips.length; t++) {
      tripBlocks += buildTripBlock(t, trips[t]);
    }

    const cronHelp = hasCalendaria
      ? `Fields: minute, hour, day-of-month, month, day-of-week — matched against the active Calendaria calendar.`
      : `Fields: minute, hour, offset — hour counts from the start of the world clock.`;

    // Wandering route state
    const isWander = existing?.type === "wander";
    const networkConfig = existing?.network ?? {};

    // Build network segment checkboxes and station weights for wander mode
    function buildNetworkSection() {
      const allSegIds = (canvas.drawings?.placeables ?? [])
        .map((d) => d.document.flags?.[MODULE_ID]?.segmentId)
        .filter(Boolean)
        .sort();
      const selectedSegs = networkConfig.segments ?? [];

      let segCheckboxes = "";
      for (const segId of allSegIds) {
        const checked = selectedSegs.includes(segId) ? " checked" : "";
        segCheckboxes += `<label style="display:block;margin:2px 0;"><input type="checkbox" name="network_seg_${segId}" value="${segId}"${checked}> ${segId}</label>`;
      }

      // Discover all stations from selected segments
      const stationNames = new Set();
      for (const segId of selectedSegs) {
        const drawing = canvas.drawings?.placeables?.find((d) => d.document.flags?.[MODULE_ID]?.segmentId === segId);
        if (drawing) {
          const path = drawingToPath(drawing.document);
          for (const node of path) {
            if ("station" in node) stationNames.add(node.station);
          }
        }
      }

      const weights = networkConfig.weights ?? {};
      let weightRows = "";
      for (const name of [...stationNames].sort()) {
        const w = weights[name] ?? "";
        weightRows += `<tr><td style="padding:4px 8px;">${name}</td><td style="padding:4px 8px;"><input type="number" name="network_weight_${name}" value="${w}" min="0" step="1" style="width:60px;"></td></tr>`;
      }

      const startOptions = [...stationNames]
        .sort()
        .map((s) => {
          const sel = s === networkConfig.startStation ? " selected" : "";
          return `<option value="${s}"${sel}>${s}</option>`;
        })
        .join("");

      return `
        <div class="form-group">
          <label>Network Segments</label>
          <div class="network-segments" style="max-height:120px;overflow-y:auto;border:1px solid var(--color-border-light);border-radius:4px;padding:4px 8px;">${segCheckboxes || "<em>No segments found on this scene</em>"}</div>
        </div>
        <div style="display:flex;gap:12px;">
          <div class="form-group" style="flex:1;">
            <label>Start Station</label>
            <select name="network_startStation">${startOptions || '<option value="">--</option>'}</select>
          </div>
          <div class="form-group" style="flex:1;">
            <label>Max Hours</label>
            <input type="number" name="network_maxHours" value="${networkConfig.maxHours ?? 0}" min="0" step="1">
            <p class="hint" style="font-size:0.85em;opacity:0.7;margin:2px 0 0;">0 = indefinite</p>
          </div>
        </div>
        <div class="form-group">
          <label>Station Weights</label>
          <p class="hint" style="font-size:0.85em;opacity:0.7;margin:2px 0 6px;">Set a positive weight for each station the train may choose as a destination. Stations without a weight are never chosen but may be traversed en route.</p>
          <table class="station-weights-table rail-table" style="border-collapse:collapse;width:100%;">
            <thead><tr><th style="text-align:left;padding:4px 8px;">Station</th><th style="text-align:left;padding:4px 8px;">Weight</th></tr></thead>
            <tbody>${weightRows || '<tr><td colspan="2" style="padding:4px 8px;opacity:0.6;"><em>Select segments above to see stations</em></td></tr>'}</tbody>
          </table>
        </div>`;
    }

    const content = `
      <style>
        ${TABLE_ROW_STYLES}
      </style>
      <form>
        <input type="hidden" name="id" value="${existing?.id ?? ""}">
        <div class="form-group">
          <label>Route Name</label>
          <input type="text" name="name" value="${existing?.name ?? ""}" required>
        </div>
        <div class="form-group">
          <label>Route Type</label>
          <select name="type">
            <option value="fixed"${!isWander ? " selected" : ""}>Fixed Route</option>
            <option value="wander"${isWander ? " selected" : ""}>Wandering</option>
          </select>
          <p class="hint" style="font-size:0.85em;opacity:0.7;margin:2px 0 0;">
            Fixed routes follow a set path. Wandering routes randomly choose their next destination.
          </p>
        </div>
        <h3 style="border-bottom:1px solid var(--color-border-light);padding-bottom:4px;">Train Actor</h3>
        <div class="form-group">
          <label>Actor</label>
          <select name="actorId" style="width:100%;">
            <option value="">-- Select Actor --</option>
            ${game.actors
              .map((a) => {
                const sel = a.id === existing?.actorId ? " selected" : "";
                return `<option value="${a.id}"${sel}>${a.name}</option>`;
              })
              .join("")}
          </select>
        </div>
        <div class="form-group rail-actor-drop-zone"
             style="border:2px dashed var(--color-border-light);border-radius:4px;padding:8px;text-align:center;cursor:default;">
          <span class="drop-hint" style="opacity:0.6;">Or drag an actor here from the sidebar</span>
          <div class="actor-preview" style="display:flex;align-items:center;gap:8px;justify-content:center;"></div>
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" name="useActorSpeed" value="true"
                   ${existing?.useActorSpeed ? "checked" : ""}>
            Use actor travel speed and scene grid size
          </label>
          <p class="hint" style="font-size:0.85em;opacity:0.7;margin:2px 0 0;">
            When checked, travel time between stations is calculated from the actor's
            travel speed and the scene grid scale instead of manual "Hours from Prev" values.
          </p>
          <div class="speed-info" style="font-size:0.85em;margin-top:4px;font-style:italic;"></div>
        </div>
        <div class="form-group">
          <label>Name Template</label>
          <input type="text" name="nameTemplate"
                 value="${existing?.nameTemplate ?? "[[name]] [[routeNum]]"}"
                 placeholder="[[name]] [[routeNum]]">
          <p class="hint" style="font-size:0.85em;opacity:0.7;margin:2px 0 0;">
            Variables: <code>[[name]]</code> (route name), <code>[[actor]]</code> (actor name), <code>[[routeNum]]</code> (route number)
          </p>
        </div>

        <div class="network-section" style="${isWander ? "" : "display:none;"}">
          <h3 style="border-bottom:1px solid var(--color-border-light);padding-bottom:4px;">Network</h3>
          <div class="network-content">${isWander ? buildNetworkSection() : ""}</div>
        </div>

        <h3 style="border-bottom:1px solid var(--color-border-light);padding-bottom:4px;">
          Trips
          <button type="button" data-action="add-trip" style="float:right;">+ Add Trip</button>
        </h3>
        <div style="margin:4px 0 8px;font-size:0.85em;opacity:0.7;">
          <p class="trips-desc" style="margin:0 0 6px;">Each trip defines when a train departs, which direction it travels, and which track segments it follows. ${cronHelp}</p>
          <p class="trips-desc-wander" style="margin:0 0 6px;display:none;">Each trip defines when a wandering train departs. The route is chosen randomly based on station weights. ${cronHelp}</p>
          <details style="margin-bottom:4px;">
            <summary style="cursor:pointer;font-weight:bold;">Schedule field syntax</summary>
            <table style="margin:4px 0;border-collapse:collapse;font-size:0.95em;">
              <tr><td style="padding:2px 8px 2px 0;"><code>5</code></td><td>Exact value (minute 5, or hour 5 repeating daily)</td></tr>
              <tr><td style="padding:2px 8px 2px 0;"><code>*</code></td><td>Every value (every minute, every hour)</td></tr>
              <tr><td style="padding:2px 8px 2px 0;"><code>1,3,5</code></td><td>List — matches 1, 3, or 5</td></tr>
              <tr><td style="padding:2px 8px 2px 0;"><code>1-5</code></td><td>Range — matches 1 through 5</td></tr>
              <tr><td style="padding:2px 8px 2px 0;"><code>*/15</code></td><td>Every 15th value (e.g. minutes 0, 15, 30, 45)</td></tr>
              <tr><td style="padding:2px 8px 2px 0;"><code>6/48</code></td><td>Starting at 6, every 48 (e.g. hour 6, 54, 102…)</td></tr>
            </table>
          </details>
          <details>
            <summary style="cursor:pointer;font-weight:bold;">Examples</summary>
            <table style="margin:4px 0;border-collapse:collapse;font-size:0.95em;">
              <tr><td style="padding:2px 8px 2px 0;">Min <code>0</code>, Hour <code>6</code></td><td>Daily at 06:00</td></tr>
              <tr><td style="padding:2px 8px 2px 0;">Min <code>30</code>, Hour <code>6</code></td><td>Daily at 06:30</td></tr>
              <tr><td style="padding:2px 8px 2px 0;">Min <code>0</code>, Hour <code>6,18</code></td><td>Twice daily at 06:00 and 18:00</td></tr>
              <tr><td style="padding:2px 8px 2px 0;">Min <code>0</code>, Hour <code>*/12</code></td><td>Every 12 hours</td></tr>
              <tr><td style="padding:2px 8px 2px 0;">Min <code>0</code>, Hour <code>6/48</code></td><td>At 06:00 every 2 days</td></tr>
              <tr><td style="padding:2px 8px 2px 0;">Min <code>0</code>, Hour <code>6/48</code>, Offset <code>24</code></td><td>At 06:00 every 2 days, shifted by 1 day</td></tr>
              ${
                hasCalendaria
                  ? `
              <tr><td style="padding:2px 8px 2px 0;">Hour <code>6</code>, Weekday <code>1,3,5</code></td><td>At 06:00 on weekdays 1, 3, and 5</td></tr>
              <tr><td style="padding:2px 8px 2px 0;">Hour <code>6</code>, Day <code>1</code></td><td>At 06:00 on the 1st of every month</td></tr>
              `
                  : ""
              }
            </table>
          </details>
        </div>
        <div class="trips-container">${tripBlocks}</div>
      </form>
    `;

    // Track next trip index for dynamic additions
    let nextTripIdx = trips.length;

    const result = await foundry.applications.api.DialogV2.wait({
      id: "rail-network-route-edit",
      window: {
        title: isEdit ? `Rail Network — Edit Route: ${existing?.name || routeId}` : "Rail Network — New Route",
      },
      content,
      position: { width: 620, top: 50, left: 200 },
      render: (event, dialog) => {
        const form = dialog.element.querySelector("form");
        if (!form) return;

        const scrollEl = dialog.element.querySelector(".window-content");
        if (scrollEl) {
          scrollEl.style.overflowY = "auto";
          scrollEl.scrollTop = 0;
        }

        // Actor preview updater
        const actorSelect = form.querySelector('select[name="actorId"]');
        const dropZone = form.querySelector(".rail-actor-drop-zone");
        const updateActorPreview = (actorId) => {
          const actor = game.actors.get(actorId);
          const preview = form.querySelector(".actor-preview");
          const hint = form.querySelector(".drop-hint");
          if (actor) {
            const imgSrc = actor.prototypeToken.texture.src ?? actor.img;
            preview.innerHTML = `<img src="${imgSrc}" width="36" height="36" style="border:0;border-radius:2px;"> <strong>${actor.name}</strong>`;
            if (hint) hint.style.display = "none";
          } else {
            preview.innerHTML = "";
            if (hint) hint.style.display = "";
          }
        };
        updateActorPreview(existing?.actorId);
        actorSelect.addEventListener("change", () => {
          updateActorPreview(actorSelect.value);
          updateSpeedInfo();
        });

        // Speed info updater
        const speedCheckbox = form.querySelector('[name="useActorSpeed"]');
        const speedInfoEl = form.querySelector(".speed-info");
        const updateSpeedInfo = () => {
          const checked = speedCheckbox?.checked;
          const actorId = actorSelect.value;
          if (!checked || !actorId) {
            speedInfoEl.textContent = "";
            return;
          }
          const actor = game.actors.get(actorId);
          const speed = actor?.system?.attributes?.travel?.speeds?.land;
          const units = actor?.system?.attributes?.travel?.units;
          if (speed && units) {
            const grid = canvas.scene?.grid;
            if (grid) {
              const pph = convertSpeedToPixelsPerHour(speed, units, grid.size, grid.distance, grid.units);
              if (pph) {
                speedInfoEl.textContent = `${actor.name}: ${speed} ${units} → ${pph.toFixed(1)} px/hr on this scene (${grid.distance} ${grid.units}/square)`;
                speedInfoEl.style.color = "";
              } else {
                speedInfoEl.textContent = `Could not convert ${speed} ${units} to scene grid units (${grid.units}).`;
                speedInfoEl.style.color = "var(--color-level-error)";
              }
            }
          } else {
            speedInfoEl.textContent = "Selected actor has no travel speed defined.";
            speedInfoEl.style.color = "var(--color-level-warning)";
          }
        };
        updateSpeedInfo();
        speedCheckbox?.addEventListener("change", updateSpeedInfo);

        // Drag-drop actor from sidebar
        dropZone.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "link";
          dropZone.style.borderColor = "var(--color-shadow-primary)";
        });
        dropZone.addEventListener("dragleave", () => {
          dropZone.style.borderColor = "";
        });
        dropZone.addEventListener("drop", async (e) => {
          e.preventDefault();
          dropZone.style.borderColor = "";
          try {
            const data = JSON.parse(e.dataTransfer.getData("text/plain"));
            if (data.type !== "Actor") return;
            const actor = await fromUuid(data.uuid);
            if (!actor) return;
            actorSelect.value = actor.id;
            updateActorPreview(actor.id);
            updateSpeedInfo();
          } catch {
            /* not valid drag data */
          }
        });

        // Route type toggle: show/hide network section and trip segment/direction fields
        const typeSelect = form.querySelector('select[name="type"]');
        const networkSection = form.querySelector(".network-section");
        const updateRouteType = () => {
          const wander = typeSelect.value === "wander";
          networkSection.style.display = wander ? "" : "none";
          // Toggle trip description text
          const tripsDesc = form.querySelector(".trips-desc");
          const tripsDescWander = form.querySelector(".trips-desc-wander");
          if (tripsDesc) tripsDesc.style.display = wander ? "none" : "";
          if (tripsDescWander) tripsDescWander.style.display = wander ? "" : "none";
          // Rebuild network section content when switching to wander
          if (wander && !networkSection.querySelector(".network-segments")) {
            networkSection.querySelector(".network-content").innerHTML = buildNetworkSection();
            // Attach segment checkbox listeners to refresh stations
            networkSection.querySelectorAll('.network-segments input[type="checkbox"]').forEach((cb) => {
              cb.addEventListener("change", refreshNetworkStations);
            });
          }
          // Hide/show trip direction and segment fields
          form.querySelectorAll(".trip-block").forEach((block) => {
            const dirField = block.querySelector(`[name$="_dir"]`)?.closest("div");
            const segArea = block.querySelector(".seg-chain")?.closest("div");
            if (dirField) dirField.style.display = wander ? "none" : "";
            if (segArea) segArea.style.display = wander ? "none" : "";
          });
          // Auto-add a default trip if switching to wander with no trips
          if (wander && form.querySelectorAll(".trip-block").length === 0) {
            const container = form.querySelector(".trips-container");
            const idx = nextTripIdx++;
            const defaultTrip = { cron: "0 6", routeNumbers: [], direction: "outbound", segments: [] };
            const tmp = document.createElement("div");
            tmp.innerHTML = buildTripBlock(idx, defaultTrip);
            container.appendChild(tmp.firstElementChild);
            // Hide direction/segment fields on the new block
            const block = container.lastElementChild;
            const dirField = block.querySelector(`[name$="_dir"]`)?.closest("div");
            const segArea = block.querySelector(".seg-chain")?.closest("div");
            if (dirField) dirField.style.display = "none";
            if (segArea) segArea.style.display = "none";
          }
        };
        typeSelect.addEventListener("change", updateRouteType);
        // Initial state
        updateRouteType();

        // Refresh station weights table when network segments change
        const refreshNetworkStations = () => {
          const checkboxes = form.querySelectorAll('.network-segments input[type="checkbox"]:checked');
          const selectedSegs = [...checkboxes].map((cb) => cb.value);
          const stationNames = new Set();
          for (const segId of selectedSegs) {
            const drawing = canvas.drawings?.placeables?.find(
              (d) => d.document.flags?.[MODULE_ID]?.segmentId === segId,
            );
            if (drawing) {
              const path = drawingToPath(drawing.document);
              for (const node of path) {
                if ("station" in node) stationNames.add(node.station);
              }
            }
          }
          // Preserve existing weight values
          const existingWeights = {};
          form.querySelectorAll('[name^="network_weight_"]').forEach((inp) => {
            const name = inp.name.replace("network_weight_", "");
            if (inp.value) existingWeights[name] = inp.value;
          });
          // Update start station dropdown
          const startSelect = form.querySelector('[name="network_startStation"]');
          if (startSelect) {
            const prevStart = startSelect.value;
            startSelect.innerHTML =
              [...stationNames]
                .sort()
                .map((s) => {
                  const sel = s === prevStart ? " selected" : "";
                  return `<option value="${s}"${sel}>${s}</option>`;
                })
                .join("") || '<option value="">--</option>';
          }
          // Update weights table
          const tbody = form.querySelector(".station-weights-table tbody");
          if (tbody) {
            if (stationNames.size === 0) {
              tbody.innerHTML =
                '<tr><td colspan="2" style="padding:4px 8px;opacity:0.6;"><em>Select segments above to see stations</em></td></tr>';
            } else {
              tbody.innerHTML = [...stationNames]
                .sort()
                .map((name) => {
                  const w = existingWeights[name] ?? networkConfig.weights?.[name] ?? "";
                  return `<tr><td style="padding:4px 8px;">${name}</td><td style="padding:4px 8px;"><input type="number" name="network_weight_${name}" value="${w}" min="0" step="1" style="width:60px;"></td></tr>`;
                })
                .join("");
            }
          }
        };
        // Attach initial segment checkbox listeners
        networkSection.querySelectorAll('.network-segments input[type="checkbox"]').forEach((cb) => {
          cb.addEventListener("change", refreshNetworkStations);
        });

        // Update cron description live when fields change
        const updateDesc = (tripBlock) => {
          const idx = tripBlock.dataset.trip;
          const min = tripBlock.querySelector(`[name="trip_${idx}_min"]`)?.value ?? "0";
          const hour = tripBlock.querySelector(`[name="trip_${idx}_hour"]`)?.value ?? "*";
          let cron;
          if (hasCalendaria) {
            const day = tripBlock.querySelector(`[name="trip_${idx}_day"]`)?.value ?? "*";
            const month = tripBlock.querySelector(`[name="trip_${idx}_month"]`)?.value ?? "*";
            const weekday = tripBlock.querySelector(`[name="trip_${idx}_weekday"]`)?.value ?? "*";
            cron = `${min} ${hour} ${day} ${month} ${weekday}`;
          } else {
            const offset = tripBlock.querySelector(`[name="trip_${idx}_offset"]`)?.value ?? "0";
            cron = offset && offset !== "0" ? `${min} ${hour} ${offset}` : `${min} ${hour}`;
          }
          const desc = describeCronExpression(cron, hasCalendaria, getCalendarInfo());
          const descEl = tripBlock.querySelector(".trip-desc");
          if (descEl) descEl.textContent = `→ ${desc}`;
        };

        // Update direction dropdown labels based on resolved segment path
        const updateDirLabels = (tripBlock) => {
          const idx = tripBlock.dataset.trip;
          const segSelects = tripBlock.querySelectorAll(`[name^="trip_${idx}_seg_"]`);
          const segments = [...segSelects].map((sel) => ({ segmentId: sel.value })).filter((s) => s.segmentId);
          const compass = getCompassOpts(segments) ?? defaultLabels;
          const dirSelect = tripBlock.querySelector(`[name="trip_${idx}_dir"]`);
          if (dirSelect) {
            for (const opt of dirSelect.options) {
              opt.textContent = compass[opt.value] ?? defaultLabels[opt.value];
            }
          }
        };

        // Live update descriptions and direction labels on input/change
        form.addEventListener("input", (e) => {
          const tripBlock = e.target.closest(".trip-block");
          if (tripBlock) updateDesc(tripBlock);
        });
        form.addEventListener("change", (e) => {
          const tripBlock = e.target.closest(".trip-block");
          if (tripBlock && e.target.tagName === "SELECT" && e.target.name?.includes("_seg_")) {
            updateDirLabels(tripBlock);
          }
        });

        // Add trip
        form.querySelector("[data-action='add-trip']")?.addEventListener("click", (e) => {
          e.preventDefault();
          const container = form.querySelector(".trips-container");
          const idx = nextTripIdx++;
          // Copy segments from the first trip if available
          const defaultTrip = {
            cron: "0 6",
            routeNumbers: [],
            direction: "outbound",
            segments: trips[0]?.segments ?? [],
          };
          const tmp = document.createElement("div");
          tmp.innerHTML = buildTripBlock(idx, defaultTrip);
          container.appendChild(tmp.firstElementChild);
          // Hide direction/segment fields if in wander mode
          if (typeSelect.value === "wander") {
            const block = container.lastElementChild;
            const dirField = block.querySelector(`[name$="_dir"]`)?.closest("div");
            const segArea = block.querySelector(".seg-chain")?.closest("div");
            if (dirField) dirField.style.display = "none";
            if (segArea) segArea.style.display = "none";
          }
        });

        // Add segment to trip
        form.addEventListener("click", (e) => {
          if (e.target.classList.contains("add-trip-seg")) {
            e.preventDefault();
            const tripIdx = e.target.dataset.trip;
            const chain = e.target.closest(".trip-block").querySelector(".seg-chain");
            const segIdx = chain.querySelectorAll("select").length;
            if (segIdx > 0) {
              const arrow = document.createElement("span");
              arrow.style.cssText = "margin:0 4px;opacity:0.5;";
              arrow.textContent = "→";
              chain.appendChild(arrow);
            }
            const sel = document.createElement("select");
            sel.name = `trip_${tripIdx}_seg_${segIdx}`;
            sel.style.width = "140px";
            sel.innerHTML = segOptions;
            chain.appendChild(sel);
          }
        });

        // Remove trip
        form.addEventListener("click", (e) => {
          if (e.target.classList.contains("remove-trip")) {
            e.preventDefault();
            e.target.closest(".trip-block").remove();
          }
        });
      },
      buttons: [
        {
          action: "save",
          label: "Save",
          callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object,
        },
        { action: "cancel", label: "Cancel" },
      ],
    });

    if (result === "cancel" || !result) return;

    // Reconstruct route from flat form data
    const schedule = [];
    // Collect all trip indices from form keys
    const tripIndices = new Set();
    for (const key of Object.keys(result)) {
      const m = key.match(/^trip_(\d+)_/);
      if (m) tripIndices.add(Number(m[1]));
    }

    for (const t of [...tripIndices].sort((a, b) => a - b)) {
      const min = result[`trip_${t}_min`] ?? "0";
      const hour = result[`trip_${t}_hour`] ?? "6";
      let cron;
      if (hasCalendaria) {
        const day = result[`trip_${t}_day`] ?? "*";
        const month = result[`trip_${t}_month`] ?? "*";
        const weekday = result[`trip_${t}_weekday`] ?? "*";
        cron = `${min} ${hour} ${day} ${month} ${weekday}`;
      } else {
        const offset = result[`trip_${t}_offset`] ?? "0";
        cron = offset && offset !== "0" ? `${min} ${hour} ${offset}` : `${min} ${hour}`;
      }

      const routeNum = result[`trip_${t}_routeNum`];
      const direction = result[`trip_${t}_dir`] ?? "outbound";

      // Collect segments for this trip
      const segments = [];
      for (let s = 0; ; s++) {
        const segId = result[`trip_${t}_seg_${s}`];
        if (!segId) break;
        segments.push({ segmentId: segId });
      }

      schedule.push({
        cron,
        routeNumbers: routeNum != null && routeNum !== "" ? [routeNum] : [],
        direction,
        segments,
      });
    }

    const routeType = result.type === "wander" ? "wander" : undefined;

    // Reconstruct network config for wandering routes
    let network;
    if (routeType === "wander") {
      const segments = [];
      for (const key of Object.keys(result)) {
        const m = key.match(/^network_seg_(.+)$/);
        if (m && result[key]) segments.push(m[1]);
      }
      const weights = {};
      for (const key of Object.keys(result)) {
        const m = key.match(/^network_weight_(.+)$/);
        if (m) {
          const w = Number(result[key]);
          if (w > 0) weights[m[1]] = w;
        }
      }
      network = {
        startStation: result.network_startStation || "",
        segments,
        maxHours: Number(result.network_maxHours) || 0,
        weights,
      };
    }

    const route = {
      id: result.id || foundry.utils.randomID(),
      name: result.name,
      actorId: result.actorId || undefined,
      useActorSpeed: !!result.useActorSpeed,
      nameTemplate: result.nameTemplate || "[[name]] [[routeNum]]",
      schedule,
      ...(routeType && { type: routeType }),
      ...(network && { network }),
    };
    if (!route.actorId) {
      ui.notifications.warn("No actor selected — this route will not produce tokens.");
    }

    if (isEdit) {
      await api.updateRoute(routeId, route);
      ui.notifications.info(`Route "${route.name}" updated.`);
    } else {
      await api.addRoute(route);
      ui.notifications.info(`Route "${route.name}" created.`);
    }
  },

  /** Open a dialog listing all routes with New/Edit/Delete actions. */
  async routeListDialog() {
    const routes = game.settings.get(MODULE_ID, "routes");

    let rows = "";
    for (const r of routes) {
      const normalized = normalizeSchedule(r);
      let tripCount;
      let schedSummary;
      if (r.type === "wander") {
        const net = r.network ?? {};
        const destCount = Object.values(net.weights ?? {}).filter((w) => w > 0).length;
        tripCount = "Wander";
        schedSummary = `From ${net.startStation || "?"}, ${destCount} destination${destCount !== 1 ? "s" : ""}, ${(net.segments ?? []).length} segment${(net.segments ?? []).length !== 1 ? "s" : ""}`;
        if (net.maxHours > 0) schedSummary += `, max ${net.maxHours}h`;
      } else {
        tripCount = normalized.schedule.length;
        schedSummary = normalized.schedule
          .map((t) => {
            const desc = describeCronExpression(t.cron, !!getCalendaria(), getCalendarInfo());
            let dirLabel;
            try {
              const path = resolveRouteWithDrawings({ segments: t.segments }, game.time.worldTime);
              const compass = getPathCompassLabels(path);
              dirLabel = compass?.[t.direction ?? "outbound"];
            } catch {
              /* ignore */
            }
            if (!dirLabel) {
              dirLabel = t.direction === "return" ? "Return" : t.direction === "roundtrip" ? "Round trip" : "Outbound";
            }
            return `${dirLabel} ${desc}`;
          })
          .join("; ");
      }
      rows += `
        <tr>
          <td>${r.name || "Unnamed Route"}</td>
          <td>${r.actorId ? (game.actors.get(r.actorId)?.name ?? "Unknown Actor") : "No actor"}</td>
          <td>${tripCount}</td>
          <td>${schedSummary || "—"}</td>
          <td style="white-space:nowrap;">
            <button type="button" class="route-edit" data-id="${r.id}">Edit</button>
            <button type="button" class="route-delete" data-id="${r.id}" data-name="${r.name || ""}">Delete</button>
          </td>
        </tr>`;
    }

    if (routes.length === 0) {
      rows = `<tr><td colspan="5" style="text-align:center;font-style:italic;">No routes configured. Create an Actor to represent your train first, then add a route.</td></tr>`;
    }

    const content = `
      <style>${TABLE_ROW_STYLES}</style>
      <table class="rail-table" style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid var(--color-border-light);">
            <th style="text-align:left;">Route</th>
            <th style="text-align:left;">Actor</th>
            <th>Trips</th>
            <th style="text-align:left;">Schedule</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    const result = await foundry.applications.api.DialogV2.wait({
      id: "rail-network-route-list",
      window: { title: "Rail Network — Manage Routes" },
      content,
      position: { width: 600, left: 200, top: 100 },
      render: (event, dialog) => {
        const el = dialog.element;
        if (!el) return;

        el.querySelectorAll(".route-edit").forEach((btn) => {
          btn.addEventListener("click", async () => {
            await dialog.close();
            await api.routeEditDialog(btn.dataset.id);
            api.routeListDialog();
          });
        });

        el.querySelectorAll(".route-delete").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const confirmed = await foundry.applications.api.DialogV2.confirm({
              window: { title: "Confirm Delete" },
              content: `<p>Delete route <b>${btn.dataset.name || btn.dataset.id}</b> and all its events?</p>`,
            });
            if (!confirmed) return;
            await dialog.close();
            await api.removeRoute(btn.dataset.id);
            ui.notifications.info(`Route "${btn.dataset.name || btn.dataset.id}" deleted.`);
            api.routeListDialog();
          });
        });
      },
      buttons: [
        {
          action: "new",
          label: "New Route",
          callback: () => "new",
        },
        { action: "close", label: "Close" },
      ],
    });

    if (result === "new") {
      await api.routeEditDialog();
      api.routeListDialog();
    }
  },

  /** Open a dialog showing the current configuration as editable JSON. */
  async configDialog() {
    const content = `
      <div style="display:flex;flex-direction:column;height:100%;">
        <label style="margin-bottom:6px;">
          <input type="checkbox" name="includeSegments" checked />
          Include scene segment geometry
        </label>
        <textarea name="json" style="font-family:monospace;font-size:12px;white-space:pre;tab-size:2;resize:vertical;min-height:450px;"
        ></textarea>
      </div>`;
    const result = await foundry.applications.api.DialogV2.wait({
      id: "rail-network-config-json",
      window: { title: "Rail Network — Configuration JSON" },
      content,
      position: { width: 700, height: 600 },
      render: (_event, dialog) => {
        const ta = dialog.element.querySelector("textarea[name=json]");
        const cb = dialog.element.querySelector("input[name=includeSegments]");
        ta.value = buildConfigJson(cb.checked);
        cb.addEventListener("change", () => {
          ta.value = buildConfigJson(cb.checked);
        });
      },
      buttons: [
        {
          action: "save",
          label: "Save",
          callback: (_event, button) => {
            return button.form.elements.json.value;
          },
        },
        { action: "close", label: "Cancel" },
      ],
    });

    if (result && result !== "close") {
      let parsed;
      try {
        parsed = JSON.parse(result);
      } catch (err) {
        ui.notifications.error(`Invalid JSON: ${err.message}`);
        return;
      }
      try {
        await applyConfig(parsed);
        ui.notifications.info("Rail Network configuration saved.");
      } catch (err) {
        ui.notifications.error(`Import failed: ${err.message}`);
      }
    }
  },

  /** Create hotbar macros in the Macro Directory. */
  async installMacros() {
    const macros = [
      {
        name: "Rail: Manage Routes",
        command: `game.modules.get("${MODULE_ID}").api.routeListDialog()`,
        img: "fa-solid fa-map-signs",
      },
      {
        name: "Rail: Tag Segment",
        command: `game.modules.get("${MODULE_ID}").api.setupDialog()`,
        img: "fa-solid fa-route",
      },
      {
        name: "Rail: Edit Segment",
        command: `game.modules.get("${MODULE_ID}").api.editSegment()`,
        img: "fa-solid fa-pen",
      },
      {
        name: "Rail: Route Status",
        command: `game.modules.get("${MODULE_ID}").api.status()`,
        img: "fa-solid fa-clipboard-list",
      },
      {
        name: "Rail: Event Manager",
        command: `game.modules.get("${MODULE_ID}").api.eventListDialog()`,
        img: "fa-solid fa-calendar-exclamation",
      },
      {
        name: "Rail: Refresh Trains",
        command: `game.modules.get("${MODULE_ID}").api.hardRefresh()`,
        img: "fa-solid fa-train",
      },
    ];
    for (const m of macros) {
      await Macro.create({ name: m.name, type: "script", command: m.command, img: "icons/svg/lightning.svg" });
    }
    ui.notifications.info("Rail Network macros installed.");
  },

  /** Open a dialog with time step and playback controls. */
  async timeControlDialog() {
    function stopPlayback() {
      if (_timePlaybackInterval) {
        clearInterval(_timePlaybackInterval);
        _timePlaybackInterval = null;
      }
    }

    const content = `
      <style>
        .rail-time-controls { display:flex; flex-direction:column; gap:8px; }
        .rail-time-controls .time-display {
          text-align:center; font-size:1.1em; padding:4px;
          background:rgba(0,0,0,0.2); border-radius:4px;
        }
        .rail-time-controls .control-row {
          display:flex; align-items:center; gap:6px;
        }
        .rail-time-controls input[type="number"] {
          width:70px; text-align:center;
          background:rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.3);
        }
        .rail-time-controls select {
          background:rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.3);
        }
        .rail-time-controls button { flex:0 0 auto; }
      </style>
      <div class="rail-time-controls">
        <div class="time-display">
          <span class="rail-time-value">${formatWorldTime(game.time.worldTime)}</span>
        </div>
        <fieldset>
          <legend>Step</legend>
          <div class="control-row">
            <button type="button" class="rail-step-back" title="Step Back"><i class="fa-solid fa-backward-step"></i></button>
            <input type="number" class="rail-step-size" value="10" min="1">
            <select class="rail-step-unit">
              <option value="1">seconds</option>
              <option value="60" selected>minutes</option>
              <option value="3600">hours</option>
            </select>
            <button type="button" class="rail-step-fwd" title="Step Forward"><i class="fa-solid fa-forward-step"></i></button>
          </div>
        </fieldset>
        <fieldset>
          <legend>Playback</legend>
          <div class="control-row">
            <button type="button" class="rail-play-toggle" title="Play"><i class="fa-solid fa-play"></i></button>
            <input type="number" class="rail-play-rate" value="10" min="1">
            <label>seconds/tick</label>
          </div>
        </fieldset>
      </div>
    `;

    stopPlayback();

    await foundry.applications.api.DialogV2.wait({
      id: "rail-network-time-controls",
      window: { title: "Rail Network — Time Controls" },
      content,
      position: { width: 340 },
      render: (_event, dialog) => {
        const el = dialog.element;
        if (!el) return;

        const timeValue = el.querySelector(".rail-time-value");
        const stepSize = el.querySelector(".rail-step-size");
        const stepUnit = el.querySelector(".rail-step-unit");
        const stepBack = el.querySelector(".rail-step-back");
        const stepFwd = el.querySelector(".rail-step-fwd");
        const playToggle = el.querySelector(".rail-play-toggle");
        const playRate = el.querySelector(".rail-play-rate");

        function getStepDelta() {
          return (parseInt(stepSize.value) || 1) * parseInt(stepUnit.value);
        }

        function updateDisplay() {
          timeValue.textContent = formatWorldTime(game.time.worldTime);
        }

        function updatePlayButton() {
          const icon = playToggle.querySelector("i");
          if (_timePlaybackInterval) {
            icon.className = "fa-solid fa-pause";
            playToggle.title = "Pause";
          } else {
            icon.className = "fa-solid fa-play";
            playToggle.title = "Play";
          }
        }

        const hookId = Hooks.on("updateWorldTime", updateDisplay);

        stepBack.addEventListener("click", () => game.time.advance(-getStepDelta()));
        stepFwd.addEventListener("click", () => game.time.advance(getStepDelta()));

        playToggle.addEventListener("click", () => {
          if (_timePlaybackInterval) {
            stopPlayback();
          } else {
            const rate = parseInt(playRate.value) || 10;
            _timePlaybackInterval = setInterval(() => game.time.advance(rate), 1000);
          }
          updatePlayButton();
        });

        // Clean up when dialog closes.
        const observer = new MutationObserver(() => {
          if (!el.isConnected) {
            observer.disconnect();
            Hooks.off("updateWorldTime", hookId);
            stopPlayback();
          }
        });
        observer.observe(el.parentElement ?? document.body, { childList: true });
      },
      buttons: [
        {
          action: "close",
          label: "Close",
        },
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

Hooks.once("init", () => {
  registerSettings();
  game.modules.get(MODULE_ID).api = api;
});

Hooks.once("ready", () => {
  if (game.user.isGM) {
    console.log(`${MODULE_ID} | Rail Network ready`);
  }

  // Socket listener for non-GM clients
  game.socket.on(`module.${MODULE_ID}`, (data) => {
    if (game.user.isGM) return; // GM already fired locally
    Hooks.callAll(`${MODULE_ID}.${data.type}`, ...data.args);
  });

  Hooks.callAll(`${MODULE_ID}.ready`, api);
});

Hooks.on("updateWorldTime", (worldTime, _dt, _options, _userId) => {
  updateAllTrains(worldTime);
});

Hooks.on("canvasReady", () => {
  invalidateCache();
  _intendedPositions.clear();
  if (_timePlaybackInterval) {
    clearInterval(_timePlaybackInterval);
    _timePlaybackInterval = null;
  }
  updateAllTrains(game.time.worldTime);

  // Tag Segment tool: click a drawing on canvas to open the Tag Segment dialog.
  // Remove prior listener to avoid duplicates on scene change.
  // Tag Segment: find drawing under cursor
  const findDrawingAtPos = (pos) =>
    canvas.drawings?.placeables?.find((d) => {
      const bounds = d.bounds;
      return (
        bounds &&
        pos.x >= bounds.x &&
        pos.x <= bounds.x + bounds.width &&
        pos.y >= bounds.y &&
        pos.y <= bounds.y + bounds.height
      );
    });

  const isTagSegmentActive = () =>
    game.user.isGM && ui.controls?.activeControl === MODULE_ID && ui.controls?.activeTool === "tag-segment";

  const clearHoverHighlight = () => {
    if (_tagSegmentHoverHighlight) {
      _tagSegmentHoverHighlight.destroy();
      _tagSegmentHoverHighlight = null;
    }
    _tagSegmentHoveredDrawing = null;
  };

  // Click handler
  if (_tagSegmentHandler) canvas.stage.off("pointerdown", _tagSegmentHandler);
  _tagSegmentHandler = (event) => {
    if (!isTagSegmentActive()) return;
    const pos = event.getLocalPosition(canvas.stage);
    const drawing = findDrawingAtPos(pos);
    if (drawing) {
      event.stopPropagation();
      clearHoverHighlight();
      api.setupDialog(drawing.document);
    }
  };
  canvas.stage.on("pointerdown", _tagSegmentHandler);

  // Hover handler — highlight drawing under cursor
  if (_tagSegmentHoverHandler) canvas.stage.off("pointermove", _tagSegmentHoverHandler);
  _tagSegmentHoverHandler = (event) => {
    if (!isTagSegmentActive()) {
      if (_tagSegmentHoverHighlight) clearHoverHighlight();
      return;
    }
    const pos = event.getLocalPosition(canvas.stage);
    const drawing = findDrawingAtPos(pos);

    if (drawing === _tagSegmentHoveredDrawing) return; // no change
    clearHoverHighlight();
    if (!drawing) return;

    _tagSegmentHoveredDrawing = drawing;
    const doc = drawing.document;
    const points = doc.shape.points;
    if (!points || points.length < 4) return;

    const g = new PIXI.Graphics();
    // Glow layers (wide, transparent → narrow, opaque)
    for (const { width, alpha } of [
      { width: 12, alpha: 0.1 },
      { width: 8, alpha: 0.2 },
      { width: 5, alpha: 0.3 },
    ]) {
      g.lineStyle(width, 0xffcc00, alpha);
      g.moveTo(doc.x + points[0], doc.y + points[1]);
      for (let i = 2; i < points.length; i += 2) g.lineTo(doc.x + points[i], doc.y + points[i + 1]);
    }
    // Core line
    g.lineStyle(3, 0xffcc00, 0.9);
    g.moveTo(doc.x + points[0], doc.y + points[1]);
    for (let i = 2; i < points.length; i += 2) g.lineTo(doc.x + points[i], doc.y + points[i + 1]);
    canvas.controls.addChild(g);
    _tagSegmentHoverHighlight = g;
  };
  canvas.stage.on("pointermove", _tagSegmentHoverHandler);

  // Route Status tool: click a train token or station to see info
  const isStatusActive = () =>
    game.user.isGM && ui.controls?.activeControl === MODULE_ID && ui.controls?.activeTool === "status";

  const clearStatusHighlight = () => {
    if (_statusHoverHighlight) {
      _statusHoverHighlight.destroy();
      _statusHoverHighlight = null;
    }
    _statusHoveredTarget = null;
  };

  // Status click handler
  if (_statusHandler) canvas.stage.off("pointerdown", _statusHandler);
  _statusHandler = (event) => {
    if (!isStatusActive()) return;
    const pos = event.getLocalPosition(canvas.stage);
    const token = findManagedTokenAtPos(pos);
    if (token) {
      event.stopPropagation();
      clearStatusHighlight();
      showTrainInfoDialog(token);
      return;
    }
    const station = findStationAtPos(pos);
    if (station) {
      event.stopPropagation();
      clearStatusHighlight();
      showStationInfoDialog(station);
    }
  };
  canvas.stage.on("pointerdown", _statusHandler);

  // Status hover handler — highlight train tokens and stations
  if (_statusHoverHandler) canvas.stage.off("pointermove", _statusHoverHandler);
  _statusHoverHandler = (event) => {
    if (!isStatusActive()) {
      if (_statusHoverHighlight) clearStatusHighlight();
      return;
    }
    const pos = event.getLocalPosition(canvas.stage);

    // Check managed tokens first (they overlay stations)
    const token = findManagedTokenAtPos(pos);
    if (token) {
      if (_statusHoveredTarget?.type === "train" && _statusHoveredTarget.ref === token) return;
      clearStatusHighlight();
      _statusHoveredTarget = { type: "train", ref: token };
      const b = token.bounds;
      const g = new PIXI.Graphics();
      for (const { width, alpha } of [
        { width: 12, alpha: 0.1 },
        { width: 8, alpha: 0.2 },
        { width: 5, alpha: 0.3 },
      ]) {
        g.lineStyle(width, 0xffcc00, alpha);
        g.drawRect(b.x, b.y, b.width, b.height);
      }
      g.lineStyle(3, 0xffcc00, 0.9);
      g.drawRect(b.x, b.y, b.width, b.height);
      canvas.controls.addChild(g);
      _statusHoverHighlight = g;
      return;
    }

    // Check stations
    const station = findStationAtPos(pos);
    if (station) {
      if (
        _statusHoveredTarget?.type === "station" &&
        _statusHoveredTarget.ref?.stationName === station.stationName &&
        _statusHoveredTarget.ref?.x === station.x &&
        _statusHoveredTarget.ref?.y === station.y
      )
        return;
      clearStatusHighlight();
      _statusHoveredTarget = { type: "station", ref: station };
      const g = new PIXI.Graphics();
      g.beginFill(0xffcc00, 0.1);
      g.drawCircle(station.x, station.y, 20);
      g.endFill();
      g.beginFill(0xffcc00, 0.2);
      g.drawCircle(station.x, station.y, 14);
      g.endFill();
      g.beginFill(0xffcc00, 0.5);
      g.drawCircle(station.x, station.y, 8);
      g.endFill();
      canvas.controls.addChild(g);
      _statusHoverHighlight = g;
      return;
    }

    // Nothing under cursor — clear highlight
    if (_statusHoveredTarget) clearStatusHighlight();
  };
  canvas.stage.on("pointermove", _statusHoverHandler);
});

// Drawing mutation hooks — invalidate cache and reposition tokens
Hooks.on("createDrawing", (drawing, options, userId) => {
  const sid = drawing.flags?.[MODULE_ID]?.segmentId;
  if (sid) {
    invalidateCache(sid);
    updateAllTrains(game.time.worldTime);
  }

  // Auto-open Tag Segment dialog after Draw Track
  if (_awaitingDrawTrack && game.user.isGM && userId === game.user.id) {
    _awaitingDrawTrack = false;
    api.setupDialog(drawing).then(() => {
      ui.controls.render({ control: MODULE_ID });
    });
  }
});

Hooks.on("updateDrawing", (drawing, _change, _options, _userId) => {
  const sid = drawing.flags?.[MODULE_ID]?.segmentId;
  if (sid) {
    invalidateCache(sid);
    updateAllTrains(game.time.worldTime);
  }
});

Hooks.on("deleteDrawing", (drawing, _options, _userId) => {
  const sid = drawing.flags?.[MODULE_ID]?.segmentId;
  if (sid) {
    invalidateCache(sid);
    updateAllTrains(game.time.worldTime);
  }
});

// Handle Draw Track tool activation/deactivation
Hooks.on("activateSceneControls", (app, change) => {
  if (!change.controlChange && !change.toolChange) return;

  // When Draw Track tool is selected, switch to polygon drawing mode
  const isDrawTrack = ui.controls?.activeControl === MODULE_ID && ui.controls?.activeTool === "draw-track";
  if (isDrawTrack && !_awaitingDrawTrack) {
    _awaitingDrawTrack = true;
    ui.controls.render({ control: "drawings", tool: "polygon" });
    return;
  }
  // Clear flag when user switches away from drawings polygon tool
  if (_awaitingDrawTrack) {
    const isDrawingPolygon = ui.controls?.activeControl === "drawings" && ui.controls?.activeTool === "polygon";
    if (!isDrawingPolygon) _awaitingDrawTrack = false;
  }
});

// Scene control buttons (GM only)
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  controls[MODULE_ID] = {
    name: MODULE_ID,
    order: 10,
    title: "Rail Network",
    icon: "fa-solid fa-train",
    tools: {
      status: {
        name: "status",
        order: 1,
        title: "Status (click train or station)",
        icon: "fa-solid fa-clipboard-list",
        // Persistent tool — stays selected so user can click trains/stations
      },
      "draw-track": {
        name: "draw-track",
        order: 2,
        title: "Draw Track",
        icon: "fa-solid fa-draw-polygon",
        // Persistent tool — selecting it switches to polygon drawing mode
      },
      "tag-segment": {
        name: "tag-segment",
        order: 3,
        title: "Tag Segment (click a drawing)",
        icon: "fa-solid fa-route",
        // Persistent tool — stays selected so user can click drawings on the canvas
      },
      routes: {
        name: "routes",
        order: 4,
        title: "Manage Routes",
        icon: "fa-solid fa-map-signs",
        onClick: () => api.routeListDialog(),
        button: true,
      },
      events: {
        name: "events",
        order: 5,
        title: "Event Manager",
        icon: "fa-solid fa-calendar-exclamation",
        onClick: () => api.eventListDialog(),
        button: true,
      },
      refresh: {
        name: "refresh",
        order: 6,
        title: "Refresh Trains",
        icon: "fa-solid fa-train",
        onClick: () => api.refresh(),
        button: true,
      },
      "config-json": {
        name: "config-json",
        order: 7,
        title: "Configuration JSON",
        icon: "fa-solid fa-file-code",
        onClick: () => api.configDialog(),
        button: true,
      },
      "time-controls": {
        name: "time-controls",
        order: 8,
        title: "Time Controls",
        icon: "fa-solid fa-clock",
        onClick: () => api.timeControlDialog(),
        button: true,
        visible: !game.modules.get("calendaria")?.active,
      },
    },
  };
});

// Calendaria integration
Hooks.on("calendaria.eventTriggered", async (note) => {
  if (!game.user.isGM) return;
  const railData = note.flagData?.railNetwork;
  if (!railData) return;

  const event = {
    ...railData,
    startTime: game.time.worldTime,
    endTime: railData.endTime ?? null,
  };

  const id = await api.addEvent(event);
  console.log(`${MODULE_ID} | Calendaria event triggered: ${event.type} (${id})`);
});

Hooks.on("calendaria.ready", () => {
  console.log(`${MODULE_ID} | Calendaria integration available`);
});
