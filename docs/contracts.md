# Rig — Contracts

> How to add a contract — the declarative source of truth behind every tool, schema, migration, and event.

The contract layer turns "add a tool" from a 5-place edit into a 1-place declaration. Every cross-module boundary (MCP tools, anchor types, agent targets, migrations, WS events) is described in `.contracts/`; `bun run gen` produces the matching files under `generated/`. Pre-commit + `bun test` enforce freshness.

---

## Worked example — add `rig_random`

Goal: ship a new MCP tool that picks a random anchor. Touch one file in `.contracts/`, one in `packages/mcp/src/tool-impls/`. Nothing else.

### 1. Declare the contract

`.contracts/tools/rig_random.contract.ts`:

```ts
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_random',
  tier: 'light',
  summary: 'Pick a random anchor',
  description: `
    Returns one anchor chosen uniformly at random. Useful as a sanity probe
    or as a tie-breaker when the agent needs an unbiased starting point.
  `.trim(),
  input: z.object({
    kind: z.string().optional().describe('Optional anchor type filter'),
  }),
  output: z.object({
    node: z.object({ id: z.string(), name: z.string(), kind: z.string() }),
    elapsed_ms: z.number(),
  }),
  errors: ['NO_NODES'] as const,
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'allow',
  },
  records_activation: true,
});
```

### 2. Run the generator

```
bun run gen
```

This regenerates `generated/mcp/tools-manifest.json`, the per-target permission JSON, per-target instructions markdown, the handler stub at `generated/mcp/handlers/rig_random.handler.ts`, and the tool-names index.

### 3. Write the implementation body

`packages/mcp/src/tool-impls/rig_random.ts`:

```ts
import type { Rig } from '@rig/core';
export const rig_random = async (rig: Rig, args: { kind?: string }) => {
  const start = Date.now();
  const all = rig.searchNodes('*', { kind: args.kind, limit: 10_000 });
  if (!all.length) throw new Error('NO_NODES');
  const pick = all[Math.floor(Math.random() * all.length)]!;
  return { node: { id: pick.id, name: pick.name, kind: pick.type }, elapsed_ms: Date.now() - start };
};
```

### 4. Done

No other edits. The handler stub imports your body, validates input/output, applies tier middleware (activation recording for light tools), and is registered automatically via the generated handlers index. Permission JSONs and instructions markdowns for all 5 targets update on the next install.

---

## Per-kind reference

Each contract kind lives under `.contracts/<kind>/` and has a `define*Contract` helper in `@rig/contracts`. Validation is by Zod schema; cross-validation is enforced by the generator.

### Tools — `.contracts/tools/*.contract.ts`

Tiers: `light` (metadata-sized responses), `heavy` (returns source bodies; no session gate, because MCP can't tell a main session from a sub-agent), `write` (provenance + rationale enforced, broadcasts a WS event, paired with an inverse for undo), `live` (long-poll subscription).

Tier-specific fields:
- `light`: `records_activation?: boolean`
- `write`: `provenance_required: true`, `broadcasts: WsEventName`, `inverse?: ToolName`, `requires_rationale: true`
- `live`: `subscription_kind: string`

### Anchors — `.contracts/anchors/*.contract.ts`

```ts
defineAnchorContract({
  type: 'code-symbol',
  description: '...',
  extractor: 'tree-sitter',
  data_schema: z.object({ /* nodes.data payload */ }),
  ui: { icon, color, label_field, detail_fields },
  allowed_edges: { outgoing: [...], incoming: [...] },
  embeddable: true,
  embedding_text: ['name', 'qualified_name', 'docstring', 'signature'],
});
```

Composes into `generated/core/anchors-registry.ts`. `embedding_text` is used by the embed pipeline; `allowed_edges` constrains what extractors may emit.

### Targets — `.contracts/targets/*.contract.ts`

```ts
defineTargetContract({
  name: 'claude',
  display_name: 'Claude Code',
  detect: async () => existsSync(...),
  files: [
    { role: 'mcp_config', path: '~/.claude.json', mode: 'merge-json', template: { ... } },
    { role: 'permissions', path: '~/.claude/settings.json', mode: 'merge-json', template: '{{GENERATED:claude.permissions.json}}' },
    { role: 'instructions', path: '~/.claude/CLAUDE.md', mode: 'append-section', section_marker: '## Rig', template: '{{GENERATED:claude.instructions.md}}' },
  ],
  uninstall_strategy: 'reverse',
});
```

Per-tool permissions and instructions sections are composed from BOTH the target contract and every tool contract's `permissions[<target>]` field. Add a tool → all 5 target outputs refresh on next `gen`.

### Migrations — `.contracts/migrations/v<N>.contract.ts`

Versions must be contiguous from 1. Migrations are append-only — never edit a shipped one; add `v(N+1)` instead. `schema-golden.test.ts` locks the surface.

```ts
defineMigrationContract({
  version: 2,
  description: 'Phase 3 read-write tables',
  applied_in_phase: 3,
  forward: `CREATE TABLE ...`,
  rollback: `DROP TABLE ...`,
});
```

### Events — `.contracts/events/*.contract.ts`

```ts
defineEventContract({
  name: 'edge:proposed',
  emitted_by: ['rig_propose_edge'],
  payload: z.object({ /* WS payload */ }),
  ui_effect: 'render dashed edge; pulse target node',
});
```

Composed into `generated/web/events-types.ts` as a discriminated union for the WS layer.

---

## Validation guarantees

Enforced at `bun run gen` (and therefore at pre-commit + CI + `bun test`):

| Check | Implemented in | Test |
|---|---|---|
| Zod schema match per contract | `scripts/gen/discover.ts` | `contracts.test.ts` validation block |
| Unique names per kind | `scripts/gen.ts:assertUniqueByName` | `contracts.test.ts` |
| Migration versions contiguous from 1 | `scripts/gen.ts:assertContiguousMigrations` | `contracts.test.ts` |
| Generated tree matches manifest | `scripts/gen-check.ts` | `contracts.test.ts` freshness block |
| Schema surface unchanged across migrations | `generated/core/schema.sql` golden | `schema-golden.test.ts` |
| Installer output golden per target | rendered templates | `installer-targets.test.ts` |
| `gen` finishes under 3s | timer in test | `contracts.test.ts` perf block |

---

## Common operations

| Want to | Do this |
|---|---|
| Add a tool | Write one `.contracts/tools/*.contract.ts`, write the body in `packages/mcp/src/tool-impls/`, `bun run gen` |
| Add an anchor type | Write one `.contracts/anchors/*.contract.ts`, extend extractor if `extractor: 'tree-sitter'`, `bun run gen` |
| Add a target | Write one `.contracts/targets/*.contract.ts`, run `bun run gen`. Permissions and instructions compose from existing tool contracts automatically |
| Add a migration | Write `.contracts/migrations/v(N+1).contract.ts` with `version: N+1`, `bun run gen`, update `schema-golden.test.ts` expectations |
| Add a WS event | Write one `.contracts/events/*.contract.ts`, point `emitted_by` at the tool(s) that emit it, `bun run gen` |
| Force regen after pulling | `bun run gen` (or pre-commit will block stale commits anyway) |
| Verify freshness | `bun run gen:check` — exit 0 means fresh |

---

*End. When adding a new contract kind itself (e.g. a hypothetical `defineDashboardContract`), edit `packages/contracts/src/kinds/` and `scripts/gen/emitters/` — the meta-level stays in code, not in contracts.*
