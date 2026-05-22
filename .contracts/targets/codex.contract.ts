import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { defineTargetContract } from '@rig/contracts';

// Codex CLI keeps all config under ~/.codex/ (no project-local concept). The
// mcp server entry lives in a dotted-key TOML table — the writer goes through
// our narrow TOML serializer to avoid clobbering sibling tables.
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
      role: 'instructions',
      path: '~/.codex/AGENTS.md',
      mode: 'append-section',
      section_marker: '## Rig',
      template: '{{GENERATED:codex.instructions.md}}',
    },
  ],
  uninstall_strategy: 'reverse',
});
