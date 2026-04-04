# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/jtdoepke/fvtt-rail-network/releases/tag/v0.0.1
