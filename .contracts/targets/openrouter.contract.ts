// SPDX-License-Identifier: Apache-2.0
import { defineTargetContract } from '@rig/contracts';

// OpenRouter is an OpenAI-compatible API, not an MCP host (#1): nothing reads
// these files. `rig install openrouter` writes them as a reference — an MCP
// server entry and the tool guidance to copy into whichever MCP client talks to
// OpenRouter (Cline, Continue, LibreChat, …) — and says so. It is never
// auto-detected, so `rig start` never writes it.
const REFERENCE =
  'reference only — OpenRouter is an API, not an MCP host, so nothing reads this file.';

export default defineTargetContract({
  name: 'openrouter',
  display_name: 'OpenRouter',
  detect: async () => false,
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
      note: `${REFERENCE} Copy its mcpServers.rig entry into the MCP client you use with OpenRouter (Cline, Continue, LibreChat, …).`,
    },
    {
      role: 'instructions',
      path: '~/.config/openrouter/AGENTS.md',
      mode: 'append-section',
      section_marker: '## Rig',
      template: '{{GENERATED:openrouter.instructions.md}}',
      note: `${REFERENCE} Paste the rig section into that client's custom instructions.`,
    },
  ],
  uninstall_strategy: 'reverse',
});
