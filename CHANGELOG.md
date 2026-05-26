# Changelog

All notable changes to Rig are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and Rig aims to follow
[Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

## [0.1.6] - 2026-05-26

### Added
- `rig <unknown>` now suggests the closest command ("Did you mean `rig serve`?"), and maps agent names to `install` (`rig claude` → `rig install claude`).

## [0.1.5] - 2026-05-26

### Added
- Automated release pipeline: pushing a `vX.Y.Z` tag publishes to npm (guarded so the tag must match `package.json`) and cuts a GitHub Release with generated notes (`.github/workflows/release.yml`).

### Changed
- Backfilled changelog entries for 0.1.1–0.1.4.

## [0.1.4] - 2026-05-26

### Added
- `rig update` — self-update to the latest npm release. Detects local vs global install and runs the right `npm i …@latest`; `--check` reports without applying.

## [0.1.3] - 2026-05-26

### Fixed
- `rig doctor` now checks the resolved per-project port (from `.rig/config.json`) instead of a hardcoded 7474.

## [0.1.2] - 2026-05-26

### Added
- Multi-instance awareness: deterministic per-project port (7474–7537 window) plus a free-port fallback on `EADDRINUSE`, so two checkouts run side by side without colliding.
- Project name captured at init, surfaced in `/health`, `/api/config`, and the map's browser-tab title.
- `rig-constellation` bin alias — both `rig` and `rig-constellation` resolve after a global install.
- Richer `rig start` terminal UI: per-phase indexing progress with in-place bars (dependency-free ANSI; no-ops on non-TTY).

### Fixed
- MCP `serverInfo.version` now reports the real package version (was hardcoded `0.0.1`).

## [0.1.1] - 2026-05-26

### Added
- npm `keywords` for discoverability; README badge row (npm · CI · license · runtime).
- Cross-platform CI matrix (ubuntu/macos/windows × Node 20/22) running a real `init + index` under Node.

### Changed
- README leads with `npx`, adds an agent-facing `rig_pull` / `rig_impact` before-after.

## [0.1.0] - 2026-05-25

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

### Changed (licensing)
- Relicensed from MIT to **Apache-2.0**. CodeGraph-derived portions remain under their original MIT terms (see `NOTICE` / `LICENSE-CODEGRAPH.txt`).

[Unreleased]: https://github.com/Astralchemist/rig/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Astralchemist/rig/releases/tag/v0.1.0
