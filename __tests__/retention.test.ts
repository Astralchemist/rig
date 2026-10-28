// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';

// Retention: re-index and sync must keep the graph's structural edges and the
// memory agents attached to code. Each case reproduces a loss measured on the
// pre-retention pipeline (purge + re-insert per file, edges resolved only from
// the files extracted in that run).

const B_TS = `export function helper(x: number): number { return x * 2; }\n`;
const A_TS = `import { helper } from './b';\nexport function main(): number { return helper(21); }\n`;
const C_TS = `export class Widget { run(): void {} }\n`;

class CountingEmbedder extends DeterministicEmbedder {
  count = 0;
  override async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.count += texts.length;
    return super.embed(texts);
  }
}

describe('retention across index and sync', () => {
  let project: string;
  let rig: Rig;
  let embedder: CountingEmbedder;

  const write = (name: string, body: string): void => writeFileSync(join(project, name), body);
  const one = <T>(sql: string, ...params: unknown[]): T =>
    rig.database.adapter.prepare(sql).get(...params) as T;
  const all = <T>(sql: string, ...params: unknown[]): T[] =>
    rig.database.adapter.prepare(sql).all(...params) as T[];
  const nodeId = (name: string, type: string): string =>
    one<{ id: string }>(`SELECT id FROM nodes WHERE name = ? AND type = ?`, name, type).id;

  // Derived edges whose source node belongs to `file`, as sorted "kind src->dst" keys.
  const edgesFromFile = (file: string): string[] =>
    all<{ k: string }>(
      `SELECT e.kind || ' ' || e.src || '->' || e.dst AS k FROM edges e JOIN nodes n ON n.id = e.src
       WHERE json_extract(n.data, '$.filePath') = ? AND e.provenance = 'ast' ORDER BY k`,
      file,
    ).map((r) => r.k);
  const countByKind = (keys: string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of keys) {
      const kind = k.split(' ')[0]!;
      out[kind] = (out[kind] ?? 0) + 1;
    }
    return out;
  };

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-retention-'));
    write('b.ts', B_TS);
    write('a.ts', A_TS);
    write('c.ts', C_TS);
    write('NOTES.md', `# Notes\n\n## Design\n\nSee helper.\n`);
    embedder = new CountingEmbedder();
    rig = await Rig.init(project, { embedder });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('editing a file and syncing rebuilds its outgoing calls/imports edges', async () => {
    const before = edgesFromFile('a.ts');
    expect(countByKind(before)).toMatchObject({ calls: 1, imports: 1 });

    write(
      'a.ts',
      `import { helper } from './b';\n// edited\nexport function main(): number { return helper(21); }\n`,
    );
    const s = await rig.sync();
    expect(s.filesChanged).toBe(1);

    expect(countByKind(edgesFromFile('a.ts'))).toEqual(countByKind(before));
  });

  test('indexAll({ include }) keeps every other file’s edges', async () => {
    const others = (): string[] => [...edgesFromFile('a.ts'), ...edgesFromFile('b.ts')];
    const before = others();
    expect(before.length).toBeGreaterThan(0);

    write('c.ts', `export class Widget { run(): void {} stop(): void {} }\n`);
    const r = await rig.indexAll({ include: ['c.ts'] });

    expect(others()).toEqual(before);
    expect(r.changed).toBe(1);
    const stop = nodeId('stop', 'method');
    expect(
      one(
        `SELECT 1 AS x FROM edges WHERE src = ? AND dst = ? AND kind = 'contains'`,
        nodeId('Widget', 'class'),
        stop,
      ),
    ).not.toBeNull();
  });

  test('a new same-named symbol elsewhere turns a unique call into an unresolved ref', async () => {
    const main = nodeId('main', 'function');
    const helper = nodeId('helper', 'function');
    const callEdge = (): unknown =>
      one(`SELECT 1 AS x FROM edges WHERE src = ? AND dst = ? AND kind = 'calls'`, main, helper);
    const unresolvedHelperCall = (): unknown =>
      one(
        `SELECT 1 AS x FROM unresolved_refs WHERE src = ? AND target_name = 'helper' AND kind = 'calls'`,
        main,
      );
    expect(callEdge()).not.toBeNull();
    expect(unresolvedHelperCall()).toBeNull();

    write('d.ts', `export function helper(): number { return 0; }\n`);
    await rig.sync();
    expect(callEdge()).toBeNull();
    expect(unresolvedHelperCall()).not.toBeNull();

    // And back: once the duplicate is gone the call resolves again.
    unlinkSync(join(project, 'd.ts'));
    await rig.sync();
    expect(callEdge()).not.toBeNull();
    expect(unresolvedHelperCall()).toBeNull();
  });
});
