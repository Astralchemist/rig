// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

const flag = (n: string): boolean => process.argv.includes(n);
const optionValue = (n: string): string | undefined => {
  const i = process.argv.indexOf(n);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

interface Result {
  label: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  avg: number;
}

const measure = async (label: string, n: number, fn: () => unknown): Promise<Result> => {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  const s = samples.slice().sort((a, b) => a - b);
  const p = (q: number): number => s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
  return {
    label,
    n,
    p50: p(0.5),
    p95: p(0.95),
    max: s.at(-1)!,
    avg: samples.reduce((a, b) => a + b, 0) / samples.length,
  };
};

const fmt = (ms: number): string => `${ms.toFixed(2)}ms`;

const printTable = (rows: Result[], title: string): void => {
  console.log(`\n=== ${title} ===`);
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(32)} n=${String(r.n).padStart(3)}  p50=${fmt(r.p50).padStart(9)}  p95=${fmt(r.p95).padStart(9)}  max=${fmt(r.max).padStart(9)}`,
    );
  }
};

// Generate a synthetic TS project of N files, each containing a small class
// with M methods and a few cross-file imports. Returns the project root.
const generateFixture = (n: number): string => {
  const root = mkdtempSync(join(tmpdir(), 'rig-bench-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < n; i++) {
    const importedIdx = i > 0 ? i - 1 : 0;
    const importStmt =
      i > 0 ? `import { Module${importedIdx} } from './module${importedIdx}.ts';\n` : '';
    const body = `
${importStmt}export interface Args${i} { value: string; }
export class Module${i} {
  private value: string;
  constructor(args: Args${i}) { this.value = args.value; }
  doThingA(arg: string): number { return this.value.length + arg.length; }
  doThingB(arg: number): string { return this.value + arg; }
  doThingC(): void { ${i > 0 ? `new Module${importedIdx}({ value: this.value });` : ''} }
  describe(): string { return \`Module${i}(\${this.value})\`; }
}
`.trim();
    writeFileSync(join(root, 'src', `module${i}.ts`), body + '\n');
  }
  return root;
};

const runBench = async (rig: Rig): Promise<void> => {
  const status = await rig.status();
  console.log(`graph: ${status.nodes} nodes · ${status.edges_structural} edges · ${status.files} files`);

  const allIds = (
    rig.database.adapter.prepare('SELECT id FROM nodes').all() as { id: string }[]
  ).map((r) => r.id);
  if (allIds.length === 0) {
    console.log('(empty graph — run `rig index` first)');
    return;
  }
  const N = Math.min(50, Math.max(10, Math.floor(allIds.length / 3)));
  const sample: string[] = [];
  for (let i = 0; i < N; i++) sample.push(allIds[Math.floor(Math.random() * allIds.length)]!);
  const queries = ['Rig', 'Module', 'route', 'class', 'function', 'auth', 'web'];

  const sql: Result[] = [
    await measure('status', N, () => rig.status()),
    await measure('searchNodes (FTS5 + alias)', N, () =>
      rig.searchNodes(queries[Math.floor(Math.random() * queries.length)]!, { limit: 20 }),
    ),
    await measure('getNode', N, () => rig.getNode(sample[Math.floor(Math.random() * sample.length)]!)),
    await measure('getNeighbors', N, () =>
      rig.getNeighbors(sample[Math.floor(Math.random() * sample.length)]!),
    ),
    await measure('getCallers', N, () =>
      rig.getCallers(sample[Math.floor(Math.random() * sample.length)]!),
    ),
  ];
  printTable(sql, 'SQL reads (in-process)');

  const analytical: Result[] = [
    await measure('getTopHubs(20)', N, () => rig.getTopHubs({ limit: 20 })),
    await measure('getMagneticPull(k=10)', N, () =>
      rig.getMagneticPull(sample[Math.floor(Math.random() * sample.length)]!, 10),
    ),
    await measure('getCriticalPath(12)', N, () =>
      rig.getCriticalPath(sample[Math.floor(Math.random() * sample.length)]!, 12),
    ),
    await measure('getImpactRadius(3)', N, () =>
      rig.getImpactRadius(sample[Math.floor(Math.random() * sample.length)]!, 3),
    ),
    await measure('snapshot(2000)', Math.min(N, 20), () => rig.snapshot(2000)),
  ];
  printTable(analytical, 'Analytical (reasoning)');

  if (flag('--json')) {
    console.log('\nJSON:');
    console.log(JSON.stringify({ status, sql, analytical }, null, 2));
  }
};

export const runBenchCmd = async (cwd: string): Promise<void> => {
  const fixtureStr = optionValue('--fixture');
  if (fixtureStr) {
    const n = Number.parseInt(fixtureStr, 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error('rig bench --fixture <N> requires a positive integer');
      process.exit(2);
    }
    console.log(`rig bench: generating ${n}-file synthetic fixture...`);
    const root = generateFixture(n);
    try {
      const rig = await Rig.init(root, { embedder: new DeterministicEmbedder() });
      const t0 = performance.now();
      const r = await rig.indexAll();
      console.log(
        `indexed ${n} files in ${(performance.now() - t0).toFixed(0)}ms → ${r.nodes} nodes · ${r.edges} edges`,
      );
      await runBench(rig);
      rig.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return;
  }

  if (!Rig.isInitialized(cwd)) {
    console.error('rig: not initialized. Run `rig init` or `rig bench --fixture <N>`.');
    process.exit(2);
  }
  const rig = await Rig.open(cwd);
  try {
    await runBench(rig);
  } finally {
    rig.close();
  }
};
