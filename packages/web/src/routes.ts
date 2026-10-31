// SPDX-License-Identifier: Apache-2.0
import type { Rig, RigNode, WaypointKind } from '@rig/core';
import type { FastifyInstance } from 'fastify';
import { impactTree, listOrphans, neighborhood, nodeCards } from './views.ts';

// How long a typeahead search waits for the embedding model before answering
// from names and keywords alone. The first query starts the model loading.
const SEARCH_WAIT_MS = 1200;
const WAYPOINT_KINDS = new Set([
  'decision',
  'observation',
  'constraint',
  'open-question',
  'principle',
]);
// Mutations the activity feed leaves out: gaze, not edits.
const QUIET_KINDS = "('selection', 'focus')";

interface NodeParams {
  id: string;
}
interface NeighborsQuery {
  kind?: string;
  limit?: string;
}
interface PullQuery {
  k?: string;
}
interface SearchQuery {
  q?: string;
  kind?: string;
  limit?: string;
  mode?: string;
}
interface WaypointsQuery {
  kind?: string;
  session_id?: string;
  q?: string;
  limit?: string;
}
interface LimitQuery {
  limit?: string;
}
interface DepthQuery {
  depth?: string;
  max_steps?: string;
}
interface CardsQuery {
  ids?: string;
}
interface FilesQuery {
  filter?: string;
}
interface GraphQuery {
  limit?: string;
}

const intOrUndef = (s: string | undefined): number | undefined =>
  s === undefined ? undefined : Number.parseInt(s, 10);

const ensureNode = (
  rig: Rig,
  id: string,
): { ok: true } | { ok: false; status: number; body: { error: string } } =>
  rig.getNode(id)
    ? { ok: true }
    : { ok: false, status: 404, body: { error: `node ${id} not found` } };

export const registerRoutes = (app: FastifyInstance, rig: Rig): void => {
  app.get('/api/status', async () => rig.status());

  app.get<{ Querystring: GraphQuery }>('/api/graph', async (req) =>
    rig.snapshot(intOrUndef(req.query.limit) ?? 500),
  );

  app.get<{ Params: NodeParams }>('/api/node/:id', async (req, reply) => {
    const e = ensureNode(rig, req.params.id);
    if (!e.ok) return reply.code(e.status).send(e.body);
    const n = rig.getNode(req.params.id)!;
    // card, annotations and aliases were added for the map's inspector.
    return {
      ...n,
      neighbor_counts: rig.getNeighborCounts(req.params.id),
      card: nodeCards(rig, [req.params.id])[0] ?? null,
      annotations: rig.getAnnotations(req.params.id),
      aliases: rig.getAliases(req.params.id),
    };
  });

  app.get<{ Params: NodeParams; Querystring: LimitQuery }>(
    '/api/node/:id/neighborhood',
    async (req, reply) => {
      const limit = Math.min(Math.max(intOrUndef(req.query.limit) ?? 40, 1), 200);
      const n = neighborhood(rig, req.params.id, limit);
      if (!n) return reply.code(404).send({ error: `node ${req.params.id} not found` });
      return n;
    },
  );

  app.get<{ Params: NodeParams; Querystring: DepthQuery }>(
    '/api/node/:id/impact',
    async (req, reply) => {
      const depth = Math.min(Math.max(intOrUndef(req.query.depth) ?? 3, 1), 6);
      const t = impactTree(rig, req.params.id, depth);
      if (!t) return reply.code(404).send({ error: `node ${req.params.id} not found` });
      return t;
    },
  );

  // rig_critical_path's walk, with a card per step.
  app.get<{ Params: NodeParams; Querystring: DepthQuery }>(
    '/api/node/:id/critical-path',
    async (req, reply) => {
      const e = ensureNode(rig, req.params.id);
      if (!e.ok) return reply.code(e.status).send(e.body);
      const steps = rig.getCriticalPath(
        req.params.id,
        Math.min(intOrUndef(req.query.max_steps) ?? 16, 32),
      );
      const cards = new Map(
        nodeCards(
          rig,
          steps.map((s) => s.id),
        ).map((c) => [c.id, c]),
      );
      return {
        path: steps.map((s) => ({ ...s, card: cards.get(s.id) ?? null })),
      };
    },
  );

  // Cards for a set of ids (comma-separated), in the order asked.
  app.get<{ Querystring: CardsQuery }>('/api/cards', async (req, reply) => {
    const ids = (req.query.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return reply.code(400).send({ error: 'ids query param required' });
    if (ids.length > 500) return reply.code(400).send({ error: 'at most 500 ids' });
    return nodeCards(rig, ids);
  });

  app.get<{ Params: NodeParams; Querystring: NeighborsQuery }>(
    '/api/node/:id/neighbors',
    async (req, reply) => {
      const e = ensureNode(rig, req.params.id);
      if (!e.ok) return reply.code(e.status).send(e.body);
      return rig.getNeighbors(req.params.id, {
        kind: req.query.kind,
        limit: intOrUndef(req.query.limit),
      });
    },
  );

  app.get<{ Params: NodeParams; Querystring: PullQuery }>(
    '/api/node/:id/pull',
    async (req, reply) => {
      const e = ensureNode(rig, req.params.id);
      if (!e.ok) return reply.code(e.status).send(e.body);
      return rig.getMagneticPull(req.params.id, intOrUndef(req.query.k) ?? 10);
    },
  );

  // Hybrid search (names, aliases, keywords and vectors fused by rank), the
  // same ranking the MCP tools use. The body stays the RigNode[] it always
  // was, each hit with its score and the lists that matched it added; the
  // x-rig-search header says whether vectors took part. Without them (no
  // model yet, nothing embedded, or mode=keyword) the keyword search
  // answers, so a hit the old endpoint found is never lost.
  app.get<{ Querystring: SearchQuery }>('/api/search', async (req, reply) => {
    const q = req.query.q ?? '';
    if (!q) return reply.code(400).send({ error: 'q query param required' });
    const limit = intOrUndef(req.query.limit) ?? 20;
    const keyword = (): RigNode[] => rig.searchNodes(q, { kind: req.query.kind, limit });
    if (req.query.mode === 'keyword') {
      reply.header('x-rig-search', 'keyword');
      return keyword();
    }
    try {
      const r = await rig.search(q, {
        ...(req.query.kind ? { kinds: [req.query.kind] } : {}),
        limit,
        waitMs: SEARCH_WAIT_MS,
      });
      const hits = r.hits.map((h) => ({ ...h.node, score: h.score, matched_by: h.matchedBy }));
      if (!r.degraded) {
        reply.header('x-rig-search', 'hybrid');
        return hits;
      }
      reply.header('x-rig-search', 'keyword-only');
      const seen = new Set(hits.map((h) => h.id));
      const extra = keyword().filter((n) => !seen.has(n.id));
      return [...hits, ...extra.map((n) => ({ ...n, matched_by: ['keyword'] }))].slice(0, limit);
    } catch {
      reply.header('x-rig-search', 'keyword-fallback');
      return keyword();
    }
  });

  app.get<{ Querystring: FilesQuery }>('/api/files', async (req) => rig.getFiles(req.query.filter));

  app.get('/api/pending-edges', async () => rig.writes.listPending());

  // The architecture blueprint (E4): JSON for the map's Blueprint lens, or
  // the same plan as Mermaid for copying.
  app.get<{ Querystring: { level?: string; format?: string; scope?: string } }>(
    '/api/blueprint',
    async (req, reply) => {
      const { buildBlueprint, blueprintToMermaid } = await import('@rig/core/blueprint.ts');
      const level =
        req.query.level === 'site'
          ? 'site'
          : req.query.level === 'room' && req.query.scope
            ? 'room'
            : 'floor';
      let commit: string | null = null;
      try {
        const { execFileSync } = await import('node:child_process');
        commit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: rig.projectRoot,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        commit = null;
      }
      const b = buildBlueprint(rig.database.adapter, rig.projectRoot, {
        level,
        commit,
        ...(level === 'room' ? { scope: req.query.scope! } : {}),
      });
      if (req.query.format === 'mermaid') {
        reply.type('text/plain; charset=utf-8');
        return blueprintToMermaid(b);
      }
      return b;
    },
  );

  // The orientation map rig_overview and rig://overview serve.
  app.get<{ Querystring: { budget?: string } }>('/api/overview', async (req) => {
    const budget = intOrUndef(req.query.budget);
    const o = rig.overview(budget !== undefined && Number.isFinite(budget) ? { budget } : {});
    return {
      map: o.map,
      generated_at: o.generated_at,
      nodes: o.nodes,
      budget: o.budget,
      est_tokens: o.est_tokens,
      cached: o.cached,
    };
  });

  // Waypoints newest first, filtered like rig_waypoints; q ranks them by
  // relevance instead (hybrid, keyword-only when degraded).
  app.get<{ Querystring: WaypointsQuery }>('/api/waypoints', async (req, reply) => {
    const kind = req.query.kind;
    if (kind && !WAYPOINT_KINDS.has(kind))
      return reply.code(400).send({ error: `unknown kind ${kind}` });
    const opts = {
      ...(req.query.session_id ? { sessionId: req.query.session_id } : {}),
      ...(kind ? { kind: kind as WaypointKind } : {}),
      limit: Math.min(intOrUndef(req.query.limit) ?? 100, 500),
    };
    const q = req.query.q?.trim();
    if (q) {
      const r = await rig.searchWaypoints(q, opts);
      return { waypoints: r.waypoints, ...(r.degraded ? { degraded: r.degraded } : {}) };
    }
    return { waypoints: rig.getWaypoints(opts) };
  });

  // One waypoint, the chain of predecessors it builds on, and cards for the
  // code it is anchored to.
  app.get<{ Params: NodeParams }>('/api/waypoints/:id', async (req, reply) => {
    const w = rig.getWaypoint(req.params.id);
    if (!w) return reply.code(404).send({ error: `waypoint ${req.params.id} not found` });
    const chain = rig.getWaypointChain(req.params.id);
    const refs = [...new Set(chain.flatMap((c) => c.constellation_refs))];
    return { waypoint: w, chain, refs: nodeCards(rig, refs) };
  });

  // Memory detached from deleted symbols, waiting to be re-attached.
  app.get<{ Querystring: LimitQuery }>('/api/orphans', async (req) => ({
    orphans: listOrphans(rig, Math.min(intOrUndef(req.query.limit) ?? 100, 500)),
  }));

  // Recent writes, newest first, and the one the map's Undo would revert
  // (undo is per session; the map writes as session 'web').
  app.get<{ Querystring: LimitQuery }>('/api/activity', async (req) => {
    const limit = Math.min(intOrUndef(req.query.limit) ?? 30, 200);
    const db = rig.database.adapter;
    const rows = db
      .prepare(
        `SELECT m.id, m.ts, m.session_id, m.kind, m.payload, m.actor,
           EXISTS (SELECT 1 FROM mutation_log u WHERE u.kind = 'undo'
             AND u.session_id = m.session_id
             AND json_extract(u.payload, '$.undoneId') = m.id) AS undone
         FROM mutation_log m WHERE m.kind NOT IN ${QUIET_KINDS}
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      ts: number;
      session_id: string;
      kind: string;
      payload: string;
      actor: string;
      undone: number;
    }[];
    const next = db
      .prepare(
        `SELECT m.id, m.ts, m.kind, m.payload FROM mutation_log m
         WHERE m.session_id = 'web' AND m.kind NOT IN ('undo', 'focus', 'selection')
           AND NOT EXISTS (SELECT 1 FROM mutation_log u WHERE u.session_id = m.session_id
             AND u.kind = 'undo' AND json_extract(u.payload, '$.undoneId') = m.id)
         ORDER BY m.id DESC LIMIT 1`,
      )
      .get() as { id: number; ts: number; kind: string; payload: string } | null;
    const parse = (p: string): unknown => {
      try {
        return JSON.parse(p) as unknown;
      } catch {
        return null;
      }
    };
    return {
      next_undo: next
        ? { id: next.id, ts: next.ts, kind: next.kind, payload: parse(next.payload) }
        : null,
      items: rows.map((r) => ({ ...r, payload: parse(r.payload), undone: r.undone === 1 })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/pending-edges/:id/accept', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    const row = rig.writes.acceptPending(id, { sessionId: 'web', actor: 'user:web' });
    if (!row) return reply.code(404).send({ error: 'pending edge not found or already resolved' });
    return { ok: true, accepted: row };
  });

  app.post<{ Params: { id: string } }>('/api/pending-edges/:id/reject', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    const ok = rig.writes.rejectPending(id, { sessionId: 'web', actor: 'user:web' });
    if (!ok) return reply.code(404).send({ error: 'pending edge not found or already resolved' });
    return { ok: true };
  });

  // Same shape as rig_undo: undone, or null with reason (+ failed when an
  // inverse could not be applied).
  app.post('/api/undo', async () => {
    const r = rig.writes.undo({ sessionId: 'web', actor: 'user:web' });
    const ref = r.mutation ? { id: r.mutation.id, kind: r.mutation.kind, ts: r.mutation.ts } : null;
    if (r.undone) return { undone: ref };
    return { undone: null, reason: r.reason, ...(ref ? { failed: ref } : {}) };
  });

  app.post<{ Body: { node_id?: string | null } }>('/api/selection', async (req) => {
    const nodeId = typeof req.body?.node_id === 'string' ? req.body.node_id : null;
    rig.writes.recordSelection(nodeId, { sessionId: 'web', actor: 'user:web' });
    return { ok: true };
  });
};
