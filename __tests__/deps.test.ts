// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// Phase 3.5 A2 — package.json as first-class hub via declared-dependency anchors.
describe('A2 declared-dependency from package.json', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-deps-'));
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify(
        {
          name: 'demo',
          dependencies: { pandas: '2.1.4', lodash: '^4.17.21' },
          devDependencies: { '@types/node': '20.0.0' },
          peerDependencies: { react: '>=18' },
          optionalDependencies: { fsevents: '*' },
        },
        null,
        2,
      ),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('produces one declared-dependency node per dep with correct flags', () => {
    const deps = rig.getDependencies();
    const byName = new Map(deps.map((d) => [d.name, d]));
    expect(byName.size).toBe(5);

    expect(byName.get('pandas')).toMatchObject({ spec: '2.1.4', is_dev: false, source: 'npm' });
    expect(byName.get('lodash')).toMatchObject({ spec: '^4.17.21', is_dev: false });
    expect(byName.get('@types/node')).toMatchObject({ is_dev: true });
    expect(byName.get('react')).toMatchObject({ is_peer: true });
    expect(byName.get('fsevents')).toMatchObject({ is_optional: true });
  });

  test('manifest_path filter narrows to one manifest', () => {
    const all = rig.getDependencies();
    const filtered = rig.getDependencies('package.json');
    expect(filtered.length).toBe(all.length);
    const nonexistent = rig.getDependencies('other/package.json');
    expect(nonexistent.length).toBe(0);
  });

  test('searchNodes finds a declared-dependency by name', () => {
    const hits = rig.searchNodes('pandas').filter((n) => n.type === 'declared-dependency');
    expect(hits.length).toBe(1);
    expect(hits[0]!.name).toBe('pandas');
  });

  test('manifest_declares edge connects the package.json file node to each dep', () => {
    const pandas = rig
      .searchNodes('pandas')
      .find((n) => n.type === 'declared-dependency');
    expect(pandas).toBeDefined();
    const incoming = rig
      .getNeighbors(pandas!.id)
      .filter((e) => e.kind === 'manifest_declares');
    expect(incoming.length).toBe(1);
  });
});
