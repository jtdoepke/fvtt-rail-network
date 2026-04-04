# Rail Network

A [Foundry VTT](https://foundryvtt.com/) module that animates train tokens along drawn routes based on in-game time. Trains follow configurable schedules, respond to events (delays, blockages, closures), and optionally integrate with [Sequencer](https://github.com/fantasycalendar/FoundryVTT-Sequencer) and [Calendaria](https://github.com/fantasycalendar/FoundryVTT-Calendaria). Setting-agnostic — works with any game world's rail or transit network.

**Compatibility:** Foundry VTT v13+ (verified on v14)

## Features

- **Time-driven animation** — Token positions computed as a pure function of `game.time.worldTime`. No incremental state. Time reversal (flashbacks, rewinds) works automatically.
- **Configurable schedules** — Daily or multi-day departure intervals with multiple departure times per day.
- **Route chaining** — Combine multiple track segments into a single route with junction handling.
- **Event system** — Delay trains, block tracks, close lines, destroy or halt specific departures, and inject extra unscheduled departures.
- **GM API** — Full scripting interface at `game.railNetwork` for managing routes, events, and tokens.
- **Scene controls** — Toolbar buttons for quick access to refresh, event management, segment tagging, and route status.
- **Custom hooks** — React to train departures, arrivals, delays, and other events from other modules or macros.
- **Optional integrations** — Sequencer for smooth token animation; Calendaria for calendar-triggered rail events.

## Installation

### Manifest URL (recommended)

In Foundry VTT, go to **Add-on Modules > Install Module** and paste:

```
https://github.com/jtdoepke/fvtt-rail-network/releases/latest/download/module.json
```

### Manual

Download `module.zip` from the [latest release](https://github.com/jtdoepke/fvtt-rail-network/releases/latest), extract it into your `Data/modules/rail-network/` directory, and restart Foundry.

## Quick Start

### 1. Draw your tracks

Use the Foundry **Drawing tool** (polygon/polyline) to draw track paths on your scene. Each Drawing represents one track segment — a contiguous section of rail between stations.

### 2. Tag segments

Select a Drawing and click the **Tag Segment** button in the token controls toolbar (or run `game.railNetwork.setupDialog()`). This opens a dialog where you assign a segment ID and configure stations at specific waypoints along the Drawing:

- **Station name** — Display name for the stop
- **Hours from previous** — Travel time from the prior station
- **Dwell minutes** — How long the train waits at this station

### 3. Configure a route

Routes chain one or more segments into a service line. Configure via the API:

```js
const routes = game.settings.get("rail-network", "routes");
routes.push({
  id: "capital-express",
  segments: [
    { segmentId: "northgate-crossing" },
    { segmentId: "crossing-capital" },
  ],
  tokenPrototype: {
    name: "Capital Express",
    texture: { src: "icons/svg/lightning.svg" },
    width: 0.8,
    height: 0.8,
  },
  routeNumbers: [1, 3],          // odd = outbound, even = return
  schedule: {
    intervalDays: 1,              // departs daily
    startDayOffset: 0,
    departureHours: [8, 18],      // 8:00 AM and 6:00 PM
  },
});
await game.settings.set("rail-network", "routes", routes);
```

### 4. Advance time

When `game.time.worldTime` advances (via the clock controls, SmallTime, Simple Calendar, or any time-advancing module), the module automatically spawns train tokens at the correct positions and moves them along the route.

## Configuration

### Drawing Flags

Each tagged Drawing stores its segment config in flags:

```js
drawing.flags["rail-network"] = {
  segmentId: "northgate-crossing",
  stations: [
    { pointIndex: 0, name: "Northgate", dwellMinutes: 0 },
    { pointIndex: 3, name: "Hillford", hoursFromPrev: 1.5, dwellMinutes: 5 },
    { pointIndex: 8, name: "Crossing", hoursFromPrev: 3.2, dwellMinutes: 10 },
  ],
};
```

### Route Config

Routes are stored in the `rail-network.routes` world setting:

| Field | Description |
|-------|-------------|
| `id` | Unique route identifier |
| `segments` | Array of `{ segmentId, effectiveStart? }` — segments chained in order |
| `tokenPrototype` | Token document data (`name`, `texture`, `width`, `height`, etc.) |
| `routeNumbers` | Array of route numbers (odd = outbound, even = return) |
| `schedule.intervalDays` | Days between departures (1 = daily, 3 = every 3 days) |
| `schedule.startDayOffset` | Which day in the cycle has departures |
| `schedule.departureHours` | Array of 24-hour departure times (e.g., `[8, 14, 22]`) |
| `sceneId` | *(optional)* Restrict route to a specific scene |

### Schedule System

Trains depart according to the schedule and remain active for the duration of their journey. Multiple trains can be in transit simultaneously. The engine uses a lookback algorithm to find all departures whose journey window overlaps the current world time.

## Events

Events modify train behavior in real time. Manage them via `game.railNetwork.addEvent()`, `game.railNetwork.eventDialog()`, or the Event Manager toolbar button.

| Type | Target | Effect |
|------|--------|--------|
| `closeLine` | route | No new departures. Active trains halt at the next station. |
| `blockTrack` | route + station | All trains stop at the named station. |
| `delay` | route + departure | Specific departure delayed, with optional recovery (linear or fixed-rate). |
| `destroy` | route + departure | Specific departure removed; token deleted. |
| `halt` | route + departure + station | Specific train stops at named station indefinitely. |
| `extraDeparture` | route + station | Unscheduled departure from a mid-route station. |

### Event Structure

```js
{
  id: "evt-001",
  type: "blockTrack",
  target: {
    routeId: "capital-express",
    stationName: "Hillford",        // for blockTrack, halt, extraDeparture
    departureTime: 1234567890,      // for delay, destroy, halt
  },
  startTime: 1234000000,           // null = always active
  endTime: 1234259200,             // null = permanent
  delayHours: 3,                   // for delay type
  recoveryRate: 0.5,               // for delay type (hours recovered per real hour)
  reason: "Bridge washout",        // optional flavor text
}
```

## GM API

Accessible at `game.railNetwork` (or `game.modules.get("rail-network").api`):

| Method | Description |
|--------|-------------|
| `refresh()` | Force-recalculate all train positions immediately |
| `status()` | Log routes, active departures, tokens, and events to chat |
| `routes()` | List all routes with stations, journey times, and schedules |
| `nextDeparture(routeId)` | Returns `{ routeId, departureTime, inSeconds }` for the next train |
| `addEvent(event)` | Add a rail event, returns the event ID |
| `removeEvent(eventId)` | Remove an event by ID |
| `listEvents(routeId?)` | List events, optionally filtered by route |
| `clearEvents(routeId?)` | Clear events for a route or all routes |
| `scheduleEvent(event, date)` | Create a Calendaria note that triggers a rail event |
| `eventDialog()` | Open the event management dialog |
| `tagSegment(segmentId, stations, drawingId?)` | Tag a Drawing as a track segment |
| `editSegment(segmentId)` | Edit an existing segment's station config |
| `setupDialog(preselectedDoc?)` | Open interactive segment tagging dialog |
| `installMacros()` | Create hotbar macros in the Macro Directory |

## Scene Controls

When logged in as GM, the module adds a **Rail Network** group to the token controls toolbar:

| Button | Icon | Action |
|--------|------|--------|
| Refresh Trains | `fa-train` | Force-recalculate all positions |
| Event Manager | `fa-calendar-exclamation` | Open event creation dialog |
| Tag Segment | `fa-route` | Tag selected Drawing as a track segment |
| Route Status | `fa-clipboard-list` | Post route/train/event summary to chat |

## Custom Hooks

Other modules and macros can react to rail events via these hooks:

| Hook | Arguments | Fires when... |
|------|-----------|---------------|
| `rail-network.trainDeparted` | `routeId, departureTime, stationName, tokenDoc` | A new train is created at its origin station |
| `rail-network.trainArrived` | `routeId, departureTime, stationName, tokenDoc` | A train reaches a station |
| `rail-network.trainCompleted` | `routeId, departureTime, tokenDoc` | A train reaches its final destination |
| `rail-network.trainDelayed` | `routeId, departureTime, delayHours, event` | A delay event affects a train |
| `rail-network.trainDestroyed` | `routeId, departureTime, event` | A destroy event removes a train |
| `rail-network.routeClosed` | `routeId, event` | A closeLine event activates |
| `rail-network.trackBlocked` | `routeId, stationName, event` | A blockTrack event activates |

## Optional Integrations

### Sequencer

When [Sequencer](https://github.com/fantasycalendar/FoundryVTT-Sequencer) is installed, token movement uses smooth `moveTowards` animation instead of Foundry's built-in duration-based animation.

### Calendaria

When [Calendaria](https://github.com/fantasycalendar/FoundryVTT-Calendaria) is installed, you can schedule rail events tied to calendar dates using `game.railNetwork.scheduleEvent(event, date)`. Events trigger automatically when the calendar date is reached.

## Development

### Architecture

The module follows a two-layer architecture:

- **`scripts/engine.mjs`** — Pure computation functions with no Foundry dependency. All state is computed as a function of world time. Fully testable in Node.js.
- **`scripts/integration.mjs`** — Foundry hooks, settings registration, token lifecycle management, GM API, and UI (dialogs, scene controls).

### Running Tests

The engine has 41 tests using Node.js built-in test runner (no dependencies):

```bash
# Run all tests
node --test scripts/engine.test.mjs

# Run a specific test by name
node --test --test-name-pattern="chains two segments" scripts/engine.test.mjs
```

### CI/CD

A tag-triggered GitHub Actions workflow handles releases:

1. On release publish, extracts version from the tag
2. Injects version and download/manifest URLs into `module.json`
3. Creates `module.zip` containing `module.json` + `scripts/`
4. Uploads both `module.json` and `module.zip` to the GitHub Release

### Key Design Principle: Stateless Temporal Queries

All train positions are computed from scratch on every world time update. There is no incremental state to get out of sync. This means:

- Time reversal works automatically (flashbacks, rewinds, calendar adjustments)
- Token reconciliation compares "desired state" vs "actual tokens" on every tick
- The system is deterministic and testable without mocking time progression
