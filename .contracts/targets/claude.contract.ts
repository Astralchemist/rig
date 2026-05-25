// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { defineTargetContract } from '@rig/contracts';

export default defineTargetContract({
  name: 'claude',
  display_name: 'Claude Code',
  detect: async () => existsSync(path.join(homedir(), '.claude.json')),
  files: [
    {
      role: 'mcp_config',
      path: '~/.claude.json',
      mode: 'merge-json',
      template: {
        mcpServers: {
          rig: { type: 'stdio', command: '{{RIG_BIN}}', args: ['serve', '--mcp'] },
        },
      },
    },
    {
      role: 'permissions',
      path: '~/.claude/settings.json',
      mode: 'merge-json',
      template: '{{GENERATED:claude.permissions.json}}',
    },
    {
      role: 'instructions',
      path: '~/.claude/CLAUDE.md',
      mode: 'append-section',
      section_marker: '## Rig',
      template: '{{GENERATED:claude.instructions.md}}',
    },
  ],
  uninstall_strategy: 'reverse',
});
