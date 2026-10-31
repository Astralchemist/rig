// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import {
  diffImpact,
  impactToMermaid,
  parseUnifiedDiff,
} from '../packages/core/src/graph/diff-impact.ts';

describe('parseUnifiedDiff', () => {
  test('new-side ranges per file; pure deletions anchor to their line; deleted files dropped', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,2 +3,4 @@ export function f() {',
      '@@ -20 +22 @@',
      '@@ -40,3 +41,0 @@',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,5 +0,0 @@',
    ].join('\n');
    const m = parseUnifiedDiff(diff);
    expect([...m.keys()]).toEqual(['src/a.ts']);
    expect(m.get('src/a.ts')).toEqual([
      [3, 6],
      [22, 22],
      [41, 41],
    ]);
  });
});

describe('diffImpact', () => {
  let dir: string;
  let rig: Rig;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rig-impact-'));
    writeFileSync(
      join(dir, 'auth.ts'),
      [
        'export class Session {',
        '  refresh(): number {',
        '    return 1;',
        '  }',
        '}',
        'export function login(user: string): Session {',
        '  return new Session();',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'store.ts'),
      "import { login } from './auth.ts';\nexport function signIn(u: string) {\n  return login(u);\n}\n",
    );
    writeFileSync(
      join(dir, 'view.ts'),
      "import { signIn } from './store.ts';\nexport function render() {\n  return signIn('x');\n}\n",
    );
    rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const login = rig.searchNodes('login').find((n) => n.name === 'login')!;
    rig.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'Login stays synchronous',
        summary: 'No queue between the view and login.',
        constellationRefs: [login.id],
        keyTerms: ['login'],
        rationale: 'test',
      },
      { sessionId: 's1', actor: 'ai:test' },
    );
  });
  afterAll(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (changes: Map<string, [number, number][]>, depth = 2) =>
    diffImpact(rig.database.adapter, changes, rig.getWaypoints({ limit: 1000 }), { depth });

  test('a change inside login: login changed, signIn then render depend on it, the decision is at risk', () => {
    const r = run(new Map([['auth.ts', [[7, 7]]]]));
    expect(r.changed.map((n) => n.name)).toEqual(['login']);
    const deps = Object.fromEntries(r.dependents.map((d) => [d.name, d.hops]));
    expect(deps.signIn).toBe(1);
    expect(deps.render).toBe(2);
    expect(r.memoryAtRisk.map((m) => [m.waypoint.title, m.via])).toEqual([
      ['Login stays synchronous', 'symbol'],
    ]);
    expect(r.edgeCounts.structural).toBeGreaterThan(0);
  });

  test('depth bounds the walk', () => {
    const r = run(new Map([['auth.ts', [[7, 7]]]]), 1);
    expect(r.dependents.map((d) => d.name)).toContain('signIn');
    expect(r.dependents.map((d) => d.name)).not.toContain('render');
  });

  test('a change in a method counts the method, not its class', () => {
    const r = run(new Map([['auth.ts', [[3, 3]]]]));
    expect(r.changed.map((n) => n.name)).toEqual(['refresh']);
    expect(r.memoryAtRisk).toEqual([]);
  });

  test('mermaid highlights changed symbols and caps the node count', () => {
    const r = run(new Map([['auth.ts', [[7, 7]]]]));
    const m = impactToMermaid(r, 2);
    expect(m.startsWith('flowchart RL')).toBe(true);
    expect(m).toContain('class n0 changed');
    expect(m).toMatch(/more\["\+\d+ more"\]/);
  });
});

describe('addedFilesInDiff', () => {
  test('files created by the diff, not modified or deleted ones', async () => {
    const { addedFilesInDiff } = await import('../packages/core/src/graph/diff-impact.ts');
    const diff = [
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,3 @@',
      '--- a/old.ts',
      '+++ b/old.ts',
      '@@ -1 +1 @@',
      '--- a/gone.ts',
      '+++ /dev/null',
    ].join('\n');
    expect([...addedFilesInDiff(diff)]).toEqual(['new.ts']);
  });
});

describe('PR comment', () => {
  test('summary first, decisions as checkboxes, drawing collapsed, blind spots stated; empty when nothing changed', async () => {
    const { renderImpactComment, COMMENT_MARKER } =
      await import('../packages/cli/src/impact-cmd.ts');
    const base = {
      files: ['a.ts'],
      added: [],
      docs: [],
      edges: [],
      edgeCounts: { structural: 0, accepted: 0 },
      depth: 2,
      blindSpots: [{ symbol: 'login', passedBy: ['retryWhenBusy'] }],
    };
    expect(renderImpactComment({ ...base, changed: [], dependents: [], memoryAtRisk: [] })).toBe(
      '',
    );
    const md = renderImpactComment(
      {
        ...base,
        changed: [
          {
            id: 'f',
            type: 'function',
            name: 'login',
            filePath: 'a.ts',
            startLine: 1,
            ranges: [[1, 2]],
          },
        ],
        dependents: [
          { id: 'g', type: 'function', name: 'render', filePath: 'b.ts', startLine: 3, hops: 1 },
        ],
        memoryAtRisk: [
          {
            waypoint: {
              id: 'waypoint:w1',
              kind: 'decision',
              title: 'Login stays sync',
              summary: '',
              ts: 0,
            },
            anchors: ['login'],
            via: 'symbol',
          },
        ],
      },
      { commit: 'abcdef123' },
    );
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md.split('\n')[1]).toContain(
      '1 changed symbol · 1 dependent within 2 steps · 1 recorded decision at risk',
    );
    expect(md).toContain('- [ ] still holds <!-- rig:w1:holds -->');
    expect(md).toContain('<details><summary>Blast radius');
    expect(md).toContain('```mermaid');
    expect(md).toContain("aren't seen");
    expect(md).toContain('at abcdef1');
    expect(md).toContain('**Blind spots.**');
    expect(md).toContain('`login` (by `retryWhenBusy`)');
  });
});

describe('callbacks and dispatch tables', () => {
  let dir: string;
  let rig: Rig;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rig-callbacks-'));
    writeFileSync(
      join(dir, 'a.ts'),
      [
        'export function retry<T>(fn: () => T): T { return fn(); }',
        'export function save(x: number): number {',
        '  return x + 1;',
        '}',
        'export function passer(): number { return retry(save as never); }',
        'export const handlers = { save };',
        'export class Store { sync() { return 1; } watch() { return retry(this.sync); } }',
        '',
      ].join('\n'),
    );
    rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });
  afterAll(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a function passed as a value is a dependent, and is reported as a blind spot', () => {
    const r = diffImpact(
      rig.database.adapter,
      new Map([['a.ts', [[3, 3]] as [number, number][]]]),
      [],
      { depth: 1 },
    );
    expect(r.changed.map((n) => n.name)).toEqual(['save']);
    expect(r.dependents.map((d) => d.name)).toContain('passer');
    expect(r.blindSpots).toEqual([{ symbol: 'save', passedBy: ['a.ts', 'passer'] }]);
  });

  test('`this.method` passed along links the method too', () => {
    const refs = rig.database.adapter
      .prepare(
        `SELECT (SELECT name FROM nodes WHERE id = e.src) AS src FROM edges e
         WHERE e.kind = 'references' AND e.dst = (SELECT id FROM nodes WHERE name = 'sync')`,
      )
      .all() as { src: string }[];
    expect(refs.map((r) => r.src)).toContain('watch');
  });
});

describe('may-call edges and dynamic imports', () => {
  let dir: string;
  let rig: Rig;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rig-maycall-'));
    writeFileSync(
      join(dir, 'a.ts'),
      [
        'export function retryWhenBusy<T>(fn: () => T): T { return fn(); }',
        'export function save(x: number): number {',
        '  return x + 1;',
        '}',
        'export class Store {',
        '  sync(): number { return 1; }',
        '  watch(): number { return retryWhenBusy(() => this.sync()); }',
        '}',
        'export function passer(): number { return retryWhenBusy(save as never); }',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'cli.ts'),
      "export const COMMANDS = { sync: async () => (await import('./cmd.ts')).runSync };\n",
    );
    writeFileSync(join(dir, 'cmd.ts'), 'export function runSync(): void {}\n');
    rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });
  afterAll(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const edge = (src: string, dst: string) =>
    rig.database.adapter
      .prepare(
        `SELECT kind, provenance FROM edges WHERE src = (SELECT id FROM nodes WHERE name = ?) AND dst = (SELECT id FROM nodes WHERE name = ?)`,
      )
      .all(src, dst);

  test('a function handed a callback may call it, by name or through an inline arrow', () => {
    expect(edge('retryWhenBusy', 'save')).toContainEqual({
      kind: 'calls',
      provenance: 'ast:callback',
    });
    expect(edge('retryWhenBusy', 'sync')).toContainEqual({
      kind: 'calls',
      provenance: 'ast:callback',
    });
  });

  test('so changing the callback reaches the function that calls it', () => {
    const r = diffImpact(
      rig.database.adapter,
      new Map([['a.ts', [[3, 3]] as [number, number][]]]),
      [],
      { depth: 1 },
    );
    expect(r.dependents.map((d) => d.name)).toContain('retryWhenBusy');
  });

  test('a member of a dynamic import is referenced', () => {
    const rows = rig.database.adapter
      .prepare(
        `SELECT (SELECT name FROM nodes WHERE id = e.src) AS src FROM edges e WHERE e.kind = 'references' AND e.dst = (SELECT id FROM nodes WHERE name = 'runSync')`,
      )
      .all() as { src: string }[];
    expect(rows.map((r) => r.src)).toContain('cli.ts');
  });
});

describe('old side and the shared line-to-symbol mapping', () => {
  test("side 'old' reads the removed paths and ranges", () => {
    const diff = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10,3 +12,5 @@', '@@ -30 +31,0 @@'].join(
      '\n',
    );
    expect(parseUnifiedDiff(diff, 'old').get('src/a.ts')).toEqual([
      [10, 12],
      [30, 30],
    ]);
  });

  test('innermostSymbolAt picks the smallest enclosing symbol', async () => {
    const { innermostSymbolAt } = await import('../packages/core/src/graph/diff-impact.ts');
    const sym = (name: string, startLine: number, endLine: number) => ({
      id: name,
      type: 'function',
      name,
      filePath: 'a.ts',
      startLine,
      endLine,
    });
    const syms = [sym('Outer', 1, 50), sym('inner', 10, 20), sym('other', 30, 40)];
    expect(innermostSymbolAt(syms, 15)?.name).toBe('inner');
    expect(innermostSymbolAt(syms, 25)?.name).toBe('Outer');
    expect(innermostSymbolAt(syms, 60)).toBeNull();
  });
});
