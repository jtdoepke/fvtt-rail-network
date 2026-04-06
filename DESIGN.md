# Rail Network Module Design

A Foundry VTT v13+ module that animates train tokens along routes driven by in-game time. Trains follow drawn paths on the map, run on configurable schedules, and respond to events like delays, track blockages, and line closures. Tested against v13 Build 351 and v14 Build 359.

## Dependencies

- **Foundry VTT v13+** (v13 Build 351, v14 Build 359 tested)
- **Sequencer** module (optional, for smooth animation; falls back to Foundry's built-in token animation)
- **Calendaria** module (optional, for calendar-linked events and time advancement)

## Module Structure

```
fvtt-rail-network/
  module.json                 -- Foundry module manifest
  scripts/
    engine.mjs                -- Pure computation functions (testable without Foundry)
    integration.mjs           -- Foundry hooks, token lifecycle, dialogs, GM API
  lightning-rail.mjs          -- [reference] Original prototype engine
  lightning-rail.test.mjs     -- [reference] Original test suite (41 tests, all passing)
```

### module.json

```json
{
  "id": "rail-network",
  "title": "Rail Network",
  "description": "Animated train tokens that follow drawn routes based on in-game time. Supports schedules, events, and Calendaria integration.",
  "version": "0.1.0",
  "authors": [{ "name": "jtdoepke" }],
  "compatibility": {
    "minimum": "13",
    "verified": "14"
  },
  "esmodules": ["scripts/integration.mjs"],
  "relationships": {
    "optional": [
      { "id": "sequencer", "type": "module" },
      { "id": "calendaria", "type": "module" }
    ]
  }
}
```

Because this is a registered module, the flag scope is `"rail-network"` (the module id). This was validated -- Foundry v13 rejects flag scopes for unregistered modules with `Error: Flag scope "..." is not valid or not currently active`.

## Core Concepts

### Stateless Temporal Queries

All state is computed as a pure function of `game.time.worldTime`. No incremental state is maintained. This means:

- Time reversal (flashbacks, rewinds) works automatically
- The `updateWorldTime` hook handler ignores the sign of `delta` and always does a full recalculation
- Token reconciliation compares "what should exist" vs "what does exist" on every update

### Route Geometry: Chained Drawing Segments

Routes are composed of one or more Foundry Drawings (polygon polylines, `shape.type: "p"`). Each Drawing represents a track segment. Multiple Drawings chain together end-to-end to form a complete route.

This supports:

- **Extending lines over time**: New segments with a future `effectiveStart`
- **Temporary detours**: Segments with both `effectiveStart` and `effectiveEnd`
- **Gradual rail construction**: The Sharn-Flamekeep line could start as Sharn-Wroat, then Wroat-Starilaskur opens months later

If a mid-route segment is inactive (not yet built), the route truncates there. Later segments are unreachable.

### Stations vs Waypoints

Every point in a Drawing's `shape.points` array is a position along the track. The segment's flag metadata identifies which point indices are stations (named stops with travel/dwell times). All other points are pure waypoints for track curves.

### Two-Layer Data Model

- **Scene geometry** (Drawings with flags): Track paths, station positions, waypoint curves
- **Service config** (module settings): Schedules, naming, token prototypes, route numbers

## Data Model

### Drawing Flags

Each Drawing segment is tagged with flags under the module's scope:

```javascript
drawing.flags["rail-network"] = {
  segmentId: "sharn-wroat",
  stations: [
    { pointIndex: 0, name: "Sharn", dwellMinutes: 0 },
    { pointIndex: 3, name: "First Tower", hoursFromPrev: 1.1, dwellMinutes: 5 },
    { pointIndex: 8, name: "Wroat", hoursFromPrev: 6.8, dwellMinutes: 10 },
  ],
};
```

**Station fields:**

- `pointIndex`: Index into the Drawing's `shape.points` flat array (each point is 2 values: x, y)
- `name`: Station display name
- `hoursFromPrev`: Travel time in hours since the previous station (omit for the first station in a route)
- `dwellMinutes`: How long the train stops here (0 for pass-through, 10 typical for a stop)

**Drawing coordinate model** (validated against Foundry v13):

- `shape.points` is a flat array: `[x0, y0, x1, y1, ...]`
- Coordinates are relative to `document.x`, `document.y`
- Absolute position of point i: `{ x: doc.x + points[i*2], y: doc.y + points[i*2+1] }`

**Junction stations** (where two segments meet): The last station of segment A and the first of segment B are the same location. Segment A's last station provides the dwell time (arrival wait). Segment B's first station sets `dwellMinutes: 0` (departure point). The duplicate point is dropped during chaining.

### Route Config

Stored in a module world setting (`rail-network.routes`):

```javascript
{
  id: "sharn-flamekeep",
  segments: [
    { segmentId: "sharn-wroat" },
    { segmentId: "wroat-starilaskur" },
    { segmentId: "starilaskur-flamekeep", effectiveStart: 1235000000 },
  ],
  tokenPrototype: {
    name: "The Orien Express",
    texture: { src: "icons/svg/lightning.svg" },
    width: 0.8,
    height: 0.8,
  },
  routeNumbers: [1, 3],        // odd = outbound; maps 1:1 to departureHours
  schedule: {
    intervalDays: 1,            // 1 = daily, 3 = every 3 days
    startDayOffset: 0,          // which day in the cycle has departures
    departureHours: [14, 22],   // 24h departure times on each run day
  },
  sceneId: "eYKolMv2GHF5fuwC",  // optional: restrict to a specific scene
}
```

**Segment fields:**

- `segmentId`: Matches a Drawing's `rail-network.segmentId` flag
- `effectiveStart`: World timestamp when this segment joins the route (null = always)
- `effectiveEnd`: World timestamp when this segment leaves the route (null = permanent)

**Schedule fields:**

- `intervalDays`: Period of the schedule cycle
- `startDayOffset`: Which day within the cycle has departures (stagger outbound/return)
- `departureHours`: Array of departure times on each run day

Route start/end dates are handled by `closeLine` events, not schedule fields.

**Inline path fallback**: For testing or when no Drawing exists, segments can include an inline `path` array. Drawings take precedence when found:

```javascript
{
  segmentId: "sharn-wroat",
  path: [
    { station: "Sharn", x: 1200, y: 2400, dwellMinutes: 0 },
    { x: 1180, y: 2370 },  // waypoint
    { station: "Wroat", x: 880, y: 1900, hoursFromPrev: 6.8, dwellMinutes: 10 },
  ],
}
```

### Token Flags

System-managed tokens carry flags for identification and reconciliation:

```javascript
token.flags["rail-network"] = {
  managed: true,
  routeId: "sharn-flamekeep",
  departureTime: 1234567890,
};
```

Token name format: `"Route {N} -- {serviceName}"` where N comes from `routeNumbers`. Odd numbers = outbound (away from Passage), even = return, following real-world railway convention.

### Events

Stored in a module world setting (`rail-network.events`). Events are the unified mechanism for modifying train behavior.

```javascript
{
  id: "evt-001",            // auto-generated UUID
  type: "blockTrack",       // event type
  target: {
    routeId: "sharn-flamekeep",
    stationName: "Vathirond",     // for blockTrack, halt
    departureTime: 1234567890,    // for delay, destroy, halt
  },
  startTime: 1234000000,   // null = from epoch / always active
  endTime: 1234259200,     // null = permanent / never expires
  delayHours: 3,           // for delay type
  recoveryRate: 0.5,       // for delay type (hours recovered per hour)
  reason: "Mournland incursion",  // optional flavor text
}
```

An event is **active** when: `(startTime ?? 0) <= worldTime AND (endTime == null || worldTime < endTime)`

**Event types:**

| Type             | Target            | Effect                                                         |
| ---------------- | ----------------- | -------------------------------------------------------------- |
| `closeLine`      | route             | No departures generated. Active trains halt at next station.   |
| `blockTrack`     | route + station   | All trains stop at the named station.                          |
| `delay`          | route + departure | Specific departure delayed by `delayHours`. Supports recovery. |
| `destroy`        | route + departure | Specific departure removed. Token deleted.                     |
| `halt`           | route + departure | Specific train stops at named station with infinite dwell.     |
| `extraDeparture` | route + station   | Unscheduled departure from a mid-route station.                |

**Delay recovery** has three modes:

- **Permanent** (`endTime: null`, no `recoveryRate`): Train runs late forever
- **Linear via endTime**: Delay decreases linearly from `delayHours` to 0 between `startTime` and `endTime`
- **Fixed-rate via recoveryRate**: Delay decreases at `recoveryRate` hours per hour. Takes precedence over `endTime` if both set.

## Engine Functions

All implemented and tested (41 tests passing). See `lightning-rail.mjs` and `lightning-rail.test.mjs`.

| Function                                                          | Purpose                                                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `resolveRoutePath(segments, worldTime)`                           | Chains segment configs with temporal filtering. Drops duplicate junction points.                                            |
| `buildRouteSegments(path)`                                        | Converts resolved path into station-to-station legs with cumulative pixel distances. Returns `{legs, totalJourneySeconds}`. |
| `getTrainPosition(legs, totalJourneySeconds, elapsedSeconds)`     | Walks legs chronologically (dwell then travel), interpolates between waypoints. Returns `{x, y, atStation}` or null.        |
| `findAllActiveDepartures(worldTime, schedule, maxJourneySeconds)` | Lookback algorithm finding all concurrent active trains. Handles multi-day intervals with `startDayOffset`.                 |
| `getActiveEvents(events, routeId, worldTime)`                     | Filters events by route and time window. Handles null startTime/endTime.                                                    |
| `computeEffectiveDelay(event, worldTime)`                         | Computes current delay accounting for linear or fixed-rate recovery.                                                        |
| `findExtraDepartures(activeEvents, worldTime, legs)`              | Finds synthetic departures from extraDeparture events starting at mid-route stations.                                       |

## Foundry Integration Layer

### Hooks

| Hook                        | Signature                            | Purpose                                                                                       |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `init`                      | `()`                                 | Register settings, expose `game.modules.get("rail-network").api`                              |
| `updateWorldTime`           | `(worldTime, dt, options, userId)`   | Main driver: recalculate all positions, reconcile tokens (GM only). Only `worldTime` is used. |
| `canvasReady`               | `(canvas)`                           | Refresh positions on scene load, clear route cache                                            |
| `createDrawing`             | `(drawing, options, userId)`         | Invalidate route geometry cache if Drawing has rail-network flags                             |
| `updateDrawing`             | `(drawing, change, options, userId)` | Invalidate cache and reposition tokens when track Drawing geometry changes                    |
| `deleteDrawing`             | `(drawing, options, userId)`         | Invalidate cache, reposition tokens (truncate routes missing segments)                        |
| `getSceneControlButtons`    | `(controls)`                         | Add Rail Network toolbar group to token controls (GM only)                                    |
| `calendaria.eventTriggered` | `(note)`                             | Process lightning rail calendar events                                                        |
| `calendaria.ready`          | `()`                                 | Confirm Calendaria integration available                                                      |

**Drawing change handling** (inspired by Patrol module): When track Drawings are created, modified, or deleted, the route geometry cache must be invalidated and `updateAllTrains()` re-run. This ensures tokens reposition immediately when a GM edits track geometry, rather than waiting for the next `updateWorldTime` tick.

### Token Lifecycle (`updateAllTrains`)

For each route on each world time update:

1. Find all active departures (accounting for events, closures, blocks)
2. Find all existing managed tokens on the current scene (by `rail-network.managed` flag)
3. **Match** existing tokens to active departures by `departureTime` flag
4. **Create** tokens for unmatched departures at calculated positions
5. **Move** matched tokens to updated positions (animate)
6. **Delete** tokens whose departures are no longer active

Token creation uses `canvas.scene.createEmbeddedDocuments("Token", [...])`. No Actor is created -- tokens are unlinked visual markers. Token data uses `texture: { src: "..." }` for the image and `width`/`height` (grid units) for sizing.

**Grid snapping** (inspired by Patrol module): Token positions should be snapped to the grid via `canvas.grid.getSnappedPoint({x, y})` before placement/movement. This ensures clean visual alignment even when interpolated coordinates fall between grid lines.

### Animation

- **Sequencer available**: `new Sequence().animation().on(placeable).moveTowards({x,y}).moveSpeed(200).play()`
  - Note: `.on()` takes the **placeable** (from `canvas.tokens.get(tokenDoc.id)`), not the document
- **Duration-based** (inspired by Patrol module): `tokenDoc.update({x, y}, {animation: {duration: N}})` where N is milliseconds. Gives precise control over animation timing (e.g., match animation duration to the time delta between world time ticks). Can be passed as context to `scene.updateEmbeddedDocuments("Token", updates, {animation: {duration: N}})` for batch updates.
- **Speed-based fallback**: `tokenDoc.update({x, y}, {animation: {movementSpeed: N}})`
- **Large time jumps** (distance > 2000px): Teleport instantly
- **Skip** if already within 1px of target

**Auto-rotation** (inspired by Patrol module): When `game.settings.get("core", "tokenAutoRotate")` is enabled, train tokens should face their direction of travel. Pass rotation context with movement updates: `context.movement = { [tokenId]: { autoRotate: true } }`. This makes trains visually orient along the track.

### Dialogs

Uses `foundry.applications.api.DialogV2` (validated in v13 and v14). Static convenience methods: `DialogV2.confirm()`, `DialogV2.prompt()`, `DialogV2.input()`, `DialogV2.wait()`.

**Event dialog** (`eventDialog()`):

- Route dropdown, event type dropdown
- Dynamic fields per event type (station selector, departure selector, delay hours, etc.)
- Start/end time fields supporting "now", "none" (null), or specific values
- Optional Calendaria checkbox to create a calendar note

**Segment setup dialog** (`setupDialog()`):

- Drawing selector (or auto-detect from `canvas.drawings.controlled[0]`)
- Segment ID input
- Per-point station configuration (name, hoursFromPrev, dwellMinutes)

### Settings Registration

```javascript
game.settings.register("rail-network", "routes", {
  scope: "world",
  config: false,
  type: Array,
  default: [],
});
game.settings.register("rail-network", "events", {
  scope: "world",
  config: false,
  type: Array,
  default: [],
});
```

`type: Array` works in both v13 and v14 (it's a Function constructor). v14 also accepts `DataField` instances (e.g., `new foundry.fields.ArrayField(...)`) but the Function form is cross-compatible.

### Scene Control Buttons

Inspired by the Patrol module's `getSceneControlButtons` integration. Adds a Rail Network toolbar group to the token controls (GM only):

| Button         | Icon                      | Action                                                  |
| -------------- | ------------------------- | ------------------------------------------------------- |
| Refresh Trains | `fa-train`                | Force-recalculate all positions (`refresh()`)           |
| Event Manager  | `fa-calendar-exclamation` | Open event creation dialog (`eventDialog()`)            |
| Tag Segment    | `fa-route`                | Tag selected Drawing as track segment (`setupDialog()`) |
| Route Status   | `fa-clipboard-list`       | Show all routes, trains, events in chat (`status()`)    |

```javascript
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  controls.push({
    name: "rail-network",
    title: "Rail Network",
    icon: "fa-solid fa-train",
    layer: "tokens",
    tools: [
      /* ... */
    ],
  });
});
```

### Custom Extensibility Hooks

Inspired by Patrol module's pattern of firing custom hooks (`prePatrolAlerted`, `patrolSpotted`, etc.) that other modules can consume or block. Rail-network fires hooks at key train lifecycle events:

| Hook                          | Signature                                         | Purpose                                                               |
| ----------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| `rail-network.trainDeparted`  | `(routeId, departureTime, stationName, tokenDoc)` | Fired when a new train token is created at its origin station         |
| `rail-network.trainArrived`   | `(routeId, departureTime, stationName, tokenDoc)` | Fired when a train reaches a station (during dwell)                   |
| `rail-network.trainCompleted` | `(routeId, departureTime, tokenDoc)`              | Fired when a train reaches its final destination and token is deleted |
| `rail-network.trainDelayed`   | `(routeId, departureTime, delayHours, event)`     | Fired when a delay event affects a train                              |
| `rail-network.trainDestroyed` | `(routeId, departureTime, event)`                 | Fired when a destroy event removes a train                            |
| `rail-network.routeClosed`    | `(routeId, event)`                                | Fired when a closeLine event activates                                |
| `rail-network.trackBlocked`   | `(routeId, stationName, event)`                   | Fired when a blockTrack event activates                               |

These hooks enable other modules to react to train events -- e.g., a weather module could trigger delays, a combat module could spawn encounters at stations, or a notification module could announce arrivals to players.

**Pre-hooks pattern**: For hooks where cancellation makes sense (e.g., `rail-network.preTrainDeparted`), return `false` from the hook handler to block the action. This follows Foundry's convention for `pre`-prefixed hooks.

### Multi-Client Synchronization

Token document updates (create, move, delete) propagate automatically to all clients via Foundry's built-in document synchronization. No custom socket communication is needed for core train movement.

However, custom hooks (see above) only fire on the GM client that performs the update. If non-GM clients need to react to train events (e.g., display a notification when a train arrives at a player's location), the module should relay these via `game.socket`:

```javascript
// GM client: after firing local hook
game.socket.emit("module.rail-network", {
  type: "trainArrived",
  routeId, departureTime, stationName,
});

// All clients: listener registered in init hook
game.socket.on("module.rail-network", (data) => {
  if (data.type === "trainArrived") {
    Hooks.callAll("rail-network.trainArrived", ...);
  }
});
```

This pattern is adapted from the Patrol module's socket framework, which uses `game.socket` to synchronize alert/spotted events across clients.

### GM API

Exposed at `game.modules.get("rail-network").api` and aliased to `game.railNetwork`:

| Method                                        | Description                                             |
| --------------------------------------------- | ------------------------------------------------------- |
| `refresh()`                                   | Force-update all positions now                          |
| `status()`                                    | Log routes, active departures, tokens, events           |
| `routes()`                                    | List all routes with stations, journey times, schedules |
| `nextDeparture(routeId)`                      | When does the next train leave?                         |
| `addEvent(event)`                             | Add an event, returns event ID                          |
| `removeEvent(eventId)`                        | Remove an event by ID                                   |
| `listEvents(routeId?)`                        | List events, optionally filtered by route               |
| `clearEvents(routeId?)`                       | Clear events for a route or all routes                  |
| `scheduleEvent(event, date)`                  | Create a Calendaria note that triggers a rail event     |
| `eventDialog()`                               | Open event management dialog                            |
| `tagSegment(segmentId, stations, drawingId?)` | Tag a Drawing as a track segment                        |
| `editSegment(segmentId)`                      | Edit an existing segment's station config               |
| `setupDialog()`                               | Interactive dialog for tagging Drawings                 |
| `installMacros()`                             | Create hotbar macros in Macro Directory                 |

### Hotbar Macros

| Macro          | Action                                  |
| -------------- | --------------------------------------- |
| Tag Segment    | Select Drawing, tag as track segment    |
| Edit Segment   | Edit stations on a tagged Drawing       |
| Route Status   | Show all routes, trains, events in chat |
| Event Manager  | Open event creation dialog              |
| Refresh Trains | Force-recalculate all positions         |

## Calendaria Integration

When Calendaria is installed, rail events can be linked to calendar dates:

- A Calendaria note with `flagData.railNetwork` triggers the `calendaria.eventTriggered` hook
- The hook persists the event to the world setting with the current world timestamp
- Time reversal filters out events whose `startTime > worldTime` without deleting them
- The system degrades gracefully without Calendaria (updateWorldTime hook still works)

**Note flagData schema:**

```javascript
{
  railNetwork: {
    type: "blockTrack",
    target: { routeId: "sharn-flamekeep", stationName: "Vathirond" },
    delayHours: 6,
    reason: "Mournland incursion",
  },
}
```

## API Validation Results

The following APIs were tested against Foundry VTT v13 Build 351 via browser console and verified against v14 Build 359 source:

| API                                                                                 | Status | Notes                                                                                            |
| ----------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `canvas.drawings.controlled[0]`                                                     | Works  | Returns selected Drawing                                                                         |
| `DrawingDocument.shape.points`                                                      | Works  | Flat array `[x0,y0,x1,y1,...]` relative to `doc.x, doc.y`                                        |
| `doc.setFlag("rail-network", ...)`                                                  | Works  | Requires module to be registered and active                                                      |
| `doc.setFlag("world", ...)`                                                         | Works  | Always available (used for prototyping)                                                          |
| `scene.createEmbeddedDocuments("Token", [...])`                                     | Works  | Returns array of created TokenDocuments                                                          |
| `scene.deleteEmbeddedDocuments("Token", [ids])`                                     | Works  |                                                                                                  |
| `tokenDoc.update({x, y}, {animation: ...})`                                         | Works  | Position doesn't update synchronously -- lags behind animation                                   |
| `canvas.tokens.get(tokenDoc.id)`                                                    | Works  | Returns the placeable (visual object)                                                            |
| `new Sequence().animation().on(placeable).moveTowards({x,y}).moveSpeed(200).play()` | Works  | `.on()` requires placeable, not document                                                         |
| `game.settings.register/get/set`                                                    | Works  | `"world"` scope for settings                                                                     |
| `Hooks.on("updateWorldTime", ...)`                                                  | Works  |                                                                                                  |
| `Hooks.on("calendaria.eventTriggered", ...)`                                        | Works  |                                                                                                  |
| `foundry.applications.api.DialogV2`                                                 | Works  | Constructor + static helpers: `.confirm()`, `.prompt()`, `.input()`, `.wait()`                   |
| `Macro.create()`                                                                    | Works  |                                                                                                  |
| `game.time.worldTime`                                                               | Works  | Returns seconds since epoch                                                                      |
| `CALENDARIA.api`                                                                    | Works  | 175 methods. `getAllNotes` (not `getNotes`), `createNote`, `updateNote`, `deleteNote`, `getNote` |
| `canvas.tokens.placeables.filter(...)`                                              | Works  | Flag-based token lookup                                                                          |

**Key finding**: Token `x`/`y` are integer fields. Token image is `texture: { src: "..." }` (not `img`). Token size is `width`/`height` in grid units (not `scale`). These field names apply to both v13 and v14.

**Key finding**: Flag scope must match a registered module id. World scripts cannot use arbitrary scopes. As a proper module, `"rail-network"` will be a valid scope.

**Key finding**: `token.x`/`token.y` don't update synchronously after `tokenDoc.update()`. The document coordinates lag behind animation. Track intended positions internally.

**Key finding**: Sequencer's `.on()` takes a **placeable** (`canvas.tokens.get(id)`), not a document.

## Example Routes

| Route                    | Service              | Numbers    | Schedule                     | Journey |
| ------------------------ | -------------------- | ---------- | ---------------------------- | ------- |
| Sharn - Flamekeep        | The Orien Express    | 1, 3 (out) | Daily 14:00, 22:00           | ~61.8h  |
| Flamekeep - Sharn        | The Orien Express    | 2, 4 (ret) | Daily 8:00, 20:00            | ~61.8h  |
| Sharn - Fairhaven        | Silver Flame Passage | 5, 7 (out) | Daily 8:00, 20:00            | ~56.2h  |
| Fairhaven - Sharn        | Silver Flame Passage | 6, 8 (ret) | Daily 10:00, 22:00           | ~56.2h  |
| Starilaskur - Korranberg | Zilargo Local        | 11 (out)   | Every 2 days, 10:00          | ~24h    |
| Korranberg - Starilaskur | Zilargo Local        | 12 (ret)   | Every 2 days (offset), 10:00 | ~24h    |
| Rekkenmark - Vedykar     | Karrnath Iron Line   | 21         | Every 3 days, 06:00          | ~30h    |

Odd numbers = away from Passage (House Orien's seat), even = toward Passage.
