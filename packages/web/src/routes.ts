// SPDX-License-Identifier: Apache-2.0
import type { Rig } from '@rig/core';
import type { FastifyInstance } from 'fastify';

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
}
interface FilesQuery {
  filter?: string;
}
interface GraphQuery {
  limit?: string;
}

const intOrUndef = (s: string | undefined): number | undefined =>
  s === undefined ? undefined : Number.parseInt(s, 10);

const ensureNode = (rig: Rig, id: string): { ok: true } | { ok: false; status: number; body: { error: string } } =>
  rig.getNode(id) ? { ok: true } : { ok: false, status: 404, body: { error: `node ${id} not found` } };

export const registerRoutes = (app: FastifyInstance, rig: Rig): void => {
  app.get('/api/status', async () => rig.status());

  app.get<{ Querystring: GraphQuery }>('/api/graph', async (req) =>
    rig.snapshot(intOrUndef(req.query.limit) ?? 500),
  );

  app.get<{ Params: NodeParams }>('/api/node/:id', async (req, reply) => {
    const e = ensureNode(rig, req.params.id);
    if (!e.ok) return reply.code(e.status).send(e.body);
    const n = rig.getNode(req.params.id)!;
    return { ...n, neighbor_counts: rig.getNeighborCounts(req.params.id) };
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

  app.get<{ Querystring: SearchQuery }>('/api/search', async (req, reply) => {
    const q = req.query.q ?? '';
    if (!q) return reply.code(400).send({ error: 'q query param required' });
    return rig.searchNodes(q, {
      kind: req.query.kind,
      limit: intOrUndef(req.query.limit),
    });
  });

  app.get<{ Querystring: FilesQuery }>('/api/files', async (req) =>
    rig.getFiles(req.query.filter),
  );

  app.get('/api/pending-edges', async () => rig.writes.listPending());

  app.post<{ Params: { id: string } }>(
    '/api/pending-edges/:id/accept',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
      const row = rig.writes.acceptPending(id, { sessionId: 'web', actor: 'user:web' });
      if (!row) return reply.code(404).send({ error: 'pending edge not found or already resolved' });
      return { ok: true, accepted: row };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/pending-edges/:id/reject',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
      const ok = rig.writes.rejectPending(id, { sessionId: 'web', actor: 'user:web' });
      if (!ok) return reply.code(404).send({ error: 'pending edge not found or already resolved' });
      return { ok: true };
    },
  );

  app.post('/api/undo', async () => {
    const undone = rig.writes.undoLast({ sessionId: 'web', actor: 'user:web' });
    return { undone: undone ? { id: undone.id, kind: undone.kind, ts: undone.ts } : null };
  });

  app.post<{ Body: { node_id?: string | null } }>(
    '/api/selection',
    async (req) => {
      const nodeId = typeof req.body?.node_id === 'string' ? req.body.node_id : null;
      rig.writes.recordSelection(nodeId, { sessionId: 'web', actor: 'user:web' });
      return { ok: true };
    },
  );
};
