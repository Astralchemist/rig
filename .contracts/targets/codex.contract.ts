// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { defineTargetContract } from '@rig/contracts';

// rig wires Codex CLI at user level, in ~/.codex/ (Codex also reads a project
// .codex/config.toml, but only in trusted projects). The mcp server entry
// lives in a dotted-key TOML table — the writer goes through our narrow TOML
// serializer to avoid clobbering sibling tables. Per-tool approvals are
// [mcp_servers.rig.tools.<tool>] tables with `approval_mode` (approve | prompt).
export default defineTargetContract({
  name: 'codex',
  display_name: 'Codex CLI',
  detect: async () => existsSync(path.join(homedir(), '.codex')),
  files: [
    {
      role: 'mcp_config',
      path: '~/.codex/config.toml',
      mode: 'write-toml',
      template: {
        mcp_servers: {
          rig: {
            command: '{{RIG_BIN}}',
            args: ['serve', '--mcp', '--client', 'codex'],
          },
        },
      },
    },
    {
      role: 'permissions',
      path: '~/.codex/config.toml',
      mode: 'write-toml',
      template: '{{GENERATED:codex.permissions.json}}',
    },
    {
      role: 'instructions',
      path: '~/.codex/AGENTS.md',
      mode: 'append-section',
      section_marker: '## Rig',
      template: '{{GENERATED:codex.instructions.md}}',
    },
  ],
  uninstall_strategy: 'reverse',
});
