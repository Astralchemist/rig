# Changelog

All notable changes to Rig are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and Rig aims to follow
[Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

### Added
- Single-package distribution: the CLI is bundled to one ~1 MB-packed `dist/rig.js` (was a 105 MB platform-locked binary). Runs under Bun and Node; runtime deps install from npm.
- One-command onboarding: `bunx rig` / `rig start` — init + index + auto-wire the detected agent + open the live map.
- `index:progress` WebSocket event so the map can animate the codebase assembling itself as it indexes.
- Tool-surface stability axis (`stable` / `experimental` / `deprecated`) and a compatibility gate (`bun run check:compat`) that fails on breaking changes to stable tools.
- Migration immutability lock (`bun run check:migrations`) — shipped migrations can no longer be edited, only added to.
- `COMPATIBILITY.md` documenting the stability promise, deprecation cycle, and supported runtimes/OS.
- `docs/integration.md` — how features compose onto five integration seams.
- Cross-platform browser-open helper (macOS / Linux / Windows / WSL).

### Changed
- 20 tools marked `stable` (since 1.0); the write surface, memory layer, observability, and live tools remain `experimental`.
- README rewritten as a product README with the one-command quickstart.

### Removed
- Origin-story design docs (build brief, phase plans, extraction map). CodeGraph attribution is retained as accreditation.

[Unreleased]: https://github.com/Astralchemist/rig/commits/main
