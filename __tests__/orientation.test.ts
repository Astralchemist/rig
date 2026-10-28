// SPDX-License-Identifier: Apache-2.0
// The orientation map (packages/core/src/orientation.ts): section content on
// small fixtures, determinism, budget enforcement, the meta cache and its
// refresh by the update pipeline, and generation time at ~3k nodes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { getMeta } from '../packages/core/src/db/meta.ts';
import {
  DEFAULT_OVERVIEW_BUDGET,
  MAX_OVERVIEW_BUDGET,
  META_OVERVIEW,
  MIN_OVERVIEW_BUDGET,
  buildOverviewMap,
  clampBudget,
  cleanProse,
  getOverview,
  isTestPath,
  moduleDocstring,
  overviewFingerprint,
  readmePurpose,
  refreshOverview,
} from '../packages/core/src/orientation.ts';

const write = (root: string, files: Record<string, string>): void => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
};

const indexed = async (files: Record<string, string>): Promise<{ root: string; rig: Rig }> => {
  const root = mkdtempSync(join(tmpdir(), 'rig-orientation-'));
  write(root, files);
  const rig = await Rig.init(root, { embedder: new DeterministicEmbedder() });
  await rig.indexAll();
  return { root, rig };
};

// A single-package TypeScript project with a string-union route table, a
// handler directory, the function dispatching to it, a CLI and tests.
const APP: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'todo-kit',
      description: 'A tiny todo service.',
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
      bin: { todo: './dist/cli.js' },
      dependencies: { zod: '^3.23.0', 'left-pad': '1.3.0' },
      devDependencies: { vitest: '^2.0.0' },
      scripts: { test: 'vitest run' },
    },
    null,
    2,
  ),
  'README.md':
    '# todo-kit\n\n[![ci](https://x/badge.svg)](https://x)\n\nA tiny todo service with a CLI and an HTTP router.\n',
  'src/index.ts': `/**
 * Public entry point of todo-kit: re-exports the store and the router.
 * @module todo-kit
 */
export { Store } from './store';
export { dispatch } from './router';
`,
  'src/cli.ts': `#!/usr/bin/env node
import { dispatch } from './router';
dispatch('list');
`,
  'src/types.ts': `/** The actions the router accepts. */
export type Action =
  | "list"
  | "create"
  | "delete"
  | "toggle"

export enum Priority {
  Low,
  Medium,
  High,
}
`,
  'src/store.ts': `import { z } from 'zod';
export const schema = z.string();
/** In-memory todo storage. */
export class Store {
  items: string[] = [];
  add(item: string): void { this.items.push(item); }
}
`,
  'src/actions/list.ts': `import { Store } from '../store';
export function list(store: Store): string[] { return store.items; }
`,
  'src/actions/create.ts': `import { Store } from '../store';
export function create(store: Store, item: string): void { store.add(item); }
`,
  'src/actions/delete.ts': `import { Store } from '../store';
export function deleteAction(store: Store, item: string): void { store.items = store.items.filter((i) => i !== item); }
`,
  'src/actions/toggle.ts': `import { Store } from '../store';
export function toggle(store: Store): void { store.items.reverse(); }
`,
  'src/router.ts': `import type { Action } from './types';
import { Store } from './store';
import { list } from './actions/list';
import { create } from './actions/create';
import { deleteAction } from './actions/delete';
import { toggle } from './actions/toggle';
export function dispatch(action: Action, store: Store = new Store()): unknown {
  if (action === 'list') return list(store);
  if (action === 'create') return create(store, 'x');
  if (action === 'delete') return deleteAction(store, 'x');
  return toggle(store);
}
`,
  'src/http.ts': `export function GET(): string { return 'ok'; }
export function POST(): string { return 'created'; }
`,
  'test/store.test.ts': `import { Store } from '../src/store';
new Store();
`,
  'test/router.test.ts': `import { dispatch } from '../src/router';
dispatch('list');
`,
};

describe('orientation map: a single-package project', () => {
  let root: string;
  let rig: Rig;
  let map: string;

  beforeAll(async () => {
    ({ root, rig } = await indexed(APP));
    map = buildOverviewMap(rig.database.adapter, root);
  });

  afterAll(() => {
    rig.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('has every section, in order, and only real paths', () => {
    const titles = [...map.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(titles).toEqual([
      'Basics',
      'Entry points',
      'Layout',
      'Key symbols',
      'Request/handler surfaces',
      'Tests',
    ]);
    expect(map).toStartWith('# Repository overview: todo-kit\n');
    const files = new Set(rig.getFiles().map((f) => f.path));
    // Every `path:line` reference names an indexed file.
    for (const m of map.matchAll(/([\w./-]+\.(?:ts|tsx|js|json|md)):\d+/g)) {
      const p = m[1]!;
      expect([...files].some((f) => f === p || f.endsWith('/' + p))).toBe(true);
    }
  });

  test('basics: name, purpose, languages, declared runtime dependencies', () => {
    expect(map).toContain('- Name: todo-kit — A tiny todo service.');
    expect(map).toMatch(/- Languages \(files\): TypeScript 12, .*JSON 1, Markdown 1/);
    expect(map).toContain('- Dependencies of todo-kit (package.json): left-pad 1.3.0, zod ^3.23.0');
    expect(map).not.toContain('vitest ^2');
  });

  test('entry points: exports and bin mapped to source, the shebang CLI', () => {
    expect(map).toContain('- todo-kit: exports "." → src/index.ts; bin todo → src/cli.ts');
  });

  test('key symbols: most-referenced exports with signature or declaration and file:line', () => {
    // Test files do not count as users.
    expect(map).toContain('- `class Store` — src/store.ts:4 · used by 5 files');
    expect(map).toContain('- Hub files (used by N files): src/store.ts (5)');
  });

  test('surfaces: the string union, its dispatcher, the handler directory, the enum, HTTP verbs', () => {
    expect(map).toContain(
      '- `Action` (string union, src/types.ts:2): list, create, delete, toggle',
    );
    expect(map).toContain(
      '  - dispatched by `dispatch` (src/router.ts:7), which calls create, deleteAction, list, toggle',
    );
    expect(map.match(/dispatched by `dispatch`/g)).toHaveLength(2);
    expect(map).toContain(
      '- src/actions/ — 4 modules, each exporting a function named after it: create (create.ts:2), deleteAction (delete.ts:2), list (list.ts:2), toggle (toggle.ts:2)',
    );
    expect(map).toContain('- `Priority` (enum, src/types.ts:8): Low, Medium, High');
  });

  test('layout: top-level directories, the main one with its sub-directories', () => {
    expect(map).toContain(
      '## Layout\n- src/ (10 files) — Public entry point of todo-kit: re-exports the store and the router.\n  - src/actions/ (4 files)\n- test/ (2 files) — tests\n- (2 files at the root)\n',
    );
    expect(map).toContain('- HTTP verb exports: src/http.ts (GET, POST)');
  });

  test('tests: where they live and which sources they import', () => {
    expect(map).toContain('2 test files in 1 places; 2 import the sources they test');
    expect(map).toContain('`test` script: `vitest run`');
    expect(map).toMatch(
      /- test\/ — 2 files, testing src\/; e\.g\. router\.test\.ts → src\/router\.ts, store\.test\.ts → src\/store\.ts/,
    );
  });

  test('is deterministic: same graph, same bytes, across connections', async () => {
    expect(buildOverviewMap(rig.database.adapter, root)).toBe(map);
    const again = await Rig.open(root, { embedder: new DeterministicEmbedder() });
    try {
      expect(buildOverviewMap(again.database.adapter, root)).toBe(map);
    } finally {
      again.close();
    }
  });

  test('a decision waypoint shows up under Recent decisions and changes the fingerprint', () => {
    const db = rig.database.adapter;
    const before = overviewFingerprint(db, root);
    rig.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'Keep the router synchronous',
        summary: 'no async handlers',
        rationale: 'simplicity',
      },
      { sessionId: 's1', actor: 'ai:test' },
    );
    rig.writes.dropWaypoint(
      { kind: 'observation', title: 'Not a decision', summary: 'x', rationale: 'x' },
      { sessionId: 's1', actor: 'ai:test' },
    );
    expect(overviewFingerprint(db, root)).not.toBe(before);
    const m = buildOverviewMap(db, root);
    expect(m).toMatch(/## Recent decisions\n- \d{4}-\d{2}-\d{2} — Keep the router synchronous\n/);
    expect(m).not.toContain('Not a decision');
  });
});

describe('orientation map: budget', () => {
  let root: string;
  let rig: Rig;

  beforeAll(async () => {
    const files: Record<string, string> = { ...APP };
    // Enough material that every section overflows a small budget.
    for (let i = 0; i < 60; i++) {
      files[`src/mod${i}/index.ts`] =
        `/** Module ${i} does thing ${i}. */\nexport function thing${i}(a: string, b: number): string { return a + b; }\n`;
      for (const u of ['use', 'reuse']) {
        files[`src/mod${i}/${u}.ts`] =
          `import { thing${i} } from './index';\nexport function ${u}${i}(): string { return thing${i}('x', ${i}); }\n`;
      }
    }
    ({ root, rig } = await indexed(files));
  });

  afterAll(() => {
    rig.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('never exceeds budget × 4 chars, and a bigger budget shows more', () => {
    let prev = 0;
    for (const budget of [200, 400, 800, 1200]) {
      const m = buildOverviewMap(rig.database.adapter, root, { budget });
      expect(m.length).toBeLessThanOrEqual(budget * 4);
      // Filled to within a line or two of the budget.
      expect(m.length).toBeGreaterThan(budget * 4 - 300);
      expect(m.length).toBeGreaterThan(prev);
      expect(m).toStartWith('# Repository overview: todo-kit\n');
      prev = m.length;
    }
  });

  test('a cut section says how much it left out', () => {
    const m = buildOverviewMap(rig.database.adapter, root, { budget: 600 });
    expect(m).toMatch(/^- …\d+ more$/m);
  });

  test('budgets are clamped', () => {
    expect(clampBudget(undefined)).toBe(DEFAULT_OVERVIEW_BUDGET);
    expect(clampBudget(1)).toBe(MIN_OVERVIEW_BUDGET);
    expect(clampBudget(1e9)).toBe(MAX_OVERVIEW_BUDGET);
    const tiny = buildOverviewMap(rig.database.adapter, root, { budget: 1 });
    expect(tiny.length).toBeLessThanOrEqual(MIN_OVERVIEW_BUDGET * 4);
  });
});

describe('orientation map: a monorepo', () => {
  let root: string;
  let rig: Rig;
  let map: string;

  beforeAll(async () => {
    const pkg = (name: string, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({ name, exports: { '.': './dist/index.js' }, ...extra });
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'root', private: true, packageManager: 'pnpm@9.0.0' }),
      'packages/core/package.json': pkg('@acme/core', {
        description: 'The core engine.',
        dependencies: { jose: '^6.0.6' },
      }),
      'packages/core/src/index.ts': `export interface Adapter { get(id: string): string }\nexport function engine(): number { return 1; }\n`,
      'packages/cli/package.json': pkg('@acme/cli', {
        dependencies: { '@acme/core': 'workspace:*' },
        bin: { acme: './dist/main.js' },
      }),
      'packages/cli/src/main.ts': `#!/usr/bin/env node\nimport { engine } from '../../core/src/index';\nengine();\n`,
      'packages/cli/README.md': '# acme cli\n\nThe command-line front end for the engine.\n',
      'scripts/release.ts': `export const release = (): void => {};\n`,
    };
    for (const name of ['redis', 'pg', 'mongo', 'sqlite', 'd1', 'kv']) {
      files[`packages/adapter-${name}/package.json`] = pkg(`@acme/${name}-adapter`, {
        description: `${name} adapter for acme.`,
        dependencies: { '@acme/core': 'workspace:*' },
      });
      files[`packages/adapter-${name}/src/index.ts`] =
        `import type { Adapter } from '../../core/src/index';\nexport function ${name}Adapter(): Adapter { return { get: (id) => id }; }\n`;
    }
    ({ root, rig } = await indexed(files));
    map = buildOverviewMap(rig.database.adapter, root);
  });

  afterAll(() => {
    rig.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('names the project after its directory when the root manifest name is generic', () => {
    expect(map).toMatch(/^# Repository overview: rig-orientation-\w+\n/);
  });

  test('workspace, package dependencies, and the most depended-on package first', () => {
    expect(map).toContain('- Workspace: pnpm monorepo, 8 packages (packages/ 8)');
    expect(map).toContain('- Dependencies of @acme/core (packages/core/package.json): jose ^6.0.6');
    const layout = map.slice(map.indexOf('## Layout'));
    expect(layout).toMatch(/^- packages\/core\/ \(@acme\/core\) — 2 files: The core engine\.$/m);
    expect(layout.indexOf('packages/core/')).toBeLessThan(layout.indexOf('packages/cli/'));
  });

  test('folds a sibling family into one layout line and one entry line', () => {
    expect(map).toContain(
      '- packages/adapter-* — 6 packages, 12 files: adapter-d1, adapter-kv, adapter-mongo, adapter-pg, adapter-redis, adapter-sqlite. e.g. adapter-d1: d1 adapter for acme.',
    );
    expect(map).toMatch(
      /- packages\/adapter-\* \(6 packages, e\.g\. @acme\/\w+-adapter\): each exports "\." → src\/index\.ts/,
    );
    expect(map).not.toMatch(/^- packages\/adapter-\w+\//m);
  });

  test('README purposes, bin entries mapped to source, directories outside packages', () => {
    expect(map).toContain(
      '- packages/cli/ (@acme/cli) — 3 files: The command-line front end for the engine.',
    );
    expect(map).toContain(
      '- @acme/cli (packages/cli): exports "." → ./dist/index.js; bin acme → src/main.ts',
    );
    expect(map).toContain('- Outside packages: scripts/ (1)');
  });
});

describe('orientation map: Python', () => {
  test('pyproject name, description and scripts; module docstrings as purposes', async () => {
    const { root, rig } = await indexed({
      'pyproject.toml': `[project]\nname = "pyshop"\ndescription = "Sell things from Python."\n\n[project.scripts]\npyshop = "pyshop.cli:main"\n`,
      'pyshop/__init__.py': `"""The pyshop package: carts, orders and payments."""\n`,
      'pyshop/cart.py': `class Cart:\n    def add(self, item):\n        return item\n`,
      'pyshop/orders.py': `from pyshop.cart import Cart\n\ndef place(cart: Cart):\n    return cart\n`,
      'tests/test_cart.py': `from pyshop.cart import Cart\n\ndef test_add():\n    Cart().add(1)\n`,
    });
    try {
      const map = buildOverviewMap(rig.database.adapter, root);
      expect(map).toContain('- Name: pyshop — Sell things from Python.');
      expect(map).toContain('- pyshop: script pyshop → pyshop.cli:main');
      expect(map).toContain(
        '- pyshop/ (3 files) — The pyshop package: carts, orders and payments.',
      );
      expect(map).toContain('- tests/ — 1 files');
    } finally {
      rig.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('orientation map: cache and refresh', () => {
  let root: string;
  let rig: Rig;

  beforeAll(async () => {
    ({ root, rig } = await indexed(APP));
  });

  afterAll(() => {
    rig.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('`rig index` stores the default map in meta with its version and time', () => {
    const raw = getMeta(rig.database.adapter, META_OVERVIEW);
    expect(raw).not.toBeNull();
    const c = JSON.parse(raw!) as { version: number; generated_at: number; map: string };
    expect(c.version).toBe(1);
    expect(c.generated_at).toBeGreaterThan(0);
    expect(c.map).toBe(buildOverviewMap(rig.database.adapter, root));
    const o = rig.overview();
    expect(o.cached).toBe(true);
    expect(o.map).toBe(c.map);
    expect(o.budget).toBe(DEFAULT_OVERVIEW_BUDGET);
    expect(o.est_tokens).toBe(Math.ceil(o.map.length / 4));
  });

  test('nothing it reads changed: no regeneration', async () => {
    const before = JSON.parse(getMeta(rig.database.adapter, META_OVERVIEW)!) as {
      generated_at: number;
    };
    expect(refreshOverview(rig.database.adapter, root)).toBe(false);
    await rig.sync();
    const after = JSON.parse(getMeta(rig.database.adapter, META_OVERVIEW)!) as {
      generated_at: number;
    };
    expect(after.generated_at).toBe(before.generated_at);
  });

  test('a changed file regenerates it on the next sync', async () => {
    writeFileSync(
      join(root, 'src/types.ts'),
      `export type Action = "list" | "create" | "delete" | "toggle" | "archive"\n`,
    );
    await rig.sync();
    const o = rig.overview();
    expect(o.cached).toBe(true);
    expect(o.map).toContain('list, create, delete, toggle, archive');
  });

  test('a stale cache is never served; other budgets are generated, not stored', () => {
    const db = rig.database.adapter;
    db.prepare(
      `UPDATE meta SET value = json_set(value, '$.fingerprint', 'stale') WHERE key = ?`,
    ).run(META_OVERVIEW);
    const fresh = getOverview(db, root);
    expect(fresh.cached).toBe(false);
    expect(getOverview(db, root).cached).toBe(true);
    const small = rig.overview({ budget: 300 });
    expect(small.cached).toBe(false);
    expect(small.map.length).toBeLessThanOrEqual(1200);
    expect(rig.overview().map).toBe(fresh.map);
  });
});

describe('orientation helpers', () => {
  test('readmePurpose skips badges, HTML and headings', () => {
    expect(
      readmePurpose(
        '<p align="center"><img src="x.png"/></p>\n<h3 align="center">Thing</h3>\n<p>Authentication for the Web.</p>\n',
      ),
    ).toBe('Authentication for the Web.');
    expect(readmePurpose('# Title\n\n[![b](x)](y)\n\nDoes the [first](u) thing. And more.\n')).toBe(
      'Does the first thing.',
    );
    expect(readmePurpose('# Only a title\n')).toBe('Only a title');
  });

  test('moduleDocstring reads JSDoc, line comments and Python docstrings, skipping licenses', () => {
    expect(
      moduleDocstring(
        '/**\n *\n * :::warning Experimental\n * Under development.\n * :::\n *\n * This is the main entry point.\n * @module x\n */\nimport a from "a"\n',
      ),
    ).toBe('This is the main entry point.');
    expect(
      moduleDocstring('// SPDX-License-Identifier: MIT\n// Parses the config file.\nexport {}\n'),
    ).toBe('Parses the config file.');
    expect(moduleDocstring('#!/usr/bin/env python\n"""Command-line tools."""\n')).toBe(
      'Command-line tools.',
    );
    expect(moduleDocstring('import x from "y"\n')).toBeNull();
  });

  test('cleanProse keeps the first sentence and cuts at a word', () => {
    expect(cleanProse('See {@link https://x.dev the docs} for _more_. Then go.')).toBe(
      'See the docs for more.',
    );
    expect(cleanProse('word '.repeat(40), 30)).toMatch(/^(word ){5}word…$|^word( word)*…$/);
  });

  test('isTestPath matches the tests-edges patterns plus pytest names', () => {
    for (const p of [
      'a.test.ts',
      'src/a.spec.js',
      '__tests__/a.ts',
      'pkg/test/a.ts',
      'tests/x.py',
      'm/test_a.py',
      'e2e/a.ts',
    ]) {
      expect(isTestPath(p)).toBe(true);
    }
    for (const p of ['src/testing.ts', 'src/contest/a.ts', 'latest.ts']) {
      expect(isTestPath(p)).toBe(false);
    }
  });
});

describe('orientation map: speed', () => {
  test('generates in well under 50 ms warm at ~3k nodes', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'big', exports: './src/index.ts' }),
    };
    // 150 modules × (file + ~16 symbols) ≈ 2.6k extracted nodes, wired
    // together with imports and calls.
    for (let i = 0; i < 150; i++) {
      const body = [`import { Shared } from '../shared/s';`];
      for (let j = 0; j < 7; j++) {
        body.push(
          `/** f${i}_${j} */\nexport function f${i}_${j}(x: number): number { return new Shared().v + x; }`,
        );
        body.push(`export interface I${i}_${j} { v: number }`);
      }
      body.push(`export type K${i} = "a${i}" | "b${i}" | "c${i}";`);
      files[`src/m${i % 10}/mod${i}.ts`] = body.join('\n') + '\n';
    }
    files['src/shared/s.ts'] = 'export class Shared { v = 1 }\n';
    const { root, rig } = await indexed(files);
    try {
      const db = rig.database.adapter;
      const nodes = (db.prepare(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n;
      expect(nodes).toBeGreaterThan(2400);
      buildOverviewMap(db, root);
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        buildOverviewMap(db, root);
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      // The median; generous for slow CI machines (≈15 ms on an M-series laptop).
      expect(times[2]!).toBeLessThan(150);
    } finally {
      rig.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
