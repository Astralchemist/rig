# CodeGraph snapshot

Read-only upstream reference vendored under `vendor/codegraph/` (gitignored). Rig copies and adapts files out; we do not ship the vendor tree.

## Snapshot identity

| Field | Value |
|---|---|
| Repo | https://github.com/colbymchenry/codegraph |
| npm package | `@colbymchenry/codegraph` |
| Commit SHA | `bf73f4d05cc7e0683444f14940a018ddbe8c8186` |
| Commit date | 2026-05-22 |
| Commit subject | `feat(installer): add codegraph uninstall command (#313) (#318)` |
| License | MIT (Copyright (c) 2026 Colby Mchenry) — verbatim in `LICENSE-CODEGRAPH.txt` |
| Engines | Node `>=18.0.0 <25.0.0` (hard exit on 25.x in `src/bin/node-version-check.ts`) |

## Why we vendor

Phase 1+ pulls specific files into `packages/`. Vendoring the snapshot lets us read upstream source while building, avoids re-cloning per session, and pins us to a known SHA so upstream churn never breaks an in-flight phase. **Do not chase `main`** — bump the snapshot deliberately and record the SHA bump here.

## Disposition (summary)

Full per-file detail lives in `docs/extractionmap.md`. One-line summary:

| Subsystem | Phase | Disposition |
|---|---|---|
| `src/db/` | 1 | pull + extend (semantic edges, embeddings, activations) |
| `src/mcp/` | 1 | pull transport verbatim; tools dispatched via Rig's contract generator |
| `src/extraction/` | 1 | pull TS/JS/Python only; add Markdown |
| `src/resolution/` | 1 | pull orchestrator + import-resolver + name-matcher; drop `frameworks/` |
| `src/graph/` | 1 | pull verbatim; add `pull.ts` magnetic-pull on top |
| `src/sync/` | 1 | pull verbatim (watcher + watch-policy + git-hooks) |
| `src/installer/` | 1 | pull + retarget; per-target files emitted by Rig's generator |
| `src/bin/` | 0–1 | pull node-version-check; CLI surface stays Rig-native |
| `src/context/` | 1 | reshape to use magnetic-pull scoring |
| `src/search/` | 1 | pull verbatim |
| `src/ui/` | 0 | pull verbatim (glyphs + shimmer) |

## Useful facts gleaned from upstream

- **Distribution shape is already posture A** — `.github/workflows/release.yml` + `scripts/build-bundle.sh` + `scripts/pack-npm.sh` produce a thin npm shim with per-platform bundles. Concrete template for when Rig adds native escape hatches.
- **NodeKind / EdgeKind** are defined in `src/types.ts` as exact string literals shared by extractors and resolvers. When Rig adds code-symbol as a first-class anchor type, mirror this discipline so the data layer is closed against typos.
- **`src/db/sqlite-adapter.ts`** is the dual-backend (`better-sqlite3` native + `node-sqlite3-wasm` fallback) abstraction. It implements the shape Rig's `SqliteAdapter` interface (`packages/core/src/db/adapter.ts`) was modeled on — the Phase 1.1 pull should be a near-drop-in.
- **`__tests__/installer-targets.test.ts`** is ~47 parameterized contract tests. Mirror this shape for Rig's generated target outputs — golden files give us safety when one tool contract change ripples through 4 target permission files + 4 instructions files.

## Refresh policy

Stay pinned unless one of:
1. A specific upstream fix is needed (record the PR/issue link in the bump commit).
2. A new file we want to extract has landed.
3. Quarterly review.

## Refresh command

```bash
rm -rf vendor/codegraph
git clone --depth 1 https://github.com/colbymchenry/codegraph.git vendor/codegraph
cd vendor/codegraph && git rev-parse HEAD && git log -1 --format='%ai %s'
# Update the SHA/date/subject rows at the top of this file with the new values.
# Update LICENSE-CODEGRAPH.txt's footer to match.
```
