import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// A2 follow-up — pyproject.toml extractor (PEP 621 + Poetry).
describe('A2 pyproject.toml extractor', () => {
  let project: string;
  let rig: Rig;

  afterEach(() => {
    rig?.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('PEP 621 [project] dependencies + optional-dependencies', async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-pep621-'));
    writeFileSync(
      join(project, 'pyproject.toml'),
      [
        '[project]',
        'name = "demo"',
        'dependencies = [',
        '    "pandas>=2.0",',
        '    "requests~=2.31",',
        '    "markupsafe",',
        ']',
        '',
        '[project.optional-dependencies]',
        'dev = ["pytest==8.0", "ruff"]',
        'docs = ["sphinx"]',
      ].join('\n'),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const deps = rig.getDependencies('pyproject.toml');
    const byName = new Map(deps.map((d) => [d.name, d]));
    expect(byName.get('pandas')).toMatchObject({ spec: '>=2.0', source: 'pypi', is_dev: false });
    expect(byName.get('requests')).toMatchObject({ spec: '~=2.31' });
    expect(byName.get('markupsafe')).toMatchObject({ spec: '*' });
    expect(byName.get('pytest')).toMatchObject({ is_dev: true });
    expect(byName.get('ruff')).toMatchObject({ is_dev: true });
    // 'docs' is not a dev group → marked as optional, not dev
    expect(byName.get('sphinx')).toMatchObject({ is_dev: false, is_optional: true });
  });

  test('Poetry [tool.poetry.dependencies] handles string + inline-table values', async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-poetry-'));
    writeFileSync(
      join(project, 'pyproject.toml'),
      [
        '[tool.poetry]',
        'name = "demo"',
        '',
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'pandas = "^2.1"',
        'requests = { version = "2.31.0", optional = true }',
        '',
        '[tool.poetry.dev-dependencies]',
        'pytest = "8.0.0"',
      ].join('\n'),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const deps = rig.getDependencies('pyproject.toml');
    const byName = new Map(deps.map((d) => [d.name, d]));
    // python interpreter pin is not a real package — skipped
    expect(byName.get('python')).toBeUndefined();
    expect(byName.get('pandas')).toMatchObject({ spec: '^2.1', source: 'pypi' });
    expect(byName.get('requests')).toMatchObject({ spec: '2.31.0' });
    expect(byName.get('pytest')).toMatchObject({ is_dev: true });
  });
});
