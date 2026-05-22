# Rig — Phase 3 Execution Plan for Claude Code

> **What this is.** A granular, sequenced task list that takes Rig from empty directory to Phase 3 (a working read-write knowledge graph with localhost map UI and AI co-cartography). Companion to `rig-build-brief.md` (philosophy + architecture) and `codegraph-extraction-map.md` (what we pull from upstream).
>
> **Read order:** build brief → extraction map → this plan. Re-read Section 1 of the build brief if you ever feel architecturally lost during execution.
>
> **Definition of "Phase 3 reached":** a user runs `rig init` in a TypeScript repo, opens `http://localhost:7474/map`, sees the constellation, asks "what other concepts pull on `authStore`?", watches Claude propose two dashed edges with rationale, clicks accept, and the edges become solid — all in under 60 seconds.

---

## 0. Pre-flight — do this before writing any code

### 0.1 Confirm decisions locked for this plan

These were left open in the build brief. They are pre-decided here so you can execute without round-trips. **If you (Claude Code) think any of these are wrong, say so before starting Phase 0.** If you (Bob) want to override, do it now.

| Decision | Locked value | Rationale |
|---|---|---|
| First use case | Code (extend CodeGraph's domain) | Faster validation, riding existing distribution. TCA extraction layer comes in v0.2 |
| Read-only vs read-write timing | Phases 1–2 read-only, Phase 3 introduces write tools | Lets each phase ship independently with a real differentiator added per phase |
| Runtime | Bun 1.1+ | Native SQLite via `bun:sqlite`, fast install, single binary potential |
| DB backend | `bun:sqlite` primary, `better-sqlite3` fallback for Node ≥20 | Avoid native compile step in the common case |
| Embedding model | `@xenova/transformers` running `Xenova/bge-small-en-v1.5` locally (≈90 MB) | No API key needed, runs CPU-only, good enough quality for magnetic-pull scoring |
| Embedding fallback | OpenAI `text-embedding-3-small` via config | Optional, off by default |
| Frontend stack | Vite + React + `react-force-graph-2d` + Vela components | Vela aligns with Bob's other products; force-graph-2d is faster than 3d for our scale |
| Web server | Fastify + native `ws` | Lean, well-typed, async-native |
| Chat transport (Phase 2) | MCP-proxy only (talks to user's Claude Code session) | Direct mode deferred to Phase 4 |
| Project layout | Bun workspaces monorepo with 4 packages | `core`, `mcp`, `web`, `cli` |
| StickyInc integration | Deferred to Phase 5 | Standalone first, adapter once API stabilizes |

### 0.2 Read these CodeGraph files end-to-end before starting

Open in `/home/claude/codegraph` (or clone it yourself with `git clone --depth 1 https://github.com/colbymchenry/codegraph.git`) and read fully:

- `src/db/schema.sql` — entire SQL schema
- `src/mcp/transport.ts` — JSON-RPC stdio implementation (we copy this verbatim)
- `src/sync/watcher.ts` — file watcher (verbatim)
- `src/installer/index.ts` and one target (`src/installer/targets/claude.ts`) — installer flow
- `src/bin/codegraph.ts` first 200 lines — CLI structure
- `CLAUDE.md` at the repo root — the agent instructions they install globally

If you can't read all of these before starting, stop and say so. The plan assumes familiarity.

### 0.3 Verify environment

Run and confirm:
- `bun --version` ≥ 1.1
- `node --version` ≥ 20 (only as a fallback consumer)
- Working directory is a fresh empty folder named `rig/` or similar
- Git is initialized

---

## 1. Cross-phase requirements

Apply to every commit, every file, every phase.

### 1.1 Coding standards
- TypeScript strict mode. `"strict": true`, `"noUncheckedIndexedAccess": true`.
- No `any`. Use `unknown` and narrow.
- Errors are values across module boundaries. `Result<T, E>` or discriminated unions. Throws are fine inside a single module.
- No global mutable state. Pass `Rig` instances explicitly.
- Public API from `core/` is **only** the `Rig` class. Everything else `internal`.
- No new npm dependency without one line of rationale in the commit message.

### 1.2 Test discipline
- Every new module ships with a test file. Vitest.
- Schema migrations have a golden-file test from day one — a `.rig.v1.db` fixture that loads cleanly under every future version.
- Installer targets have golden-file tests (mirror CodeGraph's `__tests__/installer-targets.test.ts` pattern).
- Watcher concurrency tests (mirror `__tests__/watcher.test.ts`).
- A `bun test` run completes in under 60s for the whole suite.

### 1.3 Performance budgets
| Operation | Budget |
|---|---|
| `rig status` cold start | < 200 ms |
| `rig init` (no indexing) | < 500 ms |
| Index 500 files | < 15 s |
| Single MCP `rig_search` call | < 50 ms |
| Single MCP `rig_pull` call | < 100 ms |
| Web server cold start (Phase 2+) | < 1 s |
| Map render of 500 nodes | < 2 s to interactive |

Add a perf test if any of these regress.

### 1.4 Error handling
- All file I/O wrapped to return Results.
- All SQLite operations check for `SQLITE_BUSY` and back off.
- All MCP tool handlers catch and convert errors to JSON-RPC errors with appropriate codes.
- Watcher errors logged via `logWarn`, never crash the process.

### 1.5 Git discipline
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`.
- Each phase ends with a tag: `v0.0.1-phase0`, `v0.1.0-phase1`, etc.
- Commits scoped to one task each.

### 1.6 Session checkpoints
**Pause and summarize for Bob at these points:**
- End of Phase 0 (scaffold complete)
- End of Phase 1.6 (MCP transport wired but tools not yet)
- End of Phase 1 (read-only MCP works against Claude Code)
- End of Phase 2 (map UI works in browser)
- End of Phase 3.4 (WebSocket flowing, no UI for accepts yet)
- End of Phase 3 (definition of done met)

At each checkpoint: state what's done, what's next, and any decisions encountered. Do not blast through checkpoints.

---

## 2. Phase 0 — Scaffold

**Goal:** repo exists, builds, has CodeGraph cloned as reference, `rig status` runs.

### 2.1 Initialize repo and workspace
- `bun init -y` at root
- Set up workspaces in root `package.json` pointing to `packages/*`
- Add `.gitignore`: `node_modules`, `dist`, `*.tsbuildinfo`, `.rig/`, `.env`
- Add `tsconfig.json` at root with strict settings, `paths` for workspace aliases
- Add `LICENSE` (MIT) and `LICENSE-CODEGRAPH.txt` (the upstream MIT license)

### 2.2 Clone CodeGraph as `vendor/codegraph` (read-only reference)
- `git clone --depth 1 https://github.com/colbymchenry/codegraph.git vendor/codegraph`
- Add `vendor/` to `.gitignore` — we copy files out, we don't ship the clone
- **Document in `docs/codegraph-snapshot.md`**: upstream commit SHA, date pulled, list of files we copied or adapted (mirrors the `codegraph-extraction-map.md` companion)

### 2.3 Create 4 workspace packages
```
packages/
├── core/        # graph, db, extraction, resolution, traversal, embeddings, magnetic-pull
├── mcp/         # MCP stdio server, tool handlers
├── web/         # Fastify server, REST + WebSocket, React frontend (Phase 2+)
└── cli/         # rig binary, installer, target writers
```

Each gets its own `package.json`, `tsconfig.json` extending root, and `src/index.ts`. Cross-package imports use workspace protocol (`"@rig/core": "workspace:*"`).

### 2.4 Install initial dependencies
| Package | Where | Why |
|---|---|---|
| `web-tree-sitter` | core | WASM tree-sitter |
| `tree-sitter-wasms` | core | Grammar bundles |
| `picomatch` | core | Glob matching |
| `ignore` | core | gitignore-style filtering |
| `commander` | cli | CLI parser |
| `@clack/prompts` | cli | Interactive prompts |
| `jsonc-parser` | cli | JSONC for Cursor configs |
| `vitest` | root (dev) | Test runner |
| `@types/node` | root (dev) | Node types |

Defer Fastify, React, force-graph until Phase 2. Defer transformers until Phase 1.5.

### 2.5 Pull verbatim files from CodeGraph
Per the extraction map, these files come in unchanged (with a `// Derived from CodeGraph (MIT) — github.com/colbymchenry/codegraph` header):

| Source | Destination |
|---|---|
| `vendor/codegraph/src/mcp/transport.ts` | `packages/mcp/src/transport.ts` |
| `vendor/codegraph/src/sync/watcher.ts` | `packages/core/src/watch.ts` |
| `vendor/codegraph/src/sync/watch-policy.ts` | `packages/core/src/watch-policy.ts` |
| `vendor/codegraph/src/db/sqlite-adapter.ts` | `packages/core/src/db/sqlite-adapter.ts` |
| `vendor/codegraph/src/ui/glyphs.ts` | `packages/cli/src/ui/glyphs.ts` |
| `vendor/codegraph/src/ui/shimmer-progress.ts` | `packages/cli/src/ui/shimmer-progress.ts` |
| `vendor/codegraph/src/ui/shimmer-worker.ts` | `packages/cli/src/ui/shimmer-worker.ts` |
| `vendor/codegraph/src/resolution/strip-comments.ts` | `packages/core/src/util/strip-comments.ts` |
| `vendor/codegraph/src/bin/node-version-check.ts` | `packages/cli/src/node-version-check.ts` |

Rename internal references (`codegraph` → `rig`, `.codegraph/` → `.rig/`). Run `bun test` — tests will fail; that's fine, we add ours in Phase 1.

### 2.6 Rig class skeleton in `core/`
Empty methods, full types. `core/src/index.ts`:

```ts
export class Rig {
  static async init(projectRoot: string): Promise<Rig>;
  static async open(projectRoot: string): Promise<Rig>;
  async indexAll(opts?: IndexOptions): Promise<IndexResult>;
  async sync(): Promise<SyncResult>;
  searchNodes(query: string, opts?: SearchOptions): SearchResult[];
  getNode(id: string): Node | null;
  getNeighbors(id: string, opts?: NeighborOptions): Edge[];
  getMagneticPull(id: string, k?: number): PullResult[];   // Phase 1.5
  buildContext(task: string, opts?: ContextOptions): Promise<ContextBundle>;
  async addNode(input: NodeInput, provenance: Provenance): Promise<Node>;   // Phase 3
  async addEdge(input: EdgeInput, provenance: Provenance): Promise<Edge>;   // Phase 3
  watch(): void;
  unwatch(): void;
  close(): void;
}
```

### 2.7 Minimal CLI
`packages/cli/src/index.ts` with `commander`. Subcommands stubbed:
- `rig status` — print "not initialized" or "X nodes / Y edges"
- `rig init` — create `.rig/` directory
- All others print `"not implemented yet — Phase N"`

### Acceptance for Phase 0
- [ ] `bun install` succeeds
- [ ] `bun run build` produces `dist/` outputs for all 4 packages
- [ ] `bun run packages/cli/dist/index.js init` in a fresh project creates `.rig/`
- [ ] `bun run packages/cli/dist/index.js status` prints "not initialized" or stats
- [ ] `bun test` runs (may have 0 passing tests, but does not error)
- [ ] Git tagged `v0.0.1-phase0`
- [ ] **Checkpoint:** summarize for Bob.

---

## 3. Phase 1 — Read-only MCP server

**Goal:** Claude Code can answer "what touches `authStore`?" via Rig tools with zero file reads.

### 3.1 Database layer (`packages/core/src/db/`)

#### 3.1.1 `schema.sql`
Pull `vendor/codegraph/src/db/schema.sql` verbatim, then **append**:

```sql
-- Rig extensions to CodeGraph schema

CREATE TABLE IF NOT EXISTS edges_semantic (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  weight REAL NOT NULL,
  provenance TEXT NOT NULL,
  rationale TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src, dst, provenance),
  FOREIGN KEY (src) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (dst) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_semantic_src ON edges_semantic(src);
CREATE INDEX IF NOT EXISTS idx_edges_semantic_dst ON edges_semantic(dst);
CREATE INDEX IF NOT EXISTS idx_edges_semantic_provenance ON edges_semantic(provenance);

CREATE TABLE IF NOT EXISTS embeddings (
  node_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activations (
  node_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activations_node_ts ON activations(node_id, ts);

-- Add pull_score column to nodes (computed periodically)
ALTER TABLE nodes ADD COLUMN pull_score REAL DEFAULT 0;
```

#### 3.1.2 `migrations.ts`
Pull CodeGraph's migrations.ts, renumber starting from v1 (Rig v1 = CodeGraph schema + our extensions). Add tests: a fixture DB at v1 loads cleanly; any v2 migration runs idempotently.

#### 3.1.3 `queries.ts`
Pull CodeGraph's `queries.ts` as a starting point. Drop code-only helpers we won't use yet. Keep:
- Node CRUD
- Edge CRUD (structural)
- File CRUD
- FTS5 search
- `getCallers(nodeId)`, `getCallees(nodeId)`
- `getImpactRadius(nodeId, depth)`

Add:
- `getSemanticEdges(nodeId)` — for Phase 1.5
- `getActivations(nodeId, sinceTs)` — for Phase 1.5
- `recordActivation(nodeId, source)` — append-only

### 3.2 Extraction (`packages/core/src/extract/`)

Pull from CodeGraph:
- `tree-sitter.ts` (verbatim)
- `grammars.ts` (trim to TS/JS/Python only initially)
- `parse-worker.ts` (verbatim)
- `tree-sitter-helpers.ts`, `tree-sitter-types.ts` (verbatim)
- `languages/typescript.ts`, `javascript.ts`, `python.ts` (verbatim)

Bundle WASM grammars for TS/JS/Python only (≈800 KB total). Lazy-load others later.

**Write fresh:** `languages/markdown.ts` — uses tree-sitter-markdown to extract headings as nodes, section-of-heading as `contains` edges, and inline links as `references` edges.

Test: index a small TS file with a known structure and verify node/edge counts. Index a markdown file and verify heading hierarchy.

### 3.3 Resolution orchestrator (`packages/core/src/resolve/`)
Pull `vendor/codegraph/src/resolution/index.ts` and adapt:
- Keep the extract → resolve two-phase pattern
- Keep `import-resolver.ts`, `name-matcher.ts`, `path-aliases.ts`
- **Drop** `frameworks/` entirely
- Drop hardcoded React/Django/etc. heuristics (or keep behind a `--frameworks` flag for code mode)

Acceptance: a TypeScript project with 50 files resolves all `import` edges across files. Unresolved refs land in `unresolved_refs` with file path and line.

### 3.4 Graph traversal (`packages/core/src/graph/`)
Pull `vendor/codegraph/src/graph/traversal.ts` and `queries.ts` verbatim. Tests pulled and adapted.

### 3.5 Embeddings + magnetic-pull scoring (`packages/core/src/`)

#### 3.5.1 `embed.ts`
- Interface `Embedder` with `embed(texts: string[]): Promise<Float32Array[]>`
- Default impl: `LocalEmbedder` using `@xenova/transformers` and `Xenova/bge-small-en-v1.5` (384-dim)
- Fallback impl: `OpenAIEmbedder` (off by default; needs `OPENAI_API_KEY`)
- Embeddings stored in `embeddings` table as little-endian Float32 BLOBs
- Re-embed only nodes whose `name + signature + docstring` text hash changed

Performance note: `@xenova/transformers` loads ~90MB on first run. Cache to `~/.cache/rig/models/`. Surface a one-time progress bar via `shimmer-progress`.

#### 3.5.2 `pull.ts`
The single most important file in this phase.

```ts
export interface PullResult {
  nodeId: string;
  score: number;        // 0..1
  components: {
    structural: number; // 0..1 — inverse of graph distance, capped at depth 4
    semantic: number;   // 0..1 — cosine similarity
    recency: number;    // 0..1 — exponential decay over activation log
  };
}

export function computeMagneticPull(
  anchorId: string,
  candidates: string[],
  ctx: PullContext,
  weights = { structural: 0.5, semantic: 0.35, recency: 0.15 }
): PullResult[];
```

Implementation:
1. For each candidate, compute graph distance via BFS (cap 4 hops). `structural = 1 / (1 + distance)`.
2. Compute cosine similarity between anchor's embedding and candidate's.
3. Compute recency: sum `exp(-(now - ts) / halflife)` over activations in last 30 days. Halflife = 3 days. Normalize.
4. Weighted sum, clamp 0..1.

Test: a graph with 3 nodes where A→B is a direct call and A→C is semantically similar but structurally distant — verify B scores higher than C with default weights, and C scores higher than B if we set structural=0.

### 3.6 MCP server (`packages/mcp/`)
- `transport.ts` already pulled
- `index.ts` — bootstrap, handle `initialize`, `tools/list`, `tools/call`
- `server-instructions.ts` — capability descriptor
- `tools/` directory, one file per tool

### 3.7 Light tools (Phase 1 scope, all in `packages/mcp/src/tools/`)

| Tool | Signature | Notes |
|---|---|---|
| `rig_search` | `(query: string, kind?: string, limit?: number) => NodeRef[]` | FTS5 over names + qualified names |
| `rig_node` | `(id: string) => NodeMetadata` | No source body. Includes neighbor counts |
| `rig_neighbors` | `(id: string, kind?: string, limit?: number) => EdgeRef[]` | Both directions, both edge tables |
| `rig_pull` | `(id: string, k?: number) => PullResult[]` | The magnetic-pull tool |
| `rig_callers` | `(id: string) => NodeRef[]` | Structural callers |
| `rig_callees` | `(id: string) => NodeRef[]` | Structural callees |
| `rig_impact` | `(id: string, depth?: number) => NodeRef[]` | Impact radius |
| `rig_status` | `() => StatusInfo` | Index health |
| `rig_files` | `(filter?: string) => FileInfo[]` | File listing |

Each tool: side-effect-free except `recordActivation()` on accessed nodes.

### 3.8 Heavy tools (Phase 1 scope)

| Tool | Signature | Notes |
|---|---|---|
| `rig_explore` | `(question: string, max_anchors?: number) => ExploreResult` | Full neighborhoods with source. Token-heavy. Main-session-forbidden |
| `rig_context` | `(task: string, max_nodes?: number, format?: 'markdown' \| 'json') => string` | Reshapes CodeGraph's `buildContext`; uses magnetic-pull to rank |

### 3.9 File watcher
Already pulled in Phase 0. Wire to `Rig.sync()`. Test: write a file → 2s debounce → sync runs → new nodes appear.

### 3.10 CLI commands (`packages/cli/`)
Implement (pull from `vendor/codegraph/src/bin/codegraph.ts` as template):
- `rig init [path]` — create `.rig/`, write default config
- `rig index [path] [--force] [--quiet]` — full extract + resolve + embed
- `rig sync [path]` — incremental
- `rig status [path]` — health info
- `rig query <search> [--kind] [--limit] [--json]` — CLI search
- `rig files [path]` — file listing
- `rig serve --mcp` — start MCP server on stdio
- `rig install` — interactive installer (Phase 1.11)

### 3.11 Installer + targets (`packages/cli/src/install.ts`, `packages/cli/src/targets/`)
Pull from CodeGraph:
- `installer/index.ts` flow
- `targets/claude.ts` — writes `~/.claude.json` mcpServers entry + `~/.claude/settings.json` auto-allow + `~/.claude/CLAUDE.md` instructions
- `targets/cursor.ts` — `~/.cursor/mcp.json` + `.cursor/rules/rig.mdc`
- `targets/codex.ts` — `~/.codex/config.toml` + `~/.codex/AGENTS.md`. Pull `targets/toml.ts` verbatim
- `targets/opencode.ts`
- `targets/registry.ts`, `targets/shared.ts`, `targets/types.ts`, `targets/hermes.ts`

**Rewrite the instructions template** (`installer/claude-md-template.ts`) for Rig's tool surface. Must include:
- The two-tier gate ("NEVER call `rig_explore` or `rig_context` directly in the main session")
- When to use `rig_pull` vs `rig_neighbors`
- A one-line description of magnetic pull (so the agent uses pull, not neighbors, for "what's related" questions)

### 3.12 Tests
At minimum:
- `db.test.ts` — schema migration golden file
- `extract.test.ts` — index a fixture project, verify counts
- `resolve.test.ts` — import resolution across files
- `pull.test.ts` — magnetic pull scoring with crafted graph
- `watcher.test.ts` — debounce + ignore self-writes
- `installer-targets.test.ts` — golden-file outputs for all 4 targets

### Acceptance for Phase 1
- [ ] `rig install` configures Claude Code in dry-run mode without errors
- [ ] `rig init && rig index` on a TS project with 100 files completes in < 15s
- [ ] `rig status` reports correct node/edge/file counts
- [ ] `rig query authStore` returns the expected symbol
- [ ] Claude Code (live, with Rig installed) answers "what touches authStore?" using `rig_pull` + `rig_neighbors` with **zero file reads** — verified by checking the tool-call log
- [ ] All Phase 1 tests pass under `bun test`
- [ ] Git tagged `v0.1.0-phase1`
- [ ] **Checkpoint:** record a 60-second screen recording of the live Claude Code interaction. This is your before/after for the Phase 2 demo.

---

## 4. Phase 2 — Localhost map UI (read-only)

**Goal:** open `http://localhost:7474/map`, see the graph, click a node, chat about it. No mutations yet.

### 4.1 Web server (`packages/web/src/server.ts`)
- Fastify with a single bearer token from `.rig/config.json` (auth only when binding to non-loopback)
- WebSocket via `ws` on the same port at `/ws`
- Reads the same SQLite DB as the MCP server (open in read-only mode)
- Watches the DB file with `fs.watch` for changes; pushes WS notifications on mutation

### 4.2 REST API surface
| Method | Path | Returns |
|---|---|---|
| GET | `/api/graph?limit=500` | `{ nodes, edges_structural, edges_semantic }` |
| GET | `/api/node/:id` | Full node metadata + neighbor counts |
| GET | `/api/node/:id/neighbors?kind=&limit=` | Edges (both directions, both tables) |
| GET | `/api/node/:id/pull?k=10` | Magnetic-pull results |
| GET | `/api/search?q=&kind=&limit=` | FTS5 search |
| GET | `/api/status` | Health |
| WS  | `/ws` | Server-pushed events (`node:added`, `edge:added`, `selection:requested`) |

CORS: allow only `localhost:7474` and the configured public host (if any).

### 4.3 Frontend scaffold (`packages/web/src/app/`)
- Vite + React + TypeScript
- Tailwind for layout primitives
- Vela for buttons, inputs, panels (use existing components from Bob's library)
- React Query for API data + cache invalidation on WS events

### 4.4 Map component (`packages/web/src/app/Map.tsx`)
- `react-force-graph-2d`
- Node radius scaled by `pull_score` (range 4–24)
- Node color by `kind` (function/class/module/markdown-heading)
- Edge thickness by weight (semantic edges fade from light to dark)
- Click handler emits selection to chat panel
- Camera follow on focus events

### 4.5 Node detail panel (`packages/web/src/app/NodeDetail.tsx`)
Top-of-side-panel summary of the selected node: name, kind, file path + line, caller/callee counts, pull score.

### 4.6 Chat panel (`packages/web/src/app/Chat.tsx`)
**Phase 2 scope is MCP-proxy only.**
- User types in the input → message sent to a thin Fastify endpoint `/api/chat/send`
- The endpoint spawns or reuses an MCP client connection to the user's Claude Code session
- Streams responses back via WS
- Each message is bound to the currently-selected anchor (passed as conversation prefix)

If the user has no Claude Code session running, show a clear empty state with install instructions. Direct mode is Phase 4.

### 4.7 Live data flow
- DB mutation in MCP server → SQLite write
- Web server's DB watcher fires → emits WS event
- React Query invalidates affected queries
- Force-graph animates the diff

### 4.8 Server lifecycle
- `rig serve --web [--port 7474] [--host 127.0.0.1]` starts the server
- `rig serve --all` starts MCP on stdio AND web on the configured port
- Graceful shutdown on SIGINT

### Acceptance for Phase 2
- [ ] `rig serve --web` starts and binds to `http://localhost:7474`
- [ ] Open browser, see the force-graph rendered with all anchors from the indexed project
- [ ] Click a node → side panel shows metadata, neighbor counts, pull score
- [ ] Type a question in chat → response streams back from connected Claude Code session
- [ ] Edit a source file → 2s later, map updates without page reload
- [ ] Map of 500 nodes is interactive within 2s of page load
- [ ] Bearer-token auth refuses connections when bound to non-loopback without a token
- [ ] Git tagged `v0.2.0-phase2`
- [ ] **Checkpoint:** record a 60-second video of the working UI

---

## 5. Phase 3 — Read-write (AI as co-cartographer)

**Goal:** the user asks "what other concepts pull on `authStore`?", Claude proposes 2 dashed edges with rationale, the user clicks accept, edges become solid. Under 60 seconds end to end.

### 5.1 Schema additions
The `edges_semantic` table already exists from Phase 1. Add:
```sql
CREATE TABLE IF NOT EXISTS pending_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  weight REAL NOT NULL,
  provenance TEXT NOT NULL,
  rationale TEXT NOT NULL,
  proposed_at INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected'))
);

CREATE TABLE IF NOT EXISTS mutation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,    -- 'add_node'|'add_edge'|'annotate'|'cluster'|'accept'|'reject'|'undo'
  payload TEXT NOT NULL, -- JSON
  actor TEXT NOT NULL    -- 'ai:claude'|'ai:gpt'|'user'
);
```

Migration v2.

### 5.2 Write tools (`packages/mcp/src/tools/`)

| Tool | Signature | Behavior |
|---|---|---|
| `rig_propose_edge` | `(src, dst, kind, weight, rationale) => PendingEdge` | Writes to `pending_edges` with status `pending`. Emits WS event. Returns the pending ID. *AI calls this; not `add_edge` directly* |
| `rig_add_node` | `(type, name, data, rationale) => Node` | Writes immediately (nodes are cheaper to add than edges). Provenance required |
| `rig_annotate` | `(node_id, note, rationale) => void` | Appends to `data.annotations` JSON array |
| `rig_cluster` | `(node_ids[], label, rationale) => Node` | Creates a meta-anchor of type `cluster` with `contains` edges |
| `rig_focus` | `(node_ids[]) => void` | UI hint; emits WS `focus:requested` event |

**Hard rule:** every write requires non-empty `rationale`. Enforce in the tool handler. Reject the call if missing.

### 5.3 Provenance enforcement
- `provenance` format: `ai:<model>` (e.g. `ai:claude-opus-4.7`), `user:<id>` (e.g. `user:bob`), `vector` (system), `ast` (system, structural-only)
- Every insert into `edges`, `edges_semantic`, `pending_edges`, or `nodes` (Phase 3+) must set provenance
- Add a SQLite trigger that rejects NULL provenance on inserts to these tables

### 5.4 WebSocket mutation broadcasting
Server emits, frontend listens:

| Event | Payload | UI effect |
|---|---|---|
| `node:added` | `{ node }` | Animate new circle into the force layout |
| `edge:added` | `{ edge, table }` | Draw solid edge |
| `edge:proposed` | `{ pending_edge }` | Draw dashed edge with rationale tooltip |
| `edge:accepted` | `{ pending_id, edge }` | Dashed → solid animation |
| `edge:rejected` | `{ pending_id }` | Dashed edge fades out |
| `focus:requested` | `{ node_ids }` | Camera pan + zoom |
| `selection:changed` | `{ node_id }` | Synchronize across multiple open tabs |

### 5.5 UI: dashed → accept → solid (`packages/web/src/app/`)
- Render `pending_edges` as dashed lines in the force-graph
- On hover, show a popover: `rationale`, `proposed_at`, `provenance`, and two buttons: Accept / Reject
- On Accept: POST `/api/pending-edges/:id/accept` → server moves the row into `edges_semantic`, deletes the pending, emits `edge:accepted`
- On Reject: PATCH the pending to `rejected`, emit `edge:rejected`

### 5.6 Undo log per session
- Every write to the graph appends to `mutation_log` with a `session_id`
- `rig_undo()` MCP tool: reverses the last mutation in the current session
- UI button: "Undo last AI edit"
- Undos are themselves mutations (logged with kind=`undo`) so the chain is auditable

### 5.7 Live subscription — bidirectional UI (`rig_subscribe`)
When the user clicks a node in the UI, the WS server emits `selection:changed`. The connected MCP client (Claude Code) receives this via a `rig_subscribe` long-poll or SSE endpoint, allowing the AI to respond *to what the user is looking at* without the user typing.

Practical implementation:
- The MCP client polls `rig_subscribe(since_ts)` every 2s and gets a batch of events
- The chat panel injects "user is now looking at <anchor>" as a system message before the next AI turn
- This is what makes the experience feel alive — the AI follows your gaze

### 5.8 Updated agent install (Phase 3 permissions)
The installer must now add to Claude Code's `settings.json`:
```json
{
  "permissions": {
    "allow": [
      "mcp__rig__rig_search",
      "mcp__rig__rig_node",
      "mcp__rig__rig_neighbors",
      "mcp__rig__rig_pull",
      "mcp__rig__rig_callers",
      "mcp__rig__rig_callees",
      "mcp__rig__rig_impact",
      "mcp__rig__rig_status",
      "mcp__rig__rig_files",
      "mcp__rig__rig_propose_edge",
      "mcp__rig__rig_add_node",
      "mcp__rig__rig_annotate",
      "mcp__rig__rig_cluster",
      "mcp__rig__rig_focus",
      "mcp__rig__rig_subscribe"
    ]
  }
}
```

**Heavy tools `rig_explore` and `rig_context` are intentionally NOT auto-allowed.** They require user approval per call. This is part of the two-tier gate.

Also update `CLAUDE.md` install template to add the write-tool guidance:
- Every write requires a non-empty rationale
- Use `propose_edge`, not `add_edge`, for semantic connections — the user accepts before they become canonical
- Use `add_node` directly only when extracting a new concept the user has named in conversation

### 5.9 Tests for Phase 3
- `write-tools.test.ts` — every write tool rejects calls with missing/empty provenance or rationale
- `pending-edges.test.ts` — propose → accept moves to `edges_semantic`; propose → reject leaves the table clean
- `mutation-log.test.ts` — log captures every mutation; `undo` reverses the last one
- `ws-mutations.test.ts` — propose an edge via MCP, verify WS broadcast within 100ms
- E2E (puppeteer or playwright): index a fixture project, start the web server, programmatically trigger an `edge:proposed` event via direct MCP call, click accept in the UI, verify edge is in `edges_semantic`

### Acceptance for Phase 3 — definition of done

**The 60-second demo must work end-to-end:**
1. User opens a fresh TS project, runs `rig init && rig index`
2. User runs `rig serve --all`
3. User opens `http://localhost:7474/map` and Claude Code in another window
4. User clicks the `authStore` node in the map
5. User types in the embedded chat panel: "what other concepts pull on authStore?"
6. Within 10 seconds, two dashed edges appear on the map with rationales
7. User hovers one of them → sees Claude's rationale → clicks Accept → edge becomes solid
8. User clicks Reject on the other → it fades out
9. User clicks the new solidified edge → its target node becomes the new selection
10. User clicks "Undo" in the UI → the accepted edge reverts to dashed
11. Total elapsed time: under 60 seconds

Plus the following checklist:
- [ ] All Phase 3 write tools refuse calls missing provenance or rationale
- [ ] `mutation_log` records every mutation with actor + payload
- [ ] WS events delivered to UI within 100ms of MCP call
- [ ] Open two browser tabs of the map; an edge accepted in tab A appears in tab B within 1s
- [ ] `rig install` adds Phase 3 permissions correctly (golden-file test)
- [ ] All tests pass under `bun test`
- [ ] Performance budgets still met
- [ ] Git tagged `v0.3.0-phase3`
- [ ] **Final checkpoint:** record a 90-second video of the 60-second demo + the broader feature set. This is the ship video

---

## 6. Failure modes — when to ask Bob vs proceed

| Situation | Action |
|---|---|
| Acceptance criterion not met after 2 honest attempts | Stop. Summarize attempts. Ask Bob |
| Performance budget missed by < 20% | Note it; proceed; address in a perf pass at end of phase |
| Performance budget missed by > 50% | Stop. Likely architectural; ask Bob |
| CodeGraph file we pulled has changed upstream during build | Use the version in our `vendor/codegraph` snapshot; do not chase main |
| New decision needed that isn't in the locked list | Stop. Ask Bob. Do not invent a default |
| Test failure that looks like a flaky test | Run 3x. If consistent, fix. If 1 of 3, mark `.todo` and continue with a note |
| External dependency breakage (e.g. transformers model 404) | Stop. Ask Bob — there may be a pinned mirror |

---

## 7. Glossary

- **Anchor.** A node in the graph. May be a code symbol, a markdown heading, a concept, or any user-defined node type.
- **Magnetic pull.** A blended score (structural distance + semantic similarity + recency) used to surface the most relevant nearby anchors.
- **Rig.** The full graph for a given project.
- **Provenance.** The actor that produced a node or edge: `ast`, `vector`, `ai:<model>`, `user:<id>`.
- **Co-cartographer.** An AI agent with write access to the rig, mediated by the propose→accept loop.
- **Pending edge.** An AI-proposed semantic edge awaiting user accept/reject.
- **Mutation log.** Append-only audit trail of every graph write.
- **Session ID.** A UUID per MCP session; used to scope undos.
- **Light tool.** A read-only MCP tool safe to call in the main session. Returns IDs and metadata only.
- **Heavy tool.** A read-only MCP tool that returns full source/neighborhood content. Forbidden in main session; must be called from a spawned sub-agent.
- **Write tool.** A graph-mutating MCP tool. Requires provenance + rationale on every call.

---

## 8. Final repo structure after Phase 3

```
rig/
├── package.json            # workspaces root
├── bun.lockb
├── tsconfig.json
├── LICENSE
├── LICENSE-CODEGRAPH.txt
├── README.md
├── docs/
│   ├── frederick-pov.md
│   └── codegraph-snapshot.md
├── vendor/
│   └── codegraph/          # gitignored
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── index.ts          # Rig class
│   │       ├── db/
│   │       │   ├── schema.sql
│   │       │   ├── migrations.ts
│   │       │   ├── queries.ts
│   │       │   └── sqlite-adapter.ts
│   │       ├── extract/
│   │       │   ├── tree-sitter.ts
│   │       │   ├── grammars.ts
│   │       │   ├── parse-worker.ts
│   │       │   └── languages/
│   │       │       ├── typescript.ts
│   │       │       ├── javascript.ts
│   │       │       ├── python.ts
│   │       │       └── markdown.ts
│   │       ├── resolve/
│   │       │   ├── index.ts
│   │       │   ├── import-resolver.ts
│   │       │   ├── name-matcher.ts
│   │       │   └── path-aliases.ts
│   │       ├── graph/
│   │       │   ├── traversal.ts
│   │       │   └── queries.ts
│   │       ├── embed.ts
│   │       ├── pull.ts
│   │       ├── context.ts
│   │       ├── search.ts
│   │       ├── watch.ts
│   │       ├── watch-policy.ts
│   │       └── util/
│   ├── mcp/
│   │   └── src/
│   │       ├── server.ts
│   │       ├── transport.ts
│   │       ├── server-instructions.ts
│   │       └── tools/
│   │           ├── search.ts
│   │           ├── node.ts
│   │           ├── neighbors.ts
│   │           ├── pull.ts
│   │           ├── callers.ts
│   │           ├── callees.ts
│   │           ├── impact.ts
│   │           ├── status.ts
│   │           ├── files.ts
│   │           ├── explore.ts          # heavy
│   │           ├── context.ts          # heavy
│   │           ├── propose-edge.ts     # Phase 3
│   │           ├── add-node.ts         # Phase 3
│   │           ├── annotate.ts         # Phase 3
│   │           ├── cluster.ts          # Phase 3
│   │           ├── focus.ts            # Phase 3
│   │           ├── subscribe.ts        # Phase 3
│   │           └── undo.ts             # Phase 3
│   ├── web/
│   │   └── src/
│   │       ├── server.ts
│   │       ├── api/
│   │       ├── ws/
│   │       └── app/
│   │           ├── Map.tsx
│   │           ├── Chat.tsx
│   │           ├── NodeDetail.tsx
│   │           ├── PendingEdgeTooltip.tsx
│   │           └── UndoButton.tsx
│   └── cli/
│       └── src/
│           ├── index.ts
│           ├── node-version-check.ts
│           ├── install.ts
│           ├── claude-md-template.ts
│           ├── instructions-template.ts
│           ├── config-writer.ts
│           ├── targets/
│           │   ├── claude.ts
│           │   ├── cursor.ts
│           │   ├── codex.ts
│           │   ├── opencode.ts
│           │   ├── hermes.ts
│           │   ├── registry.ts
│           │   ├── shared.ts
│           │   ├── types.ts
│           │   └── toml.ts
│           └── ui/
└── __tests__/
    ├── db.test.ts
    ├── extract.test.ts
    ├── resolve.test.ts
    ├── pull.test.ts
    ├── watcher.test.ts
    ├── installer-targets.test.ts
    ├── write-tools.test.ts
    ├── pending-edges.test.ts
    ├── mutation-log.test.ts
    └── ws-mutations.test.ts
```

---

*End of execution plan. When you reach the Phase 3 definition of done, stop. Do not start Phase 4 in the same session — record the demo, ship the tag, and check in with Bob about the model-agnostic chat layer and other phase-4 priorities.*