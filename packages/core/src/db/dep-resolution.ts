// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { SqliteAdapter } from './adapter.ts';

interface LockfileV2or3 {
  lockfileVersion?: number;
  packages?: Record<string, { version?: string }>;
}

// Parse a package-lock.json (lockfileVersion 2 or 3). Returns a map of
// package-name → resolved-version. Keys under `packages` look like
// 'node_modules/lodash' or 'node_modules/@types/node'; we strip the
// 'node_modules/' prefix and keep the scoped path intact.
const parsePackageLock = (lockPath: string): Map<string, string> => {
  const out = new Map<string, string>();
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as LockfileV2or3;
    if (!parsed.packages) return out;
    for (const [key, entry] of Object.entries(parsed.packages)) {
      if (!key.startsWith('node_modules/')) continue; // skip root + nested workspaces
      const path = key.slice('node_modules/'.length);
      // Nested packages: 'foo/node_modules/bar' — only top-level installs win
      if (path.includes('/node_modules/')) continue;
      if (entry?.version) out.set(path, entry.version);
    }
  } catch {
    // Best-effort: a malformed lockfile is silently skipped.
  }
  return out;
};

// Narrow TOML reader for the `[[package]]` array-of-tables shape both uv.lock
// (uv >= 0.1) and poetry.lock (Poetry 1.x) emit:
//
//   [[package]]
//   name = "pandas"
//   version = "2.1.4"
//
// Strings can be double- or single-quoted. Comments + other keys are ignored.
const parsePythonLock = (lockPath: string): Map<string, string> => {
  const out = new Map<string, string>();
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf-8');
  } catch {
    return out;
  }
  // Split into [[package]] chunks. The first chunk (before the first [[package]])
  // is preamble (version pin, metadata) and gets discarded.
  const chunks = raw.split(/^\s*\[\[package\]\]\s*$/m).slice(1);
  for (const chunk of chunks) {
    let name = '';
    let version = '';
    for (const rawLine of chunk.split('\n')) {
      const line = rawLine.replace(/#.*$/, '').trim();
      const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
      if (!m) continue;
      const key = m[1]!;
      const valueRaw = m[2]!.trim();
      // Stop at the next table header (defensive — split should already handle)
      if (valueRaw.startsWith('[')) break;
      let value = valueRaw;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        // unquoted (numbers, bools) — ignore for our purposes
        continue;
      }
      if (key === 'name') name = value;
      else if (key === 'version') version = value;
      if (name && version) break;
    }
    if (name && version) out.set(name, version);
  }
  return out;
};

// Walk the declared-dependency anchors, locate each manifest's sibling lock
// file (npm: package-lock.json; Python: uv.lock then poetry.lock), and update
// the dep node's data.resolvedVersion with the installed version reported.
// Run after extraction so upserts don't overwrite the enrichment. Idempotent.
export const enrichDependenciesFromLockfiles = (
  db: SqliteAdapter,
  projectRoot: string,
): number => {
  const deps = db
    .prepare(
      `SELECT id, name, data, json_extract(data, '$.filePath') AS manifest_path
       FROM nodes WHERE type = 'declared-dependency'`,
    )
    .all() as { id: string; name: string; data: string; manifest_path: string }[];

  // Per-manifest-dir caches so a manifest with many deps reads each lockfile
  // at most once per enrichment pass.
  const npmCache = new Map<string, Map<string, string>>();
  const pyCache = new Map<string, Map<string, string>>();

  const getNpm = (manifestPath: string): Map<string, string> | null => {
    const abs = resolve(projectRoot, manifestPath);
    const lockPath = join(dirname(abs), 'package-lock.json');
    if (npmCache.has(lockPath)) return npmCache.get(lockPath)!;
    if (!existsSync(lockPath)) {
      npmCache.set(lockPath, new Map());
      return null;
    }
    const map = parsePackageLock(lockPath);
    npmCache.set(lockPath, map);
    return map;
  };

  const getPython = (manifestPath: string): Map<string, string> | null => {
    const abs = resolve(projectRoot, manifestPath);
    const dir = dirname(abs);
    if (pyCache.has(dir)) return pyCache.get(dir)!;
    // uv.lock wins over poetry.lock when both exist (uv is newer and faster).
    for (const candidate of ['uv.lock', 'poetry.lock']) {
      const lockPath = join(dir, candidate);
      if (!existsSync(lockPath)) continue;
      const map = parsePythonLock(lockPath);
      if (map.size > 0) {
        pyCache.set(dir, map);
        return map;
      }
    }
    pyCache.set(dir, new Map());
    return null;
  };

  const upd = db.prepare(`UPDATE nodes SET data = ?, updated_at = ? WHERE id = ?`);
  let touched = 0;
  const now = Date.now();
  db.transaction(() => {
    for (const d of deps) {
      const parsed = JSON.parse(d.data) as Record<string, unknown>;
      const source = parsed.depSource;
      let map: Map<string, string> | null = null;
      if (source === 'npm') {
        map = getNpm(d.manifest_path ?? '');
      } else if (source === 'pypi') {
        // Python lockfiles only meaningfully resolve pyproject.toml-declared
        // deps. requirements.txt entries already carry their pinned version
        // via the spec; surfacing a separate resolved_version would duplicate
        // for no analytical gain.
        if (basename(d.manifest_path ?? '') !== 'pyproject.toml') continue;
        map = getPython(d.manifest_path ?? '');
      } else continue;
      if (!map) continue;
      const resolved = map.get(d.name);
      if (!resolved) continue;
      if (parsed.resolvedVersion === resolved) continue;
      parsed.resolvedVersion = resolved;
      upd.run(JSON.stringify(parsed), now, d.id);
      touched++;
    }
  })();
  return touched;
};
