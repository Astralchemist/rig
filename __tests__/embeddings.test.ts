// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { getEmbedding } from '../packages/core/src/db/embed-queries.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';

describe('embeddings wiring', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'rig-embed-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test('indexAll populates the embeddings table with the default embedder', async () => {
    writeFileSync(
      join(project, 'a.ts'),
      `export class AuthStore { login(): void {} }`,
    );
    const rig = await Rig.init(project);
    await rig.indexAll();
    const hits = rig.searchNodes('AuthStore');
    expect(hits.length).toBeGreaterThan(0);

    const vector = getEmbedding(rig.database.adapter, hits[0]!.id);
    expect(vector).not.toBeNull();
    expect(vector?.length).toBe(384);
    rig.close();
  });

  test('magnetic pull semantic component is non-zero after indexAll', async () => {
    writeFileSync(
      join(project, 'auth.ts'),
      `export class AuthStore { login(): void {} }`,
    );
    writeFileSync(
      join(project, 'cart.ts'),
      `export class ShoppingCart { checkout(): void {} }`,
    );
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const anchor = rig.searchNodes('AuthStore').find((n) => n.name === 'AuthStore');
    expect(anchor).toBeDefined();
    const pulls = rig.getMagneticPull(anchor!.id, 5);
    // With at least one other embedded node, the semantic component should
    // contribute *something* non-zero for some candidate.
    const anyNonZeroSemantic = pulls.some((p) => p.components.semantic > 0);
    expect(anyNonZeroSemantic).toBe(true);
    rig.close();
  });

  test('sync re-embeds nodes from changed files', async () => {
    writeFileSync(join(project, 'a.ts'), `export function alpha(): number { return 1; }`);
    const rig = await Rig.init(project);
    await rig.indexAll();
    const alpha = rig.searchNodes('alpha').find((n) => n.name === 'alpha');
    expect(alpha).toBeDefined();
    const before = getEmbedding(rig.database.adapter, alpha!.id);
    expect(before).not.toBeNull();

    // Change the file's signature → text hash differs → re-embed
    writeFileSync(
      join(project, 'a.ts'),
      `export function alpha(name: string): number { return name.length; }`,
    );
    await rig.sync();
    const reAlpha = rig.searchNodes('alpha').find((n) => n.name === 'alpha');
    const after = getEmbedding(rig.database.adapter, reAlpha!.id);
    expect(after).not.toBeNull();
    rig.close();
  });
});
