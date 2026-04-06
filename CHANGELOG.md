# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.0.11] - 2026-04-05

### Changed
- Draw Track is now a persistent tool (no orange border) instead of an action button
- Station info dialog: split "Upcoming Arrivals" into separate Upcoming Arrivals and Upcoming Departures sections
- Train info dialog: Station Schedule table now shows Arrival and Departure columns
- Train info dialog: Route field no longer includes the trip ID

### Added
- `rail-network.ready` hook: fires when the module API is available, passing the API object
- Convenience API methods: `delayTrain()`, `destroyTrain()`, `blockTrack()` for ergonomic event injection from other modules
- `trainDeparted` hook now passes the created `TokenDocument` as the 4th argument (was `null`)
- Notification hooks (`trainArrived`, `trainDelayed`, `trackBlocked`, `routeClosed`) now fire once per state change instead of every tick
- Calendaria-aware date/time formatting: when Calendaria is installed, all times use the world's calendar (month names, year, proper date format) instead of generic "Day N, HH:MM"
- Cron schedule descriptions now show calendar month and weekday names when Calendaria is active
- Duration formatting respects non-standard calendar time units (e.g. worlds with 50-minute hours)
- "Post to Chat" button on train and station info dialogs to share status with all players

## [0.0.10] - 2026-04-05

### Changed
- `[[name]]` template variable now refers to the route name (added `[[actor]]` for actor name)
- Existing token names update automatically when route name or template changes
- Refresh Trains macro now performs a hard refresh (delete/recreate all tokens)
- Token display settings (nameplate, disposition, etc.) come from the actor's prototype token config
- Status tool (formerly Route Status): now an interactive canvas tool — click trains or stations for contextual info
- Toolbar reordered: Status, Draw Track, Tag Segment, Manage Routes, Event Manager, Refresh Trains

### Added
- `hardRefresh()` API: deletes and recreates all managed tokens, picking up actor prototype changes
- Draw Track tool: switches to polygon drawing mode, then auto-opens Tag Segment dialog when the drawing is complete
- Tag Segment hover highlight: drawings glow yellow when hovered with the Tag Segment tool active
- Train info popup: shows route, status, next stop, ETA, final destination, and full station schedule
- Station info popup: shows trains currently dwelling and upcoming arrival schedule

## [0.0.9] - 2026-04-05

### Changed
- Route ID is now auto-generated; routes are identified by a user-facing name instead

## [0.0.8] - 2026-04-05

### Changed
- Train tokens are now created from Actor documents — select any actor to represent your train
- Route config uses `actorId` and `nameTemplate` fields (replaces `tokenPrototype`)
- Default name template: `[[name]] [[routeNum]]`
- Module now requires Foundry VTT v14 or later (v13 support dropped)

### Added
- "Delayed" status effect icon displayed on train tokens during active delay events
- Drag-and-drop: drop an actor from the sidebar into the route edit dialog
- Actor dropdown selector with image preview in route edit dialog
- Configurable token name template per route

### Removed
- Foundry VTT v13 support
- `tokenPrototype` field in route config (replaced by `actorId`)

## [0.0.7] - 2026-04-05

### Fixed
- First segment now correctly reversed when its junction with the next segment is at the start rather than the end
- Departure station dwell time zeroed so trains depart on schedule instead of waiting at origin

## [0.0.6] - 2026-04-04

### Changed
- Segment chaining now uses closest-endpoint matching instead of requiring exact position match at segment boundaries
- Segments are auto-oriented based on which ends are closest, so segment order in trip config no longer matters
- Junction dwell time uses the maximum from both connecting segments

### Added
- T-junction support: a segment can connect mid-way along another segment, enabling branching tracks
- `findClosestEndpointPair` and `orientAndSlicePath` engine functions for flexible segment joining

## [0.0.5] - 2026-04-04

### Added
- Tag Segment tool is now a selectable canvas tool — click any drawing to open its Tag Segment dialog
- Direction dropdown shows compass directions (N, S, E, W, NE, etc.) derived from path geometry
- Compass labels update dynamically when segments are changed in the route edit dialog

### Changed
- Tag Segment table inputs have consistent dark background for visibility on alternating row colors

### Fixed
- Multiple trips with the same departure time now correctly produce separate tokens (removed incorrect deduplication)
- Token reconciliation key includes route number to distinguish same-time departures on different trips

## [0.0.4] - 2026-04-04

### Changed
- Tag Segment dialog: removed Station? checkbox — a point is a station if Name is filled in
- Tag Segment dialog: station names displayed in bold when non-empty
- Route edit dialog: expanded cron help text with collapsible syntax guide and examples

### Fixed
- All dialogs now horizontally draggable on Foundry v14 (explicit `left` position prevents NaN drag)
- Tag Segment dialog: scrollbar and constrained height so content doesn't fill the screen
- Tag Segment dialog: point hover highlight on canvas now works correctly on v14
- All dialogs: consistent render callback parameter handling for v14 compatibility

## [0.0.3] - 2026-04-04

### Added
- Cron-based schedule system with support for `*`, commas, ranges, and step expressions
- Travel direction per trip: outbound, return, and round trip
- Per-trip segment paths: different departures on the same route can take different branches
- Live human-readable schedule descriptions in route edit dialog
- Optional Calendaria integration: day-of-month, month, and day-of-week cron fields when Calendaria is active
- Offset field for non-Calendaria schedules (e.g., `0 6/48 24` = 6am every 2 days, offset 24h)

### Changed
- Route data model: `schedule` is now an array of trip objects (cron expression + direction + segments + route numbers)
- Route edit dialog: Schedule/Departure Hours/Segments sections replaced with trip blocks
- Route list: "Segs" column replaced with "Trips" showing cron schedule summaries
- Backward compatible: existing routes with old format are auto-converted on read

### Fixed
- Duplicate dialogs when clicking toolbar buttons multiple times (added dialog IDs)
- FormDataExtended deprecation warning on Foundry v14
- Dialog overflow: scrollbar now appears when content exceeds dialog height
- Removed unused Scene selector from route edit dialog

## [0.0.2] - 2026-04-04

### Fixed
- Scene control toolbar buttons not appearing on Foundry v14 (controls object API change)
- Train tokens now centered on track path instead of offset by top-left corner
- Removed grid snapping for managed train tokens so they follow freeform paths accurately

### Changed
- Tag Segment dialog: sticky column headers, hover-to-highlight points on map, conditional station fields
- Event dialog: fields show/hide based on event type, station name is a dropdown, departure time is a dropdown with readable timestamps
- Route dialog: scene ID is a dropdown, texture path has a file picker, departure hour fields have placeholders, start day offset has a help tooltip
- All dialogs now open scrolled to top

## [0.0.1] - 2026-04-04

### Added
- Pure computation engine for train position interpolation along drawn routes
- Stateless temporal query model — all state derived from `worldTime`
- Schedule system with lookback algorithm for concurrent departures
- Event system (delays, blockages, closures, extra departures)
- Route segment chaining with junction deduplication
- Integration layer with Foundry hooks, settings, token lifecycle, and GM API
- Optional Sequencer and Calendaria module integration
- GitHub Actions release workflow

[Unreleased]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.11...HEAD
[0.0.11]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/jtdoepke/fvtt-rail-network/releases/tag/v0.0.1
