// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { Database as BunSqlite } from 'bun:sqlite';
import { pprRerank } from '../packages/core/src/search/ppr.ts';

// Step 3: relevance spreads from the hits; hubs are damped.
const db = (edges: [string, string][]) => {
  const raw = new BunSqlite(':memory:');
  raw.exec('CREATE TABLE edges (src TEXT, dst TEXT, kind TEXT)');
  const ins = raw.prepare(`INSERT INTO edges VALUES (?, ?, 'calls')`);
  for (const [a, b] of edges) ins.run(a, b);
  return raw as never;
};

describe('pprRerank', () => {
  test('a node next to two good hits rises above a lone weak hit', () => {
    const g = db([
      ['a', 'shared'],
      ['b', 'shared'],
    ]);
    const out = pprRerank(g, [
      { id: 'a', score: 1 },
      { id: 'b', score: 0.9 },
      { id: 'lonely', score: 0.3 },
    ]).map((x) => x.id);
    expect(out.indexOf('shared')).toBeLessThan(out.indexOf('lonely'));
  });

  test('a hub connected to everything is damped below a specific neighbour', () => {
    const edges: [string, string][] = [
      ['a', 'specific'],
      ['b', 'specific'],
    ];
    for (let i = 0; i < 40; i++) edges.push(['hub', `x${i}`]);
    edges.push(['a', 'hub'], ['b', 'hub']);
    const out = pprRerank(db(edges), [
      { id: 'a', score: 1 },
      { id: 'b', score: 1 },
    ]).map((x) => x.id);
    expect(out.indexOf('specific')).toBeLessThan(out.indexOf('hub'));
  });

  test('no hits, no change', () => {
    expect(pprRerank(db([]), [])).toEqual([]);
  });
});
