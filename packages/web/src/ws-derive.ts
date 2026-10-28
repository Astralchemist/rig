// SPDX-License-Identifier: Apache-2.0
import type { MutationRow, Rig } from '@rig/core';

export interface DerivedEvent {
  type: string;
  ts: number;
  payload: unknown;
}

// Map mutation_log rows into typed WS events. Some kinds require an extra
// lookup (propose_edge → pending_edges row, drop_waypoint → the waypoint,
// annotate → the note) to assemble the full payload; a write undone before
// the lookup emits nothing.
export const deriveEvents = (rig: Rig, mutations: MutationRow[]): DerivedEvent[] => {
  const out: DerivedEvent[] = [];
  for (const m of mutations) {
    const p = m.payload as Record<string, unknown>;
    switch (m.kind) {
      case 'propose_edge': {
        const pendingId = Number(p.pendingId);
        const row = rig.writes
          .listPending()
          .find((r) => r.id === pendingId);
        if (row) {
          out.push({
            type: 'edge:proposed',
            ts: m.ts,
            payload: {
              pending_id: row.id,
              src: row.src,
              dst: row.dst,
              kind: row.kind,
              weight: row.weight,
              provenance: row.provenance,
              rationale: row.rationale,
              proposed_at: row.proposed_at,
            },
          });
        }
        break;
      }
      case 'accept_edge':
        out.push({
          type: 'edge:accepted',
          ts: m.ts,
          payload: { pending_id: p.pendingId, src: p.src, dst: p.dst },
        });
        break;
      case 'reject_edge':
        out.push({
          type: 'edge:rejected',
          ts: m.ts,
          payload: { pending_id: p.pendingId },
        });
        break;
      case 'add_node':
      case 'cluster': {
        const id = String(p.id);
        const node = rig.getNode(id);
        if (node) {
          out.push({
            type: 'node:added',
            ts: m.ts,
            payload: { id: node.id, type: node.type, name: node.name },
          });
        }
        break;
      }
      case 'add_alias':
        out.push({
          type: 'alias:added',
          ts: m.ts,
          payload: { node_id: p.nodeId, alias: p.alias },
        });
        break;
      case 'drop_waypoint': {
        const w = rig.getWaypoint(String(p.id));
        if (w) {
          out.push({
            type: 'waypoint:dropped',
            ts: m.ts,
            payload: {
              id: w.id,
              kind: w.kind,
              title: w.title,
              session_id: w.session_id,
              constellation_refs: w.constellation_refs,
              predecessors: w.predecessors,
            },
          });
        }
        break;
      }
      case 'annotate': {
        const nodeId = String(p.nodeId);
        const note = rig.getAnnotations(nodeId).find((a) => a.id === Number(p.annotationId));
        if (note) {
          out.push({
            type: 'node:annotated',
            ts: m.ts,
            payload: { node_id: nodeId, annotation_id: note.id, note: note.note },
          });
        }
        break;
      }
      case 'promote_hub':
        out.push({
          type: 'node:promoted',
          ts: m.ts,
          payload: { id: p.id, hubness: p.hubness },
        });
        break;
      case 'focus':
        out.push({
          type: 'focus:requested',
          ts: m.ts,
          payload: { node_ids: p.nodeIds },
        });
        break;
      case 'undo':
        // An undo whose inverse could not be applied changed nothing.
        if (p.applied !== false) out.push({ type: 'undone', ts: m.ts, payload: p });
        break;
      case 'selection':
        out.push({
          type: 'selection:changed',
          ts: m.ts,
          payload: { node_id: p.nodeId ?? null },
        });
        break;
      default:
        break;
    }
  }
  return out;
};
