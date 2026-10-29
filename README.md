# Rig

**Watch your codebase become a constellation — and give your AI agent a map of it.**

<p align="center">
  <a href="https://www.npmjs.com/package/rig-constellation"><img src="https://img.shields.io/npm/v/rig-constellation.svg?color=cb3837&label=npm" alt="npm version"></a>
  <a href="https://github.com/Astralchemist/rig/actions/workflows/ci.yml"><img src="https://github.com/Astralchemist/rig/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/runtime-Node%2022%2B%20%C2%B7%20Bun-339933.svg" alt="runs on Node 22+ and Bun">
</p>

<p align="center">
  <a href="https://github.com/Astralchemist/rig/releases/download/v0.1.0/demo.mp4">
    <img src="docs/demo.gif" alt="Rig — the live map of a codebase, navigated in real time" width="820">
  </a>
  <br>
  <em><a href="https://github.com/Astralchemist/rig/releases/download/v0.1.0/demo.mp4">▶ Watch the full demo with audio</a></em>
</p>

Rig builds a local-first semantic knowledge graph of your project, renders it as an interactive map you can fly through, and exposes it to coding agents (Claude Code, Cursor, Codex, opencode) over MCP. Agents navigate by structure and by meaning, and they keep what earlier sessions decided, attached to the code it is about.

Everything runs on your machine. No API key, no upload, nothing leaves your laptop.

---

## Quickstart

In any project directory:

```bash
npx rig-constellation
```

(Have [Bun](https://bun.sh)? `bunx rig-constellation` works too.) That's the whole thing. One command:

```
  ⬡ Rig — mapping my-project
  http://localhost:7491

  ✓ initialized  ./.rig
  ✓ map live    http://localhost:7491
  → 1/6 extract      ██████████████████ 212/212
  → 5/6 hubness      ████████████████░░
  ✓ indexed     1,204 nodes · 3,891 edges · 212 files · 36 skills
  ✓ wired Claude Code  project
      wrote     .mcp.json
      wrote     .claude/settings.json
      wrote     CLAUDE.md

  press Ctrl-C to stop the map.
```

It initializes `.rig/`, opens the live map **first**, then indexes your code so the
graph assembles in the already-open browser tab in real time, and wires whichever
agent it detects into this project, listing every file it writes. The map title and
port are derived per project, so two checkouts can run side by side on stable,
distinct ports. Re-run any time, or use the explicit subcommands below.

> The command is `rig` (alias: `rig-constellation`). Prefer a global install?
> `npm i -g rig-constellation` (or `bun install -g rig-constellation`), then `rig start`.
> Installed locally with `npm i rig-constellation`? The binary lives in `node_modules/.bin` —
> run it with `npx rig start` (or install with `-g` to get `rig` on your `PATH`).

---

## What it can do

**Map and navigate code**
- **A live map of your codebase.** Files, symbols, calls, imports, tests and dependencies as a graph you can fly through in the browser. The map updates live while agents work.
- **Structural questions in one call.** Callers, callees, impact ("what breaks if I change X"), critical paths, neighbours and hubs, instead of grep-and-read.
- **Search in plain language.** "Where do we refresh expired sessions?" finds the code. Exact names, keywords (including identifier words, so "handle login" matches `handleLogin`) and on-device embeddings are fused into one ranking. A symbol name still returns that symbol first.
- **Orientation on demand.** `rig_overview` (also the MCP resource `rig://overview`, and `rig overview` on the command line) returns a compact markdown map of the repository, about 2,000 tokens long. It covers:
  - packages and their purposes
  - entry points
  - the most-referenced symbols with `file:line`
  - route and handler tables
  - where the tests live
  - recent decisions

  The map is cached and refreshed on every index, sync and file change.
- **Magnetic pull.** "What's related to X", ranked by graph distance, semantic similarity and recent activity, with the score components broken out.
- **Dependency intelligence.** Installed versions, declared-but-unused packages, imports with no declaration, and version conflicts across a monorepo. It covers npm and Python: PyPI names are matched to their import names (`PyYAML` → `yaml`), and the standard library is never flagged.

**Remember across sessions and agents**
- **Memory that survives re-indexing.** Index, sync, file edits and line moves keep everything agents attach to code:
  - waypoints (decisions, constraints, open questions)
  - aliases, annotations and promotions
  - proposed and accepted links

  If a symbol disappears, its memory is set aside rather than lost, and re-attached when the symbol comes back.
- **Waypoints** live outside the context window. They are searchable by meaning (`rig_waypoints query="…"`), and the next session can load the previous one's.
- **Human review where it matters.** Links an agent proposes wait for your accept or reject on the map, and every change can be undone step by step.
- **Portable memory.** `rig export-memory` and `rig import-memory` carry agent memory across fresh clones and machines.
- **One graph, many agents.** Claude Code, Cursor, Codex and opencode can all work on the same project at the same time. Writes are concurrency-safe and record which agent made them.

**Fit into your setup**
- **Wiring** goes into the current project by default (`rig install claude`), and `rig uninstall` removes exactly what was added. Each agent gets rig's approval policy in its own permission format; risky writes ask first.
- **A live graph.** A single file watcher per project keeps the graph current while you code.
- **Languages:** TypeScript, TSX, JavaScript, JSX, Python and Markdown, plus `package.json`, `pyproject.toml`, `requirements*.txt` and their lockfiles.

## Measured, not claimed

`scripts/bench` runs real agents through OpenRouter on [next-auth](https://github.com/nextauthjs/next-auth) at a pinned commit, and checks every answer automatically. `bun run bench:chart` draws these charts from the recorded results. The raw results and reports are in [`scripts/bench/results/`](scripts/bench/results/).

<p align="center">
  <img src="https://raw.githubusercontent.com/Astralchemist/rig/main/docs/bench/memory.svg" alt="Session-2 success: memory-off 30%, memory-on 70%, oracle 82%. memory-on minus memory-off: +40 pp, 95% CI +20 to +60 pp, above the pre-registered +15 pp bar." width="760">
</p>

**Memory across sessions passed its pre-registered bar.** On 20 two-session tasks with Claude Haiku 5.5, session 2 succeeded 70% of the time with rig's waypoints and 30% without. That is +40 pp (95% CI +20 to +60 pp), at 94% of memory-off's tokens. The bar (the whole CI at or above +15 pp, tokens at or below 110%) was written before any run. The losses: the first 10 tasks alone were inconclusive, the 10 confirmation tasks alone went over the token cap (110.2%), and two trap tasks beat every arm, oracle included.

<p align="center">
  <img src="https://raw.githubusercontent.com/Astralchemist/rig/main/docs/bench/qa-tokens.svg" alt="Single-shot tokens relative to grep-only, by rig build and arm. Every arm is above 100% overall; at rig 0.3.0 grep+rig is 134% overall, 175% on lookups and 99% on natural-language questions." width="760">
</p>

**On single questions, grep still wins.** With grep and rig both available, as in a real agent session, rig 0.3.0 used 134% of grep-only's tokens per question, and both arms got 48/48 right. Exact identifier lookups cost 175%, which is why the installed guide tells agents to use grep for them. Natural-language questions came out even (99%). Putting the orientation map in every prompt cost 187%, so the map is on demand.

<p align="center">
  <img src="https://raw.githubusercontent.com/Astralchemist/rig/main/docs/bench/cross-model.svg" alt="Memory gain and Q&A token ratio per model. anthropic/claude-haiku-5.5: +40 pp memory gain (PASS) and 134% of grep-only tokens. deepseek/deepseek-v4.1-flash: +60 pp memory gain, FAIL on the token cap at 110.6%; Q&amp;A not run. The other six lineup models are not run yet." width="760">
</p>

**One model so far.** Every result above comes from Claude Haiku 5.5. `bun run bench:matrix` reruns the same bench across low-cost and frontier models from Anthropic, OpenAI, Google, DeepSeek and Qwen, with the same prompts, tools and trials for each. Rows marked "not run yet" have no results.

---

## What your agent does differently

Without a map, an agent answers *"what breaks if I change `parseConfig`?"* by grepping the string and reading whatever files match — blind, lossy, and token-expensive.

With Rig it's one call:

```
rig_impact parseConfig
→ 7 transitive callers, ranked:
   loadSettings          calls · depth 1
   bootstrap             calls · depth 2
   __tests__/config…     tests · depth 1
   …
```

And *"what else should I look at?"* isn't a guess — `rig_pull` returns related anchors scored by graph distance, on-device embedding similarity, and recent activity, with the three components broken out so the ranking is **explainable, not a black box**:

```
rig_pull parseConfig
→ { node: "validateSchema", score: 0.81,
    components: { structural: 0.4, semantic: 0.9, recency: 0.7 } }
```

That ranked, self-explaining retrieval — not a flat grep dump — is the difference.

---

## Privacy & local-first

- Embeddings run locally via a small on-device model (`bge-small`). **No API key required.**
- The graph lives in `.rig/rig.db` in your project. `rig` auto-adds `.rig/` to your `.gitignore`.
- Nothing is uploaded. The map UI is served on loopback only and needs its per-project session token, with Host and Origin checks against other web pages; `rig start` opens it signed in.

---

## Wiring your agent

`bunx rig-constellation` auto-detects the agents you have installed and wires them **into
the current project** — it never edits your user-level config. To wire one explicitly:

```bash
rig install claude            # also: cursor · codex · opencode
rig install claude --global   # your user-level config instead: applies to every project
rig uninstall claude          # remove exactly what install added (--all · --global · --dry-run)
```

| Agent | Project (default) | `--global` |
|---|---|---|
| Claude Code | `.mcp.json` · `.claude/settings.json` · `CLAUDE.md` | `~/.claude.json` · `~/.claude/settings.json` · `~/.claude/CLAUDE.md` |
| Cursor | `.cursor/mcp.json` · `.cursor/cli.json` · `.cursor/rules/rig.mdc` | `~/.cursor/mcp.json` |
| Codex CLI | — user-level only | `~/.codex/config.toml` · `~/.codex/AGENTS.md` |
| opencode | — user-level only | `~/.config/opencode/opencode.jsonc` · `~/.config/opencode/AGENTS.md` |

Each install merges Rig's MCP server entry, Rig's per-tool approval policy (in the
agent's own permission format), and a short usage guide between `<!-- rig:begin -->`
markers, leaving the rest of each file alone — re-running it is safe. The agent spawns
`rig serve --mcp` on demand; Claude Code asks you once to approve a server from a
project's `.mcp.json`. In a directory without `.rig/`, the server still starts and every
tool answers with how to fix it (`rig init` or `rig start`).

OpenRouter is an API, not an MCP host: `rig install openrouter` only writes a reference
config to copy into the MCP client you use with it.

---

## Commands

| Command | What it does |
|---|---|
| `rig start` | One-shot: init + index + wire agent + open the live map |
| `rig install <agent>` | Wire an agent into this project (`--global` for your user-level config) |
| `rig uninstall <agent>` | Remove exactly what install added (`--all`, `--global`, `--dry-run`) |
| `rig index` | Extract + write nodes, skipping unchanged files (`--include` / `--exclude <glob>`, `--force`) |
| `rig sync` | Incremental update |
| `rig query` | CLI search |
| `rig overview` | Print the orientation map your agent gets from `rig_overview` (`--budget <tokens>`, default 2000; `--json`) |
| `rig serve --all` | Start MCP and/or the web map (`--mcp` / `--web` / `--no-auth`; `--path <dir>` for another project); keeps the graph live by syncing on file changes (`--no-watch` or `RIG_NO_WATCH=1` to turn off) |
| `rig status` | Index health |
| `rig doctor` | Diagnose environment, db, model cache, agent configs |
| `rig export-docs` | Render waypoints into a markdown doc tree |
| `rig export-memory` | Save agent memory (aliases, notes, links, promotions, waypoints) as JSONL that survives losing `.rig/` (`--out <file>`). It can contain conversation-derived text: review it before committing it |
| `rig import-memory <file>` | Merge an export back in, e.g. after a fresh clone + `rig index`. Only adds; never overwrites |

Run `rig --help` for the full list.

---

## How it works

`.contracts/` is the declarative source of truth (tools, anchors, migrations, events); `bun run gen` emits the matching code into `generated/`. The graph is plain SQLite. Search fuses exact names, SQLite FTS5 keyword matches and on-device embedding similarity by reciprocal rank; "what's related" is a single magnetic-pull scoring function over structural edges, on-device embeddings, and recency. The map UI is a force-graph over WebSocket.

- `packages/core` — the `Rig` class: DB, extraction, graph, embeddings, magnetic pull
- `packages/mcp` — MCP stdio server + tool dispatch
- `packages/web` — Fastify + WebSocket + React map UI
- `packages/cli` — the `rig` binary
- `packages/contracts` — `defineToolContract` & friends

See [`docs/contracts.md`](docs/contracts.md) to add a tool, [`docs/integration.md`](docs/integration.md) for the architecture, and [`COMPATIBILITY.md`](COMPATIBILITY.md) for the stability promise.

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 (primary), or Node ≥ 22 (fallback).
- Works on macOS, Linux, and Windows.

---

## Contributing

Adding a tool means touching one file in `.contracts/` and one implementation — the generator wires the rest. Start with [`docs/contracts.md`](docs/contracts.md), then [`docs/integration.md`](docs/integration.md) for where new ideas plug in. Stable tools are protected by a compatibility gate (`bun run check:compat`); see [`COMPATIBILITY.md`](COMPATIBILITY.md).

## License

[Apache-2.0](LICENSE). Rig's extraction layer is derived from [CodeGraph](https://github.com/colbymchenry/codegraph) (MIT, © Colby Mchenry); those portions remain under their original MIT terms — see [`LICENSE-CODEGRAPH.txt`](LICENSE-CODEGRAPH.txt) and [`NOTICE`](NOTICE). With thanks.
