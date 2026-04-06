# Rail Network API

The Rail Network module exposes a JavaScript API for other modules and macros to interact with train routes, events, and tokens programmatically.

## Accessing the API

```js
const api = game.modules.get("rail-network").api;
```

The API is available after Foundry's `init` hook. To be notified when the module is fully ready (settings loaded, socket listener active), use the `rail-network.ready` hook:

```js
Hooks.once("rail-network.ready", (api) => {
  // Safe to call api methods here
});
```

## Methods

### Train Management

#### `refresh()`

Force-update all train token positions for the current world time.

```js
api.refresh();
```

#### `hardRefresh()`

Delete all managed tokens and recreate them from scratch. Useful after changing an actor's prototype token configuration.

```js
await api.hardRefresh();
```

#### `status()`

Post a summary of all routes, active departures, tokens, and events to chat (GM whisper).

```js
api.status();
```

### Routes

#### `routes()`

Returns the raw routes array from world settings.

```js
const routes = api.routes();
```

#### `nextDeparture(routeId)`

Find the next scheduled departure for a route, searching up to 7 days ahead.

```js
const next = api.nextDeparture("sharn-flamekeep");
// { routeId: "sharn-flamekeep", departureTime: 439200, inSeconds: 3600 }
// Returns null if no upcoming departure found.
```

#### `addRoute(route)`

Add a new route to world settings.

```js
await api.addRoute({
  name: "Sharn Express",
  actorId: "actorId123",
  schedule: [{ cron: "8 *", segments: ["seg-1", "seg-2"] }],
});
```

#### `updateRoute(routeId, route)`

Replace an existing route by ID (full replacement).

```js
await api.updateRoute("sharn-flamekeep", updatedRoute);
```

#### `removeRoute(routeId)`

Remove a route and all its associated events.

```js
await api.removeRoute("sharn-flamekeep");
```

### Events

#### `addEvent(event)`

Create an event. Auto-generates an `id` if not provided. Returns the event ID.

```js
const eventId = await api.addEvent({
  type: "delay",
  target: { routeId: "sharn-flamekeep", departureTime: 432000 },
  startTime: game.time.worldTime,
  endTime: null,
  delayHours: 2,
  recoveryRate: 0.5,
  reason: "Storm in the Mournland",
});
```

See [Event Types](#event-types) below for all supported types and their fields.

#### `removeEvent(eventId)`

Delete an event by ID.

```js
await api.removeEvent("evt-abc123");
```

#### `updateEvent(eventId, event)`

Replace an event by ID. The original `id` is preserved.

```js
await api.updateEvent("evt-abc123", {
  type: "delay",
  target: { routeId: "sharn-flamekeep", departureTime: 432000 },
  delayHours: 4, // increased from 2
});
```

#### `listEvents(routeId?)`

List all events, optionally filtered by route ID.

```js
const all = api.listEvents();
const routeEvents = api.listEvents("sharn-flamekeep");
```

#### `clearEvents(routeId?)`

Clear events for a specific route, or all events if no route ID given.

```js
await api.clearEvents("sharn-flamekeep"); // clear for one route
await api.clearEvents();                  // clear all
```

### Convenience Methods

These are shorthand wrappers around `addEvent()` with sensible defaults. All return the generated event ID. `startTime` defaults to the current world time.

#### `delayTrain(routeId, departureTime, delayHours, opts?)`

Delay a specific departure.

```js
const eventId = await api.delayTrain("sharn-flamekeep", 432000, 2, {
  recoveryRate: 0.5,  // recover 0.5 hours per hour elapsed
  endTime: null,       // permanent until removed (default)
  reason: "Mechanical failure",
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `startTime` | `number` | `game.time.worldTime` | When the delay takes effect |
| `endTime` | `number\|null` | `null` | When the delay expires (`null` = permanent) |
| `recoveryRate` | `number` | `undefined` | Hours of delay recovered per hour elapsed |
| `reason` | `string` | `undefined` | Flavor text |

#### `destroyTrain(routeId, departureTime, opts?)`

Cancel a specific departure (remove its token).

```js
await api.destroyTrain("sharn-flamekeep", 432000, {
  reason: "Service cancelled",
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `startTime` | `number` | `game.time.worldTime` | When the cancellation takes effect |
| `endTime` | `number\|null` | `null` | When the cancellation expires |
| `reason` | `string` | `undefined` | Flavor text |

#### `blockTrack(routeId, stationName, opts?)`

Hold all trains at a named station.

```js
await api.blockTrack("sharn-flamekeep", "Vathirond", {
  endTime: game.time.worldTime + 7200, // 2 hours
  reason: "Track obstruction",
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `startTime` | `number` | `game.time.worldTime` | When the block takes effect |
| `endTime` | `number\|null` | `null` | When the block is lifted |
| `reason` | `string` | `undefined` | Flavor text |

### Calendaria Integration

#### `scheduleEvent(event, date?)`

Create a Calendaria note that triggers a rail event. Requires the Calendaria module.

```js
await api.scheduleEvent(
  { type: "blockTrack", target: { routeId: "sharn-flamekeep", stationName: "Vathirond" } },
  { year: 998, month: 3, day: 15 }
);
```

### UI Dialogs

#### `routeListDialog()`

Open the route management dialog.

#### `routeEditDialog(routeId?)`

Open the route create/edit dialog. Pass a route ID to edit an existing route.

#### `eventListDialog()`

Open the event management dialog.

#### `eventEditDialog(eventId?)`

Open the event create/edit dialog. Pass an event ID to edit an existing event.

#### `eventDialog()`

Alias for `eventListDialog()`.

#### `installMacros()`

Create hotbar macros in the Macro Directory for common operations.

## Event Types

Events modify train behavior at runtime. All events have:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | auto | Auto-generated unique ID |
| `type` | `string` | yes | One of the types below |
| `target` | `object` | yes | Targeting fields (varies by type) |
| `startTime` | `number\|null` | no | When event activates (`null` = epoch) |
| `endTime` | `number\|null` | no | When event expires (`null` = permanent) |
| `reason` | `string` | no | Flavor text |

An event is **active** when `(startTime ?? 0) <= worldTime` and `(endTime == null || worldTime < endTime)`.

### `closeLine`

Suppress all departures on a route.

| Target Field | Type | Description |
|-------------|------|-------------|
| `routeId` | `string` | Route to close |

### `blockTrack`

Hold all trains at a named station (infinite dwell).

| Target Field | Type | Description |
|-------------|------|-------------|
| `routeId` | `string` | Route affected |
| `stationName` | `string` | Station where trains stop |

### `delay`

Delay a specific departure.

| Target Field | Type | Description |
|-------------|------|-------------|
| `routeId` | `string` | Route affected |
| `departureTime` | `number` | World time of the departure |

| Extra Field | Type | Description |
|------------|------|-------------|
| `delayHours` | `number` | Hours of delay |
| `recoveryRate` | `number` | Hours recovered per hour elapsed (optional) |

**Recovery modes:**
- No `recoveryRate`, no `endTime`: permanent delay.
- `endTime` set: delay decreases linearly to 0 between `startTime` and `endTime`.
- `recoveryRate` set (takes precedence): delay decreases at a fixed rate per hour elapsed.

### `destroy`

Remove a specific departure's token.

| Target Field | Type | Description |
|-------------|------|-------------|
| `routeId` | `string` | Route affected |
| `departureTime` | `number` | World time of the departure |

### `halt`

Stop a specific departure at a named station.

| Target Field | Type | Description |
|-------------|------|-------------|
| `routeId` | `string` | Route affected |
| `departureTime` | `number` | World time of the departure |
| `stationName` | `string` | Station where the train halts |

### `extraDeparture`

Create an unscheduled departure from a mid-route station.

| Target Field | Type | Description |
|-------------|------|-------------|
| `routeId` | `string` | Route to depart on |
| `stationName` | `string` | Station where the extra train starts |

## Hooks

The module fires hooks via `Hooks.callAll()` that other modules can listen to. All hook names are prefixed with `rail-network.`. Non-GM clients receive hooks via socket relay.

### Lifecycle

#### `rail-network.ready`

Fired once when the module is fully initialized.

```js
Hooks.once("rail-network.ready", (api) => {
  // api === game.modules.get("rail-network").api
});
```

### Train Events

These fire during token reconciliation when world time changes.

#### `rail-network.trainDeparted`

A new train token was created on the scene.

```js
Hooks.on("rail-network.trainDeparted", (routeId, departureTime, atStation, tokenDoc) => {
  // routeId: string - route ID
  // departureTime: number - world time of departure
  // atStation: string|null - station name if at a station, null if in transit
  // tokenDoc: TokenDocument - the created token
});
```

#### `rail-network.trainArrived`

A train arrived at a station. Fires once per arrival (deduplicated across ticks).

```js
Hooks.on("rail-network.trainArrived", (routeId, departureTime, stationName, tokenDoc) => {
  // stationName: string - the station the train arrived at
  // tokenDoc: TokenDocument - the train's token
});
```

#### `rail-network.trainCompleted`

A train reached its final destination and its token was removed.

```js
Hooks.on("rail-network.trainCompleted", (routeId, departureTime, tokenDoc) => {
  // tokenDoc: TokenDocument - the token (about to be deleted)
});
```

### Event Notifications

These fire when events affect train behavior. Deduplicated — fires once when the condition becomes true, not on every tick.

#### `rail-network.trainDestroyed`

A destroy event removed a departure.

```js
Hooks.on("rail-network.trainDestroyed", (routeId, departureTime, event) => {});
```

#### `rail-network.trainDelayed`

A delay event is affecting a departure.

```js
Hooks.on("rail-network.trainDelayed", (routeId, departureTime, effectiveDelayHours, event) => {
  // effectiveDelayHours: number - current delay after recovery
});
```

#### `rail-network.trackBlocked`

A blockTrack event is holding trains at a station.

```js
Hooks.on("rail-network.trackBlocked", (routeId, stationName, event) => {});
```

#### `rail-network.routeClosed`

A closeLine event is suppressing all departures on a route.

```js
Hooks.on("rail-network.routeClosed", (routeId, event) => {});
```
