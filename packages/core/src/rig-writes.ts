import type { Database } from './db/database.ts';
import {
  lastUndoableMutation,
  listMutationsSince,
  recordMutation,
  type MutationRow,
} from './db/mutation-log.ts';
import {
  acceptPending as peAccept,
  getPendingEdge,
  listPendingEdges as peList,
  proposeEdge as peProposeEdge,
  rejectPending as peReject,
  removeSemanticEdge,
  restorePendingToPending,
  type PendingEdgeRow,
} from './db/pending-edges.ts';

export interface WriteCtx {
  sessionId: string;
  actor: string;
}

export interface ProposeArgs {
  src: string;
  dst: string;
  kind?: string;
  weight?: number;
  provenance: string;
  rationale: string;
}

export interface AddNodeArgs {
  type: string;
  name: string;
  data?: Record<string, unknown>;
  rationale: string;
}

export class RigWrites {
  constructor(private readonly db: Database) {}

  proposeEdge(args: ProposeArgs, ctx: WriteCtx): number {
    const adapter = this.db.adapter;
    const pendingId = peProposeEdge(adapter, { ...args, sessionId: ctx.sessionId });
    recordMutation(adapter, {
      sessionId: ctx.sessionId,
      kind: 'propose_edge',
      payload: { pendingId, src: args.src, dst: args.dst, kind: args.kind ?? 'related' },
      actor: ctx.actor,
    });
    return pendingId;
  }

  acceptPending(pendingId: number, ctx: WriteCtx): PendingEdgeRow | null {
    const row = peAccept(this.db.adapter, pendingId);
    if (!row) return null;
    recordMutation(this.db.adapter, {
      sessionId: ctx.sessionId,
      kind: 'accept_edge',
      payload: { pendingId, src: row.src, dst: row.dst, provenance: row.provenance },
      actor: ctx.actor,
    });
    return row;
  }

  rejectPending(pendingId: number, ctx: WriteCtx): boolean {
    const ok = peReject(this.db.adapter, pendingId);
    if (!ok) return false;
    recordMutation(this.db.adapter, {
      sessionId: ctx.sessionId,
      kind: 'reject_edge',
      payload: { pendingId },
      actor: ctx.actor,
    });
    return true;
  }

  listPending(): PendingEdgeRow[] {
    return peList(this.db.adapter);
  }

  recordFocus(nodeIds: string[], ctx: WriteCtx): void {
    recordMutation(this.db.adapter, {
      sessionId: ctx.sessionId,
      kind: 'focus',
      payload: { nodeIds },
      actor: ctx.actor,
    });
  }

  mutationsSince(sinceTs: number, sessionId?: string): MutationRow[] {
    return listMutationsSince(this.db.adapter, sinceTs, sessionId);
  }

  // Reverses the last non-undo, non-focus mutation in this session. Returns
  // the mutation that was undone, or null if nothing to undo.
  undoLast(ctx: WriteCtx): MutationRow | null {
    const adapter = this.db.adapter;
    const last = lastUndoableMutation(adapter, ctx.sessionId);
    if (!last) return null;
    const p = last.payload as Record<string, unknown>;
    switch (last.kind) {
      case 'propose_edge':
        adapter.prepare(`DELETE FROM pending_edges WHERE id = ?`).run(p.pendingId as number);
        break;
      case 'accept_edge': {
        const pe = getPendingEdge(adapter, p.pendingId as number);
        if (pe) {
          adapter.transaction(() => {
            removeSemanticEdge(adapter, pe.src, pe.dst, pe.provenance);
            restorePendingToPending(adapter, pe.id);
          })();
        }
        break;
      }
      case 'reject_edge':
        restorePendingToPending(adapter, p.pendingId as number);
        break;
      case 'add_node':
        adapter.prepare(`DELETE FROM nodes WHERE id = ?`).run(p.id as string);
        break;
      default:
        // annotate/cluster are not yet undoable; log nothing.
        break;
    }
    recordMutation(adapter, {
      sessionId: ctx.sessionId,
      kind: 'undo',
      payload: { undoneId: last.id, undoneKind: last.kind },
      actor: ctx.actor,
    });
    return last;
  }
}
