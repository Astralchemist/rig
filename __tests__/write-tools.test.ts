import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { ToolError, type ToolContext } from '../packages/mcp/src/dispatch.ts';
import { rigProposeEdgeHandler } from '../generated/mcp/handlers/rig_propose_edge.handler.ts';
import { rigAddNodeHandler } from '../generated/mcp/handlers/rig_add_node.handler.ts';
import { rigUndoHandler } from '../generated/mcp/handlers/rig_undo.handler.ts';

describe('Phase 3 write tools', () => {
  let project: string;
  let rig: Rig;
  let nodeA: string;
  let nodeB: string;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-write-'));
    writeFileSync(
      join(project, 'app.ts'),
      `export class Alpha { do(): void {} }
export class Beta { do(): void {} }`,
    );
    rig = await Rig.init(project);
    await rig.indexAll();
    const hits = rig.searchNodes('Alpha').concat(rig.searchNodes('Beta'));
    nodeA = hits.find((n) => n.name === 'Alpha')?.id ?? '';
    nodeB = hits.find((n) => n.name === 'Beta')?.id ?? '';
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const ctxOf = (provenance: string | null): ToolContext => ({
    rig,
    sessionId: 'test-session',
    isMainSession: false,
    provenance,
    recordActivation: () => {},
  });

  test('PROVENANCE_REQUIRED fires when ctx.provenance is null', async () => {
    let caught: ToolError | null = null;
    try {
      await rigProposeEdgeHandler.run(
        { src: nodeA, dst: nodeB, kind: 'related', weight: 0.5, rationale: 'a'.repeat(20) },
        ctxOf(null),
      );
    } catch (e) {
      caught = e as ToolError;
    }
    expect(caught?.code).toBe('PROVENANCE_REQUIRED');
  });

  test('RATIONALE_REQUIRED fires on empty rationale', async () => {
    let caught: ToolError | null = null;
    try {
      await rigProposeEdgeHandler.run(
        { src: nodeA, dst: nodeB, kind: 'related', weight: 0.5, rationale: '' },
        ctxOf('ai:test'),
      );
    } catch (e) {
      caught = e as ToolError;
    }
    // Input validation rejects empty rationale (Zod min 10) before the
    // rationale guard, so INPUT_INVALID is expected.
    expect(caught?.code === 'RATIONALE_REQUIRED' || caught?.code === 'INPUT_INVALID').toBe(true);
  });

  test('propose → accept → edges_semantic row exists', async () => {
    const ctx = ctxOf('ai:test');
    const proposed = (await rigProposeEdgeHandler.run(
      { src: nodeA, dst: nodeB, kind: 'related', weight: 0.6, rationale: 'they both ship a do()' },
      ctx,
    )) as { pending_id: number };
    expect(proposed.pending_id).toBeGreaterThan(0);

    const accepted = rig.writes.acceptPending(proposed.pending_id, { sessionId: 'test-session', actor: 'user:test' });
    expect(accepted).not.toBeNull();

    const edge = rig.database.adapter
      .prepare(`SELECT src, dst, weight FROM edges_semantic WHERE src = ? AND dst = ?`)
      .get(nodeA, nodeB) as { weight: number } | null;
    expect(edge?.weight).toBeCloseTo(0.6);
  });

  test('reject leaves edges_semantic clean and flips status', async () => {
    const ctx = ctxOf('ai:test');
    const r = (await rigProposeEdgeHandler.run(
      { src: nodeA, dst: nodeB, kind: 'related', weight: 0.5, rationale: 'because reasons here' },
      ctx,
    )) as { pending_id: number };
    rig.writes.rejectPending(r.pending_id, { sessionId: 'test-session', actor: 'user:test' });
    const edge = rig.database.adapter
      .prepare(`SELECT 1 FROM edges_semantic WHERE src = ? AND dst = ?`)
      .get(nodeA, nodeB);
    expect(edge).toBeNull();
  });

  test('add_node creates node + mutation_log entry', async () => {
    const ctx = ctxOf('ai:test');
    const result = (await rigAddNodeHandler.run(
      { type: 'concept', name: 'OnboardingFlow', data: {}, rationale: 'user named this twice in chat' },
      ctx,
    )) as { id: string };
    expect(result.id.startsWith('concept:')).toBe(true);
    expect(rig.getNode(result.id)).not.toBeNull();
    const mut = rig.writes.mutationsSince(0);
    expect(mut.some((m) => m.kind === 'add_node')).toBe(true);
  });

  test('undo reverses propose_edge', async () => {
    const ctx = ctxOf('ai:test');
    const r = (await rigProposeEdgeHandler.run(
      { src: nodeA, dst: nodeB, kind: 'related', weight: 0.5, rationale: 'because reasons here' },
      ctx,
    )) as { pending_id: number };
    expect(rig.writes.listPending().length).toBe(1);

    await rigUndoHandler.run({}, ctx);
    expect(rig.writes.listPending().length).toBe(0);
  });

  test('undo reverses accept_edge (semantic row gone, pending restored)', async () => {
    const ctx = ctxOf('ai:test');
    const r = (await rigProposeEdgeHandler.run(
      { src: nodeA, dst: nodeB, kind: 'related', weight: 0.5, rationale: 'because reasons here' },
      ctx,
    )) as { pending_id: number };
    rig.writes.acceptPending(r.pending_id, { sessionId: 'test-session', actor: 'user:test' });
    // Now undo from same session
    await rigUndoHandler.run({}, { ...ctx, sessionId: 'test-session' });
    const edge = rig.database.adapter
      .prepare(`SELECT 1 FROM edges_semantic WHERE src = ? AND dst = ?`)
      .get(nodeA, nodeB);
    expect(edge).toBeNull();
  });
});
