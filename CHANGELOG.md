# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.5...HEAD
[0.0.5]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/jtdoepke/fvtt-rail-network/releases/tag/v0.0.1
