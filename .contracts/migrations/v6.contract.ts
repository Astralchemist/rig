import { defineMigrationContract } from '@rig/contracts';

export default defineMigrationContract({
  version: 6,
  description: 'A4-lite: community_id column on nodes for label-propagation clustering',
  applied_in_phase: 4,
  forward: `
ALTER TABLE nodes ADD COLUMN community_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_nodes_community ON nodes(community_id);
  `.trim(),
  rollback: `
DROP INDEX IF EXISTS idx_nodes_community;
-- SQLite cannot DROP COLUMN before 3.35; intentional no-op.
  `.trim(),
});
