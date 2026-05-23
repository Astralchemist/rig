import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// Regression test: when a file's content shifts (e.g. adding imports above a
// class declaration), the class's startLine moves and produces a new
// position-keyed node id. Prior behavior left the old node in place; index
// and sync now purge nodes for the file before re-extract.

describe('stale-node dedup on re-extract', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'rig-purge-'));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const countWidget = (rig: Rig): number =>
    (
      rig.database.adapter
        .prepare(`SELECT COUNT(*) AS n FROM nodes WHERE name = 'Widget' AND type = 'class'`)
        .get() as { n: number }
    ).n;

  test('class only counted once even after the source moves its line position', async () => {
    writeFileSync(join(project, 'lib.ts'), `export class Widget { foo(): void {} }\n`);
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    expect(countWidget(rig)).toBe(1);

    // Add an import above — pushes Widget down a line.
    writeFileSync(
      join(project, 'lib.ts'),
      `import { x } from 'somewhere';\nexport class Widget { foo(): void {} }\n`,
    );
    await rig.indexAll();
    expect(countWidget(rig)).toBe(1);

    // Add another import — another line shift.
    writeFileSync(
      join(project, 'lib.ts'),
      `import { x } from 'somewhere';\nimport { y } from 'elsewhere';\nexport class Widget { foo(): void {} }\n`,
    );
    await rig.indexAll();
    expect(countWidget(rig)).toBe(1);
    rig.close();
  });

  test('removing a class from a file removes the node on sync', async () => {
    writeFileSync(
      join(project, 'lib.ts'),
      `export class A { f(): void {} }\nexport class B { g(): void {} }\n`,
    );
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    expect(
      (
        rig.database.adapter.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE name = 'A'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(1);

    writeFileSync(join(project, 'lib.ts'), `export class B { g(): void {} }\n`);
    await rig.sync();
    expect(
      (
        rig.database.adapter.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE name = 'A'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(
      (
        rig.database.adapter.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE name = 'B'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    rig.close();
  });
});
