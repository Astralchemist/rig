import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { defineTargetContract } from '@rig/contracts';

// opencode uses an mcp.<name> wrapper (not mcpServers), takes `command` as a
// combined string-array, and includes an explicit `enabled` flag. Reads and
// writes go through jsonc-parser so user comments in opencode.jsonc survive
// idempotent re-runs.
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
            command: ['{{RIG_BIN}}', 'serve', '--mcp'],
            enabled: true,
          },
        },
      },
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
