// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { consolidate, findClusters } from '../packages/core/src/memory/consolidate.ts';

// Step 5: near-duplicates become one lesson; the originals stay, hidden.
describe('consolidation', () => {
  let dir: string;
  let rig: Rig;
  let login: string;
  let logout: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rig-consolidate-'));
    writeFileSync(join(dir, 'a.ts'), 'export function login() {}\nexport function logout() {}\n');
    rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    login = rig.searchNodes('login').find((n) => n.name === 'login')!.id;
    logout = rig.searchNodes('logout').find((n) => n.name === 'logout')!.id;
  });
  afterEach(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const drop = (title: string, summary: string, refs: string[], kind = 'decision', session = 's') =>
    rig.writes.dropWaypoint(
      {
        kind: kind as never,
        title,
        summary,
        constellationRefs: refs,
        keyTerms: [],
        rationale: 'r',
      },
      { sessionId: session, actor: 'ai:test' },
    );

  test('same kind, same anchor, saying the same thing: one cluster; different anchors or kinds: none', () => {
    drop(
      'Login stays synchronous',
      'Keep login synchronous, no queue between view and login',
      [login],
      'decision',
      's1',
    );
    drop(
      'Login must stay synchronous',
      'No queue between the view and login; keep login synchronous',
      [login],
      'decision',
      's2',
    );
    drop('Logout clears the cookie', 'Logout clears the session cookie', [logout]);
    drop(
      'Login stays synchronous',
      'Keep login synchronous, no queue between view and login',
      [login],
      'constraint',
    );
    const c = findClusters(rig);
    expect(c).toHaveLength(1);
    expect(c[0]!.members).toHaveLength(2);
    expect(c[0]!.kind).toBe('decision');
  });

  test('dry run writes nothing; apply makes a lesson that points at its sources and hides them', () => {
    const a = drop(
      'Login stays synchronous',
      'Keep login synchronous, no queue between view and login',
      [login],
    );
    const b = drop(
      'Login must stay synchronous',
      'No queue between the view and login; keep login synchronous',
      [login],
    );
    expect(consolidate(rig).lessons[0]!.id).toBeNull();
    expect(rig.getWaypoints({ limit: 50 })).toHaveLength(2);

    const { lessons } = consolidate(rig, { apply: true });
    expect(lessons).toHaveLength(1);
    const visible = rig.getWaypoints({ limit: 50 });
    expect(visible.map((w) => w.id)).toEqual([lessons[0]!.id]);
    const lesson = visible[0]!;
    expect(lesson.sources?.sort()).toEqual([a, b].sort());
    expect(lesson.summary).toContain('Recorded 2 times');
    expect(lesson.constellation_refs).toEqual([login]);
    // The originals are still there, marked.
    const all = rig.getWaypoints({ limit: 50, includeConsolidated: true });
    expect(
      all
        .filter((w) => w.consolidated_into === lesson.id)
        .map((w) => w.id)
        .sort(),
    ).toEqual([a, b].sort());
    // Running again finds nothing new.
    expect(consolidate(rig, { apply: true }).lessons).toEqual([]);
  });
});
