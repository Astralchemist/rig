# Rig Web UI — Workbench design spec

Status: phase 1 and the waypoints/review part of phase 5 shipped (see CHANGELOG, Unreleased):
rail, view router, inspector, Review, Waypoints and Overview. Hubs, Deps, Doctor, the activity
feed and the savings metric are still to do. Two departures from this spec: the UI uses the
system font stack (no bundled Inter or JetBrains Mono, so nothing is fetched), and node kinds are
coloured by three validated categorical hues plus neutral rather than by the accent. Tokens live
in `packages/web/src/app/styles.css`.

The web UI's job is two-fold: let a **developer** explore the graph, and make rig's
real value — **an agent traversing the repo in fewer tokens** — *visible and provable*.
Layout: **Workbench**. Aesthetic: **Observatory** (refine the existing dark constellation theme).

---

## Design tokens

Defined as CSS custom properties in `packages/web/src/app/theme.tsx` / `index.css`.

### Color — Observatory (dark)
```
--bg        #0a0c10   near-black "space"
--surface   #12161d   rail, panels, inspector
--surface-2 #171c24   raised rows / hover
--border    #1f2630   hairline dividers (1px)
--text      #e6edf3   primary  (~15:1 on --bg, AAA)
--text-dim  #8b98a6   secondary (~6:1, AA)
--accent    #4dd0c4   luminous teal — links, focus, active nav, node glow
--ok        #5ec98b   doctor pass / healthy
--warn      #e0b341   conflicts, attention
--err       #e5705f   failures
```
Rules: accent is reserved for *interactive + the graph itself* (nodes/edges glow teal);
status colors only for status. No decorative color. Never color-only meaning — pair with
icon/label. Verify any new pairing at WCAG AA (4.5:1 text, 3:1 large/UI).

### Typography
- **Inter** — UI (variable; weights 400/500/600). **JetBrains Mono** — code, IDs, metrics.
- Scale 1.25: `12 · 13 · 16 · 20 · 25 · 31px`. Body 16/24 (1.5). UI labels 13.
- Headlines tighter tracking (−0.02em); mono metrics default.

### Spacing & motion
- 4px base → `4 8 12 16 24 32 48`. Layout via flex/grid `gap`, not child margins.
- Motion: micro 150ms · panel/view 300ms · modal 500ms. `ease-out` in, `ease-in` out.
  Animate `transform`/`opacity` only. Honor `prefers-reduced-motion`.

---

## Information architecture

```
┌──┬──────────────────────────────┬──────────────┐
│rail│        main (swaps)          │  inspector   │
└──┴──────────────────────────────┴──────────────┘
```

### Left rail (≈56px; icon + hover label; active = teal)
`◆ Map · 🔍 Search · ⬡ Hubs · ⊞ Deps · 🔥 Activity · ◷ Waypoints · ✓ Doctor`

### Main area (one frame, instant view-swap — no reload)
- **Map** — existing force-graph; nodes glow `--accent`, hubs larger. Hero.
- **Search** — FTS + magnetic-pull, ranked rows with the score components bar.
- **Hubs** — ranked hub list → click focuses the map (`focus:requested`).
- **Deps** — declared deps + conflicts / phantom / unused as scannable tables.
- **Waypoints** — conversation memory + `rig_chain` timeline.
- **Doctor** — the `rig doctor` checks, live, with the resolved port.

Selecting a node anywhere cross-highlights it on the Map.

### Right inspector (collapsible)
Selected node: signature · docstring · callers/callees counts · neighbors · **Impact**
(transitive callers). These are exactly the facts an agent would otherwise read files to learn.

---

## 🔥 Activity — the thesis, made visible

A live feed (fed by the existing WS / `rig_subscribe` stream over `mutation_log` +
`activations` + `focus:requested`) of what the agent does *through* rig:

```
Agent activity · this session
  14:02  rig_pull   parseConfig    → 8 ranked nodes
  14:02  rig_impact parseConfig    → 7 callers (depth 3)
  14:01  rig_search "auth gate"    → 5 hits
  ─────────────────────────────────────────────
  42 rig queries · ~18 files not read · est. ~36k tokens saved
```

The running **"files not read / tokens saved"** tally is the point: every
`rig_pull`/`rig_impact`/`rig_search` is traversal the agent didn't spend tokens
grepping + reading. Needs a small backend addition — an estimate, per query kind, of
the file-read cost it displaced (data already exists in `activations`/`mutation_log`).

---

## Build phases

1. **Frame** — rail + view router + collapsible inspector around the existing Map/Search/NodeDetail. (No new backend.)
2. **Read views** — Hubs, Deps, Doctor tables over existing `/api/*` (+ small endpoints where missing).
3. **Activity feed** — consume the WS stream into a live list. (No new backend.)
4. **Savings metric** — backend estimate of displaced file-reads/tokens + the tally. (Small backend addition.)
5. **Waypoints timeline** + write-surface (pending edges/aliases) — last, experimental tier.

Tokens land in phase 1 so every later view inherits the system.
