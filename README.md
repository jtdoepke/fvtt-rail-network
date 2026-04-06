# Rail Network

A [Foundry VTT](https://foundryvtt.com/) module that animates train tokens along drawn routes based on in-game time. Trains follow configurable schedules, respond to events (delays, blockages, closures), and optionally integrate with [Sequencer](https://github.com/fantasycalendar/FoundryVTT-Sequencer) and [Calendaria](https://github.com/fantasycalendar/FoundryVTT-Calendaria). Setting-agnostic — works with any game world's rail or transit network.

**Compatibility:** Foundry VTT v14+

## Features

- **Time-driven animation** — Token positions computed as a pure function of `game.time.worldTime`. No incremental state. Time reversal (flashbacks, rewinds) works automatically.
- **Actor-based tokens** — Train tokens are created from Actor documents. Any actor can represent a train, with configurable name templates.
- **Cron-based schedules** — Flexible departure schedules using cron expressions, with per-trip direction (outbound, return, round trip) and segment paths.
- **Route chaining** — Combine multiple track segments into a single route with automatic closest-endpoint matching and T-junction support.
- **Event system** — Delay trains, block tracks, close lines, destroy or halt specific departures, and inject extra unscheduled departures.
- **Interactive tools** — Draw Track tool for creating segments, Status tool for clicking trains and stations to view info popups, Tag Segment tool for configuring stations.
- **GM API** — Full scripting interface at `game.railNetwork` for managing routes, events, and tokens. See [API.md](API.md).
- **Custom hooks** — React to train departures, arrivals, delays, and other events from other modules or macros. Notification hooks fire once per state change.
- **Optional integrations** — Sequencer for smooth token animation; Calendaria for calendar-aware scheduling and date formatting.

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

Use the **Draw Track** tool in the Rail Network toolbar (or the Foundry Drawing tool) to draw track paths on your scene. Each Drawing represents one track segment — a contiguous section of rail between stations.

### 2. Tag segments

Select a Drawing and click the **Tag Segment** tool in the Rail Network toolbar (or run `game.railNetwork.setupDialog()`). This opens a dialog where you assign a segment ID and configure stations at specific waypoints along the Drawing:

- **Station name** — Display name for the stop
- **Hours from previous** — Travel time from the prior station
- **Dwell minutes** — How long the train waits at this station

### 3. Configure a route

Click **Manage Routes** in the Rail Network toolbar to open the route management dialog. From there you can create routes, assign actors, define trips with cron schedules, and configure segments.

You can also configure routes via the API:

```js
await game.railNetwork.addRoute({
  name: "Capital Express",
  actorId: "your-actor-id-here",
  nameTemplate: "[[name]] [[routeNum]]",
  schedule: [
    {
      cron: "0 8,18",                    // 8:00 AM and 6:00 PM daily
      direction: "outbound",
      routeNumbers: [1],
      segments: [
        { segmentId: "northgate-crossing" },
        { segmentId: "crossing-capital" },
      ],
    },
    {
      cron: "0 8,18",
      direction: "return",
      routeNumbers: [2],
      segments: [
        { segmentId: "northgate-crossing" },
        { segmentId: "crossing-capital" },
      ],
    },
  ],
});
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
| `id` | Auto-generated unique identifier |
| `name` | Display name for the route |
| `actorId` | Actor document ID used to create train tokens |
| `nameTemplate` | Token name template (e.g., `[[name]] [[routeNum]]`; supports `[[name]]`, `[[actor]]`, `[[routeNum]]`) |
| `schedule` | Array of trip objects (see below) |

Each trip in the `schedule` array:

| Field | Description |
|-------|-------------|
| `cron` | Cron expression for departure times |
| `direction` | `"outbound"`, `"return"`, or `"roundtrip"` |
| `routeNumbers` | Array of route numbers for this trip |
| `segments` | Array of `{ segmentId }` — segments chained in order |

### Cron Schedule Format

Without Calendaria, cron expressions use 2-3 fields: `minute hour [offset]`

| Expression | Meaning |
|------------|---------|
| `0 8` | 8:00 AM daily |
| `0 8,14,22` | 8:00 AM, 2:00 PM, 10:00 PM daily |
| `30 */6` | Every 6 hours at :30 |
| `0 6/48 24` | 6:00 AM every 2 days (48h interval), offset 24h |

With Calendaria installed, full 5-field cron is available: `minute hour day month weekday`

| Expression | Meaning |
|------------|---------|
| `0 6 1 * *` | 6:00 AM on the 1st of every month |
| `0 8 * * 1,5` | 8:00 AM on weekdays 1 and 5 |

Cron field syntax: `*` (every), `1,3,5` (list), `1-5` (range), `*/15` (step), `6/48` (start/step).

## Events

Events modify train behavior in real time. Manage them via the **Event Manager** toolbar button, or programmatically with `game.railNetwork.addEvent()` and the convenience methods `delayTrain()`, `destroyTrain()`, `blockTrack()`.

| Type | Target | Effect |
|------|--------|--------|
| `closeLine` | route | No new departures. Active trains halt at the next station. |
| `blockTrack` | route + station | All trains stop at the named station. |
| `delay` | route + departure | Specific departure delayed, with optional recovery (linear or fixed-rate). |
| `destroy` | route + departure | Specific departure removed; token deleted. |
| `halt` | route + departure + station | Specific train stops at named station indefinitely. |
| `extraDeparture` | route + station | Unscheduled departure from a mid-route station. |

See [API.md](API.md#event-types) for the full event structure and field reference.

## GM API

The API is accessible at `game.railNetwork` (or `game.modules.get("rail-network").api`). Key methods:

| Category | Methods |
|----------|---------|
| **Train Management** | `refresh()`, `hardRefresh()`, `status()` |
| **Routes** | `routes()`, `nextDeparture()`, `addRoute()`, `updateRoute()`, `removeRoute()` |
| **Events** | `addEvent()`, `removeEvent()`, `updateEvent()`, `listEvents()`, `clearEvents()` |
| **Convenience** | `delayTrain()`, `destroyTrain()`, `blockTrack()` |
| **Calendaria** | `scheduleEvent()` |
| **UI Dialogs** | `routeListDialog()`, `routeEditDialog()`, `eventListDialog()`, `eventEditDialog()`, `setupDialog()`, `installMacros()` |

See [API.md](API.md) for detailed method signatures, parameters, and examples.

## Scene Controls

When logged in as GM, the module adds a **Rail Network** group to the token controls toolbar:

| Tool | Icon | Type | Action |
|------|------|------|--------|
| Status | `fa-clipboard-list` | Persistent tool | Click trains or stations on the canvas for contextual info popups |
| Draw Track | `fa-draw-polygon` | Persistent tool | Switch to polygon drawing mode; auto-opens Tag Segment when done |
| Tag Segment | `fa-route` | Persistent tool | Click a drawing to open its segment configuration dialog |
| Manage Routes | `fa-map-signs` | Button | Open the route management dialog |
| Event Manager | `fa-calendar-exclamation` | Button | Open the event management dialog |
| Refresh Trains | `fa-train` | Button | Force-recalculate all train positions |

## Custom Hooks

Other modules and macros can react to rail events. Notification hooks fire once per state change, not on every tick. See [API.md](API.md#hooks) for detailed signatures.

| Hook | Arguments | Fires when... |
|------|-----------|---------------|
| `rail-network.ready` | `api` | Module API is fully initialized |
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

When [Calendaria](https://github.com/fantasycalendar/FoundryVTT-Calendaria) is installed:

- **Full cron support** — 5-field cron expressions with day-of-month, month, and day-of-week fields
- **Calendar-aware formatting** — All times display using the world's calendar (month names, year, proper date format)
- **Event scheduling** — Schedule rail events tied to calendar dates via `game.railNetwork.scheduleEvent()`
- **Duration formatting** — Respects non-standard calendar time units (e.g., worlds with 50-minute hours)

## Development

### Architecture

The module follows a two-layer architecture:

- **`scripts/engine.mjs`** — Pure computation functions with no Foundry dependency. All state is computed as a function of world time. Fully testable in Node.js.
- **`scripts/integration.mjs`** — Foundry hooks, settings registration, token lifecycle management, GM API, and UI (dialogs, scene controls).

### Running Tests

The module has 120 tests (93 engine, 27 integration) using Node.js built-in test runner (no dependencies):

```bash
# Run all tests
npm test

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
