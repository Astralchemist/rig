import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// Phase 3.5 A3 — aliases.
describe('A3 aliases', () => {
  let project: string;
  let rig: Rig;
  let nodeId: string;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-aliases-'));
    writeFileSync(join(project, 'lib.ts'), `export function pandas(): void {}\n`);
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const hit = rig.searchNodes('pandas').find((n) => n.type === 'function');
    expect(hit).toBeDefined();
    nodeId = hit!.id;
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('addAlias persists with provenance, listAliases returns it', () => {
    const ok = rig.writes.addAlias(
      { nodeId, alias: 'pd', rationale: 'common idiomatic alias for pandas' },
      { sessionId: 'test', actor: 'user:test' },
    );
    expect(ok).toBe(true);

    const rows = rig.getAliases(nodeId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.alias).toBe('pd');
    expect(rows[0]!.provenance).toBe('user:test');
  });

  test('re-adding same alias returns added=false (idempotent)', () => {
    rig.writes.addAlias(
      { nodeId, alias: 'pd', rationale: 'first add' },
      { sessionId: 'test', actor: 'user:test' },
    );
    const second = rig.writes.addAlias(
      { nodeId, alias: 'pd', rationale: 'second add — should be no-op' },
      { sessionId: 'test', actor: 'user:test' },
    );
    expect(second).toBe(false);
  });

  test('searching for an alias resolves to the canonical node', () => {
    rig.writes.addAlias(
      { nodeId, alias: 'pd', rationale: 'idiomatic pandas alias' },
      { sessionId: 'test', actor: 'user:test' },
    );
    const hits = rig.searchNodes('pd');
    expect(hits.some((h) => h.id === nodeId)).toBe(true);
  });

  test('undo reverses the alias insert', () => {
    rig.writes.addAlias(
      { nodeId, alias: 'pd', rationale: 'will be undone' },
      { sessionId: 'undo-test', actor: 'user:test' },
    );
    expect(rig.getAliases(nodeId).length).toBe(1);
    const undone = rig.writes.undoLast({ sessionId: 'undo-test', actor: 'user:test' });
    expect(undone?.kind).toBe('add_alias');
    expect(rig.getAliases(nodeId).length).toBe(0);
  });

  test('alias on a non-existent node returns false', () => {
    const ok = rig.writes.addAlias(
      { nodeId: 'nope:does-not-exist', alias: 'x', rationale: 'should fail silently' },
      { sessionId: 'test', actor: 'user:test' },
    );
    expect(ok).toBe(false);
  });
});
