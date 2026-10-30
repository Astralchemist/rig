// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import manifest from '../generated/mcp/tools-manifest.json' with { type: 'json' };
import * as handlersModule from '../generated/mcp/handlers-index.ts';
import { Rig } from '../packages/core/src/index.ts';
import { queryHash } from '../packages/core/src/db/activation-queries.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { makeActivationRecorder, type ToolContext } from '../packages/mcp/src/dispatch.ts';
import { buildHandlersMap } from '../packages/mcp/src/server-handlers.ts';
import { discoverContracts } from '../scripts/gen/discover.ts';

// Every tool contract declares records_activation; the implementation must
// do exactly that. Each tool is called once on a small graph: it records
// activations iff its flag is true.
const contracts = (await discoverContracts(resolve(__dirname, '..')))
  .filter((c) => c.kind === 'tools')
  .map((c) => c.data as { name: string; records_activation?: boolean; description: string })
  .toSorted((a, b) => (a.name < b.name ? -1 : 1));
const handlers = buildHandlersMap(handlersModule as unknown as Record<string, unknown>);

interface Fixture {
  main: string;
  helper: string;
  fileA: string;
  waypoint: string;
}

// One valid call per tool. A tool missing here fails the coverage test.
const argsFor = (f: Fixture): Record<string, Record<string, unknown>> => ({
  rig_add_alias: { id: f.helper, alias: 'doubler', rationale: 'audit alias here' },
  rig_add_node: { type: 'concept', name: 'Audit', rationale: 'named in the audit' },
  rig_aliases: { id: f.helper },
  rig_annotate: { node_id: f.helper, note: 'audited', rationale: 'audit note here' },
  rig_callees: { id: f.main },
  rig_callers: { id: f.helper },
  rig_chain: { id: f.waypoint },
  rig_cluster: { node_ids: [f.main, f.helper], label: 'Audit', rationale: 'audit cluster' },
  rig_cold: {},
  rig_context: { task: 'helper' },
  rig_critical_path: { id: f.main },
  rig_dep_conflicts: {},
  rig_deps: {},
  rig_drill: { hub_id: f.fileA, query: 'main' },
  rig_drop_waypoint: {
    kind: 'decision',
    title: 'Audit',
    summary: 'audit waypoint summary',
    rationale: 'audit waypoint here',
  },
  rig_explore: { question: 'helper' },
  rig_files: {},
  rig_focus: { node_ids: [f.helper] },
  rig_handoff: { action: 'write', current_work: 'audit handoff' },
  rig_hotspots: {},
  rig_hub_of: { id: f.helper },
  rig_hubs: {},
  rig_impact: { id: f.helper },
  rig_neighbors: { id: f.helper },
  rig_node: { id: f.helper },
  rig_overview: {},
  rig_phantom_imports: {},
  rig_promote: { id: f.helper, rationale: 'audit promote here' },
  rig_propose_edge: { src: f.main, dst: f.helper, rationale: 'audit proposal here' },
  rig_pull: { id: f.helper },
  rig_relevant_skills: { query: 'pull' },
  rig_search: { query: 'helper' },
  rig_session_token: {},
  rig_status: {},
  rig_subscribe: {},
  rig_undo: {},
  rig_unused_deps: {},
  rig_waypoints: {},
});

describe('records_activation matches what each tool does', () => {
  let project: string;
  let rig: Rig;
  let fixture: Fixture;
  let ctx: ToolContext;

  const one = <T>(sql: string, ...params: unknown[]): T =>
    rig.database.adapter.prepare(sql).get(...params) as T;
  const lastRowid = (): number =>
    one<{ n: number | null }>(`SELECT MAX(rowid) AS n FROM activations`).n ?? 0;
  // Activations recorded since `rowid`, as [node_id, query_hash] pairs.
  const recordedSince = (rowid: number): [string, string | null][] =>
    (
      rig.database.adapter
        .prepare(`SELECT node_id, query_hash FROM activations WHERE rowid > ? ORDER BY rowid`)
        .all(rowid) as { node_id: string; query_hash: string | null }[]
    ).map((r) => [r.node_id, r.query_hash]);
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
    handlers.get(name)!.run(args, ctx);

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-records-activation-'));
    writeFileSync(
      join(project, 'b.ts'),
      `export function helper(x: number): number { return x * 2; }\n`,
    );
    writeFileSync(
      join(project, 'a.ts'),
      `import { helper } from './b';\nexport function main(): number { return helper(21); }\n`,
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    // rig_session_token reads the map's token.
    writeFileSync(join(project, '.rig', '.runtime'), 'a'.repeat(64));
    await rig.indexAll();
    rig.seedSkills(manifest.tools);
    const idOf = (name: string, type: string): string =>
      one<{ id: string }>(`SELECT id FROM nodes WHERE name = ? AND type = ?`, name, type).id;
    fixture = {
      main: idOf('main', 'function'),
      helper: idOf('helper', 'function'),
      fileA: idOf('a.ts', 'file'),
      waypoint: rig.writes.dropWaypoint(
        { kind: 'observation', title: 'seed', summary: 'seed waypoint' },
        { sessionId: 'seed', actor: 'ai:test' },
      ),
    };
    ctx = {
      rig,
      sessionId: 'audit',
      provenance: 'ai:audit',
      recordActivation: makeActivationRecorder(rig, 'audit'),
    };
  });

  afterAll(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('every tool has an audit call', () => {
    expect(Object.keys(argsFor(fixture)).sort()).toEqual(contracts.map((c) => c.name));
    expect(contracts).toHaveLength(38);
  });

  for (const c of contracts) {
    test(`${c.name}: records_activation ${c.records_activation === true}`, async () => {
      const before = lastRowid();
      await call(c.name, argsFor(fixture)[c.name]!);
      expect(recordedSince(before).length > 0).toBe(c.records_activation === true);
    });
  }

  test('query-driven tools stamp query_hash with the normalized query or anchor', async () => {
    const hashesOf = async (name: string, args: Record<string, unknown>): Promise<unknown[]> => {
      const before = lastRowid();
      await call(name, args);
      const rows = recordedSince(before);
      expect(rows.length).toBeGreaterThan(0);
      return [...new Set(rows.map(([, h]) => h))];
    };
    expect(queryHash('  Helper\tfunction ')).toBe(queryHash('helper function'));
    expect(queryHash('helper')).toMatch(/^[0-9a-f]{16}$/);

    expect(await hashesOf('rig_search', { query: 'Helper' })).toEqual([queryHash('helper')]);
    expect(await hashesOf('rig_context', { task: 'helper' })).toEqual([queryHash('helper')]);
    expect(await hashesOf('rig_explore', { question: 'helper' })).toEqual([queryHash('helper')]);
    expect(await hashesOf('rig_relevant_skills', { query: 'pull' })).toEqual([queryHash('pull')]);
    expect(await hashesOf('rig_pull', { id: fixture.helper })).toEqual([queryHash(fixture.helper)]);
    expect(await hashesOf('rig_drill', { hub_id: fixture.fileA, query: 'main' })).toEqual([
      queryHash('main'),
    ]);
    expect(await hashesOf('rig_drill', { hub_id: fixture.fileA })).toEqual([null]);
    // Node-centric tools have no query.
    expect(await hashesOf('rig_node', { id: fixture.helper })).toEqual([null]);
  });

  test('search-driven tools record exactly the anchors they return', async () => {
    const recorded = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ out: Record<string, unknown>; ids: string[] }> => {
      const before = lastRowid();
      const out = (await call(name, args)) as Record<string, unknown>;
      return { out, ids: recordedSince(before).map(([id]) => id) };
    };
    const ids = (items: unknown): string[] => (items as { id: string }[]).map((x) => x.id);

    const search = await recorded('rig_search', { query: 'helper', limit: 5 });
    expect(search.ids).toEqual(ids(search.out.nodes));
    const context = await recorded('rig_context', { task: 'helper', max_nodes: 5, format: 'json' });
    expect(context.ids).toEqual(ids(JSON.parse(context.out.context as string)));
    const explore = await recorded('rig_explore', { question: 'helper', max_anchors: 5 });
    expect(explore.ids).toEqual(ids(explore.out.anchors));
    const skills = await recorded('rig_relevant_skills', { query: 'pull', k: 3 });
    expect(skills.ids).toEqual(ids(skills.out.skills));
  });

  test("rig_context's description says what it does: search order, no pull ranking", async () => {
    const description = contracts.find((c) => c.name === 'rig_context')!.description;
    expect(description).not.toMatch(/magnetic-pull ranking/i);
    expect(description).toMatch(/rig_search/);
    const searched = (
      (await call('rig_search', { query: 'helper', limit: 5 })) as { nodes: { id: string }[] }
    ).nodes.map((n) => n.id);
    const bundle = (await call('rig_context', {
      task: 'helper',
      max_nodes: 5,
      format: 'json',
    })) as {
      context: string;
    };
    expect((JSON.parse(bundle.context) as { id: string }[]).map((b) => b.id)).toEqual(searched);
  });
});
