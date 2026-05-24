import { defineMigrationContract } from '@rig/contracts';

// Distinguish unresolved imports (bare specifiers like `pandas`) from
// unresolved other-kind refs (e.g. an unknown function call). rig_phantom_imports
// only wants the imports subset; without this column we can't tell them apart.
export default defineMigrationContract({
  version: 10,
  description: 'A2 follow-up: kind column on unresolved_refs for phantom-import detection',
  applied_in_phase: 4,
  forward: `
ALTER TABLE unresolved_refs ADD COLUMN kind TEXT;
CREATE INDEX IF NOT EXISTS idx_unresolved_kind_target ON unresolved_refs(kind, target_name);
  `.trim(),
  rollback: `
DROP INDEX IF EXISTS idx_unresolved_kind_target;
-- SQLite cannot DROP COLUMN before 3.35; intentional no-op.
  `.trim(),
});
