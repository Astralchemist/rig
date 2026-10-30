// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { defineTargetContract } from '@rig/contracts';

// opencode uses an mcp.<name> wrapper (not mcpServers), takes `command` as a
// combined string-array, and includes an explicit `enabled` flag. Reads and
// writes go through jsonc-parser so user comments in opencode.jsonc survive
// idempotent re-runs. Tool approvals go in `permission`, keyed by tool name —
// MCP tools are named <server>_<tool>, so rig's are rig_rig_*.
export default defineTargetContract({
  name: 'opencode',
  display_name: 'opencode',
  detect: async () =>
    existsSync(path.join(homedir(), '.config', 'opencode')) ||
    existsSync(path.join(homedir(), '.config', 'opencode', 'opencode.jsonc')) ||
    existsSync(path.join(homedir(), '.config', 'opencode', 'opencode.json')),
  files: [
    {
      role: 'mcp_config',
      path: '~/.config/opencode/opencode.jsonc',
      mode: 'merge-jsonc',
      template: {
        $schema: 'https://opencode.ai/config.json',
        mcp: {
          rig: {
            type: 'local',
            command: ['{{RIG_BIN}}', 'serve', '--mcp', '--client', 'opencode'],
            enabled: true,
          },
        },
      },
    },
    {
      role: 'permissions',
      path: '~/.config/opencode/opencode.jsonc',
      mode: 'merge-jsonc',
      template: '{{GENERATED:opencode.permissions.json}}',
    },
    {
      role: 'instructions',
      path: '~/.config/opencode/AGENTS.md',
      mode: 'append-section',
      section_marker: '## Rig',
      template: '{{GENERATED:opencode.instructions.md}}',
    },
  ],
  uninstall_strategy: 'reverse',
});
