# Rig — Build Brief for Claude Code

> **Working name:** Rig. A local-first semantic knowledge graph with an interactive map UI and an AI co-cartographer. Inspired by Obsidian's graph view, architected on the CodeGraph pattern (github.com/colbymchenry/codegraph), and grounded in a "constellation points with magnetic pull" model of knowledge organization.
>
> **Read all of Section 1 before writing any code.** The philosophy determines architectural decisions you'll otherwise get wrong. This is not flavor text — it is the spec.

---

## 1. The Frederick POV — philosophical foundation

Named after Friedrich Nietzsche, whose constellation-of-thought metaphor shapes the entire model. You must internalize this section.

### 1.1 Constellation points (anchors)

Knowledge is not stored as a flat document set or a dense embedding cloud. It is organized as **constellation points** — discrete, named anchors that each represent a concentrated idea, entity, or symbol. A constellation point is *not* a fact; it is a **decompression seed** that, when activated, unfolds into its related context on demand.

The Big Dipper is the working metaphor: a constellation is a concentration of stars, where each star carries deeper meaning. Each anchor is a star; the sub-points orbiting it are systems hidden behind that single dot. The system's job is to keep the dots cheap and the unfolding selective.

### 1.2 Magnetic pull

An anchor has many *potential sub-trajectories* — call them x¹, x², ... xⁿ where n can reach ~100. These are not all expanded at once. **The entire point of the system is to compress conversations by deferring decompression.** When a query arrives:

1. The system identifies which anchor(s) the query touches.
2. It scores each candidate sub-point by *magnetic pull* — a blend of:
   - **graph proximity** (structural distance via deterministic edges)
   - **semantic similarity** (vector cosine over embeddings)
   - **recency of activation** (was this anchor touched recently?)
3. It expands only the top-K sub-points and feeds those to the LLM, not all n.

This is the difference between Rig and a vector DB: vector DBs return *similar text*; Rig returns *resolved anchors with their probabilistically-selected immediate neighborhood*.

### 1.3 Decompression on demand

The main session never holds the full graph. It holds anchor IDs. When the LLM needs depth on an anchor, it either calls a heavy tool that returns the unfolded neighborhood, or spawns a sub-agent whose context is discarded after the answer. This mirrors human memory: we hold semantic anchors and decompress them only when needed. Token savings compound dramatically on long sessions.

### 1.4 Validation before connection

Nietzsche's Übermensch — the figure who *creates values* — informs the writer-side of this system. New connections are not drawn casually. Before an AI agent draws an edge between two anchors, it must validate the connection (via research, code analysis, or stated user intent). The graph is opinionated about what counts as an edge. **Every edge has provenance** — who drew it, when, and why.

### 1.5 What this implies for architecture

- Graph schema must support **weighted, typed, provenance-tagged edges.**
- Tool API must be **two-tier**: lightweight tools returning only anchor IDs and metadata (callable in main session); heavy tools returning full neighborhoods (callable only by sub-agents).
- Retrieval must blend **structural traversal** with **semantic similarity** rather than choose one.
- UI must make magnetic pull **visually legible** — edge thickness encodes weight, node prominence encodes pull score, distant nodes fade.

---

## 2. The reference architecture — CodeGraph

CodeGraph proved this works *for code*. We extract its patterns and extend the model beyond code to general knowledge.

### 2.1 What we copy from CodeGraph (verbatim or near-verbatim)

- **SQLite + FTS5** as the storage layer, in a `.rig/` per-project directory. No cloud DB, no Postgres, no separate vector service.
- **Single Node/Bun binary** that serves as installer, indexer, MCP server, and web server. Distributed via npm.
- **Two-tier tool API**: light tools (search, neighbors, callers, callees, node) safe for main session; heavy tools (explore, context) callable only by sub-agents.
- **Global agent instructions pattern**: writer to `~/.claude/CLAUDE.md`, `.cursor/rules/rig.mdc`, `~/.codex/AGENTS.md` during install — each agent gets told *when* to use which tool.
- **Tree-sitter for structural extraction** where applicable (code, markdown, structured text). Deterministic. Zero LLM cost at index time.
- **File watcher** using native OS events (FSEvents/inotify/ReadDirectoryChangesW) + 2-second debounce + incremental sync.
- **MCP-over-stdio** for agent integration.
- **Extraction → resolution → indexing pipeline** as three separable phases. Re-running resolution with new heuristics must not require re-parsing.

### 2.2 What we extend beyond CodeGraph

- **Domain-agnostic anchors.** CodeGraph anchors are code symbols only. Rig anchors can be code symbols, markdown sections, document concepts, business entities, change initiatives, signals — any user-defined node type.
- **Semantic edges alongside structural edges.** CodeGraph has only structural edges (calls, imports, extends). Rig has a second edge table for semantic similarity, tagged with provenance and magnitude. The blend of structural + semantic is what produces *magnetic pull*.
- **Read-write graph.** CodeGraph is read-only — the agent only queries. Rig lets agents *mutate* the graph: add nodes, draw edges, annotate, cluster. Every mutation tagged with provenance.
- **A web UI layer.** CodeGraph ships no visualization. Rig ships a localhost-served interactive map with an embedded chat panel.

---

## 3. What we're building — Rig

### 3.1 The graph model

Initial SQLite schema (refine in Phase 1 but preserve the split between structural and semantic edges — it is the architectural shape of the magnetic-pull model):

```sql
-- core anchors
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'symbol' | 'document' | 'concept' | 'entity' | user-defined
  name TEXT NOT NULL,
  data JSON NOT NULL,           -- type-specific payload (path, line, summary, ...)
  pull_score REAL DEFAULT 0,    -- aggregate magnetic pull, recomputed periodically
  created_at INTEGER,
  updated_at INTEGER
);

-- structural edges (deterministic — from AST, file structure, schema)
CREATE TABLE edges_structural (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'calls' | 'imports' | 'extends' | 'contains' | ...
  created_at INTEGER,
  PRIMARY KEY (src, dst, kind),
  FOREIGN KEY (src) REFERENCES nodes(id),
  FOREIGN KEY (dst) REFERENCES nodes(id)
);

-- semantic edges (vector similarity, drawn by AI, or asserted by user)
CREATE TABLE edges_semantic (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  weight REAL NOT NULL,         -- 0..1 magnetic pull magnitude
  provenance TEXT NOT NULL,     -- 'vector' | 'ai:claude' | 'ai:gpt' | 'user'
  rationale TEXT,               -- why this edge exists (especially for AI-drawn)
  created_at INTEGER,
  PRIMARY KEY (src, dst, provenance),
  FOREIGN KEY (src) REFERENCES nodes(id),
  FOREIGN KEY (dst) REFERENCES nodes(id)
);

-- FTS5 over nodes for fast name search
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  name, data, content='nodes', content_rowid='rowid'
);

-- vector embeddings (one row per node)
CREATE TABLE embeddings (
  node_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  vector BLOB NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

-- activation log (for recency-of-activation scoring)
CREATE TABLE activations (
  node_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL          -- 'query' | 'expand' | 'click' | 'ai'
);
```

### 3.2 The MCP tool surface

**Light tools (safe in main session — return IDs and metadata only):**

- `rig_search(query, kind?)` → matching node IDs + names + types
- `rig_node(id)` → node metadata, structural neighbor counts, no body
- `rig_neighbors(id, kind?, limit?)` → immediate neighbors with edge metadata
- `rig_pull(id, k=10)` → top-K most magnetically-pulled neighbors blending structural + semantic + recency

**Heavy tools (sub-agents only — return full neighborhoods):**

- `rig_explore(question, max_anchors=20)` → decompresses relevant anchors and returns full context
- `rig_context(task, max_nodes=20, format)` → builds an LLM-ready context block

**Write tools (Phase 3 — every call requires provenance):**

- `rig_add_node(type, name, data)`
- `rig_add_edge(src, dst, kind, weight?, rationale)`
- `rig_annotate(node_id, note)`
- `rig_cluster(node_ids[], label)` — group into a meta-anchor
- `rig_focus(node_ids[])` — UI camera hint

**Live tools (for bidirectional UI):**

- `rig_subscribe()` → agent receives user-interaction events (clicks, hovers, selections) so it can respond to what the user is looking at

### 3.3 The web UI

**Stack:** Bun + Fastify backend, React + react-force-graph + Vela component library on the frontend, WebSocket for live mutations.

**Default URL:** `http://localhost:7474/map`. Host/port configurable via `.rig/config.json`. Bearer-token auth when bound to anything other than `127.0.0.1`.

**Layout:**
- **Top bar:** URL indicator, model selector, share/copy-link icon
- **Main canvas:** force-directed graph. Edge thickness encodes weight. AI-drawn edges shown dashed until the user accepts them.
- **Right panel:** selected-node header, chat thread bound to that anchor, input box
- **Status bar:** anchor count, edge count, last sync timestamp

The chat panel is **bound to whichever anchor is selected**. Switching anchors switches conversation context. AI responses can include map mutations — these animate in real-time over WebSocket. This is the killer feature: the AI is a cartographer working on the same map the user is looking at.

### 3.4 The chat layer

Two transport modes, both configurable, both shippable simultaneously:

- **MCP mode** — chat is a proxy that forwards user input to the connected Claude Code (or Cursor / Codex / opencode) session via MCP. Zero API key setup. Locked to the agent the user already has.
- **Direct mode** — chat is an OpenAI-compatible HTTP client; user pastes any API key (Anthropic, OpenAI, OpenRouter, Groq). Model-agnostic.

Default to MCP mode for installed agents; offer Direct mode in settings.

---

## 4. Build phases

### Phase 0 — scaffold
- Bun monorepo with `packages/core`, `packages/mcp`, `packages/web`, `packages/cli`.
- `rig init` writes `.rig/` to the current project.
- **Acceptance:** `rig init && rig status` works.

### Phase 1 — read-only MCP server (mirrors CodeGraph)
- Tree-sitter extraction for TypeScript, Python, and Markdown at minimum.
- Light tools fully wired. Heavy tools fully wired.
- Global agent install: writes MCP config + CLAUDE.md instructions.
- **Acceptance:** Claude Code answers "what touches authStore?" using only `rig_search` + `rig_neighbors` with zero file reads.

### Phase 2 — localhost map UI (read-only)
- Bun-served React app at `localhost:7474`.
- Force-directed graph reading from `.rig/rig.db`.
- Click an anchor → see its sub-points + structural neighborhood in the right panel.
- Chat panel in MCP mode (proxying to the user's Claude Code session).
- **Acceptance:** open localhost, see the graph, click a node, chat about it. No mutations yet.

### Phase 3 — read-write (AI as co-cartographer)
- Write tools added. Provenance tracked on every edge.
- WebSocket pushes mutations to the UI in real-time.
- AI-drawn edges shown dashed until the user accepts them; per-session undo log.
- **Acceptance:** ask the AI "what other concepts pull on authStore?" → it adds 2 semantic edges with rationales → they appear dashed on the map → user clicks "accept" → they become solid.

### Phase 4 — multi-agent + Direct chat mode
- Installer auto-detects Cursor, Codex CLI, opencode and writes appropriate config files (mirror CodeGraph's `targets/` pattern).
- Direct chat mode added to the web UI as a model selector.
- **Acceptance:** same install command works across all four agents; embedded chat works with any provider's API key.

---

## 5. Starting file structure

```
rig/
├── package.json
├── bunfig.toml
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── db.ts                 # SQLite + migrations
│   │   │   ├── graph.ts              # Node/edge API
│   │   │   ├── extract/              # Tree-sitter extractors per language
│   │   │   ├── embed.ts              # Embedding provider abstraction
│   │   │   ├── pull.ts               # Magnetic-pull scoring
│   │   │   └── watch.ts              # File watcher + debounce
│   │   └── package.json
│   ├── mcp/
│   │   ├── src/
│   │   │   ├── server.ts             # MCP stdio server
│   │   │   ├── tools/                # one file per tool
│   │   │   └── targets/              # claude.ts, cursor.ts, codex.ts, opencode.ts
│   │   └── package.json
│   ├── web/
│   │   ├── src/
│   │   │   ├── server.ts             # Fastify + WebSocket
│   │   │   ├── app/
│   │   │   │   ├── Map.tsx           # react-force-graph
│   │   │   │   ├── Chat.tsx
│   │   │   │   └── NodeDetail.tsx
│   │   │   └── api/                  # REST endpoints over core
│   │   └── package.json
│   └── cli/
│       ├── src/
│       │   ├── install.ts            # interactive installer
│       │   ├── init.ts
│       │   └── index.ts              # rig entrypoint
│       └── package.json
└── docs/
    └── frederick-pov.md              # philosophy file referenced from CLAUDE.md
```

---

## 6. Coding conventions

- **TypeScript strict, Bun runtime.** No Node-only APIs unless polyfilled.
- **No global state.** Pass `Rig` instances explicitly.
- **Errors are values.** Use Result types or explicit unions, not throws across module boundaries.
- **Every graph mutation has provenance.** No anonymous writes.
- **The `Rig` class is the only public API surface from `core/`.** Everything else is internal.
- **No new dependencies without justification.** Tree-sitter, `bun:sqlite`, Fastify, react-force-graph, embedding library — anything else needs a one-line reason.
- **Test the schema migration path from day one.** The `.rig/` directory will outlive the binary version that created it.

---

## 7. Open decisions — confirm before assuming

These were left intentionally undecided. **Ask before starting any phase that depends on them.**

1. **Read-only or read-write from day one?** Phase 2 ships fine without write tools. Phase 3 is where Rig becomes its own product rather than "CodeGraph with a UI." Default: ship Phase 2 read-only first, then read-write as v0.2.

2. **First concrete use case — code (extend CodeGraph) or TCA's ChangeSignal graph?** The extraction layer differs: tree-sitter for code, structured schema-driven for TCA. Default: code first for faster validation and to ride CodeGraph's existing distribution.

3. **Embedding model.** Local (gte-small, jina-embeddings, BGE) or hosted (OpenAI text-embedding-3-small, Voyage)? Default: local, with hosted available via config.

4. **StickyInc integration.** Ship Rig as a StickyInc panel from day one, or standalone first? Default: standalone first, then a StickyInc adapter once the public API stabilizes.

---

## 8. Anti-goals — what this is not

- Not a code review tool. CodeGraph already does that.
- Not a chat client. The embedded chat is a thin surface bound to the map; it is not a general-purpose Claude UI.
- Not a hosted SaaS. Rig is local-first. Multi-tenant deployment is out of scope.
- Not a Pinecone/Weaviate competitor. The vector layer exists only to feed magnetic-pull scoring, not as a general-purpose embedding store.

---

*End of brief. When you begin work, summarize what you understood from Section 1 and the architectural implications in 7.5 before you write any code. Surface any contradictions you see in this document before resolving them silently.*