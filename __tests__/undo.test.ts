// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rigUndoHandler } from '../generated/mcp/handlers/rig_undo.handler.ts';
import { Rig } from '../packages/core/src/index.ts';
import { recordMutation } from '../packages/core/src/db/mutation-log.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import type { ToolContext } from '../packages/mcp/src/dispatch.ts';

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
  const flags = (id: string): { hub_explicit: number; is_hub: number; hubness: number } =>
    one(`SELECT hub_explicit, is_hub, hubness FROM nodes WHERE id = ?`, id);
  const undoTool = async (sessionId = 'agent-1'): Promise<Record<string, unknown>> => {
    const toolCtx: ToolContext = {
      rig,
      sessionId,
      provenance: 'ai:test',
      recordActivation: () => {},
    };
    const { elapsed_ms: _, ...rest } = (await rigUndoHandler.run({}, toolCtx)) as Record<
      string,
      unknown
    >;
    return rest;
  };

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

  test('undo steps back through annotate, promote and cluster too', async () => {
    rig.writes.annotateNode({ nodeId: alpha, note: 'auth boundary', rationale: 'note it' }, ctx);
    rig.writes.promoteHub(beta, 'beta matters', ctx);
    const cluster = rig.writes.clusterNodes(
      { memberIds: [alpha, beta], label: 'Greek', rationale: 'both letters' },
      ctx,
    );

    expect(((await undoTool()).undone as { kind: string }).kind).toBe('cluster');
    expect(((await undoTool()).undone as { kind: string }).kind).toBe('promote_hub');
    expect(((await undoTool()).undone as { kind: string }).kind).toBe('annotate');
    expect(rig.getNode(cluster)).toBeNull();
    expect(flags(beta).hub_explicit).toBe(0);
    expect(rig.getAnnotations(alpha)).toEqual([]);
  });

  test('undoing a promote restores the hub flags it replaced', () => {
    rig.database.adapter
      .prepare(`UPDATE nodes SET hub_explicit = 0, is_hub = 0, hubness = 0.125 WHERE id = ?`)
      .run(beta);
    const before = flags(beta);
    rig.writes.promoteHub(beta, 'beta matters', ctx);
    expect(flags(beta)).toEqual({ hub_explicit: 1, is_hub: 1, hubness: 0.3 });

    expect(rig.writes.undoLast(ctx)?.kind).toBe('promote_hub');
    expect(flags(beta)).toEqual(before);
  });

  test('a promote logged without prior flags is undone by clearing it and recomputing', () => {
    rig.database.adapter
      .prepare(`UPDATE nodes SET hub_explicit = 1, is_hub = 1, hubness = 0.85 WHERE id = ?`)
      .run(beta);
    // The payload promotes carried before they recorded `prev`.
    recordMutation(rig.database.adapter, {
      sessionId: ctx.sessionId,
      kind: 'promote_hub',
      payload: { id: beta, hubness: 0.85, rationale: 'beta matters' },
      actor: ctx.actor,
    });

    expect(rig.writes.undoLast(ctx)?.kind).toBe('promote_hub');
    // Two functions, neither with fanout or heat: no hub, hubness 0.
    expect(flags(beta)).toEqual({ hub_explicit: 0, is_hub: 0, hubness: 0 });
  });

  test('undoing an annotate removes that note only', () => {
    const keep = { nodeId: alpha, note: 'keep me', rationale: 'other session' };
    rig.writes.annotateNode(keep, { sessionId: 'agent-2', actor: 'ai:test' });
    rig.writes.annotateNode({ nodeId: alpha, note: 'drop me', rationale: 'note it' }, ctx);

    expect(rig.writes.undoLast(ctx)?.kind).toBe('annotate');
    expect(rig.getAnnotations(alpha).map((a) => a.note)).toEqual(['keep me']);
  });

  test('undoing a cluster removes the cluster node and its contains edges', () => {
    const contains = (): number =>
      count(`SELECT COUNT(*) AS n FROM edges WHERE kind = 'contains' AND provenance = 'ai:test'`);
    const cluster = rig.writes.clusterNodes(
      { memberIds: [alpha, beta], label: 'Greek', rationale: 'both letters' },
      ctx,
    );
    expect(contains()).toBe(2);

    expect(rig.writes.undoLast(ctx)?.kind).toBe('cluster');
    expect(rig.getNode(cluster)).toBeNull();
    expect(contains()).toBe(0);
    expect(rig.getNode(alpha)).not.toBeNull();
    expect(rig.getNode(beta)).not.toBeNull();
  });

  test('with nothing left, undo says so', async () => {
    expect(await undoTool()).toEqual({ undone: null, reason: 'nothing to undo' });
    rig.writes.addAlias({ nodeId: alpha, alias: 'aka', rationale: 'test alias' }, ctx);
    expect(((await undoTool()).undone as { kind: string }).kind).toBe('add_alias');
    expect(await undoTool()).toEqual({ undone: null, reason: 'nothing to undo' });
  });

  test('an inverse that cannot be applied is reported, not claimed, and skipped', async () => {
    rig.writes.addAlias({ nodeId: alpha, alias: 'aka', rationale: 'test alias' }, ctx);
    rig.writes.annotateNode({ nodeId: alpha, note: 'gone soon', rationale: 'note it' }, ctx);
    const annotate = rig.writes.mutationsSince(0, ctx.sessionId).at(-1)!;
    rig.database.adapter.prepare(`DELETE FROM annotations`).run();

    expect(await undoTool()).toEqual({
      undone: null,
      reason: expect.stringContaining('no longer exists'),
      failed: { id: annotate.id, kind: 'annotate', ts: annotate.ts },
    });
    expect(rig.writes.mutationsSince(0, ctx.sessionId).at(-1)?.payload).toMatchObject({
      undoneId: annotate.id,
      applied: false,
    });
    // The next undo moves on to the mutation before it.
    expect(((await undoTool()).undone as { kind: string }).kind).toBe('add_alias');
    expect(rig.getAliases(alpha)).toEqual([]);
  });

  test("a proposal someone else accepted can't be withdrawn until the accept is undone", async () => {
    const web = { sessionId: 'web', actor: 'user:web' };
    const pid = rig.writes.proposeEdge({ src: alpha, dst: beta, rationale: 'linked' }, ctx);
    rig.writes.acceptPending(pid, web);

    expect(await undoTool()).toMatchObject({
      undone: null,
      reason: `pending edge ${pid} was accepted since`,
      failed: { kind: 'propose_edge' },
    });
    expect(count(`SELECT COUNT(*) AS n FROM edges_semantic`)).toBe(1);
    // The web UI's own undo reverts its accept.
    expect(((await undoTool('web')).undone as { kind: string }).kind).toBe('accept_edge');
    expect(count(`SELECT COUNT(*) AS n FROM edges_semantic`)).toBe(0);
    expect(rig.writes.listPending().map((p) => p.id)).toEqual([pid]);
  });
});
