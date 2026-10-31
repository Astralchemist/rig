// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';

// Roadmap step 2: every derived edge says how it was found, so heuristic
// links can be told apart from ones read off the syntax tree.
describe('edge origins', () => {
  let dir: string;
  let rig: Rig;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rig-origins-'));
    writeFileSync(
      join(dir, 'auth.ts'),
      'export class Session {}\nexport function login(): Session { return new Session(); }\n',
    );
    writeFileSync(
      join(dir, 'view.ts'),
      "import { login } from './auth.ts';\nexport function render() { return login(); }\n",
    );
    mkdirSync(join(dir, '__tests__'));
    writeFileSync(
      join(dir, '__tests__', 'view.test.ts'),
      "import { render } from '../view.ts';\nrender();\n",
    );
    rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });
  afterEach(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const origins = () =>
    Object.fromEntries(
      (
        rig.database.adapter
          .prepare(`SELECT kind, provenance FROM edges GROUP BY kind, provenance`)
          .all() as { kind: string; provenance: string }[]
      ).map((r) => [r.kind, r.provenance]),
    );

  test('syntax, resolved import, unique-name match and test heuristics are labelled apart', () => {
    const o = origins();
    expect(o.contains).toBe('ast');
    expect(o.imports).toBe('ast:import');
    expect(o.calls).toBe('ast:name');
    expect(o.tests).toBe('ast:tests');
  });

  test('a rebuild clears every derived edge, including old unlabelled ones', async () => {
    const db = rig.database.adapter;
    const [a, b] = db.prepare(`SELECT id FROM nodes WHERE type = 'function' LIMIT 2`).all() as {
      id: string;
    }[];
    db.prepare(
      `INSERT INTO edges (src, dst, kind, provenance, created_at) VALUES (?, ?, 'calls', 'ast', 0)`,
    ).run(b!.id, a!.id);
    await rig.indexAll({ force: true } as never);
    const stale = db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges WHERE src = ? AND dst = ? AND provenance = 'ast' AND kind = 'calls'`,
      )
      .get(b!.id, a!.id) as { n: number };
    expect(stale.n).toBe(0);
  });
});
