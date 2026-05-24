import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// A2 follow-up — Python ecosystem coverage via requirements.txt.
describe('A2 requirements.txt extractor', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-pyreq-'));
    writeFileSync(
      join(project, 'requirements.txt'),
      [
        '# comment line — should be ignored',
        '',
        'pandas==2.1.4',
        'numpy>=1.20,<2.0',
        'requests~=2.31',
        'markupsafe',
        '-r other.txt',
        '--index-url https://example.com',
      ].join('\n'),
    );
    writeFileSync(
      join(project, 'requirements-dev.txt'),
      ['pytest==8.0.0', 'ruff'].join('\n'),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('parses PEP 508 lines, skips comments / -r / --flag', () => {
    const deps = rig.getDependencies('requirements.txt');
    const byName = new Map(deps.map((d) => [d.name, d]));
    expect(byName.size).toBe(4);
    expect(byName.get('pandas')).toMatchObject({ spec: '==2.1.4', source: 'pypi', is_dev: false });
    expect(byName.get('numpy')).toMatchObject({ spec: '>=1.20,<2.0', source: 'pypi' });
    expect(byName.get('requests')).toMatchObject({ spec: '~=2.31' });
    expect(byName.get('markupsafe')).toMatchObject({ spec: '*' });
  });

  test('requirements-dev.txt marks deps as is_dev=true', () => {
    const devDeps = rig.getDependencies('requirements-dev.txt');
    expect(devDeps.length).toBe(2);
    expect(devDeps.every((d) => d.is_dev === true)).toBe(true);
  });
});

// A2 follow-up — rig_dep_conflicts across manifests.
describe('A2 rig_dep_conflicts', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-conflicts-'));
    writeFileSync(
      join(project, 'requirements.txt'),
      'pandas==2.1.4\nnumpy==1.26.0\nflask==3.0.0\n',
    );
    writeFileSync(
      join(project, 'requirements-dev.txt'),
      // pandas conflicts (2.2.0 vs 2.1.4), numpy matches → no conflict
      'pandas==2.2.0\nnumpy==1.26.0\npytest==8.0.0\n',
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('flags packages with distinct specs across manifests', () => {
    const conflicts = rig.getDependencyConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.name).toBe('pandas');
    expect(conflicts[0]!.manifests.length).toBe(2);
    const specs = new Set(conflicts[0]!.manifests.map((m) => m.spec));
    expect(specs.has('==2.1.4')).toBe(true);
    expect(specs.has('==2.2.0')).toBe(true);
  });

  test('matching specs across manifests do not register as a conflict', () => {
    const conflicts = rig.getDependencyConflicts();
    expect(conflicts.find((c) => c.name === 'numpy')).toBeUndefined();
  });

  test('single-manifest deps do not register as a conflict', () => {
    const conflicts = rig.getDependencyConflicts();
    expect(conflicts.find((c) => c.name === 'flask')).toBeUndefined();
    expect(conflicts.find((c) => c.name === 'pytest')).toBeUndefined();
  });
});
