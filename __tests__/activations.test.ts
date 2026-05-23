import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import {
  decayedActivationScore,
  recordActivation,
} from '@rig/core/db/activation-queries.ts';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';
import { rigPullHandler } from '../generated/mcp/handlers/rig_pull.handler.ts';
import { makeActivationRecorder, type ToolContext } from '@rig/mcp/dispatch.ts';

// Phase 3.5 follow-up: the records_activation contract flag was previously
// inert; the dispatch ctx now carries a recordActivation closure that read
// tools call after a successful args.id lookup.

describe('activation recording', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-act-'));
    writeFileSync(join(project, 'a.ts'), `export function alpha(): void {}\n`);
    writeFileSync(join(project, 'b.ts'), `export function beta(): void {}\n`);
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const ctxOf = (): ToolContext => ({
    rig,
    sessionId: 'test',
    isMainSession: false,
    provenance: null,
    recordActivation: makeActivationRecorder(rig),
  });

  test('recordActivation appends to the activations table', () => {
    const node = rig.searchNodes('alpha')[0]!;
    recordActivation(rig.database.adapter, node.id, 'mcp');
    const rows = rig.database.adapter
      .prepare(`SELECT node_id, source FROM activations WHERE node_id = ?`)
      .all(node.id) as { node_id: string; source: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.source).toBe('mcp');
  });

  test('rig_pull handler records an activation on the queried anchor', async () => {
    const node = rig.searchNodes('alpha')[0]!;
    expect(
      rig.database.adapter
        .prepare(`SELECT COUNT(*) AS n FROM activations WHERE node_id = ?`)
        .get(node.id),
    ).toEqual({ n: 0 });

    await rigPullHandler.run({ id: node.id, k: 5 }, ctxOf());

    const after = rig.database.adapter
      .prepare(`SELECT COUNT(*) AS n FROM activations WHERE node_id = ?`)
      .get(node.id) as { n: number };
    expect(after.n).toBe(1);
  });

  test('decayed score reflects recent activity (fresh > old)', () => {
    const node = rig.searchNodes('alpha')[0]!;
    // 10 activations now, 10 from 30 days ago. Fresh batch should dominate.
    const now = Date.now();
    const insert = rig.database.adapter.prepare(
      `INSERT INTO activations (node_id, ts, source) VALUES (?, ?, 'mcp')`,
    );
    for (let i = 0; i < 10; i++) insert.run(node.id, now - i * 1000);
    for (let i = 0; i < 10; i++)
      insert.run(node.id, now - 30 * 24 * 60 * 60 * 1000 - i * 1000);
    const score = decayedActivationScore(rig.database.adapter, node.id, now);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});
