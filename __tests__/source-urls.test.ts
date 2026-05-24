import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// E1 — pending edges can carry web-validation evidence URLs.
describe('E1 source_urls on pending edges', () => {
  let project: string;
  let rig: Rig;
  let aId: string;
  let bId: string;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-srcurl-'));
    writeFileSync(join(project, 'a.ts'), 'export function alpha(): void {}\n');
    writeFileSync(join(project, 'b.ts'), 'export function beta(): void {}\n');
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    aId = rig.searchNodes('alpha').find((n) => n.type === 'function')!.id;
    bId = rig.searchNodes('beta').find((n) => n.type === 'function')!.id;
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('proposeEdge stores source_urls; listPending reads them back', () => {
    const pid = rig.writes.proposeEdge(
      {
        src: aId,
        dst: bId,
        kind: 'related',
        rationale: 'shared abstraction documented externally',
        sourceUrls: ['https://example.com/docs/x', 'https://example.com/api/y'],
      },
      { sessionId: 'test', actor: 'ai:test' },
    );
    expect(pid).toBeGreaterThan(0);
    const pending = rig.writes.listPending();
    const row = pending.find((p) => p.id === pid)!;
    expect(row.source_urls).toEqual([
      'https://example.com/docs/x',
      'https://example.com/api/y',
    ]);
  });

  test('proposeEdge without source_urls returns empty array', () => {
    const pid = rig.writes.proposeEdge(
      { src: aId, dst: bId, rationale: 'no evidence yet, just a hunch' },
      { sessionId: 'test', actor: 'ai:test' },
    );
    const row = rig.writes.listPending().find((p) => p.id === pid)!;
    expect(row.source_urls).toEqual([]);
  });

  test('mutation_log records source_urls in payload', () => {
    rig.writes.proposeEdge(
      {
        src: aId,
        dst: bId,
        rationale: 'evidence-backed',
        sourceUrls: ['https://example.com/x'],
      },
      { sessionId: 'test', actor: 'ai:test' },
    );
    const muts = rig.writes.mutationsSince(0, 'test');
    const prop = muts.find((m) => m.kind === 'propose_edge')!;
    const payload = prop.payload as Record<string, unknown>;
    expect(payload.source_urls).toEqual(['https://example.com/x']);
  });
});
