import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { defineTargetContract } from '@rig/contracts';

// Cursor launches MCP subprocesses with the wrong cwd and skips `rootUri` in
// the initialize call, so we inject `--path` ourselves. The writer substitutes
// {{CURSOR_PATH}} with `${workspaceFolder}` (global) or an absolute path (local).
export default defineTargetContract({
  name: 'cursor',
  display_name: 'Cursor',
  detect: async () => existsSync(path.join(homedir(), '.cursor')),
  files: [
    {
      role: 'mcp_config',
      path: '~/.cursor/mcp.json',
      mode: 'merge-json',
      template: {
        mcpServers: {
          rig: {
            type: 'stdio',
            command: '{{RIG_BIN}}',
            args: ['serve', '--mcp', '--path', '{{CURSOR_PATH}}'],
          },
        },
      },
    },
    {
      role: 'instructions',
      path: '.cursor/rules/rig.mdc',
      mode: 'replace',
      template: '{{GENERATED:cursor.instructions.md}}',
    },
  ],
  uninstall_strategy: 'reverse',
});
