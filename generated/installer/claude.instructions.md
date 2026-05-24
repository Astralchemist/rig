<!-- GENERATED FILE — DO NOT EDIT.
     Source: .contracts/targets/claude.contract.ts
     Edit the .contract.ts file(s), then run `bun run gen`. -->

# Rig — Claude Code instructions

Rig exposes these MCP tools. Always prefer them over file reads for graph questions.

## light tools

### `rig_cold`

Return the anchors that have not been activated within the stale-after
window. last_ts is null when the node has never been touched. Useful for
pruning candidates and identifying dead-weight in the graph.

Default stale-after is 90 days, limit 20.

### `rig_hubs`

Return the most "hub-like" anchors in the graph, ranked by hubness. Hubs are
high-fanout structural concentrations (top 5% per anchor type) plus any node
explicitly promoted via rig_promote.

Use as the entry point when navigating a large graph — pick a hub, then call
rig_drill to explore its sub-tree.

### `rig_unused_deps`

Heuristic: a declared dependency is flagged when its package name never
appears as the target of a bare-specifier import anywhere in the indexed
source. Handles scoped packages (`@types/node`) and subpath imports
(`lodash/get` counts as a use of `lodash`).

Possible false positives: JSX runtimes, bundler-only deps, runtime configs.
Treat the result as "likely removable, verify before deleting", not as an
authoritative dead-code report.

### `rig_chain`

Starting at a given waypoint, walk the waypoint_succeeds edges backward
through history up to maxDepth hops. Returns the seed at index 0 followed
by its predecessors in order. Use to reconstruct the reasoning thread
that led to a decision.

### `rig_dep_conflicts`

Return every dependency name (scoped per ecosystem source) that appears in
two or more manifests with different version specs. Same-name-different-source
(e.g. an npm package and a PyPI package that happen to share a name) is not a
conflict — only intra-ecosystem disagreement is flagged.

Use to spot drift before it bites: pandas at 2.1.4 in requirements.txt and
2.2.0 in pyproject.toml is the classic case.

### `rig_files`

List files known to the rig index, optionally filtered by a substring of
the file path. Each entry has {path, language?, node_count,
last_indexed_ts?}.

Use for "what does rig know about" sanity checks and to discover entry
points before searching. For symbol lookup inside a file use rig_search
with a kind filter.

### `rig_drill`

Walk outward from a hub via structural edges (contains > references > calls >
imports), rank descendants by magnetic pull from the hub. Optional name query
filters the returned set. Use after rig_hubs to drill into one part of the
graph instead of dumping the whole neighborhood.

### `rig_impact`

Return all anchors reachable as transitive callers of the given anchor
up to the requested depth. Useful for change-impact analysis: "if I
change this function, what tests/callers might break".

Defaults to depth 3. Depth is capped at 6 to keep the result bounded.
For one-hop callers use rig_callers.

### `rig_hotspots`

Return the anchors that have been activated (queried, expanded, AI-touched)
most often within a sliding window. Count-based ranking — for decay-weighted
relevance use rig_pull.

Use to discover the parts of the graph you have been working in lately,
or to seed a cache-warming pass. Default window is 7 days, limit 20.

### `rig_node`

Return metadata for a single anchor: id, name, kind, file_path, qualified
name, signature, docstring, and neighbor counts by edge kind. Does NOT
return the source body — use rig_explore (heavy tier) for full source.

Use as a cheap inspection step after rig_search to decide whether a node
is worth pulling neighbors or callers for.

### `rig_deps`

List the dependencies a project declares in its package manifests (currently
package.json; more formats coming). Each entry has {name, spec, source,
manifest_path, is_dev, is_optional, is_peer}.

Use for "what does this project depend on" and "what version of X does it
declare" questions. For symbol-level lookup of how a package is imported
in code, use rig_search with the package name.

### `rig_callers`

Return the set of anchors that directly call the given function/method.
One-hop, structural edges only. Output is NodeRef[].

Use to answer "who uses this" or "what will break if I change this".
For transitive impact use rig_impact; for general relatedness use
rig_pull.

### `rig_pull`

Rank the top-k anchors most "magnetically attracted" to the given node.
Score combines graph distance (structural), embedding cosine similarity
(semantic), recent activation decay (recency), and a hub-bias boost so
high-fanout anchors surface first by default. Returns PullResult[] with
{nodeId, score, components: {structural, semantic, recency, hub}}.

Use this for "what's related to X" or "what else should I look at" —
it is strictly better than rig_neighbors when you want a ranked list.
Use rig_neighbors only when you need the raw edge view. To disable the
hub bias (raw neighborhood ranking), pass hub_bias=0.

### `rig_neighbors`

Return edges incident to the given anchor in both directions, from both
the structural and semantic edge tables. Output is a flat EdgeRef list
with {src, dst, kind, weight?, table}.

Use when you want the raw graph view ("what does this connect to") rather
than a ranked similarity view. For "what's most related" use rig_pull —
it scores by structural distance + semantic similarity + recency.

### `rig_critical_path`

Greedy walk outward from the root anchor, picking the highest-scoring outbound
edge at each step. Score = w_hubness × destination.hubness + w_activation ×
normalized_activation_count + w_kind × edge_kind_weight (contains > references
> calls > imports). Returns an ordered chain — the "main thread" through the
subsystem rooted at this anchor.

Use as a one-shot architecture tour: "what's the spine of this code path"
or "which chain of anchors carries the most traffic from X". For one-hop
neighbors use rig_neighbors; for ranked similarity use rig_pull.

### `rig_search`

Find anchors by name or qualified name via SQLite FTS5. Returns
{id, name, kind, file_path?} matches ranked by FTS relevance.

Use this for "where is X defined" or "find a symbol named Y" questions.
For "what's related to this node" use rig_pull instead — search does not
score by graph proximity or semantic similarity.

### `rig_callees`

Return the set of anchors directly called by the given function/method.
One-hop, structural edges only. Output is NodeRef[].

Use to answer "what does this depend on" or "what does this function
touch". For transitive reach use rig_impact; for general relatedness
use rig_pull.

### `rig_status`

Returns counts of nodes, edges, files, and the last sync timestamp.
Use as a smoke test before any other rig_* call to confirm the index is initialized.

### `rig_hub_of`

Walk outward from an anchor via structural edges, return the first hub layer
reached (up to maxDepth hops). Use to answer "what part of the system does
this belong to" without traversing the full graph.

### `rig_phantom_imports`

Mirror of rig_unused_deps: returns import sites whose target package name
has no matching declared dependency in any manifest. Common causes are a
missing entry in package.json / requirements.txt, a typo, or reliance on a
transitive dep that should be declared directly.

Subpath imports normalize to the parent package (`lodash/get` → `lodash`);
relative + absolute paths are not counted as phantoms.

### `rig_aliases`

Return every alias name pointing at a given canonical anchor. Aliases are
alternate names (e.g. `pd` for `pandas`, `useState` for `React.useState`)
that resolve to the same node via FTS5 search. Each carries the actor that
registered it.

### `rig_waypoints`

List waypoints in newest-first order. Optional filters: session_id (pass
"last" to auto-resolve to the most-recently-active session — useful at
session start to rehydrate the previous thread), kind (decision /
observation / constraint / open-question / principle).

Call this on session start, before the first user turn, with
session_id="last" limit=20 to pick up where the previous session ended.

### `rig_session_token`

Read the per-server bearer token from .rig/.runtime and return both the raw
token and a clickable URL the user can paste into their browser to log into
the map. Used when "open the rig map" comes up in chat — the agent fetches the
token (because it has filesystem access to .rig/), the user clicks the URL,
and the cookie gets set.

Returns 'no_runtime_token' in errors when the server isn't running with auth
enabled (loopback dev mode skips the token by default).

## heavy tools

### `rig_explore`

Search the index for a question and return the top-K anchors with their
source bodies and one-hop related anchors. Returns full file slices, so
this is token-heavy.

NEVER call this in the main agent session — spawn a sub-agent. The
two-tier gate is enforced by the dispatcher (MAIN_SESSION_FORBIDDEN).
For lightweight metadata-only navigation use rig_pull or rig_neighbors.

### `rig_context`

Build a context bundle of the top-K anchors most relevant to a task,
formatted for direct LLM consumption (markdown by default; JSON
available). Uses search + magnetic-pull ranking.

Heavy tier — must be invoked from a sub-agent, not the main session.
Use rig_explore for raw exploration; use rig_context when you want a
single ready-to-prompt block.

## write tools

### `rig_propose_edge`

Write a pending semantic edge that the user must accept before it becomes
canonical. Rationale is shown in the accept popover and stored in the
mutation_log forever.

Prefer rig_propose_edge to creating edges directly — the user accepts
the connection before it solidifies.

### `rig_add_alias`

Add an alternate name for an anchor so searches for the alias return the
canonical node. Use for AI-discovered or user-asserted alternate names
(e.g. `pd` → `pandas`, `useState` → `React.useState`).

The alias is registered with the caller's provenance. Re-adding the same
(node, alias) pair is a no-op; the second call returns added=false.

### `rig_promote`

Promote any node to hub status regardless of its fanout score. Used when the
user or AI has identified a concept-level anchor that the structural heuristic
missed (a "principle" waypoint, a domain entity, a documentation root).

Hubs surface in rig_hubs results and bias rig_pull rankings.

### `rig_cluster`

Create a new node of type 'cluster' with 'contains' edges to each member.
The cluster becomes its own searchable anchor. Use when you spot a
group of related anchors that deserves a name.

### `rig_focus`

Emit a focus:requested event over WebSocket so the map UI pans and
zooms to the given anchors. No graph mutation; logged in mutation_log
for audit.

### `rig_undo`

Walk back the most recent mutation in the current MCP session — propose
becomes deleted, accept becomes pending again, reject becomes pending,
add_node deletes the node. Undos are themselves logged; the chain is
auditable.

### `rig_annotate`

Append a free-text note to a node's data.annotations array. Useful for
the AI to leave a breadcrumb on a node ("this is the auth boundary",
"renamed from FooBar in commit abc1234").

### `rig_add_node`

Create a new anchor immediately (nodes are cheaper to add than edges).
Use only when the user has explicitly named a new concept in
conversation; do not invent anchors from inference alone.

### `rig_drop_waypoint`

Record a discrete marker the AI considers worth preserving across context
compaction or session boundaries — a decision, a constraint stated by the
user, a recurring observation, an open question, or a principle. The
waypoint becomes a graph anchor with structured payload; predecessor ids
form a `waypoint_succeeds` chain; constellation refs form
`waypoint_references` edges to other anchors.

Use sparingly. Typical floor: at most one per ~5 turns. Drop one when a
real decision is locked, not as a running summary.

## live tools

### `rig_subscribe`

Long-poll endpoint for following the user's UI activity from an agent
session. Pass the last next_cursor value you saw; receive every
mutation_log row since then (selections, edges proposed/accepted/
rejected, nodes added). Polling every 2s is a good default.

Use this to inject "user is now looking at <anchor>" context into your
next agent turn without the user typing.

## Two-tier gate

NEVER call `rig_explore` or `rig_context` directly in the main session — spawn a sub-agent for these.

## Session bootstrap

At the start of a new conversation, before responding to the user, call `rig_waypoints` with `session_id="last"` and `limit=20`. The returned waypoints are the prior session's structured decision/observation markers — read them to reorient on what was decided, what constraints are in play, and what open questions remain. Do not re-derive context the prior session already settled.

Drop a waypoint via `rig_drop_waypoint` when: a real decision is locked, the user states a hard constraint, an observation recurs across turns, or an open question emerges that should outlive context compaction. Aim for at most one waypoint per ~5 turns — they are not a running summary.
