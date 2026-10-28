// SPDX-License-Identifier: Apache-2.0
import { NODE_KINDS, type NodeKind } from '../extract/upstream-types.ts';
import type { SqliteAdapter } from './adapter.ts';

// Node kinds only agents write. Every other NodeKind can come out of an
// extractor; agent-added types (cluster, add_node's free-form types) are not
// NodeKinds at all.
const AGENT_KINDS: ReadonlySet<string> = new Set(['conversation-waypoint', 'skill']);

export const EXTRACTED_KINDS: readonly NodeKind[] = NODE_KINDS.filter((k) => !AGENT_KINDS.has(k));

// `(...)` list of EXTRACTED_KINDS for `type IN ${EXTRACTED_KINDS_SQL}`.
export const EXTRACTED_KINDS_SQL = `(${EXTRACTED_KINDS.map((k) => `'${k}'`).join(', ')})`;

// SQL predicate (on alias `n`) for "this node was produced by extraction":
// an extracted kind whose data.filePath names an indexed file. Agent-written
// nodes never match, so re-extraction never touches them and they never feed
// name resolution. Uses idx_nodes_file_path.
export const EXTRACTED_NODE_SQL = `n.type IN ${EXTRACTED_KINDS_SQL}
  AND json_extract(n.data, '$.filePath') IN (SELECT path FROM files)`;

export interface ExtractedNodeRef {
  id: string;
  kind: NodeKind;
  name: string;
  filePath: string;
}

export const loadExtractedNodes = (db: SqliteAdapter): ExtractedNodeRef[] =>
  db
    .prepare(
      `SELECT n.id, n.type AS kind, n.name, json_extract(n.data, '$.filePath') AS filePath
       FROM nodes n
       WHERE ${EXTRACTED_NODE_SQL}`,
    )
    .all() as ExtractedNodeRef[];
