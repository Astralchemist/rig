import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

// Walk the declared-dependency anchors, locate each manifest's sibling
// package-lock.json (if any), and update the dep node's data.resolvedVersion
// with the installed version reported by the lockfile. Run after extraction so
// upserts don't overwrite the enrichment. Idempotent.
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

  // Cache lockfile reads — one project can have many declared deps sharing a manifest.
  const lockCache = new Map<string, Map<string, string>>();
  const getLock = (manifestPath: string): Map<string, string> | null => {
    const abs = resolve(projectRoot, manifestPath);
    const manifestDir = dirname(abs);
    const lockPath = join(manifestDir, 'package-lock.json');
    if (lockCache.has(lockPath)) return lockCache.get(lockPath)!;
    if (!existsSync(lockPath)) {
      lockCache.set(lockPath, new Map());
      return null;
    }
    const map = parsePackageLock(lockPath);
    lockCache.set(lockPath, map);
    return map;
  };

  const upd = db.prepare(`UPDATE nodes SET data = ?, updated_at = ? WHERE id = ?`);
  let touched = 0;
  const now = Date.now();
  db.transaction(() => {
    for (const d of deps) {
      const parsed = JSON.parse(d.data) as Record<string, unknown>;
      if (parsed.depSource !== 'npm') continue; // pypi resolution lives elsewhere
      const map = getLock(d.manifest_path ?? '');
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
