# Changelog

All notable changes to Rig are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and Rig aims to follow
[Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

### Added
- **A rebuilt map.** A rail with four views (Map, Review, Waypoints, Overview), an inspector for the selected node, and light and dark themes that also follow the OS (`Match system` is the new default; saved themes keep working).
  - The constellation stays on canvas. Labels are placed without overlap and in priority order, node kinds are three validated colours plus neutral with shape as a second cue, the layout no longer re-runs on every database change, and a List view gives the same nodes as a sortable, keyboard-driven table.
  - Neighbourhood and Impact lenses draw the selected node's typed links, and what depends on it (or its critical path), as React Flow cards with kind, `file:line`, signature and badges for hubs, notes, waypoints and orphaned memory. They load on demand, so the first paint doesn't pay for them.
  - Review lists every pending proposal, not only those between the top nodes, with its rationale, source URLs and context; accept, reject and undo by button or with `A`, `R` and `U`.
  - Waypoints can be filtered by kind, searched by meaning, and opened as a chain with the code each one is anchored to. New waypoints, notes, proposals and agent focus requests arrive live as notifications.
  - Overview shows the orientation map, the graph's vital signs, orphaned memory and the recent write log with what Undo would revert.
  - The search palette uses hybrid search and keeps the first keystroke; the sign-in gate uses the chosen theme.
- REST endpoints for those views, all additive: `/api/overview`, `/api/waypoints` (`kind`, `session_id`, `q`), `/api/waypoints/:id`, `/api/orphans`, `/api/activity`, `/api/cards?ids=`, `/api/node/:id/neighborhood`, `/api/node/:id/impact`, `/api/node/:id/critical-path`. `/api/node/:id` adds `card`, `annotations` and `aliases`; `/api/graph` nodes add `file_path`.

### Changed
- `/api/search` ranks with the same hybrid search as `rig_search`. The body is still the `RigNode[]` it was, each hit with `score` and `matched_by` added; the `x-rig-search` header says `hybrid` or `keyword-only`, and `mode=keyword` asks for the old keyword search.
- The map draws the top 500 nodes by default (it asked for 2,000); 300, 1,000 and 2,000 are a setting away.

## [0.3.0] - 2026-10-29

Natural-language search, measured. Benchmark (Claude Haiku 5.5 via OpenRouter, next-auth, 3 trials): with grep and rig together, the agent now uses 126% of grep-alone's median tokens (153% on 0.2.0). On natural-language questions it is cheaper than grep alone. With rig's search tools alone, correctness rose from 85% to 96%. A repository orientation map is available on demand; injected into every prompt it cost more than it saved (187%), so it isn't. See `scripts/bench/results/`.

### Added
- **Natural-language search.** `rig_search` fuses three candidate lists by reciprocal rank (k = 60): exact name and alias matches (always first), keyword matches and semantic matches from the local embeddings. A question such as "where do we refresh expired sessions?" now finds code; a symbol name still returns that symbol first. Each node carries `score` and `matched_by`.
  - The keyword index (migration v14) also covers identifier words (`handleLogin`, `handle_login` and `handle-login` all match "handle login"), signatures, docstrings, and waypoint and doc text. Symbol-like queries keep exact and prefix matching; questions drop stopwords, match any word and rank by BM25 with column weights.
  - The query is embedded with the project's embedder (lazily, with a small cache), and every vector of the active model is scored in memory. The vectors are loaded once and refreshed incrementally.
  - Without the model (offline first run, model missing, still loading) search answers from names and keywords and says `degraded: "keyword-only"`. It never fails for that reason, and the MCP server never waits on the model at startup.
- `rig_context` and `rig_explore` find their anchors with the same hybrid search, so plain-language tasks return code. `rig_relevant_skills` ranks skills semantically as well, and `rig_waypoints` takes an optional `query` that ranks waypoints by relevance instead of recency.
- Waypoints (title, summary, key terms and rationale) and skills (name and description) are embedded. A waypoint is embedded in the background after its write, and the update pipeline embeds anything still missing. Markdown sections are embedded with an excerpt of their body.

- Benchmark harness (`bun run bench:run` / `bench:report`):
  - runs through OpenRouter or Anthropic
  - four arms: grep-only, rig, rig-search, grep+rig
  - next-auth target pinned to a fixed commit, with 16 machine-checked questions, 6 of them natural-language
  - per-run cost, plus paired comparisons against grep-only
  - the 0.2.0 and 0.3.0 runs are recorded

- **Orientation map.** A compact markdown map of the repository that an agent can fetch when it needs to get oriented, instead of spending turns exploring the repo's shape. It is built from the index and the indexed files alone, with no model call, and fits a token budget (default 2,000 tokens, about 8,000 characters). Every line names real paths. Sections are ranked and trimmed to fit:
  - project basics: languages, workspace packages, key runtime dependencies
  - entry points: manifest `exports`, `main` and `bin` mapped to their source files, index and CLI files
  - module layout: packages (sibling families such as `packages/adapter-*` folded into one line) with one-line purposes from manifests, READMEs and module docstrings
  - key symbols: hub files and the most-referenced exported functions, classes and types, with signature and `file:line`
  - request/handler surfaces: string-literal unions and enums (route and action tables), directories of modules each exporting a handler named after it, the function that dispatches to them, HTTP verb exports
  - tests: where they live and which sources they import
  - recent decision waypoints
- The map is cached in `meta` and refreshed at the end of the shared update pipeline, so `rig index`, `rig sync` and the file watcher keep it current. A fingerprint of everything it reads skips regeneration when nothing changed. On next-auth (about 2,950 nodes) it generates in about 20–35 ms.
- `rig_overview(budget?)`, a light tool returning `{ map, generated_at, nodes }`. It is on demand: a benchmark arm that injected the map into every prompt cost 187% of grep-only's median tokens (against 134% without the map), so the installed instructions describe it but don't make it a mandatory first call.
- The MCP server now advertises the `resources` capability and serves the same map as `rig://overview` (`resources/list`, `resources/read`).
- `rig overview [--budget <tokens>] [--json]` prints the map.
- Benchmark arm `grep+rig+map`: `grep+rig` with the target's map in the system prompt. The results record the map's size, and `--map-budget` sets its budget.
- The README describes what Rig can do and what the benchmark measured.

### Changed
- Embedding text now includes identifier words, and its version is part of the stored text hash. The first `rig index` or `rig sync` after upgrading re-embeds every node once. The extractor version is bumped for markdown excerpts, so every file is re-extracted once (in place).

## [0.2.0] - 2026-10-28

Agent memory now survives re-indexing. This release fixes the correctness, safety and retention bugs found in an audit of 0.1.x. Because install scope, web-map auth and the Node baseline change, it is a minor bump.

### Fixed
- **Agent memory survives `rig index`, `rig sync` and line moves.** Re-indexing used to purge and re-insert every file, and the foreign-key cascades erased aliases, promotions, pending and accepted edges, annotations and waypoint→code links. Moving a function one line also changed its ID.
  - Files are now updated in place: matched symbols keep their ID.
  - Unchanged files are skipped (`--force` re-extracts).
  - Structural edges are rebuilt from per-file extraction artifacts, so `sync` and `index --include` no longer drop edges.
  - Memory of a symbol that really disappears is kept in `orphaned_memory` and re-attached if the symbol returns; `rig status` reports `orphans`.
- `rig_context` and `rig_explore` can run over MCP. A hard-coded main-session gate made them always fail. Responses are capped under Claude Code's tool-response limit, with a `truncated` flag.
- Hubs need a hubness score above zero. Before, every node type got a hub even at score 0, and `rig_pull` boosted it.
- Python: `import x` / `import x as y` are recorded, defs are typed function vs method, `async def` is marked async, and imports resolve to module files.
- Dependency checks:
  - Standard-library modules are never reported as phantoms.
  - PyPI names are matched to import names (PEP 503 and common renames such as PyYAML→`yaml`).
- TS/JS: `const f = () => …` and function-expression bindings become function nodes, and doc comments above `export` are kept.
- Live map events no longer stop after the first database write on macOS.
- `WebHandle.close()` no longer hangs on open connections (#3).
- `rig_session_token` links to the port the map actually bound.
- `rig serve --mcp` outside an initialised project starts and answers `NOT_INITIALIZED`, instead of failing to start.
- Cursor's `--path` is honoured, and Cursor configs use `${workspaceFolder}`.
- Re-installing merges permissions: rig's own entries follow rig's policy and the user's entries are kept (#8).
- The "refuse project install in `$HOME`" check compares real paths.
- Undo steps back through the session's history, and promote, annotate and cluster have real inverses. An undo that can't apply says so instead of reporting success.
- Accepted edges keep their kind and evidence URLs (migration v13), and `rig_pull` counts them as one hop.
- Waypoints keep their required rationale. Unknown refs fail with `NODE_NOT_FOUND`, and `session_id="last"` skips the caller's own session.
- Tools record activations exactly as their contracts declare, and `activations.query_hash` is populated.

### Security
- The web map requires its session token on loopback too, checks Host (DNS rebinding) and Origin (CSRF, cross-site WebSocket) on every request and on `/ws`, and no longer allows cross-origin requests. `rig start` still opens the map signed in, and `rig serve --no-auth` keeps the old loopback behaviour.
- SQLite waits up to 5 s for locks (`busy_timeout`) and takes write locks up front (`BEGIN IMMEDIATE`). Several agents, the web server and the watcher no longer fail each other with `SQLITE_BUSY`.
- `rig_promote`, `rig_undo`, `rig_add_alias` and `rig_add_node` now ask before running in every agent's generated permissions.

### Added
- A file watcher keeps the graph live in `rig serve` and `rig start`. There is one per project, and you can opt out with `--no-watch` or `RIG_NO_WATCH=1`.
- `rig uninstall [target…|--all] [--global] [--dry-run]` removes exactly what `rig install` added.
- Per-agent permission policies for opencode, Codex and the Cursor CLI, in each host's documented format.
- `rig <unknown>` suggests the closest command. This shipped in source as 0.1.6, which was never published.
- `rig export-memory` / `rig import-memory` back up and restore agent-written memory as deterministic JSONL, by default in `.rig/exports/`. Import matches by id, then by a portable `{kind, filePath, qualifiedName}` key, and sends anything unmatched to `orphaned_memory`.
- Live map events `waypoint:dropped` and `node:annotated`.
- `rig status` reports `last_index_ts`. `last_sync_ts` is now the real time of the last index or sync; it used to be the newest activation.

### Changed
- `rig install claude` and `rig install cursor` write into the project (`.mcp.json`, `.claude/settings.json`, `CLAUDE.md`) by default; `--global` keeps the old user-level behaviour.
- `rig start` never writes user-level config. Codex and opencode, which rig can only wire user-wide, are no longer auto-wired; it prints `rig install <name>` instead.
- OpenRouter is never auto-wired, and `rig install openrouter` is labelled a reference config, because it isn't an MCP host (#1).
- Node 20 is no longer supported: it reached end of life on 2026-04-30, and better-sqlite3 ships no Node 20 prebuilds. `engines` now requires Node ≥22.
- Annotations are stored in their own table (migration v12). The first `rig index` after upgrading re-extracts every file once.
- `rig_neighbors` reports a semantic edge's real kind. Filtering by `related` no longer returns accepted edges of other kinds.
- `rig_search` and `rig_relevant_skills` now record activations, as their contracts declare.

### CI
- New gates: typecheck (now including the web app's `.tsx`), a Playwright e2e job, and a pack + install smoke test that runs the published tarball under Node.

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

[Unreleased]: https://github.com/Astralchemist/rig/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Astralchemist/rig/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Astralchemist/rig/compare/v0.1.5...v0.2.0
[0.1.0]: https://github.com/Astralchemist/rig/releases/tag/v0.1.0
