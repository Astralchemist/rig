# Rig

**Watch your codebase become a constellation — and give your AI agent a map of it.**

Rig builds a local-first semantic knowledge graph of your project, renders it as an interactive map you can fly through, and exposes it to coding agents (Claude Code, Cursor, Codex, …) over MCP. Your agent stops grepping blindly and starts navigating — by structure, by meaning, and by what it's touched before.

Everything runs on your machine. No API key, no upload, nothing leaves your laptop.

---

## Quickstart

In any project directory:

```bash
bunx rig
```

That's the whole thing. One command:

```
  ⬡ Rig — mapping your codebase…
  ✓ initialized  ./.rig
  indexing      extract → resolve → embed → hubness → communities
  ✓ indexed     1,204 nodes · 3,891 edges · 212 files · 36 skills
  ✓ wired       claude
  ✓ map live    http://localhost:7474

  press Ctrl-C to stop the map.
```

It initializes `.rig/`, indexes your code, wires up whichever agent it detects, and opens the live map in your browser. Re-run any time, or use the explicit subcommands below.

> Prefer a global install? `bun install -g rig` (or `npm i -g rig`), then `rig start`.

---

## What you get

- **A map of your codebase.** Files, symbols, calls, imports, and dependencies as a navigable graph — not a file tree.
- **Magnetic pull.** Ask "what's related to X" and get a ranked answer that blends graph distance, semantic similarity, and what's been active recently.
- **Hubs.** The structurally important anchors surface first, so a 5k-node graph stays legible.
- **Dependency intelligence.** "What version of X do I have?" and "what's declared but never imported?" become one-hop graph queries.
- **Waypoints.** Your agent drops durable markers at decisions and constraints that survive context-window compaction — so a new session picks up oriented.
- **An MCP tool surface** your agent calls directly: search, pull, callers/callees, impact, hubs, deps, and more.

---

## Privacy & local-first

- Embeddings run locally via a small on-device model (`bge-small`). **No API key required.**
- The graph lives in `.rig/rig.db` in your project. `rig` auto-adds `.rig/` to your `.gitignore`.
- Nothing is uploaded. The map UI is served on loopback only.

---

## Wiring your agent

`bunx rig` auto-detects and wires the agents you have installed. To wire one explicitly:

```bash
rig install claude      # also: cursor · codex · opencode · openrouter
```

This merges Rig's MCP server into the agent's config; the agent spawns `rig serve --mcp` on demand.

---

## Commands

| Command | What it does |
|---|---|
| `rig start` | One-shot: init + index + wire agent + open the live map |
| `rig index` | Extract + write nodes (`--include` / `--exclude <glob>`) |
| `rig sync` | Incremental update |
| `rig query` | CLI search |
| `rig serve --all` | Start MCP and/or the web map (`--mcp` / `--web` / `--auth`) |
| `rig status` | Index health |
| `rig doctor` | Diagnose environment, db, model cache, agent configs |
| `rig export-docs` | Render waypoints into a markdown doc tree |

Run `rig --help` for the full list.

---

## How it works

`.contracts/` is the declarative source of truth (tools, anchors, migrations, events); `bun run gen` emits the matching code into `generated/`. The graph is plain SQLite. Retrieval is a single magnetic-pull scoring function over structural edges, on-device embeddings, and recency. The map UI is a force-graph over WebSocket.

- `packages/core` — the `Rig` class: DB, extraction, graph, embeddings, magnetic pull
- `packages/mcp` — MCP stdio server + tool dispatch
- `packages/web` — Fastify + WebSocket + React map UI
- `packages/cli` — the `rig` binary
- `packages/contracts` — `defineToolContract` & friends

See [`docs/contracts.md`](docs/contracts.md) to add a tool, [`docs/integration.md`](docs/integration.md) for the architecture, and [`COMPATIBILITY.md`](COMPATIBILITY.md) for the stability promise.

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 (primary), or Node ≥ 20 (fallback).
- Works on macOS, Linux, and Windows.

---

## Contributing

Adding a tool means touching one file in `.contracts/` and one implementation — the generator wires the rest. Start with [`docs/contracts.md`](docs/contracts.md), then [`docs/integration.md`](docs/integration.md) for where new ideas plug in. Stable tools are protected by a compatibility gate (`bun run check:compat`); see [`COMPATIBILITY.md`](COMPATIBILITY.md).

## License

[Apache-2.0](LICENSE). Rig's extraction layer is derived from [CodeGraph](https://github.com/colbymchenry/codegraph) (MIT, © Colby Mchenry); those portions remain under their original MIT terms — see [`LICENSE-CODEGRAPH.txt`](LICENSE-CODEGRAPH.txt) and [`NOTICE`](NOTICE). With thanks.
