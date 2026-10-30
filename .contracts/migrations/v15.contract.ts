import { defineMigrationContract } from '@rig/contracts';

// Which agent each MCP session belongs to (backlog C5: one colour per agent
// on the map; B6: who handed off to whom).
//
// - client: the name the client sent in the MCP `initialize` handshake
//   (clientInfo.name). Some clients send unhelpful or identical names.
// - client_label: the name `rig install <agent>` wrote into that agent's
//   server args (`--client <agent>`), or RIG_CLIENT. It wins when present, so
//   two tools that introduce themselves the same way still get two colours.
//
// A table of its own rather than columns on `sessions`: sessions holds the
// sessions that wrote memory and is exported with it; every MCP connection
// lands here, and none of it is memory.
export default defineMigrationContract({
  version: 15,
  description: 'C5: session_clients — the agent behind each MCP session',
  applied_in_phase: 4,
  forward: `
CREATE TABLE IF NOT EXISTS session_clients (
  session_id TEXT PRIMARY KEY,
  client TEXT,
  client_label TEXT,
  started_at INTEGER NOT NULL
);
  `.trim(),
  rollback: `
DROP TABLE IF EXISTS session_clients;
  `.trim(),
});
