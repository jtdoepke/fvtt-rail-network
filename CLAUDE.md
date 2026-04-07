# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Foundry VTT v14+ module (`rail-network`) that animates train tokens along drawn routes based on in-game time (`game.time.worldTime`). Trains follow configurable schedules, respond to events (delays, blockages, closures), and optionally integrate with the Sequencer and Calendaria modules. Setting-agnostic — works with any game world's rail/transit network.

## Commands

```bash
# Run all tests
npm test

# Run a single test by name
node --test --test-name-pattern="chains two segments" scripts/engine.test.mjs
```

No build step. Tests use Node.js built-in test runner via `node --test`. ESLint + Prettier configured; pre-commit hooks run linting and tests automatically.

## Architecture

### Module structure

```
module.json               — Foundry module manifest (id: "rail-network")
scripts/
  engine.mjs              — Pure computation functions (no Foundry dependency)
  engine.test.mjs         — Engine tests using node:test and node:assert/strict
  integration.mjs         — Foundry hooks, settings, token lifecycle, GM API
  integration.test.mjs    — Integration layer tests (with Foundry mocks)
```

Only `module.json` and `scripts/` are shipped in the release zip.

### Reference files (not part of the module, not included in releases)

- `fvtt_source/` — Gitignored Foundry VTT v13 and v14 source (for API reference)

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

### Dialog table styling

All data tables in dialogs use the shared `TABLE_ROW_STYLES` constant and the `rail-table` CSS class for consistent alternating row contrast. When adding new tables to dialogs, add `class="rail-table"` to the `<table>` element and include `<style>${TABLE_ROW_STYLES}</style>` in the dialog content.

### Coordinate model

Foundry Drawing `shape.points` is a flat array `[x0, y0, x1, y1, ...]` relative to `document.x, document.y`. Absolute position: `{ x: doc.x + points[i*2], y: doc.y + points[i*2+1] }`.

### Junction chaining

When segments chain, the last station of segment A and first of segment B are duplicates at the same position. Segment A's last station provides the dwell time; segment B's first is dropped during `resolveRoutePath`.

### Changelog

Maintain `CHANGELOG.md` using [Keep a Changelog](https://keepachangelog.com/) format. When making user-facing changes, add an entry under `## [Unreleased]` in the appropriate category: Added, Changed, Deprecated, Removed, Fixed, Security.

### Releasing

1. Move the `[Unreleased]` section in `CHANGELOG.md` to a new version heading (e.g. `## [0.0.11] - 2026-04-05`) and add the comparison link at the bottom.
2. Commit the changelog update.
3. Create an annotated git tag with the changelog contents as the message: `git tag -a v0.0.11 -m "$(changelog contents for this version)"`.
4. Push the commit and tag: `git push && git push --tags`.
5. Create a GitHub release: `gh release create v0.0.11 --title "v0.0.11 — Short description" --notes-file -` (pipe the changelog section as notes). The release workflow handles building and uploading the module zip.

### CI/CD

- `.github/workflows/ci.yml` — runs tests on push/PR to `main`
- `.github/workflows/release.yml` — on release publish, injects version + download/manifest URLs into `module.json` via `jq`, zips `module.json` + `scripts/`, and uploads both to the GitHub Release
