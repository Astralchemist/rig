// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rigWaypointsHandler } from '../generated/mcp/handlers/rig_waypoints.handler.ts';
import { MemoryFileError, Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import type { ToolContext } from '../packages/mcp/src/dispatch.ts';
import { runCli } from './support/cli.ts';

// `rig export-memory` / `rig import-memory`: the agent-written memory survives
// losing .rig/ (gitignored by `rig init`, gone after a fresh clone or
// `git clean -fdx`).

const B_TS = `export function helper(x: number): number { return x * 2; }\n`;
const A_TS = `import { helper } from './b';\nexport function main(): number { return helper(21); }\n`;
// Two "Design" sections share an anchor: told apart by ordinal.
const NOTES_MD = `# Notes\n\n## Design\n\nfirst\n\n## Design\n\nsecond\n`;

const ctx = { sessionId: 'agent-1', actor: 'ai:test' };
const web = { sessionId: 'web', actor: 'user:web' };

const writeProject = (dir: string, files: Record<string, string>): void => {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
};

const one = <T>(rig: Rig, sql: string, ...params: unknown[]): T =>
  rig.database.adapter.prepare(sql).get(...params) as T;
const all = <T>(rig: Rig, sql: string, ...params: unknown[]): T[] =>
  rig.database.adapter.prepare(sql).all(...params) as T[];
const idOf = (rig: Rig, name: string, type = 'function'): string =>
  one<{ id: string }>(rig, `SELECT id FROM nodes WHERE name = ? AND type = ?`, name, type).id;
const designs = (rig: Rig): string[] =>
  all<{ id: string }>(
    rig,
    `SELECT id FROM nodes WHERE name = 'Design' ORDER BY json_extract(data, '$.startLine')`,
  ).map((r) => r.id);

// Memory of every kind, as the MCP write tools and the map leave it.
const attachMemory = (rig: Rig): { waypoint: string } => {
  const helper = idOf(rig, 'helper');
  const main = idOf(rig, 'main');
  rig.writes.addAlias({ nodeId: helper, alias: 'doubler', rationale: 'test alias' }, ctx);
  rig.writes.annotateNode({ nodeId: helper, note: 'auth boundary', rationale: 'test note' }, ctx);
  rig.writes.annotateNode(
    { nodeId: designs(rig)[1]!, note: 'the second design', rationale: 'test note' },
    ctx,
  );
  rig.writes.promoteHub(main, 'main is the entry point', ctx);
  const first = rig.writes.dropWaypoint(
    {
      kind: 'decision',
      title: 'Route through helper',
      summary: 'All doubling goes through helper',
      constellationRefs: [helper, main],
      rationale: 'the user asked for one entry point',
    },
    ctx,
  );
  const waypoint = rig.writes.dropWaypoint(
    { kind: 'observation', title: 'Then main', summary: 'main follows', predecessors: [first] },
    ctx,
  );
  const accepted = rig.writes.proposeEdge(
    {
      src: main,
      dst: helper,
      kind: 'calls',
      rationale: 'main calls helper',
      sourceUrls: ['https://example.com/spec'],
    },
    ctx,
  );
  rig.writes.acceptPending(accepted, web);
  rig.writes.proposeEdge({ src: helper, dst: main, rationale: 'still pending' }, ctx);
  const rejected = rig.writes.proposeEdge(
    { src: helper, dst: designs(rig)[0]!, kind: 'documents', rationale: 'rejected link' },
    ctx,
  );
  rig.writes.rejectPending(rejected, web);
  rig.writes.clusterNodes(
    { memberIds: [helper, main], label: 'Core', rationale: 'both core' },
    ctx,
  );
  return { waypoint };
};

// The memory by names and positions, so two graphs with different ids compare.
const memoryOf = (rig: Rig): Record<string, unknown> => {
  const name = `n.name || '@' || COALESCE(json_extract(n.data, '$.startLine'), '')`;
  const named = (alias: string): string =>
    `${alias}.name || '@' || COALESCE(json_extract(${alias}.data, '$.startLine'), '')`;
  const titleOf = (id: string): string | undefined => rig.getNode(id)?.name;
  return {
    aliases: all(
      rig,
      `SELECT ${name} AS node, a.alias, a.provenance FROM aliases a JOIN nodes n ON n.id = a.node_id
       ORDER BY node, a.alias`,
    ),
    annotations: all(
      rig,
      `SELECT ${name} AS node, a.note, a.actor FROM annotations a JOIN nodes n ON n.id = a.node_id
       ORDER BY a.ts, a.note`,
    ),
    promoted: all(
      rig,
      `SELECT ${name} AS node FROM nodes n WHERE n.hub_explicit = 1 ORDER BY node`,
    ),
    waypoints: rig.getWaypoints().map((w) => ({
      title: w.title,
      kind: w.kind,
      rationale: w.rationale ?? null,
      refs: w.constellation_refs.map(titleOf),
      predecessors: w.predecessors.map(titleOf),
    })),
    agentEdges: all(
      rig,
      `SELECT e.kind, ${named('a')} AS src, ${named('b')} AS dst FROM edges e
       JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst
       WHERE e.provenance != 'ast' ORDER BY e.kind, src, dst`,
    ),
    semantic: all(
      rig,
      `SELECT ${named('a')} AS src, ${named('b')} AS dst, s.kind, s.source_urls FROM edges_semantic s
       JOIN nodes a ON a.id = s.src JOIN nodes b ON b.id = s.dst ORDER BY src, dst`,
    ),
    pending: all(
      rig,
      `SELECT ${named('a')} AS src, ${named('b')} AS dst, p.kind, p.status, p.source_urls
       FROM pending_edges p JOIN nodes a ON a.id = p.src JOIN nodes b ON b.id = p.dst
       ORDER BY p.proposed_at, p.id`,
    ),
    sessions: all(rig, `SELECT id FROM sessions ORDER BY id`),
    clusters: all(rig, `SELECT name FROM nodes WHERE type = 'cluster'`),
    orphans: all(rig, `SELECT reason FROM orphaned_memory`),
  };
};

// Every row of the memory tables, raw: what "no change" means for an import.
const dump = (rig: Rig): Record<string, unknown> =>
  Object.fromEntries(
    [
      'sessions',
      'aliases',
      'annotations',
      'edges_semantic',
      'pending_edges',
      'orphaned_memory',
    ].map((t) => [t, all(rig, `SELECT * FROM ${t} ORDER BY rowid`)]),
  );
const fullDump = (rig: Rig): Record<string, unknown> => ({
  ...dump(rig),
  agentNodes: all(rig, `SELECT * FROM nodes WHERE type IN ('conversation-waypoint', 'cluster')`),
  hubs: all(rig, `SELECT id, hub_explicit, is_hub, hubness FROM nodes ORDER BY id`),
  agentEdges: all(rig, `SELECT * FROM edges WHERE provenance != 'ast' ORDER BY src, dst, kind`),
  sequences: all(rig, `SELECT name, seq FROM sqlite_sequence ORDER BY name`),
});

describe('memory export and import', () => {
  let root: string;
  const open = async (name: string, files: Record<string, string>): Promise<Rig> => {
    const dir = join(root, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeProject(dir, files);
    const rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    return rig;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rig-memory-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('the export is JSONL with a header, typed records and portable keys', async () => {
    const rig = await open('src', { 'b.ts': B_TS, 'a.ts': A_TS, 'NOTES.md': NOTES_MD });
    try {
      attachMemory(rig);
      const { text, counts } = rig.exportMemory();
      const lines = text
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines[0]).toMatchObject({ type: 'header', format: 'rig-memory', version: 1 });
      expect(lines.slice(1).every((r) => typeof r.type === 'string')).toBe(true);
      expect(counts).toEqual({
        session: 1,
        node: 1,
        waypoint: 2,
        edge: 5,
        alias: 1,
        annotation: 2,
        promotion: 1,
        semantic_edge: 1,
        pending_edge: 3,
        orphan: 0,
      });
      const alias = lines.find((r) => r.type === 'alias')!;
      expect(alias.node).toEqual({
        id: idOf(rig, 'helper'),
        key: { kind: 'function', filePath: 'b.ts', qualifiedName: 'helper', name: 'helper' },
      });
      // A shared anchor carries the ordinal; an agent-written node, its id only.
      const second = lines.find((r) => r.type === 'annotation' && r.note === 'the second design')!;
      expect(second.node).toMatchObject({ key: { kind: 'markdown-section', ordinal: 1 } });
      const succeeds = lines.find((r) => r.type === 'edge' && r.kind === 'waypoint_succeeds')!;
      expect(Object.keys(succeeds.dst as object)).toEqual(['id']);
      const waypoint = lines.find(
        (r) => r.type === 'waypoint' && r.title === 'Route through helper',
      );
      expect(waypoint?.data).toMatchObject({ rationale: 'the user asked for one entry point' });
    } finally {
      rig.close();
    }
  });

  test('two exports of the same database are byte-identical', async () => {
    const rig = await open('src', { 'b.ts': B_TS, 'a.ts': A_TS, 'NOTES.md': NOTES_MD });
    try {
      attachMemory(rig);
      const first = rig.exportMemory().text;
      expect(rig.exportMemory().text).toBe(first);
      await rig.indexAll(); // nothing changed: same graph, same export
      expect(rig.exportMemory().text).toBe(first);
    } finally {
      rig.close();
    }
  });

  test('references not found here wait in orphans and re-attach when indexed', async () => {
    const src = await open('src', { 'b.ts': B_TS, 'a.ts': A_TS, 'NOTES.md': NOTES_MD });
    attachMemory(src);
    const text = src.exportMemory().text;
    const helperId = idOf(src, 'helper');
    const before = memoryOf(src);
    src.close();

    // helper does not exist here.
    const dst = await open('dst', {
      'b.ts': 'export const keep = 1;\n',
      'a.ts': A_TS,
      'NOTES.md': NOTES_MD,
    });
    try {
      const r = dst.importMemory(text);
      expect(r.records.alias).toEqual({ added: 0, present: 0, orphaned: 1, dropped: 0 });
      expect(r.records.annotation).toMatchObject({ added: 1, orphaned: 1 });
      expect(r.records.waypoint).toMatchObject({ added: 2 });
      expect(r.orphanRows).toBe(1);
      const rows = all<{ node_id: string; file_path: string; reason: string; payload: string }>(
        dst,
        `SELECT node_id, file_path, kind, qualified_name, reason, payload FROM orphaned_memory`,
      );
      expect(rows).toEqual([
        expect.objectContaining({
          node_id: helperId,
          file_path: 'b.ts',
          kind: 'function',
          qualified_name: 'helper',
          reason: 'import-unmatched',
        }),
      ]);
      const payload = JSON.parse(rows[0]!.payload) as {
        aliases: { alias: string }[];
        annotations: { note: string }[];
        edges: { kind: string }[];
        semantic_edges: unknown[];
        pending_edges: unknown[];
      };
      expect(payload.aliases.map((a) => a.alias)).toEqual(['doubler']);
      expect(payload.annotations.map((a) => a.note)).toEqual(['auth boundary']);
      expect(payload.edges.map((e) => e.kind).sort()).toEqual(['contains', 'waypoint_references']);
      expect(payload.semantic_edges).toHaveLength(1);
      expect(payload.pending_edges).toHaveLength(3);
      expect((await dst.status()).orphans).toBe(1);

      // helper comes back a line lower, so under another id: retention
      // re-attaches everything, waypoint refs rewritten to the new id.
      writeFileSync(join(root, 'dst', 'b.ts'), `// back\n${B_TS}`);
      await dst.sync();
      expect(idOf(dst, 'helper')).not.toBe(helperId);
      expect(memoryOf(dst)).toEqual(
        JSON.parse(JSON.stringify(before).replaceAll('helper@1', 'helper@2')),
      );
      expect(dst.getWaypoints().flatMap((w) => w.constellation_refs)).toContain(
        idOf(dst, 'helper'),
      );
      expect((await dst.status()).orphans).toBe(0);
    } finally {
      dst.close();
    }
  });

  test('importing the same file twice changes nothing the second time', async () => {
    const src = await open('src', { 'b.ts': B_TS, 'a.ts': A_TS, 'NOTES.md': NOTES_MD });
    attachMemory(src);
    const text = src.exportMemory().text;
    src.close();
    // helper is missing, so part of the memory waits in orphans.
    const dst = await open('dst', { 'b.ts': 'export const keep = 1;\n', 'a.ts': A_TS });
    try {
      dst.importMemory(text);
      const after = fullDump(dst);
      const again = dst.importMemory(text);
      expect(fullDump(dst)).toEqual(after);
      for (const c of Object.values(again.records)) {
        expect(c).toMatchObject({ added: 0, orphaned: 0 });
      }
      expect(again.orphanRows).toBe(0);
    } finally {
      dst.close();
    }
  });

  test('import never overwrites what the database already has', async () => {
    const src = await open('src', { 'b.ts': B_TS, 'a.ts': A_TS, 'NOTES.md': NOTES_MD });
    try {
      attachMemory(src);
      const text = src.exportMemory().text;
      // Newer than the export: a proposal decided, a session seen again.
      const pending = one<{ id: number }>(
        src,
        `SELECT id FROM pending_edges WHERE status = 'pending'`,
      );
      src.writes.rejectPending(pending.id, web);
      src.database.adapter.prepare(`UPDATE sessions SET last_seen = last_seen + 1000`).run();
      const newer = dump(src);

      const r = src.importMemory(text);
      expect(dump(src)).toEqual(newer);
      for (const c of Object.values(r.records)) expect(c).toMatchObject({ added: 0, orphaned: 0 });
    } finally {
      src.close();
    }
  });

  test('a file that is not a memory export is refused, and nothing is written', async () => {
    const rig = await open('dst', { 'b.ts': B_TS });
    try {
      const before = fullDump(rig);
      expect(() => rig.importMemory('{"hello":1}\n')).toThrow(MemoryFileError);
      expect(() =>
        rig.importMemory('{"type":"header","format":"rig-memory","version":2}\n'),
      ).toThrow(/version 2 is not supported/);
      const header = '{"type":"header","format":"rig-memory","version":1}';
      const session =
        '{"type":"session","id":"s","started_at":1,"last_seen":1,"title":null,"context_model":null}';
      expect(() =>
        rig.importMemory(`${header}\n${session}\n{"type":"alias","alias":"x"}\n`),
      ).toThrow(/line 3: alias\.node/);
      expect(fullDump(rig)).toEqual(before);
    } finally {
      rig.close();
    }
  });
});

describe('rig export-memory / rig import-memory', () => {
  let root: string;
  let project: string;
  let home: string;

  const cli = (...args: string[]): { code: number; stdout: string; stderr: string } =>
    runCli(args, { cwd: project, home });
  // `rig init` + `rig index`, with the offline embedder.
  const initAndIndex = (): void => {
    expect(cli('init').code).toBe(0);
    writeFileSync(
      join(project, '.rig', 'config.json'),
      JSON.stringify({ embedder: { kind: 'deterministic' } }),
    );
    expect(cli('index').code).toBe(0);
  };
  const withRig = async <T>(run: (rig: Rig) => T | Promise<T>): Promise<T> => {
    const rig = await Rig.open(project, { embedder: new DeterministicEmbedder() });
    try {
      return await run(rig);
    } finally {
      rig.close();
    }
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rig-memory-cli-'));
    project = join(root, 'project');
    home = join(root, 'home');
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeProject(project, { 'b.ts': B_TS, 'a.ts': A_TS, 'NOTES.md': NOTES_MD });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('export, delete .rig, init + index, import: the memory comes back attached', async () => {
    initAndIndex();
    await withRig((rig) => attachMemory(rig));
    // Shifted since they were first indexed: the source keeps the old ids,
    // a fresh index gives new ones, so import has to match by key.
    writeProject(project, {
      'b.ts': `// moved\n${B_TS}`,
      'NOTES.md': `<!-- moved -->\n${NOTES_MD}`,
    });
    expect(cli('sync').code).toBe(0);
    const before = await withRig((rig) => ({
      memory: memoryOf(rig),
      helper: idOf(rig, 'helper'),
      design: designs(rig)[1]!,
    }));

    const file = join(root, 'memory.jsonl');
    const exported = cli('export-memory', '--out', file);
    expect(exported.code).toBe(0);
    expect(exported.stdout).toContain(file);
    expect(exported.stdout).toMatch(/waypoint\s+2/);
    expect(exported.stdout).toContain('conversation-derived text');

    rmSync(join(project, '.rig'), { recursive: true, force: true });
    initAndIndex();
    const imported = cli('import-memory', file);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toMatch(/alias\s+1 added/);

    await withRig(async (rig) => {
      expect(idOf(rig, 'helper')).not.toBe(before.helper);
      expect(designs(rig)[1]).not.toBe(before.design);
      expect(memoryOf(rig)).toEqual(before.memory);
      // Waypoint refs and cluster members point at the nodes as they are now.
      for (const w of rig.getWaypoints()) {
        for (const ref of w.constellation_refs) expect(rig.getNode(ref)).not.toBeNull();
      }
      const cluster = one<{ data: string }>(rig, `SELECT data FROM nodes WHERE type = 'cluster'`);
      const members = (JSON.parse(cluster.data) as { members: string[] }).members;
      expect(members.sort()).toEqual([idOf(rig, 'helper'), idOf(rig, 'main')].sort());
      // A new session picks up the imported thread, rationale included.
      const fresh: ToolContext = {
        rig,
        sessionId: 'fresh',
        provenance: 'ai:test',
        recordActivation: () => {},
      };
      const last = (await rigWaypointsHandler.run({ session_id: 'last' }, fresh)) as {
        waypoints: { title: string; rationale?: string }[];
      };
      expect(last.waypoints.map((w) => w.title).sort()).toEqual([
        'Route through helper',
        'Then main',
      ]);
    });
  }, 60_000);

  test('export defaults to .rig/exports; help says the file can hold conversation text', () => {
    initAndIndex();
    const r = cli('export-memory');
    expect(r.code).toBe(0);
    const files = readdirSync(join(project, '.rig', 'exports'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^memory-\d{8}T\d{6}Z\.jsonl$/);
    const path = join(project, '.rig', 'exports', files[0]!);
    expect(r.stdout).toContain(path);
    expect(readFileSync(path, 'utf-8').split('\n')[0]).toContain('"format":"rig-memory"');

    const help = cli('--help').stdout;
    expect(help).toContain('export-memory');
    expect(help).toContain('import-memory <file>');
    expect(help).toMatch(/conversation-derived text \(waypoint summaries and payloads\)/);

    const bad = join(root, 'bad.jsonl');
    writeFileSync(bad, 'not json\n');
    const refused = cli('import-memory', bad);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('not a rig memory export');
    expect(cli('import-memory').code).toBe(2);
    expect(existsSync(join(project, '.rig', 'rig.db'))).toBe(true);
  }, 60_000);
});
