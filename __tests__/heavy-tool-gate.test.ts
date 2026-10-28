// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import type { ToolContext } from '../packages/mcp/src/dispatch.ts';
import { rigContextHandler } from '../generated/mcp/handlers/rig_context.handler.ts';
import { rigExploreHandler } from '../generated/mcp/handlers/rig_explore.handler.ts';
import { rigStatusHandler } from '../generated/mcp/handlers/rig_status.handler.ts';

const ROOT = resolve(__dirname, '..');

// MCP can't tell a main session from a sub-agent, so there is no main-session
// gate: 'heavy' is tier metadata and heavy tools run from any session.
describe('heavy-tool tier (no main-session gate)', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-heavy-'));
    writeFileSync(join(project, 'auth.ts'), `export class AuthStore {\n  login(): void {}\n}\n`);
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({
    rig,
    sessionId: 'test',
    provenance: null,
    recordActivation: () => {},
  });

  test('rig_explore runs and returns anchors with source', async () => {
    const result = (await rigExploreHandler.run({ question: 'AuthStore' }, ctx())) as {
      anchors: { name: string; source: string }[];
    };
    const store = result.anchors.find((a) => a.name === 'AuthStore');
    expect(store?.source).toContain('class AuthStore');
  });

  test('rig_context runs and returns a bundle', async () => {
    const result = (await rigContextHandler.run({ task: 'AuthStore' }, ctx())) as {
      context: string;
      anchor_count: number;
    };
    expect(result.anchor_count).toBeGreaterThan(0);
    expect(result.context).toContain('class AuthStore');
  });

  test('heavy handlers keep the tier but no longer emit the gate', () => {
    expect(rigExploreHandler.tier).toBe('heavy');
    expect(rigContextHandler.tier).toBe('heavy');
    for (const name of ['rig_explore', 'rig_context']) {
      const src = readFileSync(join(ROOT, 'generated/mcp/handlers', `${name}.handler.ts`), 'utf-8');
      expect(src).not.toContain('MAIN_SESSION_FORBIDDEN');
    }
  });

  test('rig_status (light tier) still runs', async () => {
    const result = (await rigStatusHandler.run({}, ctx())) as { initialized: boolean };
    expect(result.initialized).toBe(true);
  });
});
