// SPDX-License-Identifier: Apache-2.0

// Which permission entries are rig's own. Install treats rig's current policy
// as authoritative for these — each sits in exactly the list (or holds exactly
// the value) the policy gives it, and stale ones go — while every other entry
// is the user's and is kept. Uninstall removes exactly these.
//
// Tool names are `rig_<snake_case>` (tool contract schema) and every target
// registers the MCP server as `rig`, so in each host's vocabulary:
//   claude    mcp__rig__rig_status        permissions.allow / ask / deny
//   cursor    Mcp(rig:rig_status)         .cursor/cli.json permissions.allow / deny
//   opencode  rig_rig_status              permission.<key>
//   codex     mcp_servers.rig.tools.rig_status   TOML table (approval_mode)
// Wildcards (mcp__rig__*, Mcp(rig:*)) and server-wide rules (mcp__rig) name no
// single tool, so they stay the user's.
const TOOL = 'rig_[a-z][a-z0-9_]*';

const LIST_ENTRY = new RegExp(`^(?:mcp__rig__${TOOL}|Mcp\\(rig:${TOOL}\\))$`);
const MAP_KEY = new RegExp(`^rig_${TOOL}$`);
const TOML_TOOL_TABLE = new RegExp(`^mcp_servers\\.rig\\.tools\\.${TOOL}$`);

export const isRigListEntry = (entry: unknown): boolean =>
  typeof entry === 'string' && LIST_ENTRY.test(entry);

export const isRigMapKey = (key: string): boolean => MAP_KEY.test(key);

export const isRigToolTable = (header: string): boolean => TOML_TOOL_TABLE.test(header);
