// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rigStatusHandler } from '../generated/mcp/handlers/rig_status.handler.ts';
import { Rig } from '../packages/core/src/index.ts';
import { recordActivation } from '../packages/core/src/db/activation-queries.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import type { ToolContext } from '../packages/mcp/src/dispatch.ts';

// status used to report MAX(activations.ts) as last_sync_ts: any tool call
// moved it, and an index or sync did not.
describe('status: last index and sync time', () => {
  let project: string;
  let rig: Rig;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-status-ts-'));
    writeFileSync(join(project, 'a.ts'), 'export function alpha(): void {}\n');
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('both are null before the first index', async () => {
    expect(await rig.status()).toMatchObject({ last_sync_ts: null, last_index_ts: null });
  });

  test('last_sync_ts is the last index or sync, not the newest activation', async () => {
    const t0 = Date.now();
    await rig.indexAll();
    const indexed = await rig.status();
    expect(indexed.last_index_ts).toBeGreaterThanOrEqual(t0);
    expect(indexed.last_index_ts).toBeLessThanOrEqual(Date.now());
    expect(indexed.last_sync_ts).toBe(indexed.last_index_ts);

    // A tool touching a node is not a sync.
    await sleep(5);
    recordActivation(rig.database.adapter, rig.searchNodes('alpha')[0]!.id, 'mcp');
    expect((await rig.status()).last_sync_ts).toBe(indexed.last_index_ts);

    // A sync counts even when no file changed: the graph was checked.
    await sleep(5);
    const t1 = Date.now();
    await rig.sync();
    const synced = await rig.status();
    expect(synced.last_sync_ts).toBeGreaterThanOrEqual(t1);
    expect(synced.last_index_ts).toBe(indexed.last_index_ts);

    // A sync that applies a change counts too.
    await sleep(5);
    const t2 = Date.now();
    writeFileSync(join(project, 'b.ts'), 'export function beta(): void {}\n');
    await rig.sync();
    expect((await rig.status()).last_sync_ts).toBeGreaterThanOrEqual(t2);

    // rig_status (and /api/status, which serves rig.status()) report both.
    const ctx: ToolContext = {
      rig,
      sessionId: 'test',
      provenance: null,
      recordActivation: () => {},
    };
    const tool = (await rigStatusHandler.run({}, ctx)) as Record<string, unknown>;
    expect(tool).toMatchObject({
      last_sync_ts: (await rig.status()).last_sync_ts,
      last_index_ts: indexed.last_index_ts,
    });
  });
});
