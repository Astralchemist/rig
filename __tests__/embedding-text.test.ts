// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { getEmbedding } from '@rig/core/db/embed-queries.ts';
import { embeddingHash, embeddingText } from '@rig/core/embed/index-embeddings.ts';
import { EXCERPT_MAX, extractMarkdown, sectionExcerpt } from '@rig/core/extract/markdown.ts';
import { ControlledEmbedder } from './_search-fixture.ts';

const W = { sessionId: 'embed-test', actor: 'ai:test' };

describe('embedding text', () => {
  test('code: identifier words, name, qualified name, signature, docstring', () => {
    const text = embeddingText({
      id: 'f',
      kind: 'method',
      name: 'refreshExpiredSessions',
      data: {
        qualifiedName: 'SessionStore.refreshExpiredSessions',
        signature: '(now: number): void',
        docstring: 'Renew what lapsed.',
      },
    });
    expect(text).toBe(
      [
        'refresh expired sessions',
        'refreshExpiredSessions',
        'SessionStore.refreshExpiredSessions',
        '(now: number): void',
        'Renew what lapsed.',
      ].join('\n'),
    );
  });

  test('waypoint: title, summary, key terms, rationale', () => {
    const text = embeddingText({
      id: 'w',
      kind: 'conversation-waypoint',
      name: 'Use token buckets',
      data: { summary: 'throttle per client', key_terms: ['rate', 'limit'], rationale: 'abuse' },
    });
    expect(text).toBe('Use token buckets\nthrottle per client\nrate, limit\nabuse');
  });

  test('skill: name as words, name, description', () => {
    const text = embeddingText({
      id: 'skill:rig_pull',
      kind: 'skill',
      name: 'rig_pull',
      data: { description: 'Rank related anchors', tier: 'light' },
    });
    expect(text).toBe('rig pull\nrig_pull\nRank related anchors');
  });

  test('markdown: heading, heading path, excerpt', () => {
    const text = embeddingText({
      id: 'm',
      kind: 'markdown-section',
      name: 'Install',
      data: { qualifiedName: 'Guide.Install', excerpt: 'Run the script.' },
    });
    expect(text).toBe('Install\nGuide.Install\nRun the script.');
  });

  test('the hash carries the text version of the node family', () => {
    const node = { id: 'x', kind: 'function', name: 'x', data: {} };
    expect(embeddingHash(node, 'x')).toMatch(/^c2:[0-9a-f]{16}$/);
    expect(embeddingHash({ ...node, kind: 'skill' }, 'x')).toMatch(/^s1:/);
    expect(embeddingHash({ ...node, kind: 'conversation-waypoint' }, 'x')).toMatch(/^w1:/);
    expect(embeddingHash({ ...node, kind: 'markdown-section' }, 'x')).toMatch(/^m2:/);
  });
});

describe('markdown excerpts', () => {
  test('a section keeps its own prose, without code, markup or subsections', () => {
    const md = [
      '# Guide',
      '',
      'Intro with `code` and a [link](http://x).',
      '',
      '```sh',
      'rm -rf /',
      '```',
      '- first item',
      '> quoted',
      '| a | b |',
      '|---|---|',
      '## Sub',
      'Sub body.',
    ].join('\n');
    const nodes = extractMarkdown('g.md', md).nodes;
    expect(nodes.map((n) => [n.name, n.excerpt])).toEqual([
      ['Guide', 'Intro with code and a link. first item quoted a b'],
      ['Sub', 'Sub body.'],
    ]);
  });

  test('capped at a word boundary; empty sections have none', () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const ex = sectionExcerpt(['# T', long], 1);
    expect(ex.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(long.startsWith(ex)).toBe(true);
    expect(long.charAt(ex.length)).toBe(' ');
    expect(extractMarkdown('e.md', '# A\n# B\n').nodes[0]!.excerpt).toBeUndefined();
  });
});

describe('embedding waypoints, skills and markdown', () => {
  let project: string;
  let rig: Rig;
  let embedder: ControlledEmbedder;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-embed-agent-'));
    writeFileSync(join(project, 'a.ts'), `export function alpha(): number { return 1; }\n`);
    writeFileSync(
      join(project, 'NOTES.md'),
      `# Notes\n\n## Rate limiting\n\nEach client gets a bucket; the API answers 429.\n`,
    );
    embedder = new ControlledEmbedder();
    rig = await Rig.init(project, { embedder });
    await rig.indexAll();
  });
  afterEach(() => {
    embedder.unblock();
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const drop = (title: string, summary: string): string =>
    rig.writes.dropWaypoint({ kind: 'decision', title, summary, rationale: 'test' }, W);

  test('a waypoint is embedded after its write commits, off the caller path', async () => {
    embedder.mode = 'hang';
    const id = drop('Use token buckets', 'throttle each client per window');
    // The write returned while the model was busy.
    expect(rig.getWaypoint(id)).not.toBeNull();
    expect(getEmbedding(rig.database.adapter, id)).toBeNull();
    embedder.unblock();
    await rig.whenIdle();
    expect(getEmbedding(rig.database.adapter, id)).not.toBeNull();
  });

  test('a failed background embed is healed by the next sync', async () => {
    embedder.mode = 'fail';
    const id = drop('Cache invoices', 'keep bills in memory');
    await rig.whenIdle();
    expect(getEmbedding(rig.database.adapter, id)).toBeNull();
    embedder.mode = 'ok';
    await rig.sync();
    expect(getEmbedding(rig.database.adapter, id)).not.toBeNull();
  });

  test('skills are embedded when seeded', async () => {
    rig.seedSkills([{ name: 'mailer', description: 'send a message to an account', tier: 'live' }]);
    await rig.whenIdle();
    expect(getEmbedding(rig.database.adapter, 'skill:mailer')).not.toBeNull();
    // Re-seeding the same description embeds nothing.
    const calls = embedder.calls;
    rig.seedSkills([{ name: 'mailer', description: 'send a message to an account', tier: 'live' }]);
    await rig.whenIdle();
    expect(embedder.calls).toBe(calls);
  });

  test('a stale embedding text version re-embeds just that node', async () => {
    const alpha = rig.searchNodes('alpha')[0]!;
    rig.database.adapter
      .prepare(`UPDATE embeddings SET text_hash = 'legacyhash' WHERE node_id = ?`)
      .run(alpha.id);
    const before = embedder.calls;
    await rig.sync();
    expect(embedder.calls - before).toBe(1);
    const { text_hash } = rig.database.adapter
      .prepare(`SELECT text_hash FROM embeddings WHERE node_id = ?`)
      .get(alpha.id) as { text_hash: string };
    expect(text_hash).toMatch(/^c2:[0-9a-f]{16}$/);
  });

  test('markdown sections are embedded and found by their body text', async () => {
    const [section] = rig.searchNodes('answers 429');
    expect(section!.name).toBe('Rate limiting');
    expect(section!.type).toBe('markdown-section');
    const { text_hash } = rig.database.adapter
      .prepare(`SELECT text_hash FROM embeddings WHERE node_id = ?`)
      .get(section!.id) as { text_hash: string };
    expect(text_hash).toMatch(/^m2:/);
  });
});
