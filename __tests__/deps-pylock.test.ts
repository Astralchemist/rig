import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// A2 — Python lockfile resolution attaches installed versions to pyproject deps.
describe('A2 Python lockfile resolution', () => {
  let project: string;
  let rig: Rig;

  afterEach(() => {
    rig?.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('uv.lock [[package]] entries enrich pyproject deps', async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-uv-'));
    writeFileSync(
      join(project, 'pyproject.toml'),
      ['[project]', 'name = "demo"', 'dependencies = ["pandas>=2.0", "requests"]'].join('\n'),
    );
    writeFileSync(
      join(project, 'uv.lock'),
      [
        'version = 1',
        '',
        '[[package]]',
        'name = "pandas"',
        'version = "2.1.4"',
        '',
        '[[package]]',
        'name = "requests"',
        'version = "2.31.0"',
        'description = "HTTP for humans"',
      ].join('\n'),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const deps = rig.getDependencies('pyproject.toml');
    const byName = new Map(deps.map((d) => [d.name, d]));
    expect(byName.get('pandas')!.resolved_version).toBe('2.1.4');
    expect(byName.get('requests')!.resolved_version).toBe('2.31.0');
  });

  test('poetry.lock works the same way', async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-poetry-'));
    writeFileSync(
      join(project, 'pyproject.toml'),
      ['[tool.poetry.dependencies]', 'python = "^3.11"', 'numpy = "^1.26"'].join('\n'),
    );
    writeFileSync(
      join(project, 'poetry.lock'),
      [
        '[[package]]',
        'name = "numpy"',
        'version = "1.26.0"',
        'description = "..."',
        'optional = false',
      ].join('\n'),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const deps = rig.getDependencies('pyproject.toml');
    expect(deps.find((d) => d.name === 'numpy')!.resolved_version).toBe('1.26.0');
  });

  test('uv.lock wins when both lockfiles are present', async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-both-'));
    writeFileSync(
      join(project, 'pyproject.toml'),
      ['[project]', 'dependencies = ["pandas"]'].join('\n'),
    );
    writeFileSync(
      join(project, 'uv.lock'),
      ['version = 1', '[[package]]', 'name = "pandas"', 'version = "2.1.4"'].join('\n'),
    );
    writeFileSync(
      join(project, 'poetry.lock'),
      ['[[package]]', 'name = "pandas"', 'version = "1.5.3"'].join('\n'),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const pandas = rig.getDependencies('pyproject.toml').find((d) => d.name === 'pandas')!;
    expect(pandas.resolved_version).toBe('2.1.4');
  });

  test('requirements.txt deps are not enriched (spec already carries the version)', async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-reqtxt-'));
    writeFileSync(join(project, 'requirements.txt'), 'pandas==2.1.4\n');
    writeFileSync(
      join(project, 'uv.lock'),
      ['version = 1', '[[package]]', 'name = "pandas"', 'version = "2.2.0"'].join('\n'),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const pandas = rig.getDependencies('requirements.txt').find((d) => d.name === 'pandas')!;
    // requirements.txt deps stay as declared; lockfile doesn't override them
    expect(pandas.resolved_version).toBeNull();
  });
});
