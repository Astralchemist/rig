// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { SqliteAdapter } from './adapter.ts';

export interface ActivationRow {
  node_id: string;
  ts: number;
  source: string;
}

export type ActivationSource = 'query' | 'expand' | 'click' | 'ai' | 'mcp' | 'web';

// Pull the activations that arrived since `sinceTs` (exclusive). Used by the
// WS layer to derive `activation:fired` pulse events whenever the db ticks.
export const activationsSince = (
  db: SqliteAdapter,
  sinceTs: number,
  limit = 50,
): ActivationRow[] => {
  return db
    .prepare(`SELECT node_id, ts, source FROM activations WHERE ts > ? ORDER BY ts ASC LIMIT ?`)
    .all(sinceTs, limit) as ActivationRow[];
};

// The agent behind an MCP session: the install-time label when there is one,
// else the name from the handshake. One row per session; a reconnect keeps it.
export const recordSessionClient = (
  db: SqliteAdapter,
  sessionId: string,
  client: string | null,
  clientLabel: string | null,
): void => {
  db.prepare(
    `INSERT INTO session_clients (session_id, client, client_label, started_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET client = excluded.client, client_label = excluded.client_label`,
  ).run(sessionId, client, clientLabel, Date.now());
};

/** node id -> agent, for activations newer than `sinceTs` whose session has a known agent. */
export const activationAgentsSince = (
  db: SqliteAdapter,
  sinceTs: number,
  limit = 50,
): Record<string, string> => {
  const rows = db
    .prepare(
      `SELECT a.node_id AS node_id, COALESCE(c.client_label, c.client) AS agent
       FROM activations a JOIN session_clients c ON c.session_id = a.session_id
       WHERE a.ts > ? AND COALESCE(c.client_label, c.client) IS NOT NULL
       ORDER BY a.ts ASC LIMIT ?`,
    )
    .all(sinceTs, limit) as { node_id: string; agent: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.node_id] = r.agent;
  return out;
};

export interface ActivationMeta {
  sessionId?: string;
  queryHash?: string;
}

// activations.query_hash: a short, stable key for the query that produced an
// activation. The text is trimmed, whitespace-collapsed and case-folded, so
// the same question asked again (or through another tool) groups together.
// Anchor-driven tools hash the anchor id.
export const queryHash = (query: string): string =>
  createHash('sha256')
    .update(query.trim().replace(/\s+/g, ' ').toLowerCase())
    .digest('hex')
    .slice(0, 16);

export const recordActivation = (
  db: SqliteAdapter,
  nodeId: string,
  source: ActivationSource | string = 'mcp',
  meta: ActivationMeta = {},
): void => {
  db.prepare(
    'INSERT INTO activations (node_id, ts, source, session_id, query_hash) VALUES (?, ?, ?, ?, ?)',
  ).run(nodeId, Date.now(), source, meta.sessionId ?? null, meta.queryHash ?? null);
};

/**
 * Exponential-decay activation score over the last `windowMs` milliseconds.
 * Half-life is `halflifeMs`. Returns 0..1 (clamped at the top by sane defaults).
 */
export const decayedActivationScore = (
  db: SqliteAdapter,
  nodeId: string,
  now: number = Date.now(),
  windowMs: number = 30 * 24 * 60 * 60 * 1000, // 30 days
  halflifeMs: number = 3 * 24 * 60 * 60 * 1000, // 3 days
): number => {
  const rows = db
    .prepare('SELECT ts FROM activations WHERE node_id = ? AND ts > ?')
    .all(nodeId, now - windowMs) as { ts: number }[];
  const lambda = Math.LN2 / halflifeMs;
  let score = 0;
  for (const r of rows) score += Math.exp(-lambda * (now - r.ts));
  // Soft-cap via 1 - exp(-score) so the function is monotone but bounded.
  return 1 - Math.exp(-score);
};

export interface HotspotRow {
  id: string;
  name: string;
  kind: string;
  touches: number;
  unique_sessions: number;
  last_ts: number;
}

// Top-N nodes by activation count within the given window. Count-based, not
// decay-weighted — distinct from the magnetic-pull recency term, which uses
// the exponential decay in decayedActivationScores below. Joins through nodes
// so the result carries name/kind directly.
export const listHotspots = (
  db: SqliteAdapter,
  windowMs: number = 7 * 24 * 60 * 60 * 1000,
  limit = 20,
  now: number = Date.now(),
): HotspotRow[] => {
  const since = now - windowMs;
  return db
    .prepare(
      `SELECT n.id, n.name, n.type AS kind,
              COUNT(*)                       AS touches,
              COUNT(DISTINCT a.session_id)   AS unique_sessions,
              MAX(a.ts)                      AS last_ts
       FROM activations a
       JOIN nodes n ON n.id = a.node_id
       WHERE a.ts > ?
       GROUP BY n.id
       ORDER BY touches DESC, last_ts DESC
       LIMIT ?`,
    )
    .all(since, limit) as HotspotRow[];
};

export interface ColdRow {
  id: string;
  name: string;
  kind: string;
  last_ts: number | null;
}

// Nodes that haven't been touched in `staleAfterMs` (or never touched).
// Surfaces dead-weight anchors that can be pruned or deprioritized.
export const listCold = (
  db: SqliteAdapter,
  staleAfterMs: number = 90 * 24 * 60 * 60 * 1000,
  limit = 20,
  now: number = Date.now(),
): ColdRow[] => {
  const threshold = now - staleAfterMs;
  return db
    .prepare(
      `SELECT n.id, n.name, n.type AS kind,
              (SELECT MAX(ts) FROM activations WHERE node_id = n.id) AS last_ts
       FROM nodes n
       WHERE NOT EXISTS (
         SELECT 1 FROM activations a WHERE a.node_id = n.id AND a.ts >= ?
       )
       ORDER BY (CASE WHEN (SELECT MAX(ts) FROM activations WHERE node_id = n.id) IS NULL
                      THEN 0 ELSE (SELECT MAX(ts) FROM activations WHERE node_id = n.id) END) ASC
       LIMIT ?`,
    )
    .all(threshold, limit) as ColdRow[];
};

// Batch variant — one SQL roundtrip for the whole window, grouped in JS.
// At 4.5k candidates this replaces 4499 prepare/get calls with a single scan
// over the (typically tiny) activations slice in the window.
export const decayedActivationScores = (
  db: SqliteAdapter,
  now: number = Date.now(),
  windowMs: number = 30 * 24 * 60 * 60 * 1000,
  halflifeMs: number = 3 * 24 * 60 * 60 * 1000,
): Map<string, number> => {
  const since = now - windowMs;
  const rows = db.prepare('SELECT node_id, ts FROM activations WHERE ts > ?').all(since) as {
    node_id: string;
    ts: number;
  }[];
  const lambda = Math.LN2 / halflifeMs;
  const sums = new Map<string, number>();
  for (const r of rows) {
    sums.set(r.node_id, (sums.get(r.node_id) ?? 0) + Math.exp(-lambda * (now - r.ts)));
  }
  const out = new Map<string, number>();
  for (const [id, s] of sums) out.set(id, 1 - Math.exp(-s));
  return out;
};
