// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import {
  loadAllFileArtifacts,
  replaceFileArtifacts,
} from '../packages/core/src/db/file-artifacts.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import type { Edge, UnresolvedReference } from '../packages/core/src/extract/upstream-types.ts';
import * as resolver from '../packages/core/src/resolve/resolver.ts';

// The structural-edge rebuild reads each file's refs and direct edges back
// from file_refs / file_edges instead of re-extracting, so the stored
// artifacts must carry every field an extractor emits, including fields this
// version does not know about yet.
describe('per-file extraction artifacts', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-artifacts-'));
    writeFileSync(join(project, 'b.ts'), `export function helper(): number { return 2; }\n`);
    writeFileSync(
      join(project, 'a.ts'),
      `import { helper } from './b';\nexport function main(): number { return helper(); }\n`,
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const storedFor = <T>(table: 'file_refs' | 'file_edges', path: string): T[] =>
    (
      rig.database.adapter
        .prepare(`SELECT payload FROM ${table} WHERE path = ? ORDER BY rowid`)
        .all(path) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as T);

  test('refs keep everything the extractor emitted', () => {
    const call = storedFor<UnresolvedReference>('file_refs', 'a.ts').find(
      (r) => r.referenceKind === 'calls',
    );
    expect(call).toMatchObject({
      referenceName: 'helper',
      filePath: 'a.ts',
      language: 'typescript',
      line: 2,
    });
    expect(typeof call!.column).toBe('number');
  });

  test('fields unknown to this version reach the resolver through store and rebuild', async () => {
    const db = rig.database.adapter;
    const future = { importedNames: ['helper'], alias: 'h', futureField: { nested: [1, 2] } };
    const refs = storedFor<UnresolvedReference>('file_refs', 'a.ts').map(
      (r) => ({ ...r, ...future }) as UnresolvedReference,
    );
    const edges = storedFor<Edge>('file_edges', 'a.ts').map(
      (e) => ({ ...e, metadata: { via: 'test' }, provenance: 'heuristic', ...future }) as Edge,
    );
    db.transaction(() => replaceFileArtifacts(db, 'a.ts', refs, edges))();

    const loaded = loadAllFileArtifacts(db);
    expect(loaded.refs.filter((r) => r.filePath === 'a.ts')).toEqual(refs);
    expect(loaded.edges).toEqual(expect.arrayContaining(edges));

    // An update elsewhere rebuilds every file's edges from the stored a.ts
    // artifacts (a.ts itself is unchanged and not re-extracted).
    const spy = spyOn(resolver, 'resolveReferences');
    try {
      writeFileSync(
        join(project, 'b.ts'),
        `// touched\nexport function helper(): number { return 2; }\n`,
      );
      expect((await rig.sync()).filesChanged).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
      const [, , passedRefs, passedEdges] = spy.mock.calls[0]!;
      expect(passedRefs.filter((r) => r.filePath === 'a.ts')).toEqual(refs);
      expect(passedEdges).toEqual(expect.arrayContaining(edges));
    } finally {
      spy.mockRestore();
    }
  });
});
