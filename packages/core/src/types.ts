// SPDX-License-Identifier: Apache-2.0
export type NodeId = string;
export type EdgeKind = string;
export type Provenance =
  | { kind: 'ast' }
  | { kind: 'vector' }
  | { kind: 'ai'; model: string }
  | { kind: 'user'; id: string };

export interface RigNode {
  id: NodeId;
  type: string;
  name: string;
  data: Record<string, unknown>;
  pull_score: number;
  created_at: number;
  updated_at: number;
}

export interface StructuralEdge {
  src: NodeId;
  dst: NodeId;
  kind: EdgeKind;
  provenance: string;
  created_at: number;
}

export interface SemanticEdge {
  src: NodeId;
  dst: NodeId;
  weight: number;
  provenance: string;
  rationale: string | null;
  created_at: number;
  // The kind it was proposed with, and the URLs cited as evidence.
  kind: EdgeKind;
  source_urls: string[];
}

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export class NotImplemented extends Error {
  constructor(method: string) {
    super(`${method} not implemented yet (Phase 0 stub)`);
    this.name = 'NotImplemented';
  }
}
