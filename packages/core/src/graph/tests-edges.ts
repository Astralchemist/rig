// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from '../db/adapter.ts';

// Duplicate `imports` edges originating from test files as `tests` edges so
// "what tests cover this anchor" becomes a one-hop query via rig_callers / a
// neighbors lookup. The original `imports` edges are preserved.
//
// Test patterns: *.test.{ts,tsx,js,jsx,py}, *.spec.{ts,tsx,js,jsx},
//                anything under a __tests__/ directory,
//                anything under tests/ or test/ at any depth.
//
// Idempotent — the edges table PK is (src, dst, kind), so duplicate runs are a
// no-op via INSERT OR IGNORE.
export const inferTestsEdges = (db: SqliteAdapter): number => {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO edges (src, dst, kind, provenance, created_at)
       SELECT e.src, e.dst, 'tests', 'ast:tests', strftime('%s','now') * 1000
       FROM edges e
       JOIN nodes n ON n.id = e.src
       WHERE e.kind = 'imports'
         AND (
           json_extract(n.data, '$.filePath') LIKE '%.test.%'
           OR json_extract(n.data, '$.filePath') LIKE '%.spec.%'
           OR json_extract(n.data, '$.filePath') LIKE '%/__tests__/%'
           OR json_extract(n.data, '$.filePath') LIKE '%/tests/%'
           OR json_extract(n.data, '$.filePath') LIKE '%/test/%'
           OR json_extract(n.data, '$.filePath') LIKE 'tests/%'
           OR json_extract(n.data, '$.filePath') LIKE 'test/%'
         )`,
    )
    .run();
  return res.changes;
};
