# Rig — Integration Addendum v0.1

> Companion to `iterationbacklog.md`. The backlog says *what* to build and *in what order*; this doc says *how the 24 items compose into one system* without becoming 24 subsystems.
>
> **Thesis.** Almost every backlog item is one of five things plugged into a shared substrate: a new **node type**, a new **edge kind**, a new **term in the magnetic-pull formula**, a new **tool over existing tables**, or a new **view over the WebSocket stream**. Integration is extending registries and rebalancing one scoring function — not wiring independent features together. Anything that can't be expressed as one of the five is a design smell worth a second look.

---

## 1. The five integration seams

Every item lands on exactly one of these. The seam tells you where the code goes and what can't change underneath you.

| Seam | What plugs in | Backlog items |
|---|---|---|
| **S1 — Pull formula** | A new scored term | C1, A1, D2, A4, D3 |
| **S2 — Node-type registry** | A new anchor variant | A2, B1, C2, C4, G1, G2 |
| **S3 — Edge-kind registry** | A new edge kind + precedence slot | A2, B1, C4, G2 |
| **S4 — Mutation/provenance spine** | A write that must be undoable + auditable | A3, A5, B1, E1, E2, C4 |
| **S5 — Pulse/WS stream** | A live event + a UI view over it | C3, C5, F4, A4 |

Cross-cutting (no new surface, pure config/threshold): F1, F2, F3, E3.

---

## 2. S1 — the pull formula is the one scoring function

Today: `score = w_s·structural + w_e·semantic + w_r·recency`, weights summing to 1.

Items don't add features here — they add **terms** or **rescale existing ones**:

- **C1** redefines `recency` as normalized `heat_score` (exponentially-decayed activations).
- **A1** feeds `hubness` into ranking; **D2** adds a light-tier `hub_bias` boost.
- **A4 + D3** add `w_community · sameCommunity(anchor, candidate)`.

**Integration rule.** The weight vector is a single versioned object in the contracts layer — not constants scattered across `pull.ts`. Every item that touches S1:

1. declares its term in the one weight contract,
2. rebalances so the vector still sums to 1, and
3. re-runs the token-cost benchmark (scaffolded in `941a69f`) as the merge gate.

That bench is the regression detector: a retrieval item does not merge if it moves p50 token cost or hand-judged correctness the wrong way. This is the single highest-risk seam because every retrieval item nudges the same function — see §6.

---

## 3. S2 / S3 — node and edge registries

New anchors and edges are registry entries, not new code paths. FTS5 search, `rig_pull`, and the structural walkers (`rig_drill`, `rig_hub_of`) dispatch on the discriminant and treat every variant identically.

**Node types** are a discriminated union in `.contracts/`:
`manifest`, `declared-dependency` (A2) · `conversation-waypoint` (B1) · `query` (C2) · `model`, `skill`, `agent-session` (C4) · multi-modal + dataset-example (G1/G2).

**Edge kinds** slot into the fixed structural precedence `contains > references > calls > imports`. A new kind only needs its rank declared so drill/hub-of know where it sits:
`manifest_declares`, `imports_package`, `resolves_to` (A2) · `waypoint_succeeds`, `waypoint_references` (B1) · `model_has_skill`, `skill_uses_tool`, `invoked_in_session` (C4).

**Integration rule.** Adding a type or kind is a one-file contract edit + generator run (per `contracts.md`). If an extractor or tool needs a `switch` on node type, that switch lives behind the registry, not inline — this is what keeps each addition under the ≤150-line declarative bar.

---

## 4. S4 — the mutation/provenance spine

Every write tool routes through `mutation_log`. That single discipline is what makes the write items integrate for free:

- `rig_undo` works on A3 (alias), A5 (consolidation), B1 (waypoint), E1 (sourced edge) without per-feature undo logic — undo just walks the log.
- **E2 (OpenClaw composition) needs no integration code at all**: OpenClaw calls the same `rig_propose_edge` / `rig_drop_waypoint` tools, so its writes appear as pending edges in the UI and feed back via `rig_subscribe` automatically.
- **C4's deferred tail** (model nodes + thought-granularity provenance like `ai:claude-opus-4.7|skills:pull→explore→infer`) is an enrichment of the `provenance` field already on `edges_semantic` — it lands when the pulse log (S5) gives it the skill chain to record.

**Integration rule.** No feature gets its own write path or its own undo. If a write can't be expressed as a `mutation_log` row, the schema is missing a column, not a subsystem.

---

## 5. S5 — the pulse stream is the one live surface

Build the event stream once; every live feature is a consumer:

- **C3** emits a `pulse` WS event per tool call (input/output anchors, skill, elapsed_ms) and animates activation paths.
- **C5** scrubs/replays the same `pulse_log` rows.
- **F4** (hub-default rendering) and **A4** (community coloring) are render modes over the same graph + stream, gated by the threshold in §7.

**Integration rule.** A live feature subscribes to the stream; it does not open its own socket or invent its own event type without adding it to the WS-event contract.

---

## 6. Sequencing — four independent long-pole chains

Phases 3.5 / 4 / 5 are largely shipped (see backlog §3). What remains is four chains that are mostly independent of each other, so they can advance in parallel. Within a chain, order is forced by dependency:

```
Observability   C1 ✅ → C2 → C3-full → C5
                          (C4 provenance tail rides here once pulse log is real)

Community       A4-lite ✅ → A4-full Leiden → D3 → F3

Composition     E1 backend ✅ → E1 frontend → E2
                E3 (direct chat) — independent, land anytime

Scale           F1 / F2 / F4 — trigger-gated, not date-gated (§7)
```

**Recommended next move:** the **observability chain (C2 → C3-full → C5)**. It is highest-leverage because completing the pulse log also unblocks C4's deferred provenance tail — one chain clears two backlog debts.

Vision (G1 → G2/G3, G4 capstone) stays parked behind everything above.

---

## 7. Two integration risks to actively manage

**R1 — Pull-formula entropy.** Every S1 item perturbs the same function; uncoordinated weights drift toward noise. *Mitigation:* one versioned weight vector (§2) + the token-cost bench as the merge gate. No retrieval item merges without a bench delta.

**R2 — Threshold sprawl.** F1 (~20k nodes), F4 (>5k), A1 hub-mode, and A4 re-run all key off "the graph is big now." Hardcoding the number in each place guarantees they drift apart. *Mitigation:* a single `node_count` watcher exposes named thresholds; features subscribe to a threshold, never to a literal. F1's history (235 ms scare on 2026-05-24 traced to DB roundtrips, not cosine — fixed in `cefc1ea`) is the cautionary tale: verify the dominant cost before a feature self-activates.

---

## 8. The one-line test for any new item

> Can it be expressed as a node type, an edge kind, a pull term, a tool over existing tables, or a WS view?

If yes, it integrates by extending a registry or rebalancing one function. If no, stop — either the substrate is missing a primitive (add it deliberately) or the item is an anti-goal (backlog §5).

---

*End of integration addendum. Update §6 as chains advance; update §1's table when a new item is slotted to a seam.*
