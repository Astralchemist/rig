import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_session_token',
  tier: 'light',
  summary: 'Hand the user a one-click login URL for the local map',
  description: `
Read the per-server bearer token from .rig/.runtime and return both the raw
token and a clickable URL the user can paste into their browser to log into
the map. Used when "open the rig map" comes up in chat — the agent fetches the
token (because it has filesystem access to .rig/), the user clicks the URL,
and the cookie gets set.

Returns 'no_runtime_token' in errors when the server isn't running with auth
enabled (loopback dev mode skips the token by default).
  `.trim(),
  input: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(7474),
    })
    .strict(),
  output: z.object({
    token: z.string(),
    login_url: z.string(),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'NO_RUNTIME_TOKEN'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: false,
});
