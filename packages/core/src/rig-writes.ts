import { addAlias as aqAdd, removeAlias as aqRemove } from './db/alias-queries.ts';
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
import { touchSession, type WaypointKind, type WaypointPayload } from './db/waypoint-queries.ts';

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
  sourceUrls?: readonly string[];
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

export interface DropWaypointArgs {
  kind: WaypointKind;
  title: string;
  summary: string;
  analogy?: string;
  constellationRefs?: readonly string[];
  predecessors?: readonly string[];
  keyTerms?: readonly string[];
  compactable?: boolean;
  payloads?: readonly WaypointPayload[];
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
      payload: {
        pendingId,
        src: args.src,
        dst: args.dst,
        kind: args.kind ?? 'related',
        ...(args.sourceUrls && args.sourceUrls.length ? { source_urls: args.sourceUrls } : {}),
      },
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

  addAlias(args: { nodeId: string; alias: string; rationale: string }, ctx: WriteCtx): boolean {
    const adapter = this.db.adapter;
    const ok = aqAdd(adapter, {
      nodeId: args.nodeId,
      alias: args.alias,
      provenance: ctx.actor,
      rationale: args.rationale,
    });
    if (!ok) return false;
    recordMutation(adapter, {
      sessionId: ctx.sessionId,
      kind: 'add_alias',
      payload: { nodeId: args.nodeId, alias: args.alias, rationale: args.rationale },
      actor: ctx.actor,
    });
    return true;
  }

  promoteHub(nodeId: string, rationale: string, ctx: WriteCtx): boolean {
    const adapter = this.db.adapter;
    const ok = adapter.prepare(`SELECT 1 FROM nodes WHERE id = ?`).get(nodeId);
    if (!ok) return false;
    adapter
      .prepare(`UPDATE nodes SET hub_explicit = 1, is_hub = 1, hubness = MAX(hubness, 0.3) WHERE id = ?`)
      .run(nodeId);
    const hubness = (adapter
      .prepare(`SELECT hubness FROM nodes WHERE id = ?`)
      .get(nodeId) as { hubness: number }).hubness;
    recordMutation(adapter, {
      sessionId: ctx.sessionId,
      kind: 'promote_hub',
      payload: { id: nodeId, hubness, rationale },
      actor: ctx.actor,
    });
    return true;
  }

  // Drop a conversation waypoint — node + predecessor edges + constellation
  // refs + session-row upsert, all inside one transaction so the mutation log
  // entry is consistent with the visible state.
  dropWaypoint(args: DropWaypointArgs, ctx: WriteCtx): string {
    const adapter = this.db.adapter;
    const id = `waypoint:${crypto.randomUUID()}`;
    const now = Date.now();
    const data = {
      session_id: ctx.sessionId,
      type: args.kind,
      summary: args.summary,
      ...(args.analogy ? { analogy: args.analogy } : {}),
      constellation_refs: args.constellationRefs ?? [],
      predecessors: args.predecessors ?? [],
      key_terms: args.keyTerms ?? [],
      compactable: args.compactable === true,
      payloads: args.payloads ?? [],
    };
    adapter.transaction(() => {
      adapter
        .prepare(
          `INSERT INTO nodes (id, type, name, data, created_at, updated_at)
           VALUES (?, 'conversation-waypoint', ?, ?, ?, ?)`,
        )
        .run(id, args.title, JSON.stringify(data), now, now);
      const ins = adapter.prepare(
        `INSERT INTO edges (src, dst, kind, provenance, created_at) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const pid of args.predecessors ?? []) {
        ins.run(id, pid, 'waypoint_succeeds', ctx.actor, now);
      }
      for (const rid of args.constellationRefs ?? []) {
        ins.run(id, rid, 'waypoint_references', ctx.actor, now);
      }
      touchSession(adapter, ctx.sessionId);
    })();
    recordMutation(adapter, {
      sessionId: ctx.sessionId,
      kind: 'drop_waypoint',
      payload: { id, kind: args.kind, title: args.title },
      actor: ctx.actor,
    });
    return id;
  }

  // Idempotently register one of the AI's own skills as a graph anchor.
  // Deterministic id `skill:<name>` so re-seeding on every startup is a no-op
  // after the first run; data stays in sync with the contract if descriptions
  // change. C4 — closes the loop so rig_pull can rank skills alongside code.
  upsertSkill(args: { name: string; description: string; tier: string; summary?: string; recordsActivation?: boolean }): string {
    const adapter = this.db.adapter;
    const id = `skill:${args.name}`;
    const now = Date.now();
    const data = {
      tier: args.tier,
      description: args.description,
      ...(args.summary ? { summary: args.summary } : {}),
      records_activation: args.recordsActivation === true,
    };
    adapter
      .prepare(
        `INSERT INTO nodes (id, type, name, data, created_at, updated_at)
         VALUES (?, 'skill', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, data=excluded.data, updated_at=excluded.updated_at`,
      )
      .run(id, args.name, JSON.stringify(data), now, now);
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

  // Record that the user's selection in the map changed. Feeds rig_subscribe
  // so an agent can follow the user's gaze. Stored as a 'selection' mutation
  // so ws-derive can emit selection:changed events.
  recordSelection(nodeId: string | null, ctx: WriteCtx): void {
    recordMutation(this.db.adapter, {
      sessionId: ctx.sessionId,
      kind: 'selection',
      payload: { nodeId },
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
      case 'add_alias':
        aqRemove(adapter, p.nodeId as string, p.alias as string);
        break;
      case 'drop_waypoint':
        // Edges cascade via ON DELETE; the sessions row is intentionally left
        // alone so its last_seen stays accurate across an undo.
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
