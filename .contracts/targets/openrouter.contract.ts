import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { defineTargetContract } from '@rig/contracts';

// OpenRouter is an OpenAI-compatible API, not an MCP host. This target writes
// a reference MCP server entry that OpenRouter users can point any MCP-capable
// client at (Cline, Continue, LibreChat, etc.). Detection is best-effort —
// either the conventional config dir exists, or an OPENROUTER_API_KEY is set.
export default defineTargetContract({
  name: 'openrouter',
  display_name: 'OpenRouter',
  detect: async () =>
    existsSync(path.join(homedir(), '.config', 'openrouter')) ||
    !!process.env.OPENROUTER_API_KEY,
  files: [
    {
      role: 'mcp_config',
      path: '~/.config/openrouter/mcp.json',
      mode: 'merge-json',
      template: {
        mcpServers: {
          rig: {
            type: 'stdio',
            command: '{{RIG_BIN}}',
            args: ['serve', '--mcp'],
          },
        },
      },
    },
    {
      role: 'instructions',
      path: '~/.config/openrouter/AGENTS.md',
      mode: 'append-section',
      section_marker: '## Rig',
      template: '{{GENERATED:openrouter.instructions.md}}',
    },
  ],
  uninstall_strategy: 'reverse',
});
