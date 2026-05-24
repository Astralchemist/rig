import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';
import { runExportDocs } from '../packages/cli/src/export-docs-cmd.ts';

// Phase 4 B3 — markdown doc generation from waypoints.
describe('B3 rig export-docs', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-docs-'));
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    rig.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'Lock TS + Bun as stack',
        summary: 'bun:sqlite primary, better-sqlite3 fallback',
        analogy: 'The Sovereign move',
        keyTerms: ['bun', 'sqlite'],
        payloads: [
          { type: 'mermaid-diagram', content: 'graph TD; bun-->sqlite' },
          { type: 'code-snippet', lang: 'ts', content: 'import { Database } from "bun:sqlite";' },
        ],
      },
      { sessionId: 'test', actor: 'ai:test' },
    );
    rig.writes.dropWaypoint(
      {
        kind: 'principle',
        title: 'Local-first only',
        summary: 'Substrate must run offline; never a hosted service',
      },
      { sessionId: 'test', actor: 'ai:test' },
    );
    rig.writes.dropWaypoint(
      {
        kind: 'open-question',
        title: 'When to commit to sqlite-vec',
        summary: 'Empirical trigger at ~20k nodes',
      },
      { sessionId: 'test', actor: 'ai:test' },
    );
    rig.close();
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test('exports a navigable doc tree grouped by waypoint kind', async () => {
    const out = join(project, 'docs');
    process.argv = ['bun', 'rig', 'export-docs', '--out', out];
    await runExportDocs(project);

    // Top-level files
    const top = readdirSync(out).sort();
    expect(top).toContain('index.md');
    expect(top).toContain('decisions');
    expect(top).toContain('principles');
    expect(top).toContain('open-questions');

    // Each kind dir has its waypoint
    const decisions = readdirSync(join(out, 'decisions'));
    expect(decisions.length).toBe(1);
    expect(decisions[0]!).toMatch(/lock-ts-bun-as-stack\.md$/);

    // File content
    const decision = readFileSync(join(out, 'decisions', decisions[0]!), 'utf-8');
    expect(decision).toContain('# Lock TS + Bun as stack');
    expect(decision).toContain('**Analogy.** The Sovereign move');
    expect(decision).toContain('```mermaid');
    expect(decision).toContain('graph TD; bun-->sqlite');
    expect(decision).toContain('```ts');
    expect(decision).toContain('import { Database } from "bun:sqlite";');

    // Index links to each waypoint
    const index = readFileSync(join(out, 'index.md'), 'utf-8');
    expect(index).toContain('## decisions');
    expect(index).toContain('## principles');
    expect(index).toContain('## open-questions');
    expect(index).toContain('[Lock TS + Bun as stack]');
  });
});
