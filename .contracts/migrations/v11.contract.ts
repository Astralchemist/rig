import { defineMigrationContract } from '@rig/contracts';

// E1 — AI-proposed edges can now carry web-validation evidence. A JSON array
// of URLs the agent cited while reasoning about the proposal; the accept
// popover (and future audit views) render them as clickable links.
export default defineMigrationContract({
  version: 11,
  description: 'E1: source_urls JSON column on pending_edges',
  applied_in_phase: 4,
  forward: `
ALTER TABLE pending_edges ADD COLUMN source_urls TEXT;
  `.trim(),
  rollback: `
-- SQLite cannot DROP COLUMN before 3.35; intentional no-op.
  `.trim(),
});
