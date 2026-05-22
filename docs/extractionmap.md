# CodeGraph → Rig: extraction map

> **What this is.** A file-grounded outline of exactly what we are pulling from `github.com/colbymchenry/codegraph` into Rig, what we are adapting, and what we are intentionally ignoring. Read alongside the build brief.
>
> **Snapshot taken from:** `colbymchenry/codegraph` main branch, `@colbymchenry/codegraph@0.9.2`, package targets Node ≥20 <25, MIT-licensed.

---

## 1. At a glance

CodeGraph is structured as a single TypeScript package with ten subsystems under `src/`. We are pulling **the entire architecture as a template** — schema, MCP transport, installer pattern, watcher, CLI — and replacing **two of the ten subsystems** with Rig-specific implementations:

| Subsystem | Disposition |
|---|---|
| `src/db/` — SQLite storage | **Pull and extend** with semantic edges + embeddings tables |
| `src/mcp/` — MCP server | **Pull**, then add write tools and live tools |
| `src/extraction/` — tree-sitter | **Pull selectively** (3 languages of 19) + add markdown/doc extractors |
| `src/resolution/` — reference resolution | **Pull the orchestrator pattern**, drop the framework resolvers |
| `src/graph/` — traversal | **Pull verbatim**; add magnetic-pull scoring on top |
| `src/sync/` — watcher + git hooks | **Pull verbatim** — best-in-class already |
| `src/installer/` — multi-agent installer | **Pull, retarget** to write Rig configs |
| `src/bin/` — CLI | **Pull, rename** commands |
| `src/context/` — task-to-context builder | **Pull and reshape** to return rig neighborhoods |
| `src/search/` — FTS5 query parser | **Pull verbatim** |
| `src/ui/` — terminal UI helpers | **Pull verbatim** |

Plus a brand-new subsystem with no CodeGraph counterpart: **`src/web/` — Fastify + React map UI with embedded chat.**

---

## 2. Module-by-module extraction

### 2.1 Storage layer — `src/db/`

| File | What's there | What we pull | What changes |
|---|---|---|---|
| `schema.sql` | `nodes` (code symbols with kind/qualified_name/file_path/line/lang), `edges` (source/target/kind/metadata/provenance), `files`, `unresolved_refs`, FTS5 virtual table over nodes + sync triggers, schema_versions for migrations | The whole shape — nodes/edges/files/FTS5/triggers/versioning — including the **`provenance` column on `edges`** (already exists in v0.9.2; we use it more aggressively) | Add `edges_semantic` (weight + provenance + rationale), `embeddings` (BLOB vectors), `activations` (recency log). Generalize `nodes` so `kind` is no longer code-only |
| `migrations.ts` | Versioned migrations with `schema_versions` table | Verbatim pattern | Renumber starting from v1 of Rig schema |
| `queries.ts` | The `QueryBuilder` class — all node/edge SQL lives here | Pull as the template for our query layer | Add `getMagneticPull(nodeId, k)` blending structural + semantic + recency |
| `sqlite-adapter.ts` | Abstraction over `better-sqlite3` and Node's built-in `node:sqlite` | Pull verbatim — this is the dual-backend pattern that lets us avoid native deps where Node ≥22 is available | None |
| `index.ts` | DB initialization, migration runner, connection management | Pull and rename | None structural |

**Note on the existing `provenance` column.** CodeGraph already added a `provenance` column on edges and an `idx_edges_provenance` index. They use it lightly (mostly to mark resolved-by-framework edges). We make it load-bearing — every write must populate it.

### 2.2 MCP server — `src/mcp/`

| File | What's there | What we pull |
|---|---|---|
| `transport.ts` | Pure JSON-RPC 2.0 STDIO transport with `readline`. Bidirectional — supports server→client requests for `roots/list`. Handles parse errors, invalid requests, response routing | **Pull verbatim.** This is 250 lines of carefully-handled JSON-RPC. Don't rewrite it |
| `index.ts` | MCP server bootstrap: `initialize`, `tools/list`, `tools/call`, capability negotiation | Pull as template; add capability advertisement for our new tool tiers |
| `tools.ts` | All eight tools wired up: `codegraph_search`, `codegraph_context`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_node`, `codegraph_files`, `codegraph_status` | **Pull the structure**, rename to `rig_*`, then add `rig_pull`, `rig_neighbors`, plus the Phase 3 write tools and Phase 3 `rig_subscribe` for live UI events |
| `server-instructions.ts` | The server-side capability description sent during `initialize` | Pull and rewrite for Rig's tool surface |

### 2.3 Extraction — `src/extraction/`

The repo has tree-sitter extractors for 19 languages totaling ~5.6 MB of WASM grammars. We pull a subset for Phase 1.

| File / dir | What's there | What we pull |
|---|---|---|
| `tree-sitter.ts` | Core integration with `web-tree-sitter`. Node creation, file parsing, AST traversal, edge collection | **Pull verbatim** as the extraction engine |
| `grammars.ts` | Grammar loading from WASM files, per-language config | Pull and trim to our subset |
| `parse-worker.ts` | Worker pool for parallel parsing | Pull — important for large repos |
| `tree-sitter-helpers.ts`, `tree-sitter-types.ts` | Type definitions and helpers | Pull |
| `languages/typescript.ts` | TypeScript node + edge extractor | Pull |
| `languages/javascript.ts` | JavaScript extractor | Pull |
| `languages/python.ts` | Python extractor | Pull |
| `languages/java.ts`, `go.ts`, `rust.ts`, `csharp.ts`, `php.ts`, `ruby.ts`, `c-cpp.ts`, `swift.ts`, `kotlin.ts`, `dart.ts`, `scala.ts`, `lua.ts`, `luau.ts`, `pascal.ts` | The other 13 language extractors | **Pull on demand later** — not in Phase 1 |
| `svelte-extractor.ts`, `vue-extractor.ts`, `liquid-extractor.ts`, `dfm-extractor.ts` | Framework-specific extractors that wrap tree-sitter | Pull only if needed |
| `wasm/` (5.6 MB) | Compiled grammar binaries | Bundle only the ones we use; lazy-load others |

**New extractors we add:** `markdown.ts` (headings + sections as anchors), `notion.ts` / `obsidian.ts` (optional Phase 2+), `business-schema.ts` (for TCA's ChangeSignal model if we go that route).

### 2.4 Resolution — `src/resolution/`

| File / dir | What's there | What we pull |
|---|---|---|
| `index.ts` | The resolution orchestrator. Extracts unresolved references, runs strategies in order, writes resolved edges | **Pull the orchestrator pattern** — extraction and resolution as separate phases is core to our architecture |
| `import-resolver.ts` | Resolves function calls and imports across files via import maps | Pull — generally useful for any code use case |
| `name-matcher.ts` | Fuzzy and qualified-name matching | Pull |
| `path-aliases.ts` | `tsconfig.json` path alias resolution | Pull (TS-specific but cheap) |
| `strip-comments.ts` | Comment-stripping utility | Pull verbatim — useful utility |
| `frameworks/` (170 KB) | Framework-aware resolvers (React, Django, Rails, etc.) — knows that `useState` is a React import, that Django `models.Model` extends a base class, etc. | **Do not pull.** This is code-specific framework knowledge that does not generalize to our domain-agnostic model. If we later add code as a first-class node type we may pull selectively |
| `types.ts` | Resolution-phase types | Pull |

The hardcoded built-in sets (`JS_BUILT_INS`, `REACT_HOOKS`, `PYTHON_BUILT_INS`, `GO_STDLIB_PACKAGES`, etc.) live inside `index.ts` and are valuable for code-aware filtering. Pull them; treat them as code-extension-specific configuration.

### 2.5 Graph traversal — `src/graph/`

| File | What's there | What we pull |
|---|---|---|
| `traversal.ts` | BFS/DFS, impact-radius computation, callers/callees walks | **Pull verbatim** as our base traversal primitives |
| `queries.ts` | Graph-level queries (find-by-name, find-by-kind, neighborhood-of) | Pull |
| `index.ts` | Module exports | Pull |

**What we add:** `pull.ts` — magnetic-pull scoring that blends structural distance, semantic similarity (cosine over embeddings), and recency-of-activation. This is the layer that doesn't exist in CodeGraph.

### 2.6 Sync & watcher — `src/sync/`

| File | What's there | What we pull |
|---|---|---|
| `watcher.ts` | `FileWatcher` class. Uses Node's native `fs.watch({recursive: true})` (FSEvents on macOS, ReadDirectoryChangesW on Windows, inotify on Linux ≥ Node 19). 2-second debounce. Filters to source files only. Ignores `.codegraph/` self-writes. Re-triggers sync if changes arrive mid-sync. Watch-policy gate for WSL2 | **Pull verbatim.** Battle-tested. Rename `.codegraph/` → `.rig/` |
| `watch-policy.ts` | Detects environments where recursive `fs.watch` is unstable (WSL2 `/mnt/` drives) and disables watching gracefully | Pull verbatim |
| `git-hooks.ts` | Optional git pre-commit/post-merge hooks for offline syncs | Pull — useful even for non-code domains |
| `index.ts` | Sync orchestrator | Pull |

### 2.7 Installer — `src/installer/`

This is the **highest-leverage extraction.** CodeGraph's 654 GitHub stars are largely because `npx @colbymchenry/codegraph` Just Works across four agents. We copy this almost entirely.

| File / dir | What's there | What we pull |
|---|---|---|
| `index.ts` | Interactive installer using `@clack/prompts`. Auto-detects installed agents, prompts for which to configure, handles global-vs-local install, writes configs | Pull the flow; replace agent detection list as needed |
| `claude-md-template.ts` | The CLAUDE.md content written to `~/.claude/CLAUDE.md` | **Pull as template**, rewrite for Rig's two-tier tool surface and write-tool gating |
| `instructions-template.ts` | Per-agent instruction snippets | Pull and rewrite |
| `config-writer.ts` | Generic MCP config writer | Pull verbatim |
| `targets/claude.ts` | Claude Code config: writes to `~/.claude.json` mcpServers + `~/.claude/settings.json` permissions + `~/.claude/CLAUDE.md` | **Pull verbatim, retarget** to Rig paths |
| `targets/cursor.ts` | Cursor config: writes to `~/.cursor/mcp.json` and `.cursor/rules/codegraph.mdc` per project | Pull, retarget |
| `targets/codex.ts` | Codex CLI config: writes to `~/.codex/config.toml` and `~/.codex/AGENTS.md` | Pull, retarget |
| `targets/opencode.ts` | opencode config | Pull, retarget |
| `targets/hermes.ts` | A fifth target (newer) | Pull if we want broader coverage |
| `targets/toml.ts` | **Hand-rolled TOML serializer** scoped to `[mcp_servers.X]` (used for Codex configs because they didn't want a TOML dependency) | **Pull verbatim** — clever and lightweight |
| `targets/registry.ts` | Plug-in registry pattern for adding new targets | Pull — extensibility we'll want |
| `targets/shared.ts` | Shared target utilities | Pull |
| `targets/types.ts` | Target interface | Pull |

### 2.8 CLI — `src/bin/`

| File | What's there | What we pull |
|---|---|---|
| `codegraph.ts` | Commander-based CLI. Lazy-loads heavy modules for fast startup. Commands: `install`, `init`, `uninit`, `index`, `sync`, `status`, `query`, `files`, `context`, `affected`, `serve --mcp`. Node 25.x block (V8 issue) | **Pull entire structure**, rename to `rig`, add `serve --web` for the map UI |
| `node-version-check.ts` | Pre-flight Node version check with friendly error banner | Pull verbatim |
| `uninstall.ts` | `preuninstall` hook — cleans up agent configs when the npm package is removed | Pull verbatim. **Underrated** — this is what makes uninstalling clean |

### 2.9 Context builder — `src/context/`

| File | What's there | What we pull |
|---|---|---|
| `index.ts` | The `buildContext(task, options)` function. Searches relevant symbols, expands neighborhoods, dedupes, ranks, returns an LLM-ready bundle | **Pull and reshape.** This becomes our heavy tool. Replace its FTS5-only scoring with magnetic-pull scoring |
| `formatter.ts` | Markdown formatter that turns the context bundle into a single prompt string | Pull verbatim |

### 2.10 Search — `src/search/`

| File | What's there | What we pull |
|---|---|---|
| `query-parser.ts` | FTS5 query parser. Handles user-typed queries with operators, quoted strings, kind filters | Pull verbatim |
| `query-utils.ts` | Query string utilities | Pull verbatim |

### 2.11 Terminal UI — `src/ui/`

| File | What's there | What we pull |
|---|---|---|
| `glyphs.ts` | Cross-platform terminal glyphs (checkmark, error, etc. — fallback for non-Unicode terminals) | Pull verbatim |
| `shimmer-progress.ts`, `shimmer-worker.ts` | Animated progress bars during indexing | Pull verbatim |
| `types.ts` | UI types | Pull |

### 2.12 Tests — `__tests__/`

We do not pull the tests directly (they're CodeGraph-specific), but we replicate the **testing discipline**. Notable patterns to adopt:

- **`__tests__/evaluation/`** — agent-evaluation harness that runs Claude Code in headless mode against real codebases. Our equivalent is the read-write benchmark (does the AI co-cartographer draw correct edges?)
- **`__tests__/installer-targets.test.ts`** — golden-file tests for every target's output. Pull this approach exactly
- **`__tests__/watcher.test.ts`, `concurrent-locking.test.ts`** — concurrency edge cases. Read before touching the watcher

---

## 3. Patterns we extract (not tied to specific files)

### 3.1 The two-tier tool design

CodeGraph's `CLAUDE.md` is explicit: "NEVER call `codegraph_explore` or `codegraph_context` directly in the main session." This routes heavy tools through spawned sub-agents whose context is discarded. We adopt this verbatim — the agent install must write the same gating instruction.

### 3.2 The agent install pattern

The `targets/` directory is a pluggable system where each target (Claude Code, Cursor, Codex, opencode, hermes) is a TypeScript module exporting:
- `name` and detection logic
- `install(ctx)` that writes config + instructions
- `uninstall(ctx)` that cleans them up

We adopt this verbatim. Adding a new agent later is a single new file under `targets/`.

### 3.3 The CLAUDE.md instructions template

CodeGraph writes ~80 lines of instructions to `~/.claude/CLAUDE.md` during install. The instructions tell the agent: which tools to use for which questions, when to spawn sub-agents, when to trust the index without re-verifying with grep. We adopt this pattern wholesale and rewrite the content for our tool surface.

### 3.4 The benchmarking discipline

CodeGraph runs 6 real-world codebases through Claude Code with and without the index, reports tool-call counts and wall-clock time as a table in the README. If we want credibility we ship the same.

### 3.5 Schema migration discipline

`schema_versions` table, `migrations.ts` runs ordered migrations on every open. Pulled verbatim. The `.rig/` directory lives longer than any binary version that created it.

### 3.6 Impact analysis via graph traversal

The `codegraph affected` command (and the `getImpactRadius()` function in the library API) walks the edge graph N hops from a changed node to find what's affected. This is a general algorithm — we use the same primitive for "what other anchors are pulled by this change" in our system.

### 3.7 Lazy-loaded CLI

`src/bin/codegraph.ts` uses dynamic `import()` for heavy modules so `codegraph --help` returns instantly. Pull this discipline — first-impression latency matters.

---

## 4. Inherited npm dependencies

| Package | What it does | Disposition |
|---|---|---|
| `web-tree-sitter@^0.25.3` | WASM tree-sitter runtime | Keep |
| `tree-sitter-wasms@^0.1.11` | Pre-compiled grammar bundles | Keep |
| `@clack/prompts@^1.3.0` | Interactive CLI prompts | Keep |
| `commander@^14.0.2` | CLI argument parser | Keep |
| `picomatch@^4.0.3` | Glob matching | Keep |
| `ignore@^7.0.5` | `.gitignore`-style filtering | Keep |
| `jsonc-parser@^3.3.1` | JSON-with-comments parsing (Cursor configs) | Keep |
| `fast-string-width`, `fast-wrap-ansi`, `sisteransi` | Terminal text rendering helpers | Keep |
| `better-sqlite3` (`@types/better-sqlite3` in devDeps) | Optional native SQLite backend | Optional — `node:sqlite` is preferred on Node ≥22 |

**Additions we'll need:**
- `fastify` or `hono` — web server for the map UI
- `ws` — WebSocket layer
- An embedding library: `@xenova/transformers` (local), or an OpenAI-compatible HTTP client
- `react`, `react-force-graph-2d`, `vela` (your library) — frontend

---

## 5. Explicitly not pulling

| Thing | Why |
|---|---|
| Framework resolvers (`src/resolution/frameworks/`, 170 KB) | Code-specific. React/Django/Rails detection has no analogue in a domain-agnostic anchor graph |
| 13 of 16 non-essential language extractors | Phase 1 needs only TS/JS/Python/Markdown. Lazy-load others later |
| The full WASM grammar bundle (5.6 MB) | Bundle only what we ship; lazy-fetch the rest |
| `src/extraction/svelte-extractor.ts`, `vue-extractor.ts`, `liquid-extractor.ts`, `dfm-extractor.ts` | Niche, only pull if a use case requires them |
| `__tests__/` content | We write our own; we adopt the test patterns not the tests |
| `scripts/agent-eval/` benchmarking harness | Specific to CodeGraph's evaluation; we'll write our own |

---

## 6. Adoption per build phase

| Phase | What comes online from CodeGraph |
|---|---|
| **Phase 0 — scaffold** | `src/db/` (schema + migrations + adapter), `src/bin/` CLI structure, `src/ui/` helpers, `node-version-check.ts`, inherited dependencies |
| **Phase 1 — read-only MCP** | `src/mcp/transport.ts` verbatim, `src/mcp/tools.ts` as template, `src/extraction/*` (TS/Python/MD only), `src/resolution/index.ts` orchestrator (no framework resolvers), `src/graph/*`, `src/search/*`, `src/context/*`, `src/sync/*` (watcher + git hooks), `src/installer/*` retargeted, all four `targets/` files |
| **Phase 2 — localhost map UI** | No new CodeGraph code (this phase is brand-new for us). Only depends on what's already pulled |
| **Phase 3 — read-write** | Reuse `provenance` column on edges; reuse `installer/` to add Phase-3-only auto-allow permissions for write tools |
| **Phase 4 — multi-agent + Direct chat** | The remaining `targets/` files (hermes if relevant); `targets/registry.ts` for any new target |

---

## 7. File-to-file mapping cheat sheet

| CodeGraph file | Rig file | Disposition |
|---|---|---|
| `src/db/schema.sql` | `packages/core/src/db/schema.sql` | extend |
| `src/db/migrations.ts` | `packages/core/src/db/migrations.ts` | verbatim, renumbered |
| `src/db/queries.ts` | `packages/core/src/db/queries.ts` | extend with pull queries |
| `src/db/sqlite-adapter.ts` | `packages/core/src/db/sqlite-adapter.ts` | verbatim |
| `src/mcp/transport.ts` | `packages/mcp/src/transport.ts` | verbatim |
| `src/mcp/tools.ts` | `packages/mcp/src/tools/*.ts` (one per tool) | restructure, rename, extend |
| `src/extraction/tree-sitter.ts` | `packages/core/src/extract/tree-sitter.ts` | verbatim |
| `src/resolution/index.ts` | `packages/core/src/resolve/index.ts` | pull orchestrator only |
| `src/graph/traversal.ts` | `packages/core/src/graph/traversal.ts` | verbatim |
| `src/sync/watcher.ts` | `packages/core/src/watch.ts` | verbatim, path rename |
| `src/installer/index.ts` | `packages/cli/src/install.ts` | verbatim, retarget |
| `src/installer/targets/*.ts` | `packages/cli/src/targets/*.ts` | verbatim, retarget |
| `src/bin/codegraph.ts` | `packages/cli/src/index.ts` | verbatim, rename commands |
| `src/context/index.ts` | `packages/core/src/context.ts` | reshape for pull scoring |
| `src/search/query-parser.ts` | `packages/core/src/search.ts` | verbatim |

---

## 8. License note

CodeGraph is MIT-licensed. Pulled code retains attribution in source headers. Where we pull a file verbatim or near-verbatim we keep the upstream copyright line; where we adapt heavily we add a "derived from" comment. The full upstream LICENSE goes in the repo as `LICENSE-CODEGRAPH.txt` alongside our own LICENSE.

---

*End of extraction map. When adding new modules from CodeGraph later (e.g., a new language extractor or target), update Section 6 with the phase in which the dependency first becomes load-bearing.*