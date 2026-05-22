# Rig

Local-first semantic knowledge graph with an interactive map UI and an AI co-cartographer. See `docs/buildbrief.md` for the philosophy and architecture.

## Status

Phase 0 — scaffold. Contract generator pulled forward from Phase 1.5.

## Quickstart

```bash
bun install
bun run gen          # regenerate generated/ from .contracts/
bun run gen:check    # verify generated/ is fresh
bun test
```

## Layout

- `.contracts/` — declarative source of truth (tools, anchors, targets, migrations, events)
- `generated/` — emitted artifacts. Committed. Never hand-edit.
- `packages/contracts` — `defineToolContract` & friends + Zod schemas
- `packages/core` — the `Rig` class, DB, extraction, graph, embeddings, magnetic-pull
- `packages/mcp` — MCP stdio server + tool dispatch
- `packages/web` — Fastify + WebSocket + React map UI (Phase 2+)
- `packages/cli` — the `rig` binary
- `scripts/gen.ts` — the contract generator
