// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { defineTargetContract } from '@rig/contracts';

// Project scope (the default) writes where Claude Code reads per-project config:
// .mcp.json (project MCP servers), .claude/settings.json (shared project
// settings) and CLAUDE.md — so rig's instructions only reach sessions in a
// project that has a graph. `rig install claude --global` writes the user-level
// equivalents instead, which apply to every project.
// Formats: https://code.claude.com/docs/en/mcp · https://code.claude.com/docs/en/settings
export default defineTargetContract({
  name: 'claude',
  display_name: 'Claude Code',
  detect: async () => existsSync(path.join(homedir(), '.claude.json')),
  files: [
    {
      role: 'mcp_config',
      path: '.mcp.json',
      mode: 'merge-json',
      // The documented .mcp.json stdio entry: command + args, no `type`
      // (Claude Code reads an entry without one as stdio).
      template: {
        mcpServers: {
          rig: { command: '{{RIG_BIN}}', args: ['serve', '--mcp'] },
        },
      },
      note: 'Claude Code asks once before it starts a server from .mcp.json — approve `rig` the next time you run `claude` here.',
    },
    {
      role: 'permissions',
      path: '.claude/settings.json',
      mode: 'merge-json',
      template: '{{GENERATED:claude.permissions.json}}',
    },
    // Automatic capture (`rig hook`): the per-prompt and per-tool hooks only
    // append to a spool; Stop and PreCompact capture the transcript (Stop in
    // the background); SessionEnd queues within its 1.5s budget; SessionStart
    // injects the brief. Project scope only: a hook outside a rig project
    // does nothing. https://code.claude.com/docs/en/hooks
    // `rig install claude --no-hooks` leaves (or takes) them out.
    {
      role: 'hooks',
      path: '.claude/settings.json',
      mode: 'merge-json',
      template: {
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume|compact',
              hooks: [
                {
                  type: 'command',
                  command: '{{RIG_BIN}} hook SessionStart --client claude',
                  timeout: 10,
                },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '{{RIG_BIN}} hook UserPromptSubmit --client claude',
                  timeout: 5,
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: '{{RIG_BIN}} hook PostToolUse --client claude',
                  timeout: 5,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '{{RIG_BIN}} hook Stop --client claude',
                  timeout: 60,
                  async: true,
                },
              ],
            },
          ],
          PreCompact: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '{{RIG_BIN}} hook PreCompact --client claude',
                  timeout: 60,
                },
              ],
            },
          ],
          SessionEnd: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '{{RIG_BIN}} hook SessionEnd --client claude',
                  timeout: 2,
                },
              ],
            },
          ],
        },
      },
    },
    {
      role: 'instructions',
      path: 'CLAUDE.md',
      mode: 'append-section',
      section_marker: '## Rig',
      template: '{{GENERATED:claude.instructions.md}}',
    },
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
