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
  computeDesiredTokens,
} from "./engine.mjs";

const MODULE_ID = "rail-network";

// ---------------------------------------------------------------------------
// Drawing Cache
// ---------------------------------------------------------------------------

/** @type {Map<string, Array>} segmentId → path array */
const _pathCache = new Map();

/** @type {Map<string, {x: number, y: number}>} tokenId → intended position */
const _intendedPositions = new Map();

let _updating = false;
let _pendingWorldTime = null;

function invalidateCache(segmentId) {
  if (segmentId) _pathCache.delete(segmentId);
  else _pathCache.clear();
}

// ---------------------------------------------------------------------------
// Drawing-to-Path Bridge
// ---------------------------------------------------------------------------

/**
 * Resolve a route's full path, preferring Drawing geometry over inline paths.
 * Caches Drawing-derived paths for performance.
 */
function resolveRouteWithDrawings(route, worldTime) {
  const enrichedSegments = route.segments.map(seg => {
    // Check cache first
    if (_pathCache.has(seg.segmentId)) {
      return { ...seg, path: _pathCache.get(seg.segmentId) };
    }

    // Look for a Drawing on the current scene with matching segmentId
    const drawing = canvas.drawings?.placeables?.find(
      d => d.document.flags?.[MODULE_ID]?.segmentId === seg.segmentId
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
    const safeArgs = args.map(a => {
      if (a && typeof a === "object" && a.constructor?.name?.includes("Document")) {
        return a.id; // send ID instead of document
      }
      return a;
    });
    game.socket.emit(`module.${MODULE_ID}`, { type: hookName, args: safeArgs });
  }
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

  try {
    worldTime = worldTime ?? game.time.worldTime;
    const routes = game.settings.get(MODULE_ID, "routes");
    const allEvents = game.settings.get(MODULE_ID, "events");
    const sceneId = canvas.scene.id;

    // Filter routes to those on this scene (or with no sceneId restriction)
    const sceneRoutes = routes.filter(r => !r.sceneId || r.sceneId === sceneId);

    // Get existing managed tokens
    const existingTokens = canvas.scene.tokens.filter(
      t => t.flags?.[MODULE_ID]?.managed
    );
    const existingByKey = new Map();
    for (const t of existingTokens) {
      const key = `${t.flags[MODULE_ID].routeId}::${t.flags[MODULE_ID].departureTime}`;
      existingByKey.set(key, t);
    }

    // Compute desired state for all routes
    const allDesired = [];
    for (const route of sceneRoutes) {
      // Use Drawing-enriched path resolution
      const path = resolveRouteWithDrawings(route, worldTime);
      if (path.length < 2) continue;

      const { legs, totalJourneySeconds } = buildRouteSegments(path);
      if (legs.length === 0) continue;

      const activeEvents = getActiveEvents(allEvents, route.id, worldTime);

      // closeLine → skip entirely
      if (activeEvents.some(e => e.type === "closeLine")) {
        fireHook("routeClosed", route.id, activeEvents.find(e => e.type === "closeLine"));
        continue;
      }

      const scheduled = findAllActiveDepartures(worldTime, route.schedule, totalJourneySeconds);
      const extras = findExtraDepartures(activeEvents, worldTime, legs);
      const allDepartures = [...scheduled, ...extras];
      const proto = route.tokenPrototype;
      const hours = route.schedule.departureHours;

      for (const dep of allDepartures) {
        const { skip, adjustedElapsed } = applyEvents(activeEvents, dep.departureTime, dep.elapsed, legs, worldTime);

        if (skip) {
          fireHook("trainDestroyed", route.id, dep.departureTime,
            activeEvents.find(e => e.type === "destroy" && e.target.departureTime === dep.departureTime));
          continue;
        }

        // Fire delay hook if delayed
        const delayEvt = activeEvents.find(e => e.type === "delay" && e.target.departureTime === dep.departureTime);
        if (delayEvt) {
          fireHook("trainDelayed", route.id, dep.departureTime, computeEffectiveDelay(delayEvt, worldTime), delayEvt);
        }

        // Fire blockTrack hook
        const blockEvt = activeEvents.find(e => e.type === "blockTrack");
        if (blockEvt) {
          fireHook("trackBlocked", route.id, blockEvt.target.stationName, blockEvt);
        }

        const pos = getTrainPosition(legs, totalJourneySeconds, adjustedElapsed);
        if (!pos) continue; // journey complete

        // Determine route number
        let routeNum;
        if (dep.startStationName) {
          routeNum = "X";
        } else {
          const depHour = ((dep.departureTime % 86400) / 3600);
          const hourIdx = hours.indexOf(depHour);
          routeNum = (route.routeNumbers && hourIdx >= 0) ? route.routeNumbers[hourIdx] : "?";
        }

        allDesired.push({
          routeId: route.id,
          departureTime: dep.departureTime,
          name: `Route ${routeNum} -- ${proto.name}`,
          x: pos.x,
          y: pos.y,
          atStation: pos.atStation,
          texture: proto.texture,
          width: proto.width ?? 1,
          height: proto.height ?? 1,
        });
      }
    }

    // Mark desired keys
    const desiredByKey = new Map();
    for (const d of allDesired) {
      desiredByKey.set(`${d.routeId}::${d.departureTime}`, d);
    }

    // Reconcile: create, move, delete
    const toCreate = [];
    const toMove = [];
    const toDelete = [];

    for (const [key, desired] of desiredByKey) {
      const existing = existingByKey.get(key);
      // Grid snap
      let { x, y } = desired;
      if (canvas.grid?.getSnappedPoint) {
        const snapped = canvas.grid.getSnappedPoint({ x, y });
        x = snapped.x;
        y = snapped.y;
      }

      if (!existing) {
        toCreate.push({
          name: desired.name,
          texture: desired.texture,
          width: desired.width,
          height: desired.height,
          x, y,
          flags: {
            [MODULE_ID]: {
              managed: true,
              routeId: desired.routeId,
              departureTime: desired.departureTime,
            },
          },
        });
        fireHook("trainDeparted", desired.routeId, desired.departureTime, desired.atStation, null);
      } else {
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
          fireHook("trainArrived", desired.routeId, desired.departureTime, desired.atStation, existing);
        }
      }
    }

    for (const [key, existing] of existingByKey) {
      if (!desiredByKey.has(key)) {
        toDelete.push(existing.id);
        _intendedPositions.delete(existing.id);
        fireHook("trainCompleted", existing.flags[MODULE_ID].routeId,
          existing.flags[MODULE_ID].departureTime, existing);
      }
    }

    // Execute batch operations
    if (toCreate.length > 0) {
      const created = await canvas.scene.createEmbeddedDocuments("Token", toCreate);
      for (const doc of created) {
        _intendedPositions.set(doc.id, { x: doc.x, y: doc.y });
      }
    }

    if (toDelete.length > 0) {
      await canvas.scene.deleteEmbeddedDocuments("Token", toDelete);
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
          await new Sequence()
            .animation()
            .on(placeable)
            .moveTowards({ x: move.x, y: move.y })
            .moveSpeed(200)
            .play();
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

function formatWorldTime(t) {
  if (t == null) return "—";
  const day = Math.floor(t / 86400);
  const hour = Math.floor((t % 86400) / 3600);
  const min = Math.floor((t % 3600) / 60);
  return `Day ${day}, ${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function buildSegmentOptions(selectedId) {
  const tagged = canvas.drawings?.placeables?.filter(
    d => d.document.flags?.[MODULE_ID]?.segmentId
  ) ?? [];
  return tagged.map(d => {
    const sid = d.document.flags[MODULE_ID].segmentId;
    const sel = sid === selectedId ? " selected" : "";
    return `<option value="${sid}"${sel}>${sid}</option>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// GM API — exposed at game.modules.get("rail-network").api
// ---------------------------------------------------------------------------

const api = {
  /** Force-update all train positions now. */
  refresh() {
    updateAllTrains(game.time.worldTime);
  },

  /** Log routes, active departures, tokens, and events to chat. */
  status() {
    const routes = game.settings.get(MODULE_ID, "routes");
    const events = game.settings.get(MODULE_ID, "events");
    const worldTime = game.time.worldTime;
    const managed = canvas.scene?.tokens?.filter(t => t.flags?.[MODULE_ID]?.managed) ?? [];

    const lines = [`<h3>Rail Network Status</h3>`];
    lines.push(`<b>World Time:</b> ${worldTime} (${Math.floor(worldTime / 86400)}d ${Math.floor((worldTime % 86400) / 3600)}h)`);
    lines.push(`<b>Routes:</b> ${routes.length}`);
    lines.push(`<b>Active Events:</b> ${events.length}`);
    lines.push(`<b>Managed Tokens:</b> ${managed.length}`);

    for (const route of routes) {
      const path = resolveRouteWithDrawings(route, worldTime);
      if (path.length < 2) {
        lines.push(`<br><b>${route.id}:</b> No active path`);
        continue;
      }
      const { legs, totalJourneySeconds } = buildRouteSegments(path);
      const active = getActiveEvents(events, route.id, worldTime);
      const deps = findAllActiveDepartures(worldTime, route.schedule, totalJourneySeconds);
      const stationNames = legs.map(l => l.startStation.station);
      stationNames.push(legs[legs.length - 1].endStation.station);

      lines.push(`<br><b>${route.id}:</b> ${stationNames.join(" → ")}`);
      lines.push(`&nbsp;&nbsp;Journey: ${(totalJourneySeconds / 3600).toFixed(1)}h | Active departures: ${deps.length} | Events: ${active.length}`);
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
    const route = routes.find(r => r.id === routeId);
    if (!route) return null;

    const worldTime = game.time.worldTime;
    const currentDay = Math.floor(worldTime / 86400);
    const { intervalDays, startDayOffset, departureHours } = route.schedule;
    const sortedHours = [...departureHours].sort((a, b) => a - b);

    // Look forward up to intervalDays * 2 to find next run day
    for (let dayOffset = 0; dayOffset <= intervalDays * 2; dayOffset++) {
      const checkDay = currentDay + dayOffset;
      const cycleDelta = checkDay - (startDayOffset ?? 0);
      const mod = ((cycleDelta % intervalDays) + intervalDays) % intervalDays;
      if (mod !== 0) continue;

      for (const hour of sortedHours) {
        const depTime = checkDay * 86400 + hour * 3600;
        if (depTime > worldTime) {
          return { routeId, departureTime: depTime, inSeconds: depTime - worldTime };
        }
      }
    }
    return null;
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
    await game.settings.set(MODULE_ID, "events", events.filter(e => e.id !== eventId));
    updateAllTrains(game.time.worldTime);
  },

  /** List events, optionally filtered by route. */
  listEvents(routeId) {
    const events = game.settings.get(MODULE_ID, "events");
    if (routeId) return events.filter(e => e.target.routeId === routeId);
    return events;
  },

  /** Clear events for a route, or all events if no routeId given. */
  async clearEvents(routeId) {
    if (routeId) {
      const events = game.settings.get(MODULE_ID, "events");
      await game.settings.set(MODULE_ID, "events", events.filter(e => e.target.routeId !== routeId));
    } else {
      await game.settings.set(MODULE_ID, "events", []);
    }
    updateAllTrains(game.time.worldTime);
  },

  /** Update an existing event by ID. */
  async updateEvent(eventId, event) {
    const events = game.settings.get(MODULE_ID, "events");
    const idx = events.findIndex(e => e.id === eventId);
    if (idx === -1) {
      ui.notifications.warn(`Event "${eventId}" not found.`);
      return;
    }
    events[idx] = { ...event, id: eventId };
    await game.settings.set(MODULE_ID, "events", events);
    updateAllTrains(game.time.worldTime);
  },

  /** Add a route to the world settings. */
  async addRoute(route) {
    const routes = game.settings.get(MODULE_ID, "routes");
    if (!route.id) {
      ui.notifications.warn("Route ID is required.");
      return;
    }
    if (routes.some(r => r.id === route.id)) {
      ui.notifications.warn(`Route "${route.id}" already exists.`);
      return;
    }
    await game.settings.set(MODULE_ID, "routes", [...routes, route]);
    updateAllTrains(game.time.worldTime);
  },

  /** Update an existing route by ID (full replacement). */
  async updateRoute(routeId, route) {
    const routes = game.settings.get(MODULE_ID, "routes");
    const idx = routes.findIndex(r => r.id === routeId);
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
    await game.settings.set(MODULE_ID, "routes", routes.filter(r => r.id !== routeId));
    const events = game.settings.get(MODULE_ID, "events");
    await game.settings.set(MODULE_ID, "events", events.filter(e => e.target.routeId !== routeId));
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

    const existing = eventId
      ? game.settings.get(MODULE_ID, "events").find(e => e.id === eventId)
      : null;
    const isEdit = !!existing;

    const routeOptions = routes.map(r => {
      const sel = r.id === existing?.target?.routeId ? " selected" : "";
      return `<option value="${r.id}"${sel}>${r.id}</option>`;
    }).join("");

    const eventTypes = ["closeLine", "blockTrack", "delay", "destroy", "halt", "extraDeparture"];
    const typeOptions = eventTypes.map(t => {
      const sel = t === existing?.type ? " selected" : "";
      return `<option value="${t}"${sel}>${t}</option>`;
    }).join("");

    const hasCalendaria = game.modules.get("calendaria")?.active;

    const formatTime = (t) => {
      if (t == null) return "none";
      return String(t);
    };

    const content = `
      <form>
        <div class="form-group">
          <label>Route</label>
          <select name="routeId">${routeOptions}</select>
        </div>
        <div class="form-group">
          <label>Event Type</label>
          <select name="type">${typeOptions}</select>
        </div>
        <div class="form-group">
          <label>Station Name</label>
          <input type="text" name="stationName" value="${existing?.target?.stationName ?? ""}" placeholder="For blockTrack, halt, extraDeparture">
        </div>
        <div class="form-group">
          <label>Departure Time</label>
          <input type="number" name="departureTime" value="${existing?.target?.departureTime ?? ""}" placeholder="For delay, destroy, halt">
        </div>
        <div class="form-group">
          <label>Delay Hours</label>
          <input type="number" name="delayHours" step="0.1" value="${existing?.delayHours ?? ""}" placeholder="For delay type">
        </div>
        <div class="form-group">
          <label>Recovery Rate</label>
          <input type="number" name="recoveryRate" step="0.1" value="${existing?.recoveryRate ?? ""}" placeholder="Hours recovered per hour">
        </div>
        <div class="form-group">
          <label>Start Time</label>
          <input type="text" name="startTime" value="${isEdit ? formatTime(existing.startTime) : "now"}" placeholder="'now', 'none', or timestamp">
        </div>
        <div class="form-group">
          <label>End Time</label>
          <input type="text" name="endTime" value="${formatTime(existing?.endTime)}" placeholder="'none' or timestamp">
        </div>
        <div class="form-group">
          <label>Reason</label>
          <input type="text" name="reason" value="${existing?.reason ?? ""}" placeholder="Optional flavor text">
        </div>
        ${hasCalendaria && !isEdit ? `<div class="form-group">
          <label>Create Calendaria Note</label>
          <input type="checkbox" name="calendaria">
        </div>` : ""}
      </form>
    `;

    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: isEdit ? `Rail Network — Edit Event: ${eventId}` : "Rail Network — Create Event" },
      content,
      buttons: [
        {
          action: "save",
          label: isEdit ? "Save" : "Create Event",
          callback: (event, button) => new FormDataExtended(button.form).object,
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
      const target = [e.target.routeId];
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
      <table style="width:100%;border-collapse:collapse;font-size:0.9em;">
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
      window: { title: "Rail Network — Event Manager" },
      content,
      position: { width: 700 },
      render: (event, dialog) => {
        const el = dialog.element;
        if (!el) return;

        el.querySelectorAll(".evt-edit").forEach(btn => {
          btn.addEventListener("click", async () => {
            await dialog.close();
            await api.eventEditDialog(btn.dataset.id);
            api.eventListDialog();
          });
        });

        el.querySelectorAll(".evt-delete").forEach(btn => {
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
    const drawing = drawingId
      ? canvas.scene.drawings.get(drawingId)
      : canvas.drawings.controlled[0]?.document;

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
    const drawing = canvas.drawings?.placeables?.find(
      d => d.document.flags?.[MODULE_ID]?.segmentId === segmentId
    );
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
    const stationMap = new Map(existingStations.map(s => [s.pointIndex, s]));

    let pointRows = "";
    for (let i = 0; i < numPoints; i++) {
      const absX = Math.round(doc.x + points[i * 2]);
      const absY = Math.round(doc.y + points[i * 2 + 1]);
      const existing = stationMap.get(i);
      const checked = existing ? "checked" : "";
      const name = existing?.name ?? "";
      const hours = existing?.hoursFromPrev ?? "";
      const dwell = existing?.dwellMinutes ?? "";

      pointRows += `
        <tr>
          <td>${i}</td>
          <td>(${absX}, ${absY})</td>
          <td><input type="checkbox" name="isStation_${i}" ${checked}></td>
          <td><input type="text" name="name_${i}" value="${name}" size="12"></td>
          <td><input type="number" name="hours_${i}" value="${hours}" step="0.1" size="6"></td>
          <td><input type="number" name="dwell_${i}" value="${dwell}" step="1" size="4"></td>
        </tr>
      `;
    }

    const content = `
      <form>
        <div class="form-group">
          <label>Segment ID</label>
          <input type="text" name="segmentId" value="${existingFlags.segmentId ?? ""}" required>
        </div>
        <table>
          <thead>
            <tr><th>#</th><th>Position</th><th>Station?</th><th>Name</th><th>Hours from Prev</th><th>Dwell (min)</th></tr>
          </thead>
          <tbody>${pointRows}</tbody>
        </table>
      </form>
    `;

    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: "Rail Network — Tag Segment" },
      content,
      buttons: [
        {
          action: "save",
          label: "Save",
          callback: (event, button) => {
            const fd = new FormDataExtended(button.form);
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
      if (result[`isStation_${i}`]) {
        const station = {
          pointIndex: i,
          name: result[`name_${i}`] || `Point ${i}`,
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
    const existing = routeId ? routes.find(r => r.id === routeId) : null;
    const isEdit = !!existing;

    const segOptions = buildSegmentOptions();

    // Build initial departure hour rows
    const depHours = existing?.schedule?.departureHours ?? [];
    const routeNums = existing?.routeNumbers ?? [];
    let depRows = "";
    for (let i = 0; i < depHours.length; i++) {
      depRows += `
        <div class="dep-row" style="display:flex;gap:4px;margin-bottom:4px;">
          <input type="number" name="depHour_${i}" value="${depHours[i]}" step="0.5" min="0" max="24" style="width:80px;" placeholder="Hour">
          <input type="number" name="routeNum_${i}" value="${routeNums[i] ?? ""}" style="width:70px;" placeholder="Route #">
          <button type="button" class="remove-row" style="flex:0 0 auto;">✕</button>
        </div>`;
    }

    // Build initial segment rows
    const segs = existing?.segments ?? [];
    let segRows = "";
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      // Include existing segmentId as option even if not on current scene
      const opts = segOptions.includes(`value="${s.segmentId}"`)
        ? segOptions.replace(`value="${s.segmentId}"`, `value="${s.segmentId}" selected`)
        : `<option value="${s.segmentId}" selected>${s.segmentId}</option>` + segOptions;
      segRows += `
        <div class="seg-row" style="display:flex;gap:4px;margin-bottom:4px;flex-wrap:wrap;">
          <select name="seg_${i}_id" style="width:160px;">${opts}</select>
          <input type="number" name="seg_${i}_start" value="${s.effectiveStart ?? ""}" style="width:120px;" placeholder="Effective start">
          <input type="number" name="seg_${i}_end" value="${s.effectiveEnd ?? ""}" style="width:120px;" placeholder="Effective end">
          <button type="button" class="remove-row" style="flex:0 0 auto;">✕</button>
        </div>`;
    }

    const content = `
      <form>
        <div class="form-group">
          <label>Route ID</label>
          <input type="text" name="id" value="${existing?.id ?? ""}" ${isEdit ? "readonly" : ""} required>
        </div>
        <div class="form-group">
          <label>Scene ID (optional)</label>
          <input type="text" name="sceneId" value="${existing?.sceneId ?? ""}" placeholder="Leave empty for all scenes">
        </div>

        <h3 style="border-bottom:1px solid var(--color-border-light);padding-bottom:4px;">Token Prototype</h3>
        <div class="form-group">
          <label>Service Name</label>
          <input type="text" name="proto_name" value="${existing?.tokenPrototype?.name ?? ""}" required>
        </div>
        <div class="form-group">
          <label>Texture Path</label>
          <input type="text" name="proto_texture" value="${existing?.tokenPrototype?.texture?.src ?? "icons/svg/lightning.svg"}">
        </div>
        <div class="form-group" style="display:flex;gap:8px;">
          <div style="flex:1;">
            <label>Width</label>
            <input type="number" name="proto_width" value="${existing?.tokenPrototype?.width ?? 0.8}" step="0.1" min="0.1">
          </div>
          <div style="flex:1;">
            <label>Height</label>
            <input type="number" name="proto_height" value="${existing?.tokenPrototype?.height ?? 0.8}" step="0.1" min="0.1">
          </div>
        </div>

        <h3 style="border-bottom:1px solid var(--color-border-light);padding-bottom:4px;">Schedule</h3>
        <div class="form-group" style="display:flex;gap:8px;">
          <div style="flex:1;">
            <label>Interval (days)</label>
            <input type="number" name="sched_intervalDays" value="${existing?.schedule?.intervalDays ?? 1}" min="1">
          </div>
          <div style="flex:1;">
            <label>Start Day Offset</label>
            <input type="number" name="sched_startDayOffset" value="${existing?.schedule?.startDayOffset ?? 0}" min="0">
          </div>
        </div>

        <h3 style="border-bottom:1px solid var(--color-border-light);padding-bottom:4px;">
          Departure Hours
          <button type="button" data-action="add-departure" style="float:right;">+ Add</button>
        </h3>
        <div class="departure-hours">${depRows}</div>

        <h3 style="border-bottom:1px solid var(--color-border-light);padding-bottom:4px;">
          Segments
          <button type="button" data-action="add-segment" style="float:right;">+ Add</button>
        </h3>
        <div class="segments-list">${segRows}</div>
      </form>
    `;

    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: isEdit ? `Rail Network — Edit Route: ${routeId}` : "Rail Network — New Route" },
      content,
      position: { width: 560 },
      render: (event, dialog) => {
        const form = dialog.element.querySelector("form");
        if (!form) return;

        // Add departure hour row
        form.querySelector("[data-action='add-departure']")?.addEventListener("click", (e) => {
          e.preventDefault();
          const container = form.querySelector(".departure-hours");
          const idx = container.querySelectorAll(".dep-row").length;
          const row = document.createElement("div");
          row.className = "dep-row";
          row.style.cssText = "display:flex;gap:4px;margin-bottom:4px;";
          row.innerHTML = `
            <input type="number" name="depHour_${idx}" step="0.5" min="0" max="24" style="width:80px;" placeholder="Hour">
            <input type="number" name="routeNum_${idx}" style="width:70px;" placeholder="Route #">
            <button type="button" class="remove-row" style="flex:0 0 auto;">✕</button>`;
          container.appendChild(row);
        });

        // Add segment row
        form.querySelector("[data-action='add-segment']")?.addEventListener("click", (e) => {
          e.preventDefault();
          const container = form.querySelector(".segments-list");
          const idx = container.querySelectorAll(".seg-row").length;
          const row = document.createElement("div");
          row.className = "seg-row";
          row.style.cssText = "display:flex;gap:4px;margin-bottom:4px;flex-wrap:wrap;";
          row.innerHTML = `
            <select name="seg_${idx}_id" style="width:160px;">${segOptions}</select>
            <input type="number" name="seg_${idx}_start" style="width:120px;" placeholder="Effective start">
            <input type="number" name="seg_${idx}_end" style="width:120px;" placeholder="Effective end">
            <button type="button" class="remove-row" style="flex:0 0 auto;">✕</button>`;
          container.appendChild(row);
        });

        // Remove row (delegated)
        form.addEventListener("click", (e) => {
          if (e.target.classList.contains("remove-row")) {
            e.preventDefault();
            e.target.closest(".dep-row, .seg-row").remove();
          }
        });
      },
      buttons: [
        {
          action: "save",
          label: "Save",
          callback: (event, button) => new FormDataExtended(button.form).object,
        },
        { action: "cancel", label: "Cancel" },
      ],
    });

    if (result === "cancel" || !result) return;

    // Reconstruct nested route object from flat form data
    const departureHours = [];
    const routeNumbers = [];
    const segments = [];

    for (const [key, val] of Object.entries(result)) {
      if (key.startsWith("depHour_") && val != null && val !== "") {
        const i = Number(key.split("_")[1]);
        departureHours.push({ i, hour: Number(val), num: result[`routeNum_${i}`] });
      }
      const segMatch = key.match(/^seg_(\d+)_id$/);
      if (segMatch && val) {
        const i = Number(segMatch[1]);
        const seg = { segmentId: val };
        if (result[`seg_${i}_start`]) seg.effectiveStart = Number(result[`seg_${i}_start`]);
        if (result[`seg_${i}_end`]) seg.effectiveEnd = Number(result[`seg_${i}_end`]);
        segments.push({ i, ...seg });
      }
    }

    // Sort by original index to preserve order
    departureHours.sort((a, b) => a.i - b.i);
    segments.sort((a, b) => a.i - b.i);

    const route = {
      id: result.id,
      segments: segments.map(({ i, ...s }) => s),
      tokenPrototype: {
        name: result.proto_name,
        texture: { src: result.proto_texture || "icons/svg/lightning.svg" },
        width: Number(result.proto_width) || 0.8,
        height: Number(result.proto_height) || 0.8,
      },
      routeNumbers: departureHours.map(d => (d.num != null && d.num !== "") ? Number(d.num) : undefined),
      schedule: {
        intervalDays: Number(result.sched_intervalDays) || 1,
        startDayOffset: Number(result.sched_startDayOffset) || 0,
        departureHours: departureHours.map(d => d.hour),
      },
    };
    if (result.sceneId) route.sceneId = result.sceneId;

    if (isEdit) {
      await api.updateRoute(routeId, route);
      ui.notifications.info(`Route "${routeId}" updated.`);
    } else {
      await api.addRoute(route);
      ui.notifications.info(`Route "${route.id}" created.`);
    }
  },

  /** Open a dialog listing all routes with New/Edit/Delete actions. */
  async routeListDialog() {
    const routes = game.settings.get(MODULE_ID, "routes");

    let rows = "";
    for (const r of routes) {
      const segCount = r.segments?.length ?? 0;
      const hours = r.schedule?.departureHours?.map(h => `${h}:00`).join(", ") ?? "—";
      const interval = r.schedule?.intervalDays === 1 ? "Daily" : `Every ${r.schedule?.intervalDays ?? "?"}d`;
      rows += `
        <tr>
          <td>${r.id}</td>
          <td>${r.tokenPrototype?.name ?? "—"}</td>
          <td>${segCount}</td>
          <td>${interval} @ ${hours}</td>
          <td style="white-space:nowrap;">
            <button type="button" class="route-edit" data-id="${r.id}">Edit</button>
            <button type="button" class="route-delete" data-id="${r.id}">Delete</button>
          </td>
        </tr>`;
    }

    if (routes.length === 0) {
      rows = `<tr><td colspan="5" style="text-align:center;font-style:italic;">No routes configured.</td></tr>`;
    }

    const content = `
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid var(--color-border-light);">
            <th style="text-align:left;">Route ID</th>
            <th style="text-align:left;">Service</th>
            <th>Segs</th>
            <th style="text-align:left;">Schedule</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: "Rail Network — Manage Routes" },
      content,
      position: { width: 600 },
      render: (event, dialog) => {
        const el = dialog.element;
        if (!el) return;

        el.querySelectorAll(".route-edit").forEach(btn => {
          btn.addEventListener("click", async () => {
            await dialog.close();
            await api.routeEditDialog(btn.dataset.id);
            api.routeListDialog();
          });
        });

        el.querySelectorAll(".route-delete").forEach(btn => {
          btn.addEventListener("click", async () => {
            const confirmed = await foundry.applications.api.DialogV2.confirm({
              window: { title: "Confirm Delete" },
              content: `<p>Delete route <b>${btn.dataset.id}</b> and all its events?</p>`,
            });
            if (!confirmed) return;
            await dialog.close();
            await api.removeRoute(btn.dataset.id);
            ui.notifications.info(`Route "${btn.dataset.id}" deleted.`);
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

  /** Create hotbar macros in the Macro Directory. */
  async installMacros() {
    const macros = [
      { name: "Rail: Manage Routes", command: `game.modules.get("${MODULE_ID}").api.routeListDialog()`, img: "fa-solid fa-map-signs" },
      { name: "Rail: Tag Segment", command: `game.modules.get("${MODULE_ID}").api.setupDialog()`, img: "fa-solid fa-route" },
      { name: "Rail: Edit Segment", command: `game.modules.get("${MODULE_ID}").api.editSegment()`, img: "fa-solid fa-pen" },
      { name: "Rail: Route Status", command: `game.modules.get("${MODULE_ID}").api.status()`, img: "fa-solid fa-clipboard-list" },
      { name: "Rail: Event Manager", command: `game.modules.get("${MODULE_ID}").api.eventListDialog()`, img: "fa-solid fa-calendar-exclamation" },
      { name: "Rail: Refresh Trains", command: `game.modules.get("${MODULE_ID}").api.refresh()`, img: "fa-solid fa-train" },
    ];
    for (const m of macros) {
      await Macro.create({ name: m.name, type: "script", command: m.command, img: "icons/svg/lightning.svg" });
    }
    ui.notifications.info("Rail Network macros installed.");
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
});

Hooks.on("updateWorldTime", (worldTime, dt, options, userId) => {
  updateAllTrains(worldTime);
});

Hooks.on("canvasReady", () => {
  invalidateCache();
  _intendedPositions.clear();
  updateAllTrains(game.time.worldTime);
});

// Drawing mutation hooks — invalidate cache and reposition tokens
Hooks.on("createDrawing", (drawing, options, userId) => {
  const sid = drawing.flags?.[MODULE_ID]?.segmentId;
  if (sid) {
    invalidateCache(sid);
    updateAllTrains(game.time.worldTime);
  }
});

Hooks.on("updateDrawing", (drawing, change, options, userId) => {
  const sid = drawing.flags?.[MODULE_ID]?.segmentId;
  if (sid) {
    invalidateCache(sid);
    updateAllTrains(game.time.worldTime);
  }
});

Hooks.on("deleteDrawing", (drawing, options, userId) => {
  const sid = drawing.flags?.[MODULE_ID]?.segmentId;
  if (sid) {
    invalidateCache(sid);
    updateAllTrains(game.time.worldTime);
  }
});

// Scene control buttons (GM only)
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  controls.push({
    name: MODULE_ID,
    title: "Rail Network",
    icon: "fa-solid fa-train",
    layer: "tokens",
    tools: [
      {
        name: "refresh",
        title: "Refresh Trains",
        icon: "fa-solid fa-train",
        onClick: () => api.refresh(),
        button: true,
      },
      {
        name: "routes",
        title: "Manage Routes",
        icon: "fa-solid fa-map-signs",
        onClick: () => api.routeListDialog(),
        button: true,
      },
      {
        name: "events",
        title: "Event Manager",
        icon: "fa-solid fa-calendar-exclamation",
        onClick: () => api.eventListDialog(),
        button: true,
      },
      {
        name: "tag-segment",
        title: "Tag Segment",
        icon: "fa-solid fa-route",
        onClick: () => api.setupDialog(),
        button: true,
      },
      {
        name: "status",
        title: "Route Status",
        icon: "fa-solid fa-clipboard-list",
        onClick: () => api.status(),
        button: true,
      },
    ],
  });
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
