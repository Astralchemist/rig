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
  rationale: string;
}

export interface AddNodeArgs {
  type: string;
  name: string;
  data?: Record<string, unknown>;
  rationale: string;
}

export interface AnnotateArgs {
  nodeId: string;
  note: string;
  rationale: string;
}

export interface ClusterArgs {
  memberIds: string[];
  label: string;
  rationale: string;
}

export class RigWrites {
  constructor(private readonly db: Database) {}

  proposeEdge(args: ProposeArgs, ctx: WriteCtx): number {
    const adapter = this.db.adapter;
    const pendingId = peProposeEdge(adapter, {
      ...args,
      provenance: ctx.actor,
      sessionId: ctx.sessionId,
    });
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

  addNode(args: AddNodeArgs, ctx: WriteCtx): string {
    const id = `${args.type}:${crypto.randomUUID()}`;
    const now = Date.now();
    const data = { ...(args.data ?? {}), rationale: args.rationale };
    this.db.adapter
      .prepare(
        `INSERT INTO nodes (id, type, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, args.type, args.name, JSON.stringify(data), now, now);
    recordMutation(this.db.adapter, {
      sessionId: ctx.sessionId,
      kind: 'add_node',
      payload: { id, type: args.type, name: args.name },
      actor: ctx.actor,
    });
    return id;
  }

  annotateNode(args: AnnotateArgs, ctx: WriteCtx): boolean {
    const adapter = this.db.adapter;
    const row = adapter
      .prepare(`SELECT data FROM nodes WHERE id = ?`)
      .get(args.nodeId) as { data: string } | null;
    if (!row) return false;
    const data = JSON.parse(row.data) as Record<string, unknown>;
    const arr = Array.isArray(data.annotations) ? (data.annotations as unknown[]) : [];
    arr.push({ note: args.note, ts: Date.now(), actor: ctx.actor, rationale: args.rationale });
    data.annotations = arr;
    adapter
      .prepare(`UPDATE nodes SET data = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(data), Date.now(), args.nodeId);
    recordMutation(adapter, {
      sessionId: ctx.sessionId,
      kind: 'annotate',
      payload: { nodeId: args.nodeId, noteCount: arr.length },
      actor: ctx.actor,
    });
    return true;
  }

  clusterNodes(args: ClusterArgs, ctx: WriteCtx): string {
    const adapter = this.db.adapter;
    const id = `cluster:${crypto.randomUUID()}`;
    const now = Date.now();
    adapter.transaction(() => {
      adapter
        .prepare(
          `INSERT INTO nodes (id, type, name, data, created_at, updated_at) VALUES (?, 'cluster', ?, ?, ?, ?)`,
        )
        .run(
          id,
          args.label,
          JSON.stringify({ members: args.memberIds, rationale: args.rationale }),
          now,
          now,
        );
      const ins = adapter.prepare(
        `INSERT INTO edges (src, dst, kind, provenance, created_at) VALUES (?, ?, 'contains', ?, ?)`,
      );
      for (const m of args.memberIds) ins.run(id, m, ctx.actor, now);
    })();
    recordMutation(adapter, {
      sessionId: ctx.sessionId,
      kind: 'cluster',
      payload: { id, members: args.memberIds, label: args.label },
      actor: ctx.actor,
    });
    return id;
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
