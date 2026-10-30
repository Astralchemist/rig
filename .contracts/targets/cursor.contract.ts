// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { defineTargetContract } from '@rig/contracts';

// Cursor reads project MCP servers from .cursor/mcp.json and user-wide ones
// from ~/.cursor/mcp.json (https://cursor.com/docs/context/mcp). Rules are
// per project only (.cursor/rules/*.mdc), so --global writes just the server.
// Cursor launches MCP subprocesses with the wrong cwd and skips `rootUri` in
// the initialize call, so we pass `--path` ourselves. `${workspaceFolder}` is
// Cursor's documented config interpolation: it expands to the open project in
// both files, so a user-wide entry serves whichever project is open instead of
// pinning every workspace to the directory `rig install` ran in.
const server = {
  mcpServers: {
    rig: {
      type: 'stdio',
      command: '{{RIG_BIN}}',
      args: ['serve', '--mcp', '--path', '${workspaceFolder}', '--client', 'cursor'],
    },
  },
};

export default defineTargetContract({
  name: 'cursor',
  display_name: 'Cursor',
  detect: async () => existsSync(path.join(homedir(), '.cursor')),
  files: [
    {
      role: 'mcp_config',
      path: '.cursor/mcp.json',
      mode: 'merge-json',
      template: server,
    },
    {
      // The Cursor CLI's documented per-project permissions (Mcp(server:tool)).
      // The editor's MCP allowlist is a settings-UI setting with no file to write.
      role: 'permissions',
      path: '.cursor/cli.json',
      mode: 'merge-json',
      template: '{{GENERATED:cursor.permissions.json}}',
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
    {
      role: 'mcp_config',
      path: '~/.cursor/mcp.json',
      mode: 'merge-json',
      template: server,
      note: 'Cursor rules are per project — run `rig install cursor` inside a project to add .cursor/rules/rig.mdc.',
    },
  ],
  uninstall_strategy: 'reverse',
});
