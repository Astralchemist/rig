// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';

// rig_undo / POST /api/undo walk back through the caller's session, one
// mutation per call.
describe('undo', () => {
  let project: string;
  let rig: Rig;
  let alpha: string;
  let beta: string;
  const ctx = { sessionId: 'agent-1', actor: 'ai:test' };

  const one = <T>(sql: string, ...params: unknown[]): T =>
    rig.database.adapter.prepare(sql).get(...params) as T;
  const count = (sql: string, ...params: unknown[]): number => one<{ n: number }>(sql, ...params).n;
  const idOf = (name: string): string =>
    one<{ id: string }>(`SELECT id FROM nodes WHERE name = ? AND type = 'function'`, name).id;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-undo-'));
    writeFileSync(join(project, 'a.ts'), 'export function alpha(): void {}\n');
    writeFileSync(join(project, 'b.ts'), 'export function beta(): void {}\n');
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    alpha = idOf('alpha');
    beta = idOf('beta');
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('three sequential undos revert three mutations in reverse order', () => {
    const pendingId = rig.writes.proposeEdge(
      { src: alpha, dst: beta, rationale: 'alpha feeds beta' },
      ctx,
    );
    rig.writes.addAlias({ nodeId: alpha, alias: 'first', rationale: 'test alias' }, ctx);
    const concept = rig.writes.addNode(
      { type: 'concept', name: 'Onboarding', rationale: 'named in chat' },
      ctx,
    );
    // Another session's mutation in between is never touched.
    const other = { sessionId: 'agent-2', actor: 'ai:test' };
    rig.writes.addAlias({ nodeId: beta, alias: 'other', rationale: 'other session' }, other);

    expect(rig.writes.undoLast(ctx)?.kind).toBe('add_node');
    expect(rig.getNode(concept)).toBeNull();
    expect(rig.getAliases(alpha).map((a) => a.alias)).toEqual(['first']);

    expect(rig.writes.undoLast(ctx)?.kind).toBe('add_alias');
    expect(rig.getAliases(alpha)).toEqual([]);
    expect(count(`SELECT COUNT(*) AS n FROM pending_edges WHERE id = ?`, pendingId)).toBe(1);

    expect(rig.writes.undoLast(ctx)?.kind).toBe('propose_edge');
    expect(count(`SELECT COUNT(*) AS n FROM pending_edges WHERE id = ?`, pendingId)).toBe(0);

    expect(rig.writes.undoLast(ctx)).toBeNull();
    expect(rig.getAliases(beta).map((a) => a.alias)).toEqual(['other']);
  });
});
