import type { SqliteAdapter } from './adapter.ts';

export const recordActivation = (
  db: SqliteAdapter,
  nodeId: string,
  source: 'query' | 'expand' | 'click' | 'ai',
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
