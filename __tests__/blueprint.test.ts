// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { blueprintToMermaid, buildBlueprint } from '../packages/core/src/blueprint.ts';

// E4: a floor plan from declared packages, resolved imports and dependencies.
describe('blueprint', () => {
  let dir: string;
  let rig: Rig;
  const pkg = (name: string, body: object) => {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    writeFileSync(
      join(dir, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@x/${name}`, ...body }),
    );
  };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rig-blueprint-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', private: true, workspaces: ['packages/*'] }),
    );
    pkg('core', { dependencies: { pg: '^8', stripe: '^14' } });
    pkg('api', { dependencies: { fastify: '^5', '@x/core': '*' } });
    pkg('cli', { bin: { x: 'index.ts' } });
    writeFileSync(join(dir, 'packages/core/db.ts'), 'export function query() { return 1; }\n');
    writeFileSync(
      join(dir, 'packages/api/server.ts'),
      "import { query } from '../core/db.ts';\nexport function serve() { return query(); }\n",
    );
    writeFileSync(
      join(dir, 'packages/cli/index.ts'),
      "import { serve } from '../api/server.ts';\nserve();\n",
    );
    rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });
  afterAll(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('packages from manifests, import edges between them, inferred surroundings dashed', () => {
    const b = buildBlueprint(rig.database.adapter, dir, { commit: 'abcdef1234' });
    const ids = b.boxes.map((x) => x.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'pkg_packages_core',
        'pkg_packages_api',
        'pkg_packages_cli',
        'store_PostgreSQL',
        'ext_Stripe',
        'io_http_packages_api',
        'io_cli_packages_cli',
      ]),
    );
    const edge = (f: string, t: string) => b.edges.find((e) => e.from === f && e.to === t);
    expect(edge('pkg_packages_api', 'pkg_packages_core')).toMatchObject({
      weight: 1,
      inferred: false,
    });
    expect(edge('pkg_packages_cli', 'pkg_packages_api')).toMatchObject({ inferred: false });
    expect(edge('pkg_packages_core', 'store_PostgreSQL')).toMatchObject({ inferred: true });
    // From a manifest field, not an inference: solid.
    expect(edge('io_cli_packages_cli', 'pkg_packages_cli')).toMatchObject({ inferred: false });
  });

  test('folding keeps the floor under the cap', () => {
    const b = buildBlueprint(rig.database.adapter, dir, { maxBoxes: 2 });
    expect(b.boxes.filter((x) => x.kind === 'package').length).toBe(2);
    expect(b.folded.length).toBe(2);
  });

  test('mermaid: classic shapes, commit in the title, a legend, deterministic', () => {
    const m = blueprintToMermaid(
      buildBlueprint(rig.database.adapter, dir, { commit: 'abcdef1234' }),
    );
    expect(m).toContain('title: Floor plan at abcdef1');
    expect(m).toMatch(/store_PostgreSQL\[\("PostgreSQL/);
    expect(m).toMatch(/io_http_packages_api\[\/"HTTP routes/);
    expect(m).toContain('subgraph legend');
    expect(m).not.toContain('{'); // no diamonds
    expect(
      blueprintToMermaid(buildBlueprint(rig.database.adapter, dir, { commit: 'abcdef1234' })),
    ).toBe(m);
  });

  test('room plan: a package from inside, with the packages that import it at the edge', () => {
    const b = buildBlueprint(rig.database.adapter, dir, { level: 'room', scope: 'packages/core' });
    expect(b.level).toBe('room');
    expect(b.scope).toBe('packages/core');
    expect(b.boxes.find((x) => x.label === 'db.ts')?.kind).toBe('package');
    const api = b.boxes.find((x) => x.label === 'packages/api')!;
    expect(api.kind).toBe('external');
    expect(b.edges.find((e) => e.from === api.id)).toMatchObject({ weight: 1, inferred: false });
    expect(blueprintToMermaid(b)).toContain('title: Room plan: packages/core');
  });

  test('floor plan packages carry their directory, for opening the room plan', () => {
    const b = buildBlueprint(rig.database.adapter, dir);
    expect(b.boxes.find((x) => x.id === 'pkg_packages_core')?.dir).toBe('packages/core');
  });
});
