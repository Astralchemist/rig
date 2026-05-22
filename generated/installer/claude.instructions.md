<!-- GENERATED FILE — DO NOT EDIT.
     Source: .contracts/targets/claude.contract.ts
     Edit the .contract.ts file(s), then run `bun run gen`. -->

# Rig — Claude Code instructions

Rig exposes these MCP tools. Always prefer them over file reads for graph questions.

## light tools

### `rig_files`

List files known to the rig index, optionally filtered by a substring of
the file path. Each entry has {path, language?, node_count,
last_indexed_ts?}.

Use for "what does rig know about" sanity checks and to discover entry
points before searching. For symbol lookup inside a file use rig_search
with a kind filter.

### `rig_impact`

Return all anchors reachable as transitive callers of the given anchor
up to the requested depth. Useful for change-impact analysis: "if I
change this function, what tests/callers might break".

Defaults to depth 3. Depth is capped at 6 to keep the result bounded.
For one-hop callers use rig_callers.

### `rig_node`

Return metadata for a single anchor: id, name, kind, file_path, qualified
name, signature, docstring, and neighbor counts by edge kind. Does NOT
return the source body — use rig_explore (heavy tier) for full source.

Use as a cheap inspection step after rig_search to decide whether a node
is worth pulling neighbors or callers for.

### `rig_callers`

Return the set of anchors that directly call the given function/method.
One-hop, structural edges only. Output is NodeRef[].

Use to answer "who uses this" or "what will break if I change this".
For transitive impact use rig_impact; for general relatedness use
rig_pull.

### `rig_pull`

Rank the top-k anchors most "magnetically attracted" to the given node.
Score combines graph distance (structural), embedding cosine similarity
(semantic), and recent activation decay (recency). Returns PullResult[]
with {nodeId, score, components: {structural, semantic, recency}}.

Use this for "what's related to X" or "what else should I look at" —
it is strictly better than rig_neighbors when you want a ranked list.
Use rig_neighbors only when you need the raw edge view.

### `rig_neighbors`

Return edges incident to the given anchor in both directions, from both
the structural and semantic edge tables. Output is a flat EdgeRef list
with {src, dst, kind, weight?, table}.

Use when you want the raw graph view ("what does this connect to") rather
than a ranked similarity view. For "what's most related" use rig_pull —
it scores by structural distance + semantic similarity + recency.

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
