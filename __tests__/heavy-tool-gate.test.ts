import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { ToolError, type ToolContext } from '../packages/mcp/src/dispatch.ts';
import { rigExploreHandler } from '../generated/mcp/handlers/rig_explore.handler.ts';
import { rigStatusHandler } from '../generated/mcp/handlers/rig_status.handler.ts';

describe('heavy-tool tier guard', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-heavy-'));
    rig = await Rig.init(project);
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const makeCtx = (isMainSession: boolean): ToolContext => ({
    rig,
    sessionId: 'test',
    isMainSession,
    provenance: null,
    recordActivation: () => {},
  });

  test('rig_explore throws MAIN_SESSION_FORBIDDEN from main session', async () => {
    let caught: ToolError | null = null;
    try {
      await rigExploreHandler.run({ question: 'foo' }, makeCtx(true));
    } catch (e) {
      caught = e as ToolError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('MAIN_SESSION_FORBIDDEN');
  });

  test('rig_explore passes the gate from a sub-agent session', async () => {
    const result = (await rigExploreHandler.run(
      { question: 'foo', max_anchors: 1 },
      makeCtx(false),
    )) as { anchors: unknown[] };
    expect(Array.isArray(result.anchors)).toBe(true);
  });

  test('rig_status is exempt from the gate (light tier)', async () => {
    const result = (await rigStatusHandler.run({}, makeCtx(true))) as {
      initialized: boolean;
    };
    expect(result.initialized).toBe(true);
  });
});
