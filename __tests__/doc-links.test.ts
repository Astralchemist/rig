// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';

// Step 2: docs link to the code they describe.
describe('doc links', () => {
  let dir: string;
  let rig: Rig;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rig-doclinks-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'docs'));
    writeFileSync(
      join(dir, 'src', 'parse.ts'),
      'export function parseConfig(s: string) { return s; }\n',
    );
    writeFileSync(
      join(dir, 'docs', 'guide.md'),
      [
        '# Guide',
        '',
        '## Parsing',
        '',
        'The [parser](../src/parse.ts#L1) reads it; call `parseConfig()` once.',
        'See [the site](https://example.com) and `true` and `config`.',
        '',
        '```ts',
        '`ignoredInCode()`',
        '```',
      ].join('\n'),
    );
    rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });
  afterAll(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const fromParsing = () =>
    rig.database.adapter
      .prepare(
        `SELECT (SELECT name FROM nodes WHERE id = e.dst) AS dst, e.provenance AS p FROM edges e
         WHERE e.src = (SELECT id FROM nodes WHERE type = 'markdown-section' AND name = 'Parsing')
         ORDER BY dst`,
      )
      .all();

  test('a link to a repo file and a code-like name become edges from the section', () => {
    expect(fromParsing()).toEqual([
      { dst: 'parseConfig', p: 'ast:name' },
      { dst: 'src/parse.ts', p: 'ast:link' },
    ]);
  });
});
