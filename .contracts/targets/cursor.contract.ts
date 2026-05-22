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
      // Cursor .mdc rules need YAML-ish frontmatter so the rule is loaded
      // unconditionally instead of pattern-matched against the open file.
      template:
        '---\ndescription: Rig MCP usage guide — when to use which tool\nalwaysApply: true\n---\n\n{{GENERATED:cursor.instructions.md}}',
    },
  ],
  uninstall_strategy: 'reverse',
});
