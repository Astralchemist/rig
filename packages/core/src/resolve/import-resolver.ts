import { dirname, join, normalize } from 'node:path';
import { applyAliases, type AliasMap } from './path-aliases.ts';

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_NAMES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

const toPosix = (p: string): string => normalize(p).replace(/\\/g, '/');

// Look up a candidate path against the file index, trying common extensions
// and `index.<ext>` fallbacks. Returns the matched file node id, or null.
const tryCandidate = (
  candidate: string,
  fileByPath: Map<string, string>,
): string | null => {
  for (const ext of EXTENSIONS) {
    const id = fileByPath.get(candidate + ext);
    if (id) return id;
  }
  for (const idx of INDEX_NAMES) {
    const id = fileByPath.get(candidate + '/' + idx);
    if (id) return id;
  }
  return null;
};

export interface ResolveImportArgs {
  modulePath: string;
  importingFile: string;
  fileByPath: Map<string, string>;
  projectRoot: string;
  aliases: AliasMap | null;
}

// Resolve a module path (the text after `from`) to a file node id, if the
// module lives inside the project. Bare specifiers (npm packages, node:*)
// return null — they belong to external deps and stay unresolved.
export function resolveModuleImport(args: ResolveImportArgs): string | null {
  const { modulePath, importingFile, fileByPath, projectRoot, aliases } = args;

  if (modulePath.startsWith('.')) {
    const dir = dirname(importingFile);
    const candidate = toPosix(join(dir, modulePath));
    return tryCandidate(candidate, fileByPath);
  }

  if (aliases) {
    const candidates = applyAliases(modulePath, aliases, projectRoot);
    for (const c of candidates) {
      const id = tryCandidate(c, fileByPath);
      if (id) return id;
    }
  }

  return null;
}
