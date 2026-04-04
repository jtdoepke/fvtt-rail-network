# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/jtdoepke/fvtt-rail-network/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/jtdoepke/fvtt-rail-network/releases/tag/v0.0.1
