// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { recordActivation } from '../packages/core/src/db/activation-queries.ts';
import { getEmbedding } from '../packages/core/src/db/embed-queries.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { EXTRACTOR_VERSION } from '../packages/core/src/extract/extractor.ts';

// Retention: re-index and sync must keep the graph's structural edges and the
// memory agents attached to code. Each case reproduces a loss measured on the
// pre-retention pipeline (purge + re-insert per file, edges resolved only from
// the files extracted in that run).

const B_TS = `export function helper(x: number): number { return x * 2; }\n`;
const A_TS = `import { helper } from './b';\nexport function main(): number { return helper(21); }\n`;
const C_TS = `export class Widget { run(): void {} }\n`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class CountingEmbedder extends DeterministicEmbedder {
  count = 0;
  failNext = false;
  override async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('embedder down');
    }
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

  // Agent memory on code nodes, as the MCP write tools leave it.
  const ctx = { sessionId: 'agent-1', actor: 'ai:test' };
  const attachMemory = (): { helper: string; main: string; widget: string; waypoint: string } => {
    const helper = nodeId('helper', 'function');
    const main = nodeId('main', 'function');
    const widget = nodeId('Widget', 'class');
    rig.writes.addAlias({ nodeId: helper, alias: 'doubler', rationale: 'test alias' }, ctx);
    rig.writes.promoteHub(widget, 'promote for test', ctx);
    const waypoint = rig.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'Use helper',
        summary: 'We decided to route through helper',
        constellationRefs: [helper, main],
      },
      ctx,
    );
    rig.writes.proposeEdge({ src: main, dst: widget, rationale: 'semantic link for test' }, ctx);
    const accepted = rig.writes.proposeEdge(
      { src: helper, dst: widget, rationale: 'second link for test' },
      ctx,
    );
    rig.writes.acceptPending(accepted, { sessionId: 'web', actor: 'user:web' });
    rig.writes.annotateNode(
      { nodeId: helper, note: 'auth boundary', rationale: 'test annotate' },
      ctx,
    );
    return { helper, main, widget, waypoint };
  };
  const memoryState = (): Record<string, unknown> => ({
    aliases: all(`SELECT node_id, alias FROM aliases ORDER BY node_id, alias`),
    doublerHits: rig.searchNodes('doubler').map((n) => n.id),
    hubs: all(`SELECT id, hub_explicit, is_hub FROM nodes WHERE hub_explicit = 1 ORDER BY id`),
    waypointRefs: all(`SELECT src, dst FROM edges WHERE kind = 'waypoint_references' ORDER BY dst`),
    pending: all(`SELECT id, src, dst, status FROM pending_edges ORDER BY id`),
    semantic: all(`SELECT src, dst, provenance FROM edges_semantic ORDER BY src, dst`),
    annotations: all(`SELECT node_id, note FROM annotations ORDER BY id`),
  });
  const expectMemoryAttached = (state: Record<string, unknown>): void => {
    expect(state).toMatchObject({
      aliases: [expect.anything()],
      doublerHits: [expect.anything()],
      hubs: [{ hub_explicit: 1, is_hub: 1 }],
      waypointRefs: [expect.anything(), expect.anything()],
      pending: [{ status: 'pending' }, { status: 'accepted' }],
      semantic: [expect.anything()],
      annotations: [{ note: 'auth boundary' }],
    });
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

  test('a no-change re-index keeps agent memory and re-embeds nothing', async () => {
    attachMemory();
    const before = memoryState();
    expectMemoryAttached(before);

    embedder.count = 0;
    const r = await rig.indexAll();

    expect(memoryState()).toEqual(before);
    expect(embedder.count).toBe(0);
    expect(r.changed).toBe(0);
    expect(r.unchanged).toBe(r.files);
  });

  test('index --force re-extracts every file, still in place', async () => {
    attachMemory();
    const before = memoryState();

    embedder.count = 0;
    const r = await rig.indexAll({ force: true });

    expect(memoryState()).toEqual(before);
    expect(r.changed).toBe(r.files);
    expect(embedder.count).toBe(0);
  });

  test('a line shift keeps the node id, so activations and waypoint refs still resolve', async () => {
    const m = attachMemory();
    recordActivation(rig.database.adapter, m.helper, 'mcp', { sessionId: 'agent-1' });
    const before = memoryState();

    write('b.ts', `// a comment shifts helper down\n${B_TS}`);
    const s = await rig.sync();
    expect(s.filesChanged).toBe(1);

    expect(nodeId('helper', 'function')).toBe(m.helper);
    const data = JSON.parse(
      one<{ data: string }>(`SELECT data FROM nodes WHERE id = ?`, m.helper).data,
    ) as { startLine: number };
    expect(data.startLine).toBe(2);
    expect(
      one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM activations a WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = a.node_id)`,
      ).n,
    ).toBe(0);
    const refs = (
      JSON.parse(one<{ data: string }>(`SELECT data FROM nodes WHERE id = ?`, m.waypoint).data) as {
        constellation_refs: string[];
      }
    ).constellation_refs;
    expect(refs.filter((id) => one(`SELECT 1 AS x FROM nodes WHERE id = ?`, id) !== null)).toEqual(
      refs,
    );
    expect(memoryState()).toEqual(before);
  });

  test('an extractor version bump re-extracts unchanged files once, in place', async () => {
    attachMemory();
    const before = memoryState();
    const fileCount = one<{ n: number }>(`SELECT COUNT(*) AS n FROM files`).n;
    // What a DB written by the previous extractor looks like.
    rig.database.adapter
      .prepare(`UPDATE files SET extractor_version = ?`)
      .run(EXTRACTOR_VERSION - 1);

    embedder.count = 0;
    const first = await rig.indexAll();
    expect(first.changed).toBe(fileCount);
    expect(
      all<{ v: number }>(`SELECT DISTINCT extractor_version AS v FROM files`).map((r) => r.v),
    ).toEqual([EXTRACTOR_VERSION]);
    // Re-extracted in place: memory intact, unchanged embedding text skipped.
    expect(memoryState()).toEqual(before);
    expect(embedder.count).toBe(0);

    const second = await rig.indexAll();
    expect(second.changed).toBe(0);
  });

  test('deleting a symbol orphans its memory; restoring it re-attaches', async () => {
    const helper = nodeId('helper', 'function');
    rig.writes.addAlias({ nodeId: helper, alias: 'doubler', rationale: 'test alias' }, ctx);
    rig.writes.annotateNode(
      { nodeId: helper, note: 'auth boundary', rationale: 'test annotate' },
      ctx,
    );

    write('b.ts', `export const keep = 1;\n`);
    const removed = await rig.sync();
    const rows = all<Record<string, unknown> & { payload: string }>(
      `SELECT node_id, kind, name, qualified_name, file_path, reason, payload FROM orphaned_memory`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      node_id: helper,
      kind: 'function',
      name: 'helper',
      qualified_name: 'helper',
      file_path: 'b.ts',
      reason: 'symbol-removed',
    });
    const payload = JSON.parse(rows[0]!.payload) as {
      aliases: { alias: string }[];
      annotations: { note: string }[];
    };
    expect(payload.aliases.map((a) => a.alias)).toEqual(['doubler']);
    expect(payload.annotations.map((a) => a.note)).toEqual(['auth boundary']);
    expect((await rig.status()).orphans).toBe(1);
    expect(removed.orphaned).toBe(1);

    write('b.ts', B_TS);
    const restored = await rig.sync();
    const back = nodeId('helper', 'function');
    expect(rig.getAliases(back).map((a) => a.alias)).toEqual(['doubler']);
    expect(rig.searchNodes('doubler').map((n) => n.id)).toEqual([back]);
    expect(rig.getAnnotations(back).map((a) => a.note)).toEqual(['auth boundary']);
    expect((await rig.status()).orphans).toBe(0);
    expect(restored.reattached).toBe(1);
  });

  test('a deleted file restored elsewhere in the file gets its edges and waypoint refs back', async () => {
    const m = attachMemory();
    const before = memoryState();

    unlinkSync(join(project, 'b.ts'));
    await rig.sync();
    expect(
      all<{ reason: string }>(`SELECT reason FROM orphaned_memory`).map((r) => r.reason),
    ).toEqual(['file-deleted']);
    expect(all(`SELECT 1 AS x FROM edges_semantic`)).toHaveLength(0);

    // Restored two lines lower: a different position-keyed id.
    write('b.ts', `// moved\n\n${B_TS}`);
    await rig.sync();
    const back = nodeId('helper', 'function');
    expect(back).not.toBe(m.helper);
    const swap = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replaceAll(m.helper, back));
    expect(memoryState()).toEqual(swap(before));
    const refs = (
      JSON.parse(one<{ data: string }>(`SELECT data FROM nodes WHERE id = ?`, m.waypoint).data) as {
        constellation_refs: string[];
      }
    ).constellation_refs;
    expect(refs).toEqual([back, m.main]);
    expect((await rig.status()).orphans).toBe(0);
  });

  test('orphaned memory finds an endpoint whose anchor changed in place', async () => {
    write('package.json', JSON.stringify({ dependencies: { zod: '^3.0.0' } }));
    await rig.sync();
    const helper = nodeId('helper', 'function');
    const zod = nodeId('zod', 'declared-dependency');
    rig.writes.proposeEdge({ src: helper, dst: zod, rationale: 'helper validates with zod' }, ctx);

    write('b.ts', `export const keep = 1;\n`);
    await rig.sync();
    // zod keeps its id while its qualifiedName follows the new spec.
    write('package.json', JSON.stringify({ dependencies: { zod: '^3.1.0' } }));
    write('b.ts', B_TS);
    await rig.sync();

    expect(nodeId('zod', 'declared-dependency')).toBe(zod);
    expect(all(`SELECT src, dst FROM pending_edges`)).toEqual([
      { src: nodeId('helper', 'function'), dst: zod },
    ]);
    expect((await rig.status()).orphans).toBe(0);
  });

  test('memory between two symbols deleted in turn comes back once both return', async () => {
    const main = nodeId('main', 'function');
    const helper = nodeId('helper', 'function');
    const pid = rig.writes.proposeEdge(
      { src: main, dst: helper, rationale: 'main wraps helper' },
      ctx,
    );

    write('a.ts', `import { helper } from './b';\n`); // main gone: its row holds the edge
    await rig.sync();
    write('b.ts', `export const keep = 1;\n`); // helper gone: nothing left on it
    await rig.sync();
    write('a.ts', A_TS); // main back first: the edge waits for helper
    await rig.sync();
    expect(all(`SELECT 1 AS x FROM pending_edges`)).toHaveLength(0);
    expect(all<{ reason: string }>(`SELECT reason FROM orphaned_memory`)).toEqual([
      { reason: 'endpoint-missing' },
    ]);

    write('b.ts', B_TS);
    await rig.sync();
    expect(all(`SELECT id, src, dst FROM pending_edges`)).toEqual([
      { id: pid, src: nodeId('main', 'function'), dst: nodeId('helper', 'function') },
    ]);
    expect((await rig.status()).orphans).toBe(0);
  });

  test('a failed embedding after the graph committed is healed by the next sync', async () => {
    write('d.ts', `export function delta(): number { return 4; }\n`);
    embedder.failNext = true;
    await expect(rig.sync()).rejects.toThrow('embedder down');
    const delta = nodeId('delta', 'function');
    expect(getEmbedding(rig.database.adapter, delta)).toBeNull();

    const healed = await rig.sync();
    expect(healed.filesChanged).toBe(0);
    expect(getEmbedding(rig.database.adapter, delta)).not.toBeNull();
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

  test('after an upgrade, --include keeps the other files’ edges until they are re-extracted', async () => {
    // A v11 database once v12 has run: nodes and edges in place, but no
    // extractor_version and no per-file artifacts yet.
    rig.database.adapter.exec(
      `UPDATE files SET extractor_version = NULL; DELETE FROM file_refs; DELETE FROM file_edges;`,
    );
    const fileCount = one<{ n: number }>(`SELECT COUNT(*) AS n FROM files`).n;
    const others = (): string[] => [...edgesFromFile('a.ts'), ...edgesFromFile('b.ts')];
    const before = others();

    write('c.ts', `export class Widget { run(): void {} stop(): void {} }\n`);
    const partial = await rig.indexAll({ include: ['c.ts'] });
    expect(partial.changed).toBe(1);
    expect(others()).toEqual(before);

    // The next full run re-extracts the legacy files once, in place.
    const full = await rig.indexAll();
    expect(full.changed).toBe(fileCount - 1);
    expect(others()).toEqual(before);
    expect((await rig.indexAll()).changed).toBe(0);
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

  test('the file watcher syncs an edit and keeps its edges', async () => {
    const env = { force: process.env.RIG_FORCE_WATCH, off: process.env.RIG_NO_WATCH };
    process.env.RIG_FORCE_WATCH = '1';
    delete process.env.RIG_NO_WATCH;
    try {
      const before = countByKind(edgesFromFile('a.ts'));
      const hashOfA = (): string =>
        one<{ hash: string }>(`SELECT hash FROM files WHERE path = 'a.ts'`).hash;
      const old = hashOfA();
      expect(rig.watch({ debounceMs: 50 })).toBe(true);

      write(
        'a.ts',
        `import { helper } from './b';\n// edited while watching\nexport function main(): number { return helper(21); }\n`,
      );
      for (const deadline = Date.now() + 5000; hashOfA() === old && Date.now() < deadline; ) {
        await sleep(25);
      }
      expect(hashOfA()).not.toBe(old);
      expect(countByKind(edgesFromFile('a.ts'))).toEqual(before);
    } finally {
      rig.unwatch();
      if (env.force === undefined) delete process.env.RIG_FORCE_WATCH;
      else process.env.RIG_FORCE_WATCH = env.force;
      if (env.off !== undefined) process.env.RIG_NO_WATCH = env.off;
    }
  });
});
