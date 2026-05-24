import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// Phase 5 C4 — skill anchors surfaced from the tools-manifest.
describe('C4 skill anchors', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-skill-'));
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('seedSkills creates one node per tool with deterministic id', () => {
    const n = rig.seedSkills([
      { name: 'rig_pull', description: 'rank related anchors', tier: 'light', records_activation: true },
      { name: 'rig_explore', description: 'heavy retrieval', tier: 'heavy' },
    ]);
    expect(n).toBe(2);

    const pull = rig.getNode('skill:rig_pull');
    expect(pull).toBeDefined();
    expect(pull!.type).toBe('skill');
    expect(pull!.name).toBe('rig_pull');

    const explore = rig.getNode('skill:rig_explore');
    expect(explore).toBeDefined();
    expect(explore!.type).toBe('skill');
  });

  test('re-seeding is idempotent and updates description on change', () => {
    rig.seedSkills([{ name: 'rig_pull', description: 'v1', tier: 'light' }]);
    const before = rig.getNode('skill:rig_pull');
    expect(before).toBeDefined();

    rig.seedSkills([{ name: 'rig_pull', description: 'v2 updated', tier: 'light' }]);
    // still exactly one skill node for rig_pull
    const all = rig.searchNodes('rig_pull').filter((n) => n.type === 'skill');
    expect(all.length).toBe(1);
    // data updated — pull via raw SELECT since getNode shape strips arbitrary keys
    const row = rig.database.adapter
      .prepare(`SELECT data FROM nodes WHERE id = ?`)
      .get('skill:rig_pull') as { data: string };
    const data = JSON.parse(row.data) as { description: string };
    expect(data.description).toBe('v2 updated');
  });

  test('skills are searchable by name via rig_search', () => {
    rig.seedSkills([
      { name: 'rig_pull', description: 'rank', tier: 'light' },
      { name: 'rig_search', description: 'find anchors', tier: 'light' },
    ]);
    const hits = rig.searchNodes('rig_pull');
    expect(hits.some((h) => h.type === 'skill' && h.name === 'rig_pull')).toBe(true);
  });
});
