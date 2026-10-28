// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Rig } from '@rig/core';
import { resolvePythonImport } from '@rig/core/resolve/python-modules.ts';

// A flat package (app/), a src-layout package (src/corelib/), and a loose
// script directory (scripts/, no __init__.py).
const FILES: Record<string, string> = {
  'app/__init__.py': '',
  'app/models.py': 'class User:\n    pass\n',
  'app/helpers.py': 'def tidy():\n    pass\n',
  'app/views.py': 'from .models import User\nfrom . import helpers\n',
  'app/services/__init__.py': '',
  'app/services/billing.py': 'from ..models import User\n',
  'src/corelib/__init__.py': '',
  'src/corelib/text.py': 'def slug(s):\n    return s\n',
  'main.py': [
    'import app',
    'import app.services.billing',
    'import corelib.text',
    'import pandas as pd',
    '',
  ].join('\n'),
  'cli.py': 'from app.services import billing\nfrom corelib import text as t\n',
  'scripts/tools.py': 'def run():\n    pass\n',
  'scripts/run.py': 'import tools\n',
};

describe('Python import resolution', () => {
  let root: string;
  let rig: Rig;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'rig-resolve-py-'));
    for (const [path, source] of Object.entries(FILES)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    rig = await Rig.init(root);
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(root, { recursive: true, force: true });
  });

  // File paths the given file has an `imports` edge to.
  const importsOf = (file: string): string[] =>
    (
      rig.database.adapter
        .prepare(
          `SELECT dst.name AS path FROM edges e
           JOIN nodes src ON src.id = e.src
           JOIN nodes dst ON dst.id = e.dst
           WHERE e.kind = 'imports' AND src.type = 'file' AND src.name = ?`,
        )
        .all(file) as { path: string }[]
    )
      .map((r) => r.path)
      .toSorted();

  it('resolves relative imports: from .models, from . import x, from ..models', () => {
    expect(importsOf('app/views.py')).toEqual(['app/helpers.py', 'app/models.py']);
    expect(importsOf('app/services/billing.py')).toEqual(['app/models.py']);
  });

  it('resolves absolute dotted imports to module files and packages', () => {
    expect(importsOf('main.py')).toEqual([
      'app/__init__.py',
      'app/services/billing.py',
      'src/corelib/text.py',
    ]);
  });

  it('resolves `from pkg import mod` to the submodule file', () => {
    expect(importsOf('cli.py')).toEqual(['app/services/billing.py', 'src/corelib/text.py']);
  });

  it("resolves a script's imports from its own directory", () => {
    expect(importsOf('scripts/run.py')).toEqual(['scripts/tools.py']);
  });

  it('leaves third-party imports unresolved', () => {
    const rows = rig.database.adapter
      .prepare("SELECT file_path FROM unresolved_refs WHERE target_name = 'pandas'")
      .all() as { file_path: string }[];
    expect(rows).toEqual([{ file_path: 'main.py' }]);
  });
});

describe('resolvePythonImport', () => {
  const fileByPath = new Map(
    ['pkg/__init__.py', 'pkg/mod.py', 'pkg.py', 'top.py'].map((p) => [p, `file:${p}`]),
  );
  const resolve = (modulePath: string, importingFile: string, importedNames: string[] = []) =>
    resolvePythonImport({ modulePath, importedNames, importingFile, fileByPath });

  it('prefers a package over a same-named module, as Python does', () => {
    expect(resolve('pkg', 'main.py')).toBe('file:pkg/__init__.py');
  });

  it('falls back to the module when an imported name is not a submodule', () => {
    expect(resolve('pkg', 'main.py', ['helper'])).toBe('file:pkg/__init__.py');
    expect(resolve('.', 'pkg/mod.py', ['helper'])).toBe('file:pkg/__init__.py');
  });

  it('does not climb above the project root', () => {
    expect(resolve('..top', 'pkg/mod.py')).toBe('file:top.py');
    expect(resolve('...top', 'pkg/mod.py')).toBeNull();
  });
});
