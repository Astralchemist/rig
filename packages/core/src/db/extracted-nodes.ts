// SPDX-License-Identifier: Apache-2.0
import { NODE_KINDS, type NodeKind } from '../extract/upstream-types.ts';
import type { SqliteAdapter } from './adapter.ts';

// Provenance of every edge derived from extraction (direct edges and resolved
// refs written by resolver.ts, tests edges by graph/tests-edges.ts). Anything
// else on `edges` was written by an actor (waypoint_references,
// waypoint_succeeds, cluster membership): the update pipeline never rebuilds
// it, and keeps it in orphaned_memory when its node is deleted. Derived
// edges carry 'ast' or 'ast:<origin>' (EDGE_ORIGIN below).
/**
 * How a derived edge was found; every value stays in the 'ast' family so the
 * rebuild still finds them all (DERIVED_EDGE_SQL).
 * - syntax: read straight off the syntax tree (contains, extends, implements)
 * - import: a module path resolved to a file
 * - name:   a call or reference matched by a name unique in the project, not
 *           by scope; a heuristic, and the likeliest to be wrong
 * - tests:  an import from a file whose path looks like a test
 */
export const EDGE_ORIGIN = {
  syntax: 'ast',
  import: 'ast:import',
  name: 'ast:name',
  tests: 'ast:tests',
} as const;

/** SQL condition matching every derived edge: 'ast' or 'ast:<origin>'. */
export const DERIVED_EDGE_SQL = (col = 'provenance'): string =>
  `(${col} = 'ast' OR ${col} LIKE 'ast:%')`;

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
