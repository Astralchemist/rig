// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';

describe('FTS5 search + sync purge (Phase 1.6 fixes)', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'rig-search-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  const writeFixture = (name: string, body: string): void =>
    writeFileSync(join(project, name), body);

  test('FTS5 returns prefix matches via trigger-populated nodes_fts', async () => {
    writeFixture(
      'auth.ts',
      `export class AuthStore {
  login(user: string): void { console.log(user); }
}`,
    );
    writeFixture(
      'cart.ts',
      `export class ShoppingCart {
  add(item: string): void { console.log(item); }
}`,
    );

    const rig = await Rig.init(project);
    await rig.indexAll();

    const exact = rig.searchNodes('AuthStore');
    expect(exact.some((n) => n.name === 'AuthStore')).toBe(true);

    const prefix = rig.searchNodes('Shopp');
    expect(prefix.some((n) => n.name === 'ShoppingCart')).toBe(true);

    const empty = rig.searchNodes('zzznotreal');
    expect(empty).toEqual([]);

    const filtered = rig.searchNodes('login', { kind: 'method' });
    expect(filtered.length).toBeGreaterThan(0);
    rig.close();
  });

  test('sync purges nodes for deleted files; FTS5 entries vanish too', async () => {
    writeFixture('a.ts', 'export function alpha(): number { return 1; }');
    writeFixture('b.ts', 'export function beta(): number { return 2; }');

    const rig = await Rig.init(project);
    await rig.indexAll();

    const beforeNodes = (await rig.status()).nodes;
    expect(rig.searchNodes('beta').some((n) => n.name === 'beta')).toBe(true);

    unlinkSync(join(project, 'b.ts'));
    const result = await rig.sync();

    expect(result.filesPurged).toBe(1);
    const afterNodes = (await rig.status()).nodes;
    expect(afterNodes).toBeLessThan(beforeNodes);
    expect(rig.searchNodes('beta')).toEqual([]);
    rig.close();
  });
});
