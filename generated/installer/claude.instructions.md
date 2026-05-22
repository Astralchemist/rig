<!-- GENERATED FILE — DO NOT EDIT.
     Source: .contracts/targets/claude.contract.ts
     Edit the .contract.ts file(s), then run `bun run gen`. -->

# Rig — Claude Code instructions

Rig exposes these MCP tools. Always prefer them over file reads for graph questions.

## light tools

### `rig_status`

Returns counts of nodes, edges, files, and the last sync timestamp.
Use as a smoke test before any other rig_* call to confirm the index is initialized.

## Two-tier gate

NEVER call `rig_explore` or `rig_context` directly in the main session — spawn a sub-agent for these.
