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
    .prepare(
      `SELECT node_id, ts, source FROM activations WHERE ts > ? ORDER BY ts ASC LIMIT ?`,
    )
    .all(sinceTs, limit) as ActivationRow[];
};

export const recordActivation = (
  db: SqliteAdapter,
  nodeId: string,
  source: ActivationSource | string = 'mcp',
): void => {
  db.prepare('INSERT INTO activations (node_id, ts, source) VALUES (?, ?, ?)').run(
    nodeId,
    Date.now(),
    source,
  );
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
