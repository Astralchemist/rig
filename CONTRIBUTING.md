# Contributing to Rig

Thanks for being here. Rig is built so that contributing is *cheap* — most additions touch one declarative file, and the generator wires the rest.

## Setup

```bash
bun install
bun run gen          # emit generated/ from .contracts/
bun test
```

Requires [Bun](https://bun.sh) ≥ 1.1. (Node ≥ 20 works as a runtime fallback for the library, but development runs on Bun.)

## The one-file rule

Most changes are a single contract in `.contracts/`:

- **A new MCP tool** → `.contracts/tools/rig_<name>.contract.ts` + one impl in `packages/mcp/src/tool-impls/`. See [`docs/contracts.md`](docs/contracts.md) for a worked example.
- **A new anchor type** → `.contracts/anchors/`.
- **A new WS event** → `.contracts/events/`.
- **A schema change** → a *new* migration `vN+1` in `.contracts/migrations/` (never edit a shipped one).

After editing a contract, run `bun run gen` and commit the regenerated `generated/`.

## Where does my idea plug in?

[`docs/integration.md`](docs/integration.md) maps every feature to one of five seams — a node type, an edge kind, a magnetic-pull term, a tool, or a WS view. If your idea doesn't fit one of those, it may be an [anti-goal](docs/iterationbacklog.md) — open an issue first.

## Conventions

- **Keep files small** (≤ ~150 lines) and prefer declarative contracts over hand-written wiring.
- Match the surrounding code's style, naming, and comment density.
- Commit subjects: one-line [Conventional Commits](https://www.conventionalcommits.org/) (`feat(deps): …`, `fix(web): …`). No body required.

## The gates (run before you push)

```bash
bun run gen:check        # generated/ is fresh
bun run check:compat     # no breaking changes to stable tools
bun run check:migrations # shipped migrations unchanged
bun test
```

CI runs all four. Notes:

- **Stable tools are protected.** If you change a `stable` tool's inputs/outputs/errors, `check:compat` fails. Make the change additive, mark the tool `experimental`, or bump the manifest major version. See [`COMPATIBILITY.md`](COMPATIBILITY.md).
- **Migrations are immutable once shipped.** Add `vN+1`; don't edit `vN`. Re-bless with `bun run migration:lock` only when adding a version.

## Pull requests

- Keep PRs focused; one seam at a time.
- Include a test for new behavior (`__tests__/`).
- If you touched a contract, confirm `generated/` is committed and fresh.

Welcome aboard. 🛰️
