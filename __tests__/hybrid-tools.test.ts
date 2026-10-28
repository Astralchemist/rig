// SPDX-License-Identifier: Apache-2.0
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { getEmbedding } from '@rig/core/db/embed-queries.ts';
import type { ToolContext } from '@rig/mcp/dispatch.ts';
import { rigContextHandler } from '../generated/mcp/handlers/rig_context.handler.ts';
import { rigExploreHandler } from '../generated/mcp/handlers/rig_explore.handler.ts';
import { rigRelevantSkillsHandler } from '../generated/mcp/handlers/rig_relevant_skills.handler.ts';
import { rigSearchHandler } from '../generated/mcp/handlers/rig_search.handler.ts';
import { rigWaypointsHandler } from '../generated/mcp/handlers/rig_waypoints.handler.ts';
import { ConceptEmbedder, ControlledEmbedder, writeFixture } from './_search-fixture.ts';

const ctxOf = (rig: Rig): ToolContext => ({
  rig,
  sessionId: 'hybrid-test',
  provenance: 'ai:test',
  recordActivation: () => {},
});
const W = { sessionId: 'hybrid-test', actor: 'ai:test' };

describe('waypoints and skills ranked by relevance', () => {
  let project: string;
  let rig: Rig;
  let embedder: ControlledEmbedder;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-rank-agent-'));
    writeFileSync(join(project, 'a.ts'), `export function alpha(): number { return 1; }\n`);
    embedder = new ControlledEmbedder();
    rig = await Rig.init(project, { embedder });
    await rig.indexAll();
  });
  afterEach(() => {
    embedder.unblock();
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const drop = (title: string, summary: string, keyTerms: string[] = []): string =>
    rig.writes.dropWaypoint({ kind: 'decision', title, summary, keyTerms, rationale: 'eval' }, W);

  test('rig_waypoints ranks by relevance when given a query', async () => {
    drop('Lazy refunds', 'reimburse the buyer when the charge settles', ['refund']);
    drop('Throttle clients', 'rate limit with a token bucket per window', ['throttle']);
    drop('Retry policy', 'back off and try network calls again', ['backoff']);
    await rig.whenIdle();
    const ctx = ctxOf(rig);
    const recent = (await rigWaypointsHandler.run({ limit: 3 }, ctx)) as {
      waypoints: { title: string }[];
    };
    expect(recent.waypoints[0]!.title).toBe('Retry policy');
    const ranked = (await rigWaypointsHandler.run({ query: 'refund a customer' }, ctx)) as {
      waypoints: { title: string }[];
      degraded?: string;
    };
    expect(ranked.degraded).toBeUndefined();
    expect(ranked.waypoints[0]!.title).toBe('Lazy refunds');
  });

  test('rig_relevant_skills ranks skills by their descriptions', async () => {
    rig.seedSkills([
      { name: 'rig_pull', description: 'rank related anchors', tier: 'light' },
      { name: 'web_fetch', description: 'download a picture or page', tier: 'live' },
      { name: 'mailer', description: 'send a message to an account', tier: 'live' },
    ]);
    await rig.whenIdle();
    expect(getEmbedding(rig.database.adapter, 'skill:mailer')).not.toBeNull();
    const r = (await rigRelevantSkillsHandler.run(
      { query: 'email the user', k: 2 },
      ctxOf(rig),
    )) as {
      skills: { name: string }[];
    };
    expect(r.skills[0]!.name).toBe('mailer');
  });

  test('rig_waypoints with a query says when it ran without vectors', async () => {
    drop('Retry policy', 'back off and try network calls again', ['backoff']);
    await rig.whenIdle();
    embedder.mode = 'fail';
    const r = (await rigWaypointsHandler.run({ query: 'retry network calls' }, ctxOf(rig))) as {
      waypoints: { title: string }[];
      degraded?: string;
    };
    expect(r.degraded).toBe('keyword-only');
    expect(r.waypoints.map((w) => w.title)).toEqual(['Retry policy']);
  });
});

describe('MCP tools on hybrid search', () => {
  let project: string;
  let rig: Rig;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-hybrid-mcp-'));
    writeFixture(project);
    rig = await Rig.init(project, { embedder: new ConceptEmbedder() });
    await rig.indexAll();
    rig.seedSkills([{ name: 'rig_search', description: 'find anchors', tier: 'light' }]);
    await rig.whenIdle();
  });
  afterAll(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('rig_search returns score and matched_by per node', async () => {
    const r = (await rigSearchHandler.run({ query: 'issueRefund' }, ctxOf(rig))) as {
      nodes: {
        name: string;
        kind: string;
        file_path?: string;
        score: number;
        matched_by: string[];
      }[];
      degraded?: string;
    };
    expect(r.degraded).toBeUndefined();
    expect(r.nodes[0]).toMatchObject({
      name: 'issueRefund',
      kind: 'function',
      file_path: 'src/billing/refund.ts',
      matched_by: ['name', 'keyword', 'vector'],
    });
    expect(r.nodes[0]!.score).toBeGreaterThan(r.nodes[1]!.score);
    // Field order of a node ref is unchanged, the new ones appended.
    expect(Object.keys(r.nodes[0]!)).toEqual([
      'id',
      'name',
      'kind',
      'file_path',
      'score',
      'matched_by',
    ]);
  });

  test('rig_context and rig_explore find anchors for a plain-language task', async () => {
    const c = (await rigContextHandler.run(
      { task: 'make thumbnails smaller', max_nodes: 3 },
      ctxOf(rig),
    )) as {
      context: string;
      anchor_count: number;
    };
    expect(c.anchor_count).toBeGreaterThan(0);
    expect(c.context).toContain('export function shrinkImage');
    const e = (await rigExploreHandler.run(
      { question: 'how much does a buyer owe?' },
      ctxOf(rig),
    )) as {
      anchors: { name: string; file_path: string }[];
    };
    expect(e.anchors.map((a) => a.name)).toContain('computeInvoiceTotal');
    // Skills and waypoints have no source to bundle.
    const s = (await rigContextHandler.run({ task: 'rig_search', format: 'json' }, ctxOf(rig))) as {
      context: string;
    };
    expect(s.context).not.toContain('skill:rig_search');
  });
});
