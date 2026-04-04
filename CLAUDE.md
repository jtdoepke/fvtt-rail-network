# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Foundry VTT v13+ module (`rail-network`) that animates train tokens along drawn routes based on in-game time (`game.time.worldTime`). Trains follow configurable schedules, respond to events (delays, blockages, closures), and optionally integrate with the Sequencer and Calendaria modules. Setting-agnostic — works with any game world's rail/transit network.

## Commands

```bash
# Run tests (Node.js test runner, no dependencies needed)
node --test scripts/engine.test.mjs

# Run a single test by name
node --test --test-name-pattern="chains two segments" scripts/engine.test.mjs
```

No build step, no package manager, no linting configured. Tests use top-level `await import("./engine.mjs")` to load the module.

## Architecture

### Module structure

```
module.json               — Foundry module manifest (id: "rail-network")
scripts/
  engine.mjs              — Pure computation functions (no Foundry dependency)
  engine.test.mjs         — 41 tests using node:test and node:assert/strict
  integration.mjs         — Foundry hooks, settings, token lifecycle, GM API (fully implemented)
```

Only `module.json` and `scripts/` are shipped in the release zip.

`DESIGN.md` is the authoritative spec for the full module design including Foundry hooks, token reconciliation, settings, dialogs, and the GM API surface. Consult it before implementing integration layer features.

### Reference files (not part of the module, not included in releases)

- `lightning-rail.mjs` — Original prototype engine (same code as `scripts/engine.mjs`)
- `lightning-rail.test.mjs` — Original test suite (same tests as `scripts/engine.test.mjs`)
- `fvttt_source/` — Gitignored Foundry VTT v13 and v14 source (for API reference)
- `DESIGN.md` — Not shipped in module zip

### Core design principle: Stateless Temporal Queries

All state is computed as a pure function of `worldTime`. No incremental state. Time reversal works automatically — the engine recalculates from scratch on every tick.

### Key data flow

1. **Drawing bridge**: `drawingToPath(doc)` — converts Foundry Drawing geometry + flags into engine path array
2. **Route resolution**: `resolveRoutePath(segments, worldTime)` — chains segment paths with temporal filtering
3. **Leg building**: `buildRouteSegments(path)` — converts path to station-to-station legs with pixel distances
4. **Position**: `getTrainPosition(legs, totalJourneySeconds, elapsed)` — interpolates along waypoints
5. **Scheduling**: `findAllActiveDepartures(worldTime, schedule, maxJourneySeconds)` — lookback algorithm finding all concurrent trains
6. **Events**: `getActiveEvents` → `computeEffectiveDelay` / `findExtraDepartures` — modify train behavior
7. **Event application**: `applyEvents(activeEvents, departureTime, elapsed, legs, worldTime)` — applies destroy/delay/halt/blockTrack to a departure's elapsed time
8. **Orchestration**: `computeDesiredTokens(route, worldTime, allEvents)` — top-level pure function computing all token states for a route

In `integration.mjs`, `resolveRouteWithDrawings()` bridges scene Drawings into the engine by calling `drawingToPath()` for each segment, with a cache layer. `updateAllTrains()` reconciles desired vs existing tokens (create/move/delete).

### Two-layer data model

- **Scene geometry** (Drawing flags under `rail-network` scope): Track paths, station positions, waypoint curves
- **Service config** (module world settings `rail-network.routes` / `rail-network.events`): Schedules, naming, token prototypes

### Coordinate model

Foundry Drawing `shape.points` is a flat array `[x0, y0, x1, y1, ...]` relative to `document.x, document.y`. Absolute position: `{ x: doc.x + points[i*2], y: doc.y + points[i*2+1] }`.

### Junction chaining

When segments chain, the last station of segment A and first of segment B are duplicates at the same position. Segment A's last station provides the dwell time; segment B's first is dropped during `resolveRoutePath`.

### CI/CD

Tag-triggered GitHub Actions workflow (`.github/workflows/release.yml`): on release publish, injects version + download/manifest URLs into `module.json` via `jq`, zips `module.json` + `scripts/`, and uploads both `module.json` and `module.zip` to the GitHub Release.
