// SPDX-License-Identifier: Apache-2.0
import { addAlias as aqAdd, removeAlias as aqRemove } from './db/alias-queries.ts';
import { addAnnotation, listAnnotations } from './db/annotation-queries.ts';
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
import {
  touchSession,
  type WaypointKind,
  type WaypointPayload,
  type WaypointSource,
} from './db/waypoint-queries.ts';
import { recomputeHubness } from './graph/hubness.ts';

export interface WriteCtx {
  sessionId: string;
  actor: string;
}

// What an undo did. `mutation` is the mutation it targeted (null when the
// session had nothing left to undo); `undone` says whether its inverse was
// applied, and `reason` says why not.
export interface UndoOutcome {
  mutation: MutationRow | null;
  undone: boolean;
  reason?: string;
}

export const NOTHING_TO_UNDO = 'nothing to undo';

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
  // Why the waypoint was dropped (required by rig_drop_waypoint); stored in
  // its data and returned by rig_waypoints / rig_chain.
  rationale?: string;
  // Automatic capture: who wrote it, the extractor's confidence, and the
  // capture details (extractor kind, cue, source span, raw anchors), kept in
  // data under `capture`.
  source?: WaypointSource;
  provenance?: string;
  confidence?: number;
  capture?: Record<string, unknown>;
}

// A waypoint named ids that are not in the graph; nothing was written.
export class UnknownRefsError extends Error {
  readonly unknownIds: string[];
  constructor(
    readonly constellationRefs: readonly string[],
    readonly predecessors: readonly string[],
  ) {
    const parts = [
      constellationRefs.length ? `constellation_refs: ${constellationRefs.join(', ')}` : '',
      predecessors.length ? `predecessors: ${predecessors.join(', ')}` : '',
    ].filter(Boolean);
    super(`unknown node ids in ${parts.join('; ')}`);
    this.name = 'UnknownRefsError';
    this.unknownIds = [...new Set([...constellationRefs, ...predecessors])];
  }
}

export class RigWrites {
  // `onEmbeddable` hears of each committed node that search embeds (waypoints,
  // skills); Rig embeds them in the background so a write never waits on the
  // model.
  constructor(
    private readonly db: Database,
    private readonly onEmbeddable?: (nodeIds: readonly string[]) => void,
  ) {}

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

  // Notes go to the annotations table, not nodes.data — extraction rewrites
  // data on every re-extract, which used to drop them.
  annotateNode(args: AnnotateArgs, ctx: WriteCtx): boolean {
    const adapter = this.db.adapter;
    const annotationId = addAnnotation(adapter, {
      nodeId: args.nodeId,
      note: args.note,
      actor: ctx.actor,
      rationale: args.rationale,
    });
    if (annotationId === null) return false;
    recordMutation(adapter, {
      sessionId: ctx.sessionId,
      kind: 'annotate',
      payload: {
        nodeId: args.nodeId,
        annotationId,
        noteCount: listAnnotations(adapter, args.nodeId).length,
      },
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

  // The payload keeps the flags the node had before (`prev`), which undo
  // restores.
  promoteHub(nodeId: string, rationale: string, ctx: WriteCtx): boolean {
    const adapter = this.db.adapter;
    const prev = adapter
      .prepare(`SELECT hub_explicit, is_hub, hubness FROM nodes WHERE id = ?`)
      .get(nodeId) as { hub_explicit: number; is_hub: number; hubness: number } | null;
    if (!prev) return false;
    adapter
      .prepare(`UPDATE nodes SET hub_explicit = 1, is_hub = 1, hubness = MAX(hubness, 0.3) WHERE id = ?`)
      .run(nodeId);
    const hubness = (adapter
      .prepare(`SELECT hubness FROM nodes WHERE id = ?`)
      .get(nodeId) as { hubness: number }).hubness;
    recordMutation(adapter, {
      sessionId: ctx.sessionId,
      kind: 'promote_hub',
      payload: { id: nodeId, hubness, rationale, prev },
      actor: ctx.actor,
    });
    return true;
  }

  // Drop a conversation waypoint — node + predecessor edges + constellation
  // refs + session-row upsert, all inside one transaction so the mutation log
  // entry is consistent with the visible state. Every referenced id is
  // checked first: an unknown one throws UnknownRefsError listing them all
  // (it used to abort the insert halfway with "FOREIGN KEY constraint
  // failed").
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
      ...(args.rationale ? { rationale: args.rationale } : {}),
      ...(args.source ? { source: args.source } : {}),
      ...(args.provenance ? { provenance: args.provenance } : {}),
      ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
      ...(args.capture ? { capture: args.capture } : {}),
    };
    adapter.transaction(() => {
      const exists = adapter.prepare(`SELECT 1 AS x FROM nodes WHERE id = ?`);
      const unknown = (ids: readonly string[] = []): string[] =>
        [...new Set(ids)].filter((ref) => !exists.get(ref));
      const badRefs = unknown(args.constellationRefs);
      const badPreds = unknown(args.predecessors);
      if (badRefs.length || badPreds.length) throw new UnknownRefsError(badRefs, badPreds);
      adapter
        .prepare(
          `INSERT INTO nodes (id, type, name, data, created_at, updated_at)
           VALUES (?, 'conversation-waypoint', ?, ?, ?, ?)`,
        )
        .run(id, args.title, JSON.stringify(data), now, now);
      // OR IGNORE: an id listed twice is one edge.
      const ins = adapter.prepare(
        `INSERT OR IGNORE INTO edges (src, dst, kind, provenance, created_at) VALUES (?, ?, ?, ?, ?)`,
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
    this.onEmbeddable?.([id]);
    return id;
  }

  // Idempotently register one of the AI's own skills as a graph anchor.
  // Deterministic id `skill:<name>` so re-seeding on every startup is a no-op
  // after the first run; data stays in sync with the contract if descriptions
  // change. C4 — closes the loop so rig_pull can rank skills alongside code.
  upsertSkill(args: { name: string; description: string; tier: string; summary?: string | undefined; recordsActivation?: boolean }): string {
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
    this.onEmbeddable?.([id]);
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

  // Undo this session's newest mutation not undone yet, so each call steps
  // one further back. The undo is logged with its target (undoneId) either
  // way: when the inverse can't be applied (the target is gone, or someone
  // else changed it since) it is reported, never claimed, and logged with
  // applied: false so the next undo moves past it instead of failing on it
  // forever.
  undo(ctx: WriteCtx): UndoOutcome {
    const adapter = this.db.adapter;
    return adapter.transaction((): UndoOutcome => {
      const target = lastUndoableMutation(adapter, ctx.sessionId);
      if (!target) return { mutation: null, undone: false, reason: NOTHING_TO_UNDO };
      const failure = this.invert(target);
      recordMutation(adapter, {
        sessionId: ctx.sessionId,
        kind: 'undo',
        payload:
          failure === null
            ? { undoneId: target.id, undoneKind: target.kind }
            : { undoneId: target.id, undoneKind: target.kind, applied: false, reason: failure },
        actor: ctx.actor,
      });
      return failure === null
        ? { mutation: target, undone: true }
        : { mutation: target, undone: false, reason: failure };
    })();
  }

  // The mutation undo() reverted, or null when it reverted nothing.
  undoLast(ctx: WriteCtx): MutationRow | null {
    const r = this.undo(ctx);
    return r.undone ? r.mutation : null;
  }

  // Apply the inverse of `m`. Returns null on success, else why it can't be
  // applied; nothing is changed then.
  private invert(m: MutationRow): string | null {
    const adapter = this.db.adapter;
    const p = m.payload as Record<string, unknown>;
    const pendingOf = (): PendingEdgeRow | string => {
      const pe = getPendingEdge(adapter, Number(p.pendingId));
      return pe ?? `pending edge ${String(p.pendingId)} no longer exists`;
    };
    switch (m.kind) {
      case 'propose_edge': {
        const pe = pendingOf();
        if (typeof pe === 'string') return pe;
        // Withdrawing an accepted or rejected proposal would orphan that
        // decision; it has to be undone first.
        if (pe.status !== 'pending') return `pending edge ${pe.id} was ${pe.status} since`;
        adapter.prepare(`DELETE FROM pending_edges WHERE id = ?`).run(pe.id);
        return null;
      }
      case 'accept_edge': {
        const pe = pendingOf();
        if (typeof pe === 'string') return pe;
        if (pe.status !== 'accepted') return `pending edge ${pe.id} is ${pe.status}, not accepted`;
        removeSemanticEdge(adapter, pe.src, pe.dst, pe.provenance);
        restorePendingToPending(adapter, pe.id);
        return null;
      }
      case 'reject_edge': {
        const pe = pendingOf();
        if (typeof pe === 'string') return pe;
        if (pe.status !== 'rejected') return `pending edge ${pe.id} is ${pe.status}, not rejected`;
        restorePendingToPending(adapter, pe.id);
        return null;
      }
      // Each wrote one node (a cluster also its `contains` edges to the
      // members, a waypoint its succeeds/references edges); deleting the node
      // cascades those edges and leaves the members alone. A waypoint's
      // sessions row stays, so its last_seen keeps reflecting activity.
      case 'add_node':
      case 'cluster':
      case 'drop_waypoint': {
        const id = String(p.id);
        const r = adapter.prepare(`DELETE FROM nodes WHERE id = ?`).run(id);
        return r.changes > 0 ? null : `node ${id} no longer exists`;
      }
      case 'add_alias':
        return aqRemove(adapter, String(p.nodeId), String(p.alias))
          ? null
          : `alias '${String(p.alias)}' of ${String(p.nodeId)} no longer exists`;
      case 'annotate': {
        const r = adapter
          .prepare(`DELETE FROM annotations WHERE id = ?`)
          .run(Number(p.annotationId));
        return r.changes > 0 ? null : `annotation ${String(p.annotationId)} no longer exists`;
      }
      case 'promote_hub':
        return this.unpromote(p);
      default:
        return `${m.kind} has no inverse`;
    }
  }

  private unpromote(p: Record<string, unknown>): string | null {
    const adapter = this.db.adapter;
    const id = String(p.id);
    const node = adapter.prepare(`SELECT type FROM nodes WHERE id = ?`).get(id) as {
      type: string;
    } | null;
    if (!node) return `node ${id} no longer exists`;
    const prev = p.prev as { hub_explicit?: unknown; is_hub?: unknown; hubness?: unknown } | null;
    if (
      prev &&
      typeof prev.hub_explicit === 'number' &&
      typeof prev.is_hub === 'number' &&
      typeof prev.hubness === 'number'
    ) {
      adapter
        .prepare(`UPDATE nodes SET hub_explicit = ?, is_hub = ?, hubness = ? WHERE id = ?`)
        .run(prev.hub_explicit, prev.is_hub, prev.hubness, id);
      return null;
    }
    // Logged before promotes recorded their prior flags: clear the explicit
    // mark and recompute hubness for the node's type.
    adapter.prepare(`UPDATE nodes SET hub_explicit = 0 WHERE id = ?`).run(id);
    recomputeHubness(adapter, new Set([node.type]));
    return null;
  }
}
