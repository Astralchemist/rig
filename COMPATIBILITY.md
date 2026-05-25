# Rig — Compatibility & Stability

What Rig promises about its MCP tool surface, schema, and supported runtimes — so you can build on it without it moving under you.

---

## The stability axis

Every tool contract carries a `stability` field (`packages/contracts/src/kinds/tool.ts`):

| Stability | Promise | Compat gate |
|---|---|---|
| `stable` | Name, tier, required inputs, output fields, and error codes will not break without a **major manifest bump**. | Breaking changes **fail the build**. |
| `experimental` (default) | May change at any time. Build on it knowing it can move. | Exempt — changes allowed. |
| `deprecated` | On its way out. Still works; `deprecated_in` records when it was marked, `replaced_by` names its successor. | Exempt; removed on the next major. |

New tools default to `experimental`. A tool becomes a promise only when you explicitly set `stability: 'stable'` and a `since` version. Until then the gate protects nothing for it — which is the safe default.

### What counts as breaking (for a `stable` tool)

- removing the tool, or changing its `tier`
- removing an input property, or adding a **newly-required** input
- removing an output field
- removing an error code (agents branch on these)

### What is always additive (allowed)

- a new optional input
- a new output field
- a new error code
- a brand-new tool

The classifier lives in `scripts/gen/compat.ts`; the rules are locked by `__tests__/compat-gate.test.ts`.

---

## The compat gate

A blessed snapshot of the tool surface lives at `compat/tools-manifest.snapshot.json`. The gate diffs the freshly-built manifest against it.

```bash
bun run check:compat       # fails on a breaking change to a stable tool
bun run compat:snapshot    # re-bless the surface (intentional changes)
```

A **major manifest version bump** (the `version` field in `tools-manifest.json`) is the sanctioned escape hatch: it tells the gate that breaking changes are expected for this release. After a major release, re-bless the snapshot.

The gate runs in `prepublishOnly`, so a breaking change can never ship to npm un-acknowledged.

### Deprecation cycle

1. Mark the tool `stability: 'deprecated'`, set `deprecated_in`, and point `replaced_by` at its successor.
2. It keeps working across minor releases, with the deprecation noted in its description.
3. It is removed only on a major manifest bump.

---

## Schema & migrations

Migrations are **forward-only and immutable once shipped**. Each shipped migration contract is content-hashed into `compat/migrations.lock.json`.

```bash
bun run check:migrations   # fails if a shipped migration was edited or removed
bun run migration:lock     # bless after adding a new version
```

To change the schema, **add a new migration version** (`vN+1.contract.ts`) — never edit a shipped one. Versions must be contiguous from `v1` (enforced at gen time and by `__tests__/migration-lock.test.ts`). The generated schema surface is additionally golden-tested in `__tests__/schema-golden.test.ts`.

---

## Supported runtimes & platforms

The MCP tool surface is **protocol-level (JSON-RPC)** and therefore language- and shell-agnostic: a PowerShell user, a POSIX-shell user, and a Node-based caller all speak the same wire format. There are no per-language tool variants. Compatibility instead spans three axes:

| Axis | Supported | Notes |
|---|---|---|
| **JS runtime** | Bun ≥1.1 (primary), Node ≥20 <25 (fallback) | Bun uses `bun:sqlite`; Node uses `better-sqlite3`. CI runs both. |
| **OS / shell** | Linux, macOS (POSIX sh), Windows (PowerShell) | The installer resolves home dirs and `.claude.json` paths per-OS; no shell-specific tool behavior. |
| **Paths** | normalized to forward-slash internally | Node `file_path` values are normalized so search/FTS behave identically across OSes. |

If you run Rig on Node rather than Bun, the only difference is the SQLite binding; the tool surface and schema are identical.

---

## Versioning summary

- **Tool surface** — versioned by the `version` field in `tools-manifest.json`; breaking changes to `stable` tools require a major bump.
- **Schema** — versioned by migration number; shipped migrations are immutable, additions only.
- **Package** — semver in `package.json`; a tool-surface major bump implies a package major bump.

When in doubt: add, don't change. Additive evolution never trips a gate.
