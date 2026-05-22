# Rig — Phase 1.5 Addendum: Contract Generator

> **What this is.** A bolt-on to the Phase 3 execution plan that adds a declarative contract layer between Phase 1 and Phase 2. Inspired by Vasilios Syrakis's "Sovereign" Envoy control plane at Atlassian: developers declare intent in spec files, the system materializes everything else. Adapted to local-first scale (one generator script, no SQS or DynamoDB).
>
> **Read after:** `rig-build-brief.md`, `codegraph-extraction-map.md`, `rig-phase3-plan.md`.
>
> **Where this slots in.** Between Phase 1 (read-only MCP) and Phase 2 (localhost map UI). Once Phase 1 has shipped with 11 hand-written tool files, we collapse them into contracts before the surface grows further. Earlier than this and the generator is more code than the contracts it generates. Later than this and we're hand-editing the same five places every time a tool is added.

---

## 1. The principle

**Every contract in the system lives as one declarative spec file. Everything else is generated from it.**

A "contract" here is any boundary that crosses module lines and must stay in sync: MCP tools, anchor types, agent target writers, schema migrations, mutation events. Without the generator, adding one MCP tool means hand-editing the tool handler, the MCP manifest, the `settings.json` permission list, the `CLAUDE.md` instructions, the TypeScript types, and the test fixture — five places that silently drift. With the generator, you edit one `.contract.ts` file and run `bun run gen`.

This is the Sovereign pattern applied at the right scale. We are not building SQS queues or DynamoDB status polling. We are building one synchronous generator script that walks `.contracts/`, validates every spec, and emits a deterministic `generated/` tree. The discipline is the same; the plumbing is appropriately smaller.

---

## 2. Directory layout

```
rig/
├── .contracts/
│   ├── tools/                    # MCP tool contracts
│   │   ├── rig_search.contract.ts
│   │   ├── rig_node.contract.ts
│   │   ├── rig_neighbors.contract.ts
│   │   ├── rig_pull.contract.ts
│   │   ├── rig_callers.contract.ts
│   │   ├── rig_callees.contract.ts
│   │   ├── rig_impact.contract.ts
│   │   ├── rig_status.contract.ts
│   │   ├── rig_files.contract.ts
│   │   ├── rig_explore.contract.ts
│   │   ├── rig_context.contract.ts
│   │   ├── rig_propose_edge.contract.ts    # Phase 3
│   │   ├── rig_add_node.contract.ts        # Phase 3
│   │   ├── rig_annotate.contract.ts        # Phase 3
│   │   ├── rig_cluster.contract.ts         # Phase 3
│   │   ├── rig_focus.contract.ts           # Phase 3
│   │   ├── rig_subscribe.contract.ts       # Phase 3
│   │   └── rig_undo.contract.ts            # Phase 3
│   ├── anchors/
│   │   ├── code-symbol.contract.ts
│   │   ├── markdown-section.contract.ts
│   │   └── cluster.contract.ts                       # Phase 3
│   ├── targets/
│   │   ├── claude.contract.ts
│   │   ├── cursor.contract.ts
│   │   ├── codex.contract.ts
│   │   ├── opencode.contract.ts
│   │   └── hermes.contract.ts
│   ├── migrations/
│   │   ├── v1.contract.ts
│   │   └── v2.contract.ts                            # Phase 3
│   └── events/
│       ├── node-added.contract.ts                    # Phase 3
│       ├── edge-proposed.contract.ts                 # Phase 3
│       ├── edge-accepted.contract.ts                 # Phase 3
│       └── ... (one per WS event)
├── generated/                    # ALL files have // GENERATED — DO NOT EDIT
│   ├── mcp/
│   │   ├── tools-manifest.json
│   │   ├── handlers/             # one stub per tool — body still hand-written
│   │   └── types.ts
│   ├── installer/
│   │   ├── claude.permissions.json
│   │   ├── claude-md-section.md
│   │   ├── cursor.permissions.json
│   │   ├── cursor.mdc-section.md
│   │   ├── codex.toml-fragment
│   │   ├── codex.agents-md-section.md
│   │   ├── opencode.config-fragment
│   │   └── opencode.instructions.md
│   ├── core/
│   │   ├── db/schema.sql         # composed from migrations
│   │   ├── db/migrations.ts      # composed migration runners
│   │   └── anchors/registry.ts   # composed anchor registry
│   ├── web/
│   │   └── events/types.ts       # WS event types
│   ├── tests/contracts/          # one validation test per contract
│   └── .manifest                 # hash map for freshness check
├── packages/
│   └── contracts/                # NEW package: contract type definitions + helpers
│       └── src/
│           ├── index.ts          # defineToolContract, defineAnchorContract, ...
│           └── schemas.ts        # Zod schemas for every contract kind
└── scripts/
    ├── gen.ts                    # the generator
    └── gen-check.ts              # freshness check (gen --check entrypoint)
```

`generated/` is committed to the repo so a clean checkout builds without running the generator first. The pre-commit hook ensures `generated/` is never stale.

---

## 3. Contract schemas — concrete shapes

### 3.1 Tool contract (`.contracts/tools/*.contract.ts`)

```ts
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_search',
  tier: 'light',                              // 'light' | 'heavy' | 'write' | 'live'
  summary: 'Find anchors by name',            // ≤ 60 chars — used in tools/list
  description: `
    FTS5 search over anchor names and qualified names. Returns matches as
    {id, name, kind, file_path?}. Use for "where is X defined" questions.
    Records an activation on every returned anchor.
  `.trim(),                                   // longer description → CLAUDE.md section
  input: z.object({
    query: z.string().min(1).describe('FTS5 query string'),
    kind: z.string().optional().describe('Filter by anchor kind'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  output: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      file_path: z.string().optional(),
    })),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'QUERY_INVALID'] as const,
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto',
    opencode: 'allow',
  },
  // tier-specific fields below:
  records_activation: true,                   // light tools may record
  // (write tools add): provenance_required, broadcasts, inverse, requires_rationale
  // (heavy tools add): main_session_forbidden: true
  // (live tools add): subscription_kind
});
```

### 3.2 Write tool contract (Phase 3)

```ts
export default defineToolContract({
  name: 'rig_propose_edge',
  tier: 'write',
  summary: 'Propose a semantic edge between two anchors',
  description: `
    Writes to the pending_edges table. The edge is shown as dashed in the UI
    until the user accepts it. Rationale is shown in the accept popover and
    is permanent in the mutation_log.
  `.trim(),
  input: z.object({
    src: z.string(),
    dst: z.string(),
    weight: z.number().min(0).max(1),
    rationale: z.string().min(10).describe('Why this edge should exist'),
  }),
  output: z.object({
    pending_id: z.number().int(),
  }),
  errors: ['NODE_NOT_FOUND', 'EDGE_EXISTS', 'RATIONALE_TOO_SHORT'] as const,
  permissions: { claude: 'auto-allow' },
  provenance_required: true,                  // generator emits validator
  broadcasts: 'edge:proposed' as const,       // generator emits WS broadcast
  inverse: 'reject_pending_edge' as const,    // generator wires undo
  requires_rationale: true,
});
```

### 3.3 Anchor type contract

```ts
import { z } from 'zod';
import { defineAnchorContract } from '@rig/contracts';

export default defineAnchorContract({
  type: 'code-symbol',
  description: 'A function, class, method, or other code-level identifier',
  extractor: 'tree-sitter',                   // 'tree-sitter' | 'custom' | 'manual'
  data_schema: z.object({
    qualified_name: z.string(),
    file_path: z.string(),
    start_line: z.number().int(),
    end_line: z.number().int(),
    start_column: z.number().int(),
    end_column: z.number().int(),
    signature: z.string().optional(),
    docstring: z.string().optional(),
    visibility: z.enum(['public', 'private', 'protected', 'internal']).optional(),
    is_exported: z.boolean().default(false),
    is_async: z.boolean().default(false),
  }),
  ui: {
    icon: 'function',                         // Tabler icon name
    color: 'c-teal',                          // Rig color ramp
    label_field: 'name',
    detail_fields: ['qualified_name', 'file_path', 'signature'],
  },
  allowed_edges: {
    outgoing: ['calls', 'imports', 'extends', 'implements', 'contains', 'references'],
    incoming: ['calls', 'extends', 'implements', 'contains', 'references'],
  },
  embeddable: true,                           // generator wires embedding job
  embedding_text: ['name', 'qualified_name', 'docstring', 'signature'],
});
```

### 3.4 Target writer contract

```ts
import { defineTargetContract } from '@rig/contracts';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export default defineTargetContract({
  name: 'claude',
  display_name: 'Claude Code',
  detect: async () => existsSync(path.join(homedir(), '.claude.json')),
  files: [
    {
      role: 'mcp_config',
      path: '~/.claude.json',
      mode: 'merge-json',
      template: {
        mcpServers: {
          rig: {
            type: 'stdio',
            command: '{{RIG_BIN}}',
            args: ['serve', '--mcp'],
          },
        },
      },
    },
    {
      role: 'permissions',
      path: '~/.claude/settings.json',
      mode: 'merge-json',
      template: '{{GENERATED:claude.permissions.json}}',
    },
    {
      role: 'instructions',
      path: '~/.claude/CLAUDE.md',
      mode: 'append-section',
      section_marker: '## Rig',
      template: '{{GENERATED:claude-md-section.md}}',
    },
  ],
  uninstall_strategy: 'reverse',              // re-apply each file in reverse with delete semantics
});
```

### 3.5 Migration contract

```ts
import { defineMigrationContract } from '@rig/contracts';

export default defineMigrationContract({
  version: 2,
  description: 'Add pending_edges, mutation_log for Phase 3 read-write graph',
  applied_in_phase: 3,
  forward: `
    CREATE TABLE pending_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      src TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      dst TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      weight REAL NOT NULL,
      provenance TEXT NOT NULL,
      rationale TEXT NOT NULL,
      proposed_at INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected'))
    );
    CREATE INDEX idx_pending_edges_status ON pending_edges(status);

    CREATE TABLE mutation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      actor TEXT NOT NULL
    );
    CREATE INDEX idx_mutation_log_session_ts ON mutation_log(session_id, ts);
  `,
  rollback: `
    DROP TABLE IF EXISTS mutation_log;
    DROP TABLE IF EXISTS pending_edges;
  `,
});
```

### 3.6 Event contract (Phase 3)

```ts
import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

export default defineEventContract({
  name: 'edge:proposed',
  emitted_by: ['rig_propose_edge'],
  payload: z.object({
    pending_edge: z.object({
      id: z.number().int(),
      src: z.string(),
      dst: z.string(),
      weight: z.number(),
      provenance: z.string(),
      rationale: z.string(),
      proposed_at: z.number().int(),
    }),
  }),
  ui_effect: 'render dashed edge with rationale tooltip; pulse the target node',
});
```

---

## 4. Generator algorithm

`scripts/gen.ts` is a single-file Bun script. Pseudocode:

```ts
async function generate(): Promise<GenerateResult> {
  // 1. Discovery
  const files = await glob('.contracts/**/*.contract.ts');

  // 2. Load + validate each contract
  const contracts: ContractsByKind = { tools: [], anchors: [], targets: [], migrations: [], events: [] };
  for (const file of files) {
    const mod = await import(path.resolve(file));
    const contract = mod.default;
    const kind = inferKindFromPath(file);  // .contracts/tools/* → 'tools'
    const schema = SCHEMAS[kind];
    const result = schema.safeParse(contract);
    if (!result.success) throw new ContractValidationError(file, result.error);
    contracts[kind].push({ file, contract: result.data });
  }

  // 3. Cross-contract validation
  ensureUniqueNames(contracts);
  ensureMigrationVersionsContiguous(contracts.migrations);
  ensureAllReferencedAnchorTypesExist(contracts);
  ensureEventEmittersExist(contracts);

  // 4. Per-kind generators (run in this order)
  const outputs: GeneratedFile[] = [];
  outputs.push(...generateMcpManifest(contracts.tools));
  outputs.push(...generateMcpHandlerStubs(contracts.tools));
  outputs.push(...generateMcpTypes(contracts.tools));
  outputs.push(...generateInstallerArtifacts(contracts.targets, contracts.tools));
  outputs.push(...generateAnchorRegistry(contracts.anchors));
  outputs.push(...generateSchemaSql(contracts.migrations));
  outputs.push(...generateMigrationRunners(contracts.migrations));
  outputs.push(...generateEventTypes(contracts.events));
  outputs.push(...generateContractTests(contracts));

  // 5. Format with prettier (one config, applied to everything)
  for (const out of outputs) out.content = await prettier.format(out.content, out.prettierOptions);

  // 6. Write
  await rm('generated/', { recursive: true, force: true });
  for (const out of outputs) await writeFile(`generated/${out.path}`, out.content);

  // 7. Manifest with hashes for freshness check
  const manifest = computeManifest(outputs);
  await writeFile('generated/.manifest', JSON.stringify(manifest, null, 2));

  return { fileCount: outputs.length, elapsedMs: Date.now() - start };
}
```

### Key per-kind generation rules

**Tools → MCP manifest, handlers, types, install fragments**

For each tool contract:
- Append to `generated/mcp/tools-manifest.json` as one entry: `{ name, description, inputSchema (JSON Schema from Zod), tier }`
- Write `generated/mcp/handlers/<tool-name>.handler.ts` — a stub that imports the user-written body from `packages/mcp/src/tool-impls/<tool-name>.ts`, runs input validation, dispatches to body, validates output, applies tier-specific middleware (provenance check for `write`, main-session-forbidden middleware for `heavy`, activation recording for `light`)
- Emit a permission entry in each target's permissions file based on `permissions[target]`
- Append a section to each target's instructions markdown describing the tool, when to use it, the tier gating

**Anchors → SQL constraints, registry, embedding plan**

For each anchor contract:
- Compose `generated/core/anchors/registry.ts` — `Map<string, AnchorTypeMeta>` keyed by `type`
- Generate type-specific JSON Schema for the `nodes.data` payload
- If `embeddable: true`, generate an embedding-job entry that the embedder iterates over

**Targets + Tools → install configs**

The install fragments are composed from BOTH the target contract AND the tool contracts:
- Walk all tool contracts, collect `permissions[<target>]`, produce the target's permission file
- Walk all tool contracts, render descriptions into a markdown section, produce the target's instructions file
- Tool contracts and target contracts are decoupled — adding a tool updates all target outputs automatically

**Migrations → schema.sql + migrations.ts**

- Sort migration contracts by `version` (validated contiguous starting at 1)
- Compose `generated/core/db/schema.sql` by concatenating `forward` SQL from all migrations
- Compose `generated/core/db/migrations.ts` as a `MIGRATIONS` array of `{version, forward, rollback}` runners

**Events → WS event types**

- Emit a discriminated union `WsEvent = { type: 'edge:proposed', payload: ... } | ...` for the WebSocket layer

### Generated file headers

Every generated file starts with:
```
// GENERATED FILE — DO NOT EDIT.
// Source: .contracts/tools/rig_search.contract.ts
// Generated at: 2026-05-22T14:30:00Z by scripts/gen.ts
// Edit the .contract.ts file instead, then run `bun run gen`.
```

SQL files use `--` comments. Markdown files use HTML comments.

---

## 5. Freshness enforcement

`scripts/gen-check.ts` is the staleness detector:

```ts
async function check(): Promise<void> {
  const diskManifest = JSON.parse(await readFile('generated/.manifest', 'utf-8'));
  const freshResult = await generateInMemory();  // does not write to disk
  const freshManifest = computeManifest(freshResult.outputs);

  const diff = diffManifests(diskManifest, freshManifest);
  if (diff.length > 0) {
    console.error('generated/ is stale. Run `bun run gen`.');
    console.error(formatDiff(diff));
    process.exit(1);
  }
}
```

### Wired into:
- **Pre-commit hook** (via husky or a simple `.git/hooks/pre-commit` shell script): runs `bun run gen --check`. Fails the commit on stale.
- **CI on every PR**: same check, fails the build.
- **`bun test` setup**: runs `gen --check` before tests start. Stale generated/ produces a clear error instead of a confusing test failure.

---

## 6. Migrating Phase 1 code into contracts

Phase 1 ships with hand-written tools. Phase 1.5 starts by collapsing them.

**Order of migration (one tool at a time, one PR per tool):**

1. Pick a tool, e.g. `rig_search`
2. Create `.contracts/tools/rig_search.contract.ts` declaring its current behavior
3. Run `bun run gen` — produces a handler stub at `generated/mcp/handlers/search.handler.ts`
4. Move the existing implementation body to `packages/mcp/src/tool-impls/search.ts` (the user-editable file the stub imports from)
5. Delete the old hand-written handler
6. Update `packages/mcp/src/server.ts` to register handlers from the generated manifest instead of from a hand-written list
7. Run tests. Should pass.
8. Commit, repeat for next tool

Once the last Phase 1 tool is migrated, hand-edit the install code path so it reads from generated install fragments instead of hand-written templates. This is the breakage moment — write tests first, then make the swap.

The `installer/index.ts` flow becomes:
```ts
async function installFor(target: TargetName, opts: InstallOptions) {
  const fragments = await loadGeneratedFor(target);  // generated/installer/<target>.*
  for (const file of fragments) {
    await applyFile(file, opts);                     // merge-json, append-section, etc.
  }
}
```

---

## 7. Tests for the generator itself

In `__tests__/contracts/`:

- **`fixture.test.ts`** — golden file. A fixture set of `.contracts/*.contract.ts` under `__tests__/fixtures/contracts/` produces a known `generated/` tree. Snapshot the entire tree. Any drift fails the test until snapshots are updated.
- **`validation.test.ts`** — malformed contracts produce clear errors. Test: missing `name` field → error mentions the file path and the missing field. Duplicate name across two files → error names both files.
- **`cross-validation.test.ts`** — migration versions must be contiguous; tools cannot reference anchor types that don't exist; events cannot list non-existent emitters.
- **`freshness.test.ts`** — modify a contract → run `gen --check` → exits non-zero with a diff listing the stale files.
- **`migration-stability.test.ts`** — a v1 contract that ships and is then edited in a backwards-incompatible way fails (we never edit a migration after it ships; new changes go in a new migration).
- **`perf.test.ts`** — full generation of the canonical contract set finishes in < 3 seconds.

---

## 8. Performance budgets

| Operation | Budget |
|---|---|
| `bun run gen` (full regeneration of canonical contract set, ~25 contracts) | < 3 s |
| `bun run gen --check` (in-memory regen + manifest diff) | < 2 s |
| Single tool contract → handler stub | < 50 ms |
| Pre-commit hook total | < 3 s (anything slower and developers disable hooks) |

If any of these regress, add a perf test and fix before merging.

---

## 9. Acceptance criteria for Phase 1.5

- [ ] `packages/contracts/` package exists with `defineToolContract`, `defineAnchorContract`, `defineTargetContract`, `defineMigrationContract`, `defineEventContract` helpers and their Zod schemas
- [ ] All 9 Phase 1 light tools + 2 Phase 1 heavy tools expressed as contracts
- [ ] All 4 Phase 1 target writers (Claude, Cursor, Codex, opencode) expressed as contracts
- [ ] 2 anchor types (code-symbol, markdown-section) expressed as contracts
- [ ] Migration v1 expressed as a contract
- [ ] `scripts/gen.ts` regenerates all `generated/` outputs deterministically
- [ ] `scripts/gen-check.ts` exits non-zero on stale and zero on fresh
- [ ] Pre-commit hook installed and tested
- [ ] All Phase 1 tests still pass with the generated handler dispatch
- [ ] Adding a new tool to `.contracts/tools/` updates: MCP manifest, all 4 target permission files, all 4 target instructions files, types, tests — without touching any other code
- [ ] `bun run gen` completes in under 3 s
- [ ] Documentation: a short `docs/contracts.md` explaining how to add each kind of contract, with a worked example for tools
- [ ] Git tagged `v0.1.5-contracts`
- [ ] **Checkpoint:** demonstrate adding a hypothetical `rig_random` tool — one new file in `.contracts/tools/`, one `bun run gen`, one implementation file. No other edits required.

---

## 10. Open decisions for Phase 1.5

**Lock before starting.**

| Decision | Default | Rationale |
|---|---|---|
| Validation library | Zod | Already in TS ecosystem; converts to JSON Schema cleanly via `zod-to-json-schema` |
| JSON Schema generation | `zod-to-json-schema` | Maintained, supports modern draft |
| Formatting | Prettier with repo config | Generated output reformatted on every run |
| Pre-commit hook installer | Plain `.git/hooks/pre-commit` shell script committed in `scripts/install-hooks.sh` | Avoids the husky dependency; one less surface |
| Strict mode for unknowns | Reject any field not in the contract schema | Better to catch typos than silently ignore them |
| Manifest format | JSON with content-hash per file | Easy to diff in `gen --check` |

---

## 11. Anti-goals for the contract layer

- **Not a code generator for tool implementations.** The handler *stub* is generated; the handler *body* is hand-written in `packages/mcp/src/tool-impls/`. The generator does input validation, output validation, and middleware. The actual work stays human-written.
- **Not a CMS for the project.** The contracts are source code, written in TypeScript, edited in your editor, reviewed in PRs. They are not a runtime configuration system.
- **Not a runtime feature flag system.** Contracts are baked at build time. No hot-swap. No A/B.
- **Not a way to define new contract *kinds* declaratively.** Adding a new kind (e.g. `defineDashboardContract`) means writing TypeScript in `packages/contracts/` — the meta-level stays in code, not in YAML.

---

## 12. What this gives us by Phase 2

By the time Phase 2 (localhost map UI) starts, Rig has a stable contract surface. Adding write tools in Phase 3 means writing 7 new `.contract.ts` files and 7 new implementation bodies — the manifest, permissions, CLAUDE.md sections, undo wiring, WS broadcasts, and tests all generate themselves. The Phase 3 surface area drops by roughly 60%.

That is the Sovereign principle paying out: **declare the contract, not the consequences.**

---

*End of Phase 1.5 addendum. When you reach the Phase 1.5 acceptance checklist, stop. Demonstrate the "add a new tool with one file" workflow for Bob before continuing to Phase 2.*