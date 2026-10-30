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
