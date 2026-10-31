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
            args: ['serve', '--mcp'],
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
    // SessionStart hook (Codex reads ~/.codex/hooks.json, enabled by default
    // in current releases): delivers a handoff another session left, then
    // the brief. Codex marks new hooks for review and skips them until the
    // user trusts them in /hooks. User-level, so it runs in every project;
    // `rig hook` exits silently where there is no .rig/.
    // https://learn.chatgpt.com/docs/hooks
    {
      role: 'hooks',
      path: '~/.codex/hooks.json',
      mode: 'merge-json',
      template: {
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume|clear|compact',
              hooks: [
                {
                  type: 'command',
                  command: '{{RIG_BIN}} hook SessionStart --client codex',
                  timeout: 10,
                  statusMessage: 'rig: loading handoff',
                },
              ],
            },
          ],
        },
      },
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
