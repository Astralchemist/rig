import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Database } from './db/database.ts';
import { upsertFile, upsertNode } from './db/node-queries.ts';
import { extractFromSource } from './extract/extractor.ts';
import { walkProject } from './extract/walker.ts';

export interface SyncResult {
  filesChanged: number;
  durationMs: number;
}

/**
 * Incremental sync: walk the project, re-extract only files whose content hash
 * has changed since the last index. Phase 1.6 form — does not yet purge nodes
 * for deleted files (that lands when the watcher gets per-event paths).
 */
export async function runSync(
  projectRoot: string,
  database: Database,
): Promise<SyncResult> {
  const start = Date.now();
  let filesChanged = 0;

  const known = new Map<string, string>();
  const knownRows = database.adapter
    .prepare(`SELECT path, hash FROM files`)
    .all() as { path: string; hash: string }[];
  for (const r of knownRows) known.set(r.path, r.hash);

  for await (const file of walkProject(projectRoot)) {
    const source = await readFile(file.absPath, 'utf-8');
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
    if (known.get(file.relPath) === hash) continue;
    const mtime = statSync(file.absPath).mtimeMs;
    const result = await extractFromSource(file.relPath, source);
    database.adapter.transaction(() => {
      upsertFile(database.adapter, file.relPath, Math.floor(mtime), hash);
      for (const node of result.nodes) upsertNode(database.adapter, node);
    })();
    filesChanged++;
  }

  return { filesChanged, durationMs: Date.now() - start };
}
