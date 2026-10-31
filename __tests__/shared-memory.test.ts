// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import {
  PromoteError,
  SHARED_DIR,
  SHARED_PROVENANCE,
  importShared,
  loadShared,
  parseCommentVerdicts,
  promoteWaypoint,
  recordVerdicts,
  trustTier,
  unshare,
} from '../packages/core/src/memory/shared.ts';

// B5: memory travels with the repo, one file per record, promotion only.
describe('shared memory', () => {
  let base: string;
  let a: string; // the machine that promotes
  let b: string; // a fresh clone elsewhere
  let rigA: Rig;
  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'rig-shared-'));
    a = join(base, 'a');
    b = join(base, 'b');
    for (const d of [a, b]) {
      mkdirSync(d);
      writeFileSync(
        join(d, 'auth.ts'),
        'export function login(user: string): boolean {\n  return user.length > 0;\n}\n',
      );
    }
    rigA = await Rig.init(a, { embedder: new DeterministicEmbedder() });
    await rigA.indexAll();
  });
  afterEach(() => {
    rigA.close();
    rmSync(base, { recursive: true, force: true });
  });

  const drop = (extra: Record<string, unknown> = {}) => {
    const login = rigA.searchNodes('login').find((n) => n.name === 'login')!;
    return rigA.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'Login stays synchronous',
        summary: 'No queue between the view and login.',
        constellationRefs: [login.id],
        keyTerms: ['login'],
        rationale: 'latency',
        ...extra,
      },
      { sessionId: 's1', actor: 'ai:test' },
    );
  };

  test('promote on one clone, import on another: anchored, and importing again adds nothing', async () => {
    const id = drop();
    promoteWaypoint(rigA, id, { by: 'alice' });
    cpSync(join(a, SHARED_DIR), join(b, SHARED_DIR), { recursive: true });
    const rigB = await Rig.init(b, { embedder: new DeterministicEmbedder() });
    try {
      await rigB.indexAll();
      expect(importShared(rigB)).toMatchObject({ added: 1, unanchored: 0, removed: 0, errors: [] });
      const w = rigB.getWaypoint(id)!;
      expect(w.provenance).toBe(SHARED_PROVENANCE);
      expect(rigB.getNode(w.constellation_refs[0]!)?.name).toBe('login');
      expect(importShared(rigB).added).toBe(0);
      // Unshared on A, removed on B at the next import.
      unshare(a, id, 'alice');
      cpSync(join(a, SHARED_DIR), join(b, SHARED_DIR), { recursive: true });
      expect(importShared(rigB).removed).toBe(1);
      expect(rigB.getWaypoint(id)).toBeNull();
    } finally {
      rigB.close();
    }
  });

  test('captured records, secrets and hidden Unicode are refused', () => {
    expect(() =>
      promoteWaypoint(rigA, drop({ source: 'hook', confidence: 0.9 }), { by: 'a' }),
    ).toThrow(PromoteError);
    expect(() =>
      promoteWaypoint(rigA, drop({ summary: 'use key sk-ant-api03-' + 'x'.repeat(90) }), {
        by: 'a',
      }),
    ).toThrow(/secret/);
    expect(() => promoteWaypoint(rigA, drop({ title: 'safe‮evil' }), { by: 'a' })).toThrow(
      /hidden Unicode/,
    );
    expect(
      promoteWaypoint(rigA, drop({ source: 'hook', confidence: 0.9 }), {
        by: 'a',
        includeCaptured: true,
      }).version,
    ).toBe(1);
  });

  test('one file per record; identical duplicate lines are harmless; conflicting versions and hidden Unicode fail the check', () => {
    const id = drop().replace(/^waypoint:/, '');
    promoteWaypoint(rigA, `waypoint:${id}`, { by: 'alice' });
    const dir = join(a, SHARED_DIR, id.slice(0, 2));
    expect(readdirSync(dir)).toEqual([`${id}.jsonl`]);
    const file = join(dir, `${id}.jsonl`);
    const line = readFileSync(file, 'utf-8');
    appendFileSync(file, line); // what a union merge of identical appends leaves
    expect(loadShared(a).errors).toEqual([]);
    appendFileSync(file, line.replace('alice', 'mallory'));
    expect(loadShared(a).errors.join()).toMatch(/two different versions 1/);
    writeFileSync(file, line.replace('synchronous', 'synchro​nous'));
    expect(loadShared(a).errors.join()).toMatch(/hidden Unicode/);
  });

  test("verdicts: only ticked boxes count, they're recorded against the version seen, the latest per reviewer wins", () => {
    const wid = drop();
    const id = wid.replace(/^waypoint:/, '');
    promoteWaypoint(rigA, wid, { by: 'alice' });
    const comment = [
      '<!-- rig-impact -->',
      `- **Login stays synchronous** (decision, on \`login\`)`,
      `  - [ ] still holds <!-- rig:${id}:holds -->`,
      `  - [x] outdated <!-- rig:${id}:outdated -->`,
      `  - [ ] can't tell <!-- rig:${id}:unsure -->`,
      '  - [x] outdated <!-- rig:not-shared-here:outdated -->',
    ].join('\n');
    const parsed = parseCommentVerdicts(comment);
    expect(parsed).toEqual([
      { id, verdict: 'outdated' },
      { id: 'not-shared-here', verdict: 'outdated' },
    ]);
    expect(parseCommentVerdicts(comment.replace(/\[x\]/g, '[ ]'))).toEqual([]);
    expect(recordVerdicts(a, parsed, { by: 'bob', pr: 58 })).toEqual({
      recorded: 1,
      skipped: ['not-shared-here'],
    });
    recordVerdicts(a, [{ id, verdict: 'holds' }], { by: 'bob' });
    recordVerdicts(a, [{ id, verdict: 'outdated' }], { by: 'carol' });
    const s = loadShared(a);
    expect(s.errors).toEqual([]);
    expect(Object.fromEntries(s.verdicts.get(id)!)).toEqual({ bob: 'holds', carol: 'outdated' });
    expect(s.records.get(id)!.version).toBe(1);
  });

  test('trust tiers follow reviewer verdicts; disputed records are hidden from rig_waypoints unless asked', async () => {
    const { run } = await import('../packages/mcp/src/tool-impls/rig_waypoints.ts');
    const { makeActivationRecorder } = await import('../packages/mcp/src/dispatch.ts');
    const wid = drop();
    const id = wid.replace(/^waypoint:/, '');
    promoteWaypoint(rigA, wid, { by: 'alice' });
    cpSync(join(a, SHARED_DIR), join(b, SHARED_DIR), { recursive: true });
    const rigB = await Rig.init(b, { embedder: new DeterministicEmbedder() });
    try {
      await rigB.indexAll();
      importShared(rigB);
      expect(trustTier(rigB.getWaypoint(wid)!)).toBe('shared');
      expect(trustTier(rigA.getWaypoint(wid)!)).toBe('local');

      recordVerdicts(b, [{ id, verdict: 'holds' }], { by: 'bob' });
      importShared(rigB);
      expect(trustTier(rigB.getWaypoint(wid)!)).toBe('shared-reviewed');

      recordVerdicts(b, [{ id, verdict: 'outdated' }], { by: 'carol' });
      recordVerdicts(b, [{ id, verdict: 'outdated' }], { by: 'dan' });
      importShared(rigB);
      expect(trustTier(rigB.getWaypoint(wid)!)).toBe('disputed');

      const ctx = {
        rig: rigB,
        sessionId: 'x',
        provenance: null,
        recordActivation: makeActivationRecorder(rigB, 'x'),
      };
      expect((await run({ limit: 50 } as never, ctx as never)).waypoints).toEqual([]);
      const shown = (await run({ limit: 50, include_disputed: true } as never, ctx as never))
        .waypoints;
      expect(shown.map((w: { trust?: string }) => w.trust)).toEqual(['disputed']);
    } finally {
      rigB.close();
    }
  });
});
