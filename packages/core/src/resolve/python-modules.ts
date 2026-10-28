// SPDX-License-Identifier: Apache-2.0
import { posix } from 'node:path';

// Absolute imports are searched from the importing file's import root, then
// the project root, then `src/` (the src layout).
const SOURCE_ROOTS = ['.', 'src'];

// The directory a file's absolute imports start from: the nearest ancestor
// that is not a package (has no __init__.py). For pkg/sub/mod.py that is the
// directory holding pkg; for a loose script it is the script's own directory.
const importRootOf = (file: string, fileByPath: Map<string, string>): string => {
  let dir = posix.dirname(file);
  while (dir !== '.' && fileByPath.has(posix.join(dir, '__init__.py'))) dir = posix.dirname(dir);
  return dir;
};

// Module `segments` under `dir`: a/b → a/b/__init__.py, then a/b.py (a
// package wins over a same-named module, as in Python's own finder).
const moduleFile = (
  dir: string,
  segments: readonly string[],
  fileByPath: Map<string, string>,
): string | null => {
  const base = posix.join(dir, ...segments);
  const pkg = fileByPath.get(posix.join(base, '__init__.py'));
  if (pkg) return pkg;
  return segments.length > 0 ? (fileByPath.get(`${base}.py`) ?? null) : null;
};

// `from pkg import mod` may name a submodule, so each imported name is tried
// as a module under the target before the target itself.
const resolveUnder = (
  dir: string,
  segments: readonly string[],
  importedNames: readonly string[],
  fileByPath: Map<string, string>,
): string | null => {
  for (const name of importedNames) {
    const id = moduleFile(dir, [...segments, name], fileByPath);
    if (id) return id;
  }
  return moduleFile(dir, segments, fileByPath);
};

export interface ResolvePythonImportArgs {
  // The module as written: 'pkg.mod', '.', '..models'.
  modulePath: string;
  // Names a `from` import pulls in; empty for `import x` and `from x import *`.
  importedNames: readonly string[];
  importingFile: string;
  fileByPath: Map<string, string>;
}

// Resolve a Python import to the file node id of the module it loads, if
// that module lives inside the project. Stdlib and third-party modules
// return null — they stay unresolved for the dependency views.
export function resolvePythonImport(args: ResolvePythonImportArgs): string | null {
  const { modulePath, importedNames, importingFile, fileByPath } = args;
  const dots = modulePath.length - modulePath.replace(/^\.+/, '').length;
  const segments = modulePath.slice(dots).split('.').filter(Boolean);

  if (dots > 0) {
    // One dot is the importing file's package; each further dot climbs a level.
    let dir = posix.dirname(importingFile);
    for (let i = 1; i < dots; i++) dir = posix.join(dir, '..');
    return resolveUnder(dir, segments, importedNames, fileByPath);
  }

  for (const root of new Set([importRootOf(importingFile, fileByPath), ...SOURCE_ROOTS])) {
    const id = resolveUnder(root, segments, importedNames, fileByPath);
    if (id) return id;
  }
  return null;
}
