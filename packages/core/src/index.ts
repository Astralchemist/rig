// SPDX-License-Identifier: Apache-2.0
export { Rig, RIG_DIR_NAME, DB_FILE_NAME, UnknownRefsError, MemoryFileError } from './rig.ts';
export type {
  RigOptions,
  PullResult,
  StatusInfo,
  GraphSnapshot,
  PendingEdgeRow,
  MutationRow,
  MutationKind,
  TaggedEdge,
  NeighborsOptions,
  SearchOptions,
  HybridSearchOptions,
  SearchHit,
  SearchResult,
  MatchSource,
  FileRow,
  WaypointKind,
  WaypointPayload,
  WaypointRow,
  UndoOutcome,
  MemoryExport,
  MemoryImportCounts,
  MemoryImportResult,
  MemoryRecordType,
} from './rig.ts';
export { Database } from './db/database.ts';
export { bunSqliteFactory } from './db/bun-adapter.ts';
export type {
  NodeId,
  EdgeKind,
  Provenance,
  RigNode,
  StructuralEdge,
  SemanticEdge,
  Result,
} from './types.ts';
export { ok, err, NotImplemented } from './types.ts';
export type { SqliteAdapter, SqliteStatement, SqliteAdapterFactory } from './db/adapter.ts';
export type { Embedder } from './embed/types.ts';
export type { Parser, ParseResult, ParsedNode, ParsedEdge } from './extract/parser-types.ts';
