// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// Phase 5 D4 — skill-relevance selection via the same retrieval substrate.
describe('D4 rig_relevant_skills', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-rel-skill-'));
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    rig.seedSkills([
      { name: 'rig_pull', description: 'rank related anchors', tier: 'light' },
      { name: 'rig_neighbors', description: 'list incident edges', tier: 'light' },
      { name: 'rig_search', description: 'find anchors by name', tier: 'light' },
      {
        name: 'browser_fetch',
        description: 'fetch a web page and return its content',
        tier: 'live',
      },
      {
        name: 'web_search',
        description: 'search the public web for a query',
        tier: 'live',
      },
    ]);
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('returns skills matching the query', () => {
    const hits = rig.getRelevantSkills('pull');
    const names = hits.map((s) => s.name);
    expect(names).toContain('rig_pull');
  });

  test('returns full payload (tier + description) per skill', () => {
    const hits = rig.getRelevantSkills('pull', 1);
    expect(hits.length).toBe(1);
    expect(hits[0]!.tier).toBe('light');
    expect(hits[0]!.description.length).toBeGreaterThan(0);
  });

  test('respects k limit', () => {
    const hits = rig.getRelevantSkills('rig', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  test('empty query returns no results', () => {
    expect(rig.getRelevantSkills('')).toEqual([]);
  });
});
