import { defineMigrationContract } from '@rig/contracts';

export default defineMigrationContract({
  version: 5,
  description: 'A3.5 perf: text_hash on embeddings lets re-index skip unchanged nodes',
  applied_in_phase: 4,
  forward: `
ALTER TABLE embeddings ADD COLUMN text_hash TEXT NOT NULL DEFAULT '';
  `.trim(),
  rollback: `
-- SQLite cannot DROP COLUMN before 3.35; intentional no-op.
  `.trim(),
});
