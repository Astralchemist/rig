# Rig — Iteration Backlog v0.4

> Companion to the four foundation docs (build brief, extraction map, Phase 3 plan, Phase 1.5 contracts). Holds every architectural idea sketched in conversation that didn't make it into the original spec set. Each item is structured so it can be promoted to its own addendum when you're ready to build it.
>
> **Snapshot taken at:** end of the conversation that produced the original four docs, after Phase 0/1/2 shipped and the screenshot showing 792 nodes / 223 edges / 202 files.
>
> **Read order before touching this backlog:** finish the extractor diagnostic (Section 0.1 below), confirm the connectivity ratio reaches 2–5 edges/node on the same codebase, then come back here. Most of the prioritization assumes structural edges work correctly.
>
> **How these items compose:** see `integration.md` — it maps every item to one of five integration seams (pull formula, node-type registry, edge-kind registry, mutation spine, pulse stream) and the four long-pole chains.

---

## 0. Where we are

### 0.1 Pre-existing diagnostic (do this first)

The screenshot review surfaced one issue that needs to be cleared before any backlog work starts:

- 223 edges / 792 nodes ≈ 0.28 edges/node — far too low for a real TS codebase
- `MutationRow` interface shows zero neighbors despite being defined in a real `.ts` file
- Likely cause: `packages/core/src/extract/languages/typescript.ts` handles concrete imports but not type-only references (`type_identifier`, `predefined_type` AST nodes)

**Acceptance for "ready to start the backlog":** re-index the same codebase, see 2–5 edges/node, see `MutationRow` showing incoming `references` edges from its usage sites. Magnetic pull's structural component (`s`) will start showing non-zero values automatically once edges exist.

### 0.2 Shipped foundation

What the four docs already produced:

- Phase 0 — scaffold, workspaces, vendored tree-sitter extraction layer
- Phase 1 — read-only MCP server with light + heavy tools, embeddings, magnetic-pull scoring
- Phase 1.5 — contract layer (if applied; confirm before assuming downstream)
- Phase 2 — localhost map UI with force-graph, selection, chat bound to selected node
- Phase 3 — scaffolding present (the `undo` button in the UI suggests at least the write-tool surface exists; confirm whether the propose → accept loop is wired end-to-end)

### 0.3 What's intentionally not in this doc

Implementation prose for things already specced — the four foundation docs cover that. This is the **next-wave architecture**.

---

## 1. How to use this doc

Each backlog item follows the same structure:

```
### Code. Name
- One-liner
- Why it matters
- Schema additions
- New tools
- Acceptance
- Dependencies
- Risk surface
```

The codes are letter+number (A1, B2, C3, …) for cross-reference. A ★ on **Risk surface** means the risks are open enough that the item starts with a deep-research pass when its turn comes. Sections A–G group items by theme. Section 3 gives a recommended sequence across themes; Section 4 lists decisions that need locking before building.

Items are sized so each can be promoted into a full implementation spec — like the Phase 1.5 contracts addendum — when its turn comes. The body of each item is enough to remember the design without re-deriving it from chat.

---

## 2. Backlog items

### A. Graph enrichment

#### A1. Hub-and-spoke topology

**One-liner.** Any node can be a hub; hubness is computed from graph structure; navigation flows hub → sub.

**Why.** Makes 5k+ node graphs legible. Drops token cost on broad queries by roughly 5×. Falls out of existing schema for free.

**Schema:**
```sql
ALTER TABLE nodes ADD COLUMN is_hub BOOLEAN DEFAULT FALSE;
ALTER TABLE nodes ADD COLUMN hubness REAL DEFAULT 0;
CREATE INDEX idx_nodes_hub ON nodes(is_hub) WHERE is_hub = TRUE;
```

**Hubness formula:**
```
hubness(node) =
    w_fanout      * outgoing_contains_edges(node)
  + w_centrality  * betweenness_centrality(node)
  + w_heat        * heat_score(node)              -- from C1
  + w_explicit    * is_marked_as_hub(node)
```

Starting weights: `w_fanout=0.35, w_centrality=0.30, w_heat=0.20, w_explicit=0.15`. Threshold for `is_hub=TRUE`: top 5% by `hubness` per anchor type.

**New tools:**
- `rig_hubs(scope?, limit=20)` — top hubs in scope (default: whole graph)
- `rig_hub_of(node_id)` — the hub(s) a sub-node belongs to
- `rig_drill(hub_id, query?)` — explore a hub's sub-tree, optionally filtered
- `rig_promote(node_id, rationale)` — explicit hub mark, provenance-tagged

**Acceptance.**
- [ ] `is_hub` and `hubness` populated at index time
- [ ] `rig_hubs` returns top-N anchors sorted by hubness
- [ ] UI defaults to hub-mode rendering when node count > 5,000
- [ ] `rig_pull` re-ranks light-tier results to surface hubs first
- [ ] `rig_drill` returns sub-nodes ranked by their pull score within the hub

**Dependencies.** None — builds on existing schema. Improves dramatically once C1 (heat) is in.

**Risk surface.** Cross-cutting concerns (sub-nodes belonging to multiple hubs). Ship with primary-only assignment; add multi-hub or shared-tier in a follow-up if real usage exposes the gap.

---

#### A2. Package manifests as first-class hubs

**One-liner.** Treat dependency-declaration files (`package.json`, `requirements.txt`, `pyproject.toml`, etc.) as queryable anchors carrying version metadata, not as opaque text.

**Why.** Vibecoded apps are ~25% imports. Dependency questions ("what version of pandas do I have?") become 1-hop lookups instead of grep. Conflict detection, unused-dep detection, and version-bump impact all become graph queries.

**New anchor types.**
- `package-manifest` — represents a single declaration file
- `declared-dependency` — one entry within a manifest, with version on the node:
  ```json
  {
    "name": "pandas",
    "version": "2.1.4",
    "spec": "^2.1.0",
    "source": "pypi",
    "manifest_path": "requirements.txt",
    "is_dev": false
  }
  ```

**New edge kinds.**
- `manifest_declares` — manifest → declared-dependency
- `imports_package` — code-symbol → declared-dependency (when an import resolves)
- `resolves_to` — declared-dependency → installed-version (from lock files)

**New extractors** in `packages/core/src/extract/manifests/`:
- `package.json`, `package-lock.json`, `bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`
- `requirements.txt`, `requirements-dev.txt`
- `pyproject.toml`, `Pipfile`, `poetry.lock`, `uv.lock`
- `Cargo.toml`, `Cargo.lock`
- `go.mod`, `go.sum`

**New tools.**
- `rig_deps(manifest_path?)` — list declared deps
- `rig_dep_conflicts()` — same package, different versions across manifests
- `rig_unused_deps()` — declared with zero `imports_package` incoming edges
- `rig_phantom_imports()` — imports without `resolves_to` resolution

**Acceptance.**
- [ ] All 7 listed package-manager formats parse correctly via golden-file tests
- [ ] Querying "pandas" returns the declared-dependency with version in the data field, no traversal needed
- [ ] `rig_dep_conflicts` flags a project that declares pandas 2.1.4 in requirements.txt and 2.2.0 in pyproject.toml
- [ ] `rig_unused_deps` correctly identifies a dep declared but never imported

**Dependencies.** A1 (hubs) — these are automatic hubs via the hubness formula.

**Risk surface.** Lock-file parsers are format-specific and brittle to format-version changes. Pin the parser version per format; emit warnings on unknown shapes.

---

#### A3. Obsidian-style aliases

**One-liner.** A node can have multiple names that all resolve to the same canonical anchor.

**Why.** Code symbols, doc concepts, and waypoints frequently have multiple names (`useState` vs `React.useState`, `pandas` vs `pd`, `the Sovereign move` vs `declarative contracts`). Aliases collapse them into one anchor instead of producing duplicates.

**Schema:**
```sql
CREATE TABLE aliases (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  provenance TEXT NOT NULL,     -- 'ast' | 'user' | 'ai:<model>'
  PRIMARY KEY (node_id, alias)
);
CREATE INDEX idx_aliases_alias ON aliases(alias);

-- FTS5 union: search nodes.name OR aliases.alias
```

**FTS5 integration.** Search joins against both `nodes.name` and `aliases.alias` so a query for any alias finds the canonical node.

**New tools.**
- `rig_add_alias(node_id, alias, rationale)` — Phase 3 write tool, provenance required
- `rig_aliases(node_id)` — list aliases for a node

**Acceptance.**
- [ ] Indexing `pandas` Python imports creates `pd` as an automatic alias via AST inspection
- [ ] Searching `pd` returns the same node as `pandas`
- [ ] User can add an explicit alias via the UI / MCP tool with rationale

**Dependencies.** Phase 3 write tools (already on the roadmap).

**Risk surface.** Alias collisions across unrelated anchors. Enforce that an alias can only resolve to one canonical node within an anchor type; conflicts surface as a UI warning, not a hard error.

---

#### A4. GraphRAG community detection (no LLM)

**One-liner.** Run Leiden algorithm on the graph at index time to assign every node a community ID. Pre-computed clusters power local-vs-global retrieval.

**Why.** At 10k+ nodes the UI needs visual clustering. Community detection is cheap, deterministic, and doesn't need any LLM. Provides the "community boost" term for magnetic pull.

**Schema:**
```sql
ALTER TABLE nodes ADD COLUMN community_id INTEGER DEFAULT NULL;
CREATE INDEX idx_nodes_community ON nodes(community_id);

CREATE TABLE communities (
  id INTEGER PRIMARY KEY,
  size INTEGER NOT NULL,
  label TEXT,                   -- optional human-readable name
  computed_at INTEGER NOT NULL
);
```

**Algorithm.** Leiden, weighted by both structural and semantic edges. Re-run on bulk changes (>50 edges added/removed in a sync), gated behind a 30-second debounce. Incremental Leiden for the >100k case lives in F3.

**New tools.**
- `rig_communities(limit=20)` — list communities ranked by size or by recent activity
- `rig_community_of(node_id)` — community + its other members

**Magnetic pull addition.**
```
score += w_community * sameCommunity(anchor, candidate)   // 1.0 if same, 0.0 otherwise
```
Starting weight: `w_community=0.15`. Rebalance other weights accordingly.

**Acceptance.**
- [ ] Index a 5k-node codebase, see communities of 50–500 nodes each
- [ ] UI colors nodes by community in a toggleable view
- [ ] `rig_pull` returns higher scores for candidates in the same community as the anchor

**Dependencies.** A1 (hubs benefit from community signal in the hubness formula).

**Risk surface.** Leiden non-deterministic across runs. Pin a random seed; record `computed_at` so the user can tell when community labels are stale.

---

#### A5. Mem0-style consolidation job

**One-liner.** Periodic background job that merges redundant nodes (same name, same kind, same file) and consolidates near-duplicate semantic edges.

**Why.** Repeated indexing of churning code creates duplicate nodes for renamed/moved entities. Aliases handle the alternate-name case (A3); consolidation handles the actual-duplicate case.

**Mechanism.** Nightly job (or on `rig consolidate` CLI command):
1. Find groups of nodes with identical `(name, kind, file_path)` triples
2. Pick the one with the most edges as canonical; rewrite edges from the others to point at the canonical; mark the others for deletion
3. For semantic edges between the same pair within `±epsilon` of weight, keep only the most recent

**New tools.** CLI only: `rig consolidate [--dry-run]`. MCP can call this via a heavy tool if needed.

**Acceptance.**
- [ ] Dry-run mode prints the merge plan without changes
- [ ] Real run reduces node count without breaking any queries
- [ ] Mutation log records every consolidation step (so it's auditable and reversible)

**Dependencies.** Phase 3 mutation log.

**Risk surface.** Aggressive consolidation can erase intentional duplicates. Default to dry-run; require explicit `--apply` to commit.

---

### B. Memory layer

#### B1. Conversation waypoints (basic)

**One-liner.** Discrete, structured markers the AI drops at decision points in a conversation. Survive context-window compaction.

**Why.** Context windows fill. Compaction is lossy. Waypoints are structured data that the AI is instructed to preserve verbatim even when the surrounding prose is summarized. Each carries an analogy + summary + refs into the graph for on-demand rehydration.

**Schema:**
```sql
-- waypoints use existing nodes table with type='conversation-waypoint'
-- data field carries the JSON shape below

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  title TEXT,
  context_model TEXT
);
```

Waypoint data shape:
```json
{
  "session_id": "...",
  "type": "decision | observation | constraint | open-question | principle",
  "title": "Lock TS + Bun as primary stack",
  "analogy": "The Sovereign move",
  "summary": "Bun runtime with bun:sqlite primary, better-sqlite3 fallback for Node ≥20",
  "constellation_refs": ["node:phase3_plan#0.1", "node:build_brief#3.2"],
  "predecessors": ["wp_039"],
  "key_terms": ["bun", "sqlite", "native-deps"],
  "compactable": false
}
```

**New edges.**
- `waypoint_succeeds` — waypoint → predecessor waypoint
- `waypoint_references` — waypoint → any graph node

**New tools.**
- `rig_drop_waypoint(title, type, summary, analogy, refs[])` — AI marks a decision
- `rig_recall_waypoint(id_or_analogy)` — retrieve full context
- `rig_waypoints(session_id?, type?, limit?)` — list waypoints
- `rig_chain(waypoint_id, depth=10)` — walk predecessor chain
- `rig_relevant_waypoints(query, k=5)` — vector similarity over intent vectors

**CLAUDE.md addition.** Install template gains a section: "drop a waypoint when you make a decision, when the user states a constraint, when an observation recurs, or when an open question emerges. Never compact past waypoints."

**Acceptance.**
- [ ] AI drops waypoints during a real Claude Code session
- [ ] `rig_chain` reconstructs the reasoning thread of a multi-turn session
- [ ] Opening a new chat tomorrow: `rig_waypoints session:last limit:20` lets the agent pick up oriented

**Dependencies.** Phase 3 write tools and mutation log.

**Risk surface.** Waypoint spam if the AI drops one per turn. Mitigate via a CLAUDE.md instruction with explicit threshold guidance plus a rate-limit at the tool layer (max 1 per N turns).

---

#### B2. Polymorphic waypoint payloads

**One-liner.** Waypoints carry not just text but mermaid diagrams, image refs, doc fragments, code snippets, and dataset pointers.

**Why.** Some decisions are best preserved visually (a UI mockup, an architecture diagram). The waypoint becomes a multi-modal memory cell, not a text-only summary.

**Schema addition.** The waypoint's `data` field gains a `payloads[]` array:
```json
{
  "payloads": [
    { "type": "text-summary", "content": "..." },
    { "type": "mermaid-diagram", "content": "graph TD; A-->B" },
    { "type": "image-ref", "path": ".rig/media/wp_042-mockup.svg" },
    { "type": "doc-fragment", "content": "## Decision: ..." },
    { "type": "code-snippet", "lang": "ts", "content": "..." },
    { "type": "dataset-pointer", "query": "{ filter: ..., limit: 200 }" }
  ]
}
```

**Storage.** Heavy payloads (images, large diagrams) go in `.rig/media/` as separate files; the waypoint holds a path. Keeps the SQLite row size reasonable.

**Acceptance.**
- [ ] A waypoint can be dropped with a mermaid diagram and render in the UI
- [ ] Image payloads display inline in the side-panel chat
- [ ] `rig_recall_waypoint` returns all payloads; agent decides which to render

**Dependencies.** B1.

---

#### B3. Doc generation from waypoints

**One-liner.** `rig export --docs` generates a markdown site assembled from all waypoints in the project, organized by hub.

**Why.** Engineering documentation is usually written separately, falls out of date, and becomes a chore. If waypoints already record every decision with rationale and refs, the documentation is *already there* — `export` just renders it.

**Output structure:**
```
docs/
├── index.md                 # auto-generated TOC, grouped by hub
├── decisions/
│   ├── 2026-05-22-ts-bun-stack.md      # one file per waypoint of type=decision
│   └── ...
├── principles/              # waypoints of type=principle
├── open-questions/          # waypoints of type=open-question
└── architecture/            # waypoints with mermaid-diagram payloads, rendered
```

**Acceptance.**
- [ ] Run on Rig's own waypoint chain, produce a navigable docs site
- [ ] Re-running after new waypoints updates only the changed files
- [ ] CI can regenerate and publish to a docs site (GitHub Pages, Cloudflare Pages)

**Dependencies.** B1, B2, A1 (for hub grouping).

---

#### B4. Cross-session waypoint retrieval

**One-liner.** `rig_waypoints session:last` lets a new session pick up where the previous one ended without re-reading the full prior conversation.

**Why.** This is the durability story. Open a new chat tomorrow, the agent reorients via the last 20 waypoints — their analogies + summaries.

**Mechanism.** Already supported by B1's `sessions` table + `rig_waypoints(session_id?)` tool. What B4 adds is the *install-time CLAUDE.md instruction*: on session start, before the first user turn, the agent calls `rig_waypoints session:last limit:20` and ingests it as context.

**Acceptance.**
- [ ] Fresh Claude Code session in a Rig-installed project automatically loads the last session's waypoints
- [ ] Agent's first response references prior decisions without the user needing to repeat them

**Dependencies.** B1.

---

#### B5. Memory that travels with the repo

**One-liner.** The authored layer (waypoints, decisions, constraints, dead ends, accepted links, aliases) is written to a committed, merge-friendly file, so teammates, other machines and cloud agents get it with `git pull`. No server.

**Why.** Local-first keeps verification next to the code and nothing leaves the machine, but today memory is per checkout: teammates don't see each other's decisions, a second laptop starts empty, and cloud or CI agents can't reach `localhost`. The derived graph is disposable (any machine rebuilds it from the repo); only the authored layer compounds, and it is small. Git is already the sync layer for everything else in the project, and committed memory shows up in PRs, so decisions get reviewed like code.

**Mechanism.**
- Builds on `rig export-memory` / `import-memory` (deterministic JSONL, portable `{kind, filePath, qualifiedName}` keys, unmatched records to `orphaned_memory`).
- One record per line, sorted by id, append-only: edits append a new version and deletions append a tombstone, so two branches merge by union with no textual conflicts.
- `rig index`, `rig sync` and `rig start` import new lines; agent writes append to the file as well as the database.
- Sharing is per kind and opt-in by default for raw hook captures: they quote the user's own words, so they stay local until reviewed or promoted. Agent and human decisions, constraints and dead ends are shared.
- Records from git carry provenance `git:<commit>` and go through the same trust tiers as hook capture before anything is injected at session start.

**Schema additions.** `source` / `provenance` values for git-imported records; a cursor of the last imported commit per file. Verdict records from E5 (`still holds`, `outdated`, `can't tell`, with the reviewer, the commit judged and the memory's anchor hash) live in the same file and update the memory's verification status.

**New tools.** None for agents. CLI: `rig memory share|unshare <id>`; `rig install` adds the gitignore exception for the shared file.

**Acceptance.**
- [ ] Fresh clone + `rig start` on a second machine: the session-start brief includes decisions recorded on the first
- [ ] Two branches that each add waypoints merge with no conflict in the memory file, and both sets load
- [ ] Export → import → export is byte-identical
- [ ] A poisoned record committed by another author is not injected above its trust tier (red-team case in the bench)

**Dependencies.** `export-memory` (shipped 0.2.0); the append-only authored layer and verify-on-read (research report, step 1); trust tiers (shipped with capture).

**★ Risk surface.** Memory from other people is injected into your agent, so poisoning matters more; private wording leaking through shared captures (hence opt-in for hook records); the file growing without the step-5 consolidation. ★ **Deep research before building:** when this item's turn comes, we run a deep-research pass on these risks first and write its findings into the item before any code.

---

#### B6. Handoff: continue in another agent

**One-liner.** When a session stops (usage limit, compaction, end of day), rig keeps a short, transient "where we are" record, and whichever agent opens the project next (another account, Codex, Cursor) starts from it.

**Why.** "Claude ran out, Codex picked up where it left off" is the one-sentence version of rig's neutrality claim, and the benchmark arm for it changes only one thing: whether `.rig/` was there.

**What it is.** A different object from the rest of rig's memory. Waypoints hold what was settled; a handoff holds what is in progress (the plan, the open question, the next step) and is deliberately not settled. So it is transient: one current handoff per workstream (branch or worktree, optional task label), overwritten by the next. Earlier versions stay in the mutation log for undo but never reach recall or the brief. It expires once consumed or after a set age.

**Where the content comes from** (no model call; capture stays deterministic):
- The agent's own handoff when asked ("drop a handoff before you stop"): still the most reliable source.
- Claude Code's compaction summary: `SessionStart` with source `compact` fires after compaction, and the summary is in the transcript, so rig stores it as the handoff.
- The transcript: the last user request, the current todo list, files edited this session, and the last failing command with its error.
- Written on `Stop` (each turn), `PreCompact` and `SessionEnd`. A usage limit fires no event, so the handoff is at most one completed turn old.

**Delivery.** The baseline is a file every agent loads on startup, so no model can skip it: local, gitignored, always-loaded files in a fenced, rig-managed section, merged not clobbered (`CLAUDE.local.md`; a gitignored `.cursor/rules/rig-handoff.mdc` with `alwaysApply`; Codex's project-local equivalent, to verify: rig wires Codex through the global `~/.codex/AGENTS.md` today, which would leak a handoff into every project). Not committed `AGENTS.md` or `.cursor/rules`: a brief that changes every session floods diffs, puts in-progress thoughts in commits and PRs, conflicts on merge, and is read as instructions where rig's brief is fenced as data. The `SessionStart` hook stays the Claude Code upgrade. At most 1,500 characters, and only while a handoff is fresh: injecting the orientation map into every prompt cost 187%.

**New tools.** `rig_handoff` (write/read), `rig handoff [show|clear]`; capture writes `kind: handoff` records.

**Acceptance.**
- [ ] Bench arm, pre-registered: session 1 on one model, interrupted mid-task; session 2 on a different model with the handoff vs cold, on the same tasks and bar as the memory bench
- [ ] A real run across clients: Claude Code stops, Codex and Cursor each open the project and their first reply names the in-progress step without being asked
- [ ] Two worktrees keep separate handoffs; a consumed or expired handoff leaves every brief file

**Dependencies.** Automatic capture (shipped); C5's agent identity (to say who handed off to whom); B5 only if handoffs are ever shared, which by default they aren't (they stay local).

**★ Risk surface.** A stale plan injected as if current; private in-progress wording written into agent files; the token cost of an always-loaded brief; parallel agents overwriting each other; client file-loading rules that differ by version (Codex in particular). ★ **Deep research before building:** when this item's turn comes, we run a deep-research pass on these risks first and write its findings into the item before any code.

---

### C. Observability layer

#### C1. Hot-node tracking + heat scoring

**One-liner.** Expand the activations table; compute a `heat_score` per node from exponentially-decayed recent activity; use it in magnetic pull and UI.

**Why.** At any scale beyond a toy project, knowing which anchors are touched most lets us cache them, prioritize them in UI, and identify cold/dead-weight nodes for pruning.

**Schema:**
```sql
-- expanded activations
ALTER TABLE activations ADD COLUMN session_id TEXT;
ALTER TABLE activations ADD COLUMN query_hash TEXT;
ALTER TABLE activations ADD COLUMN rank INTEGER;
ALTER TABLE activations ADD COLUMN context TEXT;
CREATE INDEX idx_act_query ON activations(query_hash);

-- materialized heat view (refreshed every 60s)
CREATE VIEW node_heat AS
SELECT
  node_id,
  COUNT(*)                              AS lifetime_touches,
  COUNT(DISTINCT session_id)            AS unique_sessions,
  COUNT(DISTINCT query_hash)            AS unique_queries,
  MAX(ts)                               AS last_touched_ts,
  SUM(EXP(-(strftime('%s','now')*1000 - ts) / 259200000.0)) AS heat_score
FROM activations
GROUP BY node_id;
```

**Magnetic pull integration.** The `recency` term in the formula becomes `heat_score`, normalized 0..1.

**Hot-node cache.** Bounded in-memory LRU keyed by `node_id`, holds precomputed `PullResult`. Populated when `heat_score` crosses threshold. Invalidated on any 2-hop structural change.

**New tools.**
- `rig_hotspots(window='7d', limit=20)` — top heat
- `rig_cold(days=90)` — candidates for pruning

**Acceptance.**
- [ ] Heat view refreshes on a 60s timer without query-time impact
- [ ] Hot-node cache hits show in tool-call elapsed_ms (<5ms cache hit vs ~50ms cold)

**Dependencies.** None directly; benefits A1, A4, D1.

---

#### C2. First-class queries + query log

**One-liner.** Promote queries themselves to graph nodes; track which queries are common, which return nothing useful (gaps), which results were clicked.

**Why.** A graph that knows what's been asked of it is qualitatively different from one that doesn't. Pre-warm hot queries; surface gaps where the graph needs more anchors; build per-user personalization.

**Schema:**
```sql
CREATE TABLE queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_hash TEXT UNIQUE,
  raw_text TEXT,
  first_seen INTEGER,
  last_seen INTEGER,
  count INTEGER DEFAULT 1
);

CREATE TABLE query_results (
  query_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  was_useful BOOLEAN,
  ts INTEGER NOT NULL
);
```

**New tools.**
- `rig_query_log(limit=50)` — recent queries with hit counts
- `rig_gaps(window='30d')` — queries that returned nothing useful
- `rig_query_warm(query_hash)` — pre-compute and cache a hot query's results

**Acceptance.**
- [ ] After 100 queries, `rig_query_log` shows the most common ones
- [ ] `rig_gaps` surfaces queries the user has run multiple times with no useful return

**Dependencies.** C1.

---

#### C3. Pulse events + WebSocket animations

**One-liner.** Every MCP tool call emits a `pulse` WS event; the UI animates the path of activation across the graph in real time.

**Why.** Watch the AI reason live. The map becomes the trace. Builds trust through transparency.

**Schema.**
```sql
CREATE TABLE pulse_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  skill TEXT NOT NULL,
  model TEXT NOT NULL,
  input_node_ids TEXT,
  output_node_ids TEXT,
  elapsed_ms INTEGER,
  payload_summary TEXT
);
CREATE INDEX idx_pulse_session_ts ON pulse_log(session_id, ts);
```

**WS event:**
```json
{
  "type": "pulse",
  "skill": "rig_pull",
  "model": "claude-opus-4.7",
  "input_anchors": ["authStore"],
  "output_anchors": ["login", "logout", "refresh"],
  "elapsed_ms": 67
}
```

**UI animation.** Input anchors glow at full saturation; traveling pulse moves along each edge to outputs; fades over ~2 seconds. Skill name flashes in an "active skills" side panel.

**Acceptance.**
- [ ] During a live Claude Code session, the UI shows pulses moving across the graph in real time
- [ ] Pulse log captures every tool call with input/output anchor IDs
- [ ] Replay mode walks through a session's pulses at 1× / 4× / 16× speed

**Dependencies.** Phase 2 WebSocket layer.

---

#### C4. Skill/model nodes — self-mapping

**One-liner.** Model the AI's own skill surface in the graph: `model`, `skill`, `agent-session` as node types; magnetic pull works on skills the same way it works on knowledge.

**Why.** Closes the loop — the actor is inside the constellation, not outside. The agent can ask `rig_pull(anchor)` and get back relevant *skills*, not just relevant knowledge. Skill discovery via the same mechanism as everything else.

**New anchor types.**
- `model` (e.g. `claude-opus-4.7`)
- `skill` (e.g. `rig_pull`, `browser_fetch`, `web_search`)
- `agent-session`

**New edges.**
- `model_has_skill`
- `skill_uses_tool`
- `invoked_in_session`

**Provenance enrichment.** The `provenance` field on `edges_semantic` can now hold not just `ai:claude-opus-4.7` but `ai:claude-opus-4.7|skills:pull→explore→infer`. Audit trail at thought-granularity.

**Acceptance.**
- [ ] `rig_pull("how do I structure auth?")` returns relevant knowledge anchors AND relevant skills
- [ ] Switching from Claude to GPT in chat panel shows different skills lit up

**Dependencies.** B1 (sessions table reused), C3 (pulse log).

---

#### C5. Pulse replay + session timeline

**One-liner.** Scrub through a past session's pulse log to see how the AI arrived at its conclusions.

**Why.** Debug "why did the AI propose this edge?" by replaying the sequence of skill invocations that led to it.

**UI.** A timeline at the bottom of the map view showing the session's pulses as a scrubbable timeline. Click any point → graph state and active skills at that moment.

**Acceptance.**
- [ ] Open the timeline for the last session, see all pulses in chronological order
- [ ] Scrub to any pulse, see which nodes were touched and which skill fired
- [ ] Click a proposed edge → jump to the pulse that produced it

**Dependencies.** C3, C4.

**Update 2026-10-30: live agent-activity overlay.** The same pulse stream drawn live as trails, one colour per agent, so the map shows an agent working.
- **Full trail, not only rig calls.** Activations today come only from rig's own tools. The `PostToolUse` hook (shipped with automatic capture) sees every read, grep and edit in Claude Code, so files the agent opens without rig light up too; edits from the file watcher get their own mark.
- **Agent identity.** Record the MCP `initialize` handshake's `clientInfo` name on every activation, and keep `rig hook --client` / an install-time override, storing both: some clients send unhelpful or identical names, and colours must not collapse when two tools introduce themselves the same way.
- **The clip is evidence, not only a demo.** Film one multi-session bench task twice, memory on and memory off, side by side: session two with memory skips the exploration the other repeats. Show it next to the 30% to 70% chart.

---

### D. Retrieval intelligence

#### D1. LightRAG dual-level retrieval

**One-liner.** Two retrieval modes — concept-level (hubs, manifests, principles) and entity-level (specific code symbols, examples) — and the agent picks based on question shape.

**Why.** Concept-level questions ("what version of pandas") get 1-hop answers from hubs. Entity-level ("where is pandas used") drill from the concept hub. The agent chooses; the system serves both.

**Mechanism.** `rig_pull` gains a `level` parameter:
- `level='concept'` — returns only hubs and manifests
- `level='entity'` — returns only non-hub nodes
- `level='auto'` — system picks based on query shape (default)

**Acceptance.**
- [ ] "what version of X" auto-routes to concept-level
- [ ] "where is X used" auto-routes to entity-level
- [ ] Manual override works in either direction

**Dependencies.** A1, A2.

---

#### D2. Hub-aware `rig_pull` reranking

**One-liner.** When the calling tier is light/main-session, surface hubs first; sub-nodes appear via drill.

**Why.** Main-session token budget is precious. Returning 5 hubs lets the agent pick one and drill, instead of dumping 50 sub-nodes.

**Mechanism.** Light-tier `rig_pull` adds a `hub_bias` parameter (default 0.3). Hubs get a +0.3 boost on their score. Drill happens via explicit `rig_drill(hub_id)`.

**Acceptance.**
- [ ] Main-session `rig_pull` returns hubs in the top half of results
- [ ] Heavy-tier `rig_explore` does not apply hub bias (it wants full context)

**Dependencies.** A1.

---

#### D3. Community-aware pull

**One-liner.** Add a community-membership term to the magnetic pull formula.

**Why.** Candidates in the same community as the anchor are usually more relevant than equally-scored candidates from other communities.

**Formula:**
```
score += w_community * sameCommunity(anchor, candidate)
```
With `w_community=0.15` starting; rebalance other weights to keep sum=1.

**Dependencies.** A4.

---

#### D4. Skill-relevance selection

**One-liner.** `rig_relevant_skills(query, k=5)` — agent asks the graph which of its own skills are most relevant to a query.

**Why.** Once skills are graph nodes (C4), the agent can use the same retrieval mechanism to pick its own tools. Reduces wasted tool calls.

**Acceptance.**
- [ ] Query "I need to validate this externally" returns `browser_fetch`, `web_search` near top
- [ ] Query "what's connected to X" returns `rig_pull`, `rig_neighbors`

**Dependencies.** C4.

---

### E. Composition

#### E1. Browser MCP install integration + `source_url` on edges

**One-liner.** During `rig install`, offer to install Playwright MCP alongside Rig. Add a `source_url[]` field to AI-proposed edges so web-validated proposals carry their evidence.

**Why.** Don't build a browser into Rig — compose with one. The AI co-cartographer can validate proposed edges via web research; the source URLs become the evidence trail in the accept/reject popover.

**Schema:**
```sql
ALTER TABLE edges_semantic ADD COLUMN source_urls TEXT;  -- JSON array
ALTER TABLE pending_edges ADD COLUMN source_urls TEXT;
```

**Installer addition.** A prompt in the `rig install` interactive flow: *"Also install Playwright MCP for web validation? (recommended)"*. If yes, write both MCP entries to the user's `.claude.json` in one step.

**UI addition.** The pending-edge popover shows `source_urls` as clickable links.

**Acceptance.**
- [ ] AI proposes an edge with a rationale citing 2 URLs → URLs appear in the accept popover
- [ ] Clicking a URL opens it in the user's browser

**Dependencies.** Phase 3 write tools.

---

#### E2. OpenClaw ↔ Rig MCP composition

**One-liner.** Spec the composition pattern: OpenClaw researches and writes findings as Rig waypoints + proposed edges; Rig persists across OpenClaw sessions.

**Why.** Two of your products doing complementary work instead of overlapping. OpenClaw is the active research agent; Rig is the durable graph. They compose via MCP — no special integration code.

**Pattern.**
1. User asks OpenClaw: "research X across these sources"
2. OpenClaw runs (it has its own browser/research stack)
3. OpenClaw writes findings to Rig via `rig_propose_edge` and `rig_drop_waypoint`
4. User accepts/rejects in Rig's UI; findings become canonical

**Acceptance.**
- [ ] OpenClaw can call Rig MCP tools when both are installed in the same agent session
- [ ] A research task in OpenClaw produces visible pending edges in Rig's map
- [ ] User accept/reject feeds back to OpenClaw's session via `rig_subscribe`

**Dependencies.** Phase 3, E1.

---

#### E3. Direct chat mode

**One-liner.** Chat panel in the map UI can speak to any OpenAI-compatible endpoint (BYO API key) instead of only proxying to Claude Code.

**Why.** Phase 2 chat is MCP-proxy only (locked to whatever agent runs MCP). Direct mode opens it up to Anthropic API, OpenAI, OpenRouter, Groq, etc. Same UI, model-agnostic.

**Config:**
```json
{
  "chat_mode": "mcp" | "direct",
  "direct_endpoint": "https://api.openai.com/v1",
  "direct_model": "gpt-5",
  "direct_api_key_env": "OPENAI_API_KEY"
}
```

**Acceptance.**
- [ ] User toggles to Direct mode in settings, pastes an API key
- [ ] Chat works with any of OpenAI/Anthropic/OpenRouter/Groq endpoints
- [ ] Direct mode can still call Rig MCP tools when configured to do so

**Dependencies.** Phase 2 chat panel.

---

#### E4. Architecture blueprints (export and Blueprint lens)

**One-liner.** A generated architecture drawing of the project, read like a house plan at several scales, exported as Mermaid (committed and diffable), React Flow JSON and SVG, and shown in the map as a Blueprint lens.

**Why.** The constellation shows every symbol; people asking "how is this built?" want the floor plan, not every nail. Rig already computes the ingredients deterministically for the orientation map: packages and their purposes, entry points, request/handler surfaces, key symbols and hubs, and declared dependencies. A blueprint is that map drawn. Committed next to the shared memory (B5) it stays current and reviewable.

**Scales (C4-style).** Site plan: the system and what it talks to. Floor plan: packages and services. Room plan: modules inside one package. Fixtures: the symbols of one module (this is the existing Neighbourhood lens).

**Shapes.** Flowchart conventions, kept strict so the drawing means what it looks like:
- cylinder: data store (SQLite, Postgres, Redis, files on disk), inferred from client dependencies and their call sites
- diamond: a branch in control flow, such as a router or dispatcher choosing a handler
- parallelogram: input/output surface (HTTP routes, CLI commands, MCP tools)
- rounded rectangle: package, service or module; hexagon: external service or third-party package
- document: docs and markdown sections
- design decisions, constraints and dead ends are not diamonds (a diamond already means "branch"); they are pinned notes or flags on the component they govern, from decision waypoints, with dead ends struck through

**Mechanism.** One blueprint model built from the index, with no model call; renderers for Mermaid flowchart, React Flow JSON (the app's lens, laid out with dagre, already a dependency) and SVG. Cached and refreshed by fingerprint like the orientation map. Every box links to `file:line`. Inferred elements (data stores, external services) are dashed and carry a confidence.

**New tools.** `rig blueprint [--level site|floor|room] [--scope <package>] [--format mermaid|reactflow|svg] [--out <file>]`; the map's Blueprint lens with an Export menu. An agent-facing `rig://blueprint` resource only if a bench arm shows it beats the control (injecting the orientation map cost 187%).

**Acceptance.**
- [ ] On rig and on next-auth, the floor plan fits one screen (about 30 boxes or fewer) without hand editing
- [ ] Data-store and external-service detection reaches at least 90% precision on a hand-labelled sample
- [ ] Mermaid output is byte-identical when nothing changed, and renders on GitHub
- [ ] Each export is stamped with the commit it was generated from

**Dependencies.** Orientation map (shipped 0.3.0); provenance and confidence on edges (research report, step 2) for honest dashed lines; B5 for committing it alongside memory.

**★ Risk surface.** Hairball drawings (mitigated by levels and folding sibling packages, as the orientation map does); a confident-looking but wrong diagram (mitigated by dashed inferred elements and the commit stamp); overlap with the orientation map (it shares the model; only the renderer is new). ★ **Deep research before building:** when this item's turn comes, we run a deep-research pass on these risks first and write its findings into the item before any code.

---

#### E5. PR review action: blast radius and memory at risk

**One-liner.** A GitHub Action that comments on each PR with what the change can break and which recorded decisions it may invalidate, and logs predicted against observed blast radius.

**Why.** It puts rig in front of every reviewer without anyone installing it, runs in the project's own CI (no server, in line with the anti-goals), and generates the labels that make two claims measurable: mapping (predicted vs observed blast radius) and memory trust (reviewer verdicts on memories at risk).

**The comment.**
- **Blast radius:** the changed symbols, what depends on them, and the subgraph as a Mermaid drawing (E4's renderer in miniature). Inferred edges are dashed, and the comment states how many edges are structural and how many inferred, so reviewers can calibrate at a glance.
- **Memory at risk:** decisions, constraints and dead ends anchored to changed code, each with what changed. Reviewers answer `still holds`, `outdated` or `can't tell`.

**Labels.**
- Only explicit clicks become labels; silence is never a "still holds". The click rate is tracked and reported; if it's low, the comment gets shorter or better targeted before its data counts.
- Verdicts are stored as records in the shared memory file (B5), not collected centrally.

**Observed blast radius.**
- Where CI produces a coverage report, the tests that execute changed code define the observed radius. Without coverage the action degrades cleanly: no score, still the comment.
- Scoring compares predicted nodes with nodes that have executed lines, and both sides go through the same line-to-node mapping code path, so mapping isn't graded against a different mapping.

**First number.** Replay rig's own merged PRs (each merge commit, with `bun test` coverage) before going public. The pass bar is written down first; the result goes in the README beside the memory chart, with its sample size.

**New tools.** `rig impact` on the CLI (the MCP tool `rig_impact` exists; the CLI command doesn't), `rig impact --diff <base>...<head> --format mermaid|json`, and the Action wrapping it. CI indexes with the structural graph only (no embedding model).

**Acceptance.**
- [ ] On rig's past PRs, a predicted-vs-observed score against a pre-registered bar, with sample size
- [ ] The edge-origin counts are correct (requires step 2's provenance: heuristic manifest edges are currently labelled `ast`)
- [ ] A repo without coverage gets the comment and no score, with no error
- [ ] Verdict records round-trip through B5's file and change the memory's status

**Dependencies.** `rig_impact` (shipped); edge provenance (research report step 2, a small piece pulled forward); B5 for verdict storage; verify-on-read (step 1) for "what changed" on a memory; E4's Mermaid renderer.

**★ Risk surface.** A confident blast radius that misses dynamic dispatch, in someone else's review; reviewer fatigue turning the comment into noise; labels that look like ground truth but reflect who bothered to click; coverage that measures tests run, not real dependency. ★ **Deep research before building:** when this item's turn comes, we run a deep-research pass on these risks first and write its findings into the item before any code.

---

### F. Scale

#### F1. sqlite-vec HNSW for vector search

**One-liner.** Replace linear cosine search with `sqlite-vec`'s HNSW index when loading the full embedding set into memory becomes the dominant cost (~20k+ nodes).

**Why.** At 100k nodes / dim=384, the embeddings table is ~150 MB. Even with a single `SELECT *` batch (already the implementation post-`cefc1ea`), loading and scanning the full set will eventually exceed the 100 ms light-tier budget. HNSW lets the semantic component traverse `O(log n)` neighbors instead of touching every vector. Empirically not needed yet — see the demotion note below.

**Acceptance.**
- [ ] HNSW index built automatically when embeddings table crosses threshold (~20k nodes)
- [ ] Magnetic pull's semantic component runs in <20 ms on 100k-node graphs
- [ ] `rig_pull` p50 stays under the 100 ms light-tier budget at all measured scales

**Dependencies.** None. Optional native dep — fall back to the batched-cosine path when the extension isn't loadable.

**History.**
- **2026-05-24 (promote):** moved to Phase 3.5 slot 3 after measuring 235 ms p50 at 4.5k nodes.
- **2026-05-24 (demote):** moved back to Phase 6 after profiling revealed the 235 ms was **4499 SQLite prepare/get roundtrips, not linear cosine**. Batching the embedding + activation fetches in `pull.ts` (commit `cefc1ea`) dropped p50 to 45.7 ms at 4.5k. Cosine math itself is only ~17 ms over 4500 × 384 vectors. The empirical trigger for HNSW is now "real codebase crosses ~20k nodes where the 150 MB+ vector load becomes the bottleneck," not "cosine is linear." Lesson: verify which layer of an `O(n)` claim is dominant before adding a native dep.

---

#### F2. Activations rollup

**One-liner.** Nightly job rolls up old activations into `activations_summary` keeping last-N per node + aggregate decay term.

**Why.** At 100k nodes with 1k touches/day, raw activations hit a million rows in 10 days. Rollup keeps the table from growing unbounded without losing the signal that matters.

**Dependencies.** C1.

---

#### F3. Incremental Leiden

**One-liner.** Re-run community detection only on the changed subgraph plus its boundary, not the whole graph.

**Why.** Full Leiden on 100k+ nodes is slow. Streaming variants converge orders of magnitude faster on incremental updates.

**Dependencies.** A4.

---

#### F4. UI hub-default rendering

**One-liner.** When node count > 5k, the map renders only hubs by default; sub-nodes expand on hub-click.

**Why.** Force-graph hits its limit around 5–10k visible nodes. Hub-default keeps the UI legible at any scale.

**Dependencies.** A1.

---

### G. Vision / long-term

#### G1. Multi-modal anchors

**One-liner.** Image, audio, and video files as first-class anchors with their own embedders (CLIP for images, Whisper-derived for audio).

**Why.** Constellation already speaks the language of "anchor + embedding + edges." Adding non-text anchors unlocks ML-researcher use cases and design workflows.

**Schema additions.** `embeddings.modality` (text|image|audio|video). Per-modality embedders pluggable via the contracts layer.

---

#### G2. Datasets-as-graph

**One-liner.** Examples are nodes; labels/splits/source/lineage are edges; "dataset" becomes a saved query.

**Why.** Filesystem-era ML curation (bucketed folders) is obsolete the moment you have a real graph. Replaces DVC/Pachyderm for new projects.

**Killer queries.**
- "Get the training set" → nodes with `in_split → train` edge
- "Hard examples" → nodes with `was_misclassified_by` edges
- "Reproduce the training set from commit X" → walk mutation_log to that timestamp

**Dependencies.** G1 (multi-modal anchors for image/audio datasets).

---

#### G3. GraphRAG community summaries (with LLM)

**One-liner.** Generate LLM summaries per community for fast "global" retrieval (zooming out).

**Why.** A1/A4 give you community membership; LLM summaries make each community queryable as a single unit.

**Cost.** Expensive at index time (LLM calls per community). Optional feature.

**Dependencies.** A4.

---

#### G4. Cross-project federation

**One-liner.** One Rig instance can query another's graph via a federation MCP tool.

**Why.** Multi-project teams need cross-project search and reasoning. The substrate becomes networked.

**Mechanism.** Each Rig exposes a `rig_remote_search(query, project_id)` tool when federation is enabled; auth via mutual API key.

**Dependencies.** Everything above. This is the v2.0 capstone.

---

## 3. Recommended sequencing

After fixing the extractor diagnostic (0.1):

### Phase 3.5 — Cement the foundation ✅ shipped 2026-05-24
1. **A1** Hub-and-spoke topology ✅
2. **A3** Aliases ✅
3. **A2** Package manifests as hubs ✅ — **fully closed**. Extractors: package.json + requirements.txt + pyproject.toml (PEP 621 + Poetry). Tools: `rig_deps` + `rig_dep_conflicts` + `rig_unused_deps` + `rig_phantom_imports`. npm lockfile resolution attaches `resolved_version` to declared-deps. Python lockfile resolution (uv.lock / poetry.lock) still deferred.
4. **C1** Hot-node tracking ✅ (`rig_hotspots` + `rig_cold` + heat feeds A1 hubness)
5. **D2** Hub-aware pull reranking ✅

Acceptance for Phase 3.5: ✅ rendering 5k-node graphs is legible; manifest queries work; aliases collapse duplicates; pull surfaces hubs first; hot anchors gain hubness automatically.

> **F1 (sqlite-vec HNSW) was briefly inserted at slot 3 on 2026-05-24 after a 235 ms p50 measurement, then demoted back to Phase 6** when profiling revealed the cost was per-candidate DB roundtrips, not linear cosine. Batching the fetches (commit `cefc1ea`) brought `rig_pull` p50 to 45.7 ms at 4.5k nodes. HNSW remains the right fix above ~20k nodes; the empirical trigger has not been hit.

### Phase 4 — Memory + observability ✅ mostly shipped 2026-05-24
6. **B1** Conversation waypoints (basic) ✅
7. **B4** Cross-session retrieval ✅ (`session_id="last"` + installer bootstrap section)
8. **C3** Pulse events + WS animations — **C3-lite shipped** previously; full timeline + replay deferred
9. **E1** Browser MCP integration + source_url on edges — **backend shipped** (v11 + `rig_propose_edge.source_urls`); installer prompt + UI popover deferred
10. **A4** Community detection — **A4-lite (label propagation) shipped** previously; full Leiden deferred

Acceptance for Phase 4: ✅ AI can pick up a project from prior session via `rig_waypoints session_id="last"`; pulses animate live (C3-lite); communities visible (A4-lite, label propagation).

### Phase 5 — Multi-modal + self-mapping
11. **B2** Polymorphic waypoint payloads ✅ shipped 2026-05-24
12. **C4** Skill nodes ✅ + **D4** `rig_relevant_skills` ✅ shipped 2026-05-24 (model nodes + provenance enrichment still deferred — they require pulse-log integration)
13. **C5** Pulse replay timeline — pending
14. **E3** Direct chat mode — pending
15. **B3** Doc generation from waypoints ✅ shipped 2026-05-24 as `rig export-docs`

Acceptance for Phase 5: ✅ Rig generates its own architecture docs from its waypoint chain (B3); ✅ agent picks its own toolchain via the graph (C4 + D4).

### Added 2026-10-30 (slotted against the research report's steps)
- **B5** Memory that travels with the repo: build the shared file as step 1's append-only authored layer; share once verify-on-read lands.
- **E4** Architecture blueprints: a first Mermaid and Blueprint-lens cut can use the orientation map today; inferred data stores wait for step 2's edge provenance.
- **E5** PR review action: first in the current order, dogfooded on rig's own PRs before anyone else sees it; built alongside step 1, which its reviewer verdicts feed.
- **C5** live overlay (update): after E5; agent identity from the MCP handshake first, trails second, then the paired clip.
- **B6** Handoff: alongside E5; the cross-model handoff arm is the neutrality claim's benchmark.
- Bench harness: accept any OpenAI-compatible endpoint, so contributors can run the pinned bench on their own models.

### Phase 6 — Scale
16. **F1** sqlite-vec HNSW — trigger: real codebase crosses ~20k nodes
17. **F4** UI hub-default rendering
18. **F2** Activations rollup
19. **A5** Consolidation job

Acceptance for Phase 6: 100k-node projects feel as snappy as 1k-node ones.

### Phase 7+ — Vision
20. **E2** OpenClaw ↔ Rig composition
21. **G1** Multi-modal anchors
22. **G2** Datasets-as-graph
23. **G3** LLM community summaries
24. **G4** Cross-project federation

---

## 4. Open decisions to lock before any of this is built

Don't start any backlog item until these are answered:

| Decision | Why it matters | Default |
|---|---|---|
| Final product name — Rig, Constellation, Pyxis? | Affects CLI binary, npm package, install paths | **Rig** (per recent screenshot) |
| MCP tool prefix — `rig_*` or `constellation_*`? | Locks the agent install configs | `rig_*` to match product |
| Embedding model upgrade path | bge-small fine through ~50k nodes; beyond that consider bge-base or hosted | Stay on bge-small until F1 ships |
| When to commit to `sqlite-vec` | Adds a native dep; defer until it's necessary | When real project crosses ~20k nodes. Briefly thought to be "now" on 2026-05-24 after a 235 ms bench measurement, but profiling traced the cost to per-candidate DB roundtrips (fixed in `cefc1ea`), not linear cosine. HNSW remains correct above the point where the full embedding load (~150 MB at 100k×dim=384) becomes the bottleneck. See F1. |
| Whether to keep "Constellation" terminology internally | Concepts (anchor, magnetic pull, waypoint) vs product name | Keep concepts; product = Rig |
| Browser MCP default-on or default-off in installer | Privacy vs convenience | Default-off, prompt during install |
| Waypoint rate-limit per session | Prevent spam | 1 per 5 turns soft, 3 per turn hard |

---

## 5. Anti-goals — what this backlog deliberately does NOT include

- **Multi-user / multi-tenant.** Rig is local-first per project. Sharing happens via MCP composition or federation (G4), not via a hosted service.
- **A separate "Rig Cloud" SaaS.** Tempting; not the bet. Local-first is the differentiation.
- **Replacing the IDE.** Rig is a graph + UI; it's not an editor. Editors integrate via MCP.
- **Becoming an agent framework.** Rig is the substrate agents use; it doesn't orchestrate them (LangGraph/CrewAI/etc. compose on top).
- **A general vector DB.** Rig's embeddings serve magnetic pull. If a use case needs a real vector DB, use one alongside.

---

*End of iteration backlog. Update Section 0.2 with what's shipped after each phase. When promoting a backlog item to a full addendum, copy the item's section verbatim as the starting point and expand from there — the body of each item is intentionally enough to remember the design without re-deriving it.*
