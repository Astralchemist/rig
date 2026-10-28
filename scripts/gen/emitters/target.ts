// SPDX-License-Identifier: Apache-2.0
import type { LoadedContract, GeneratedFile } from '../types.ts';
import { mdHeader } from '../header.ts';

export const emitTargetArtifacts = (
  targets: LoadedContract<'targets'>[],
  tools: LoadedContract<'tools'>[],
): GeneratedFile[] => {
  const out: GeneratedFile[] = [];
  for (const t of targets) {
    // Only hosts with a per-tool approval config get a policy file; nothing
    // would read one for the others.
    if (t.data.files.some((f) => f.role === 'permissions')) out.push(buildPermissions(t, tools));
    out.push(buildInstructions(t, tools));
  }
  return out;
};

interface Policy {
  allow: string[];
  ask: string[];
}

// The MCP server name every target registers rig under.
const SERVER = 'rig';

// Each host spells "run without asking" / "ask first" for one MCP tool in its
// own config format:
//   claude    settings.json permissions.allow / .ask with mcp__<server>__<tool>
//             https://code.claude.com/docs/en/permissions#mcp
//   cursor    .cursor/cli.json permissions.allow with Mcp(<server>:<tool>);
//             there is no ask list, unlisted tools prompt (Cursor CLI only)
//             https://cursor.com/docs/cli/reference/permissions
//   codex     [mcp_servers.<server>.tools.<tool>] approval_mode = approve | prompt
//             https://developers.openai.com/codex/config-reference
//   opencode  permission.<server>_<tool> = allow | ask
//             https://opencode.ai/docs/tools/ · https://opencode.ai/docs/permissions/
const PERMISSION_FORMATS: Record<string, (p: Policy) => unknown> = {
  claude: ({ allow, ask }) => ({
    permissions: {
      allow: allow.map((t) => `mcp__${SERVER}__${t}`),
      ask: ask.map((t) => `mcp__${SERVER}__${t}`),
    },
  }),
  cursor: ({ allow }) => ({ permissions: { allow: allow.map((t) => `Mcp(${SERVER}:${t})`) } }),
  codex: ({ allow, ask }) => ({
    mcp_servers: {
      [SERVER]: {
        tools: Object.fromEntries([
          ...allow.map((t) => [t, { approval_mode: 'approve' }]),
          ...ask.map((t) => [t, { approval_mode: 'prompt' }]),
        ]),
      },
    },
  }),
  opencode: ({ allow, ask }) => ({
    permission: Object.fromEntries([
      ...allow.map((t) => [`${SERVER}_${t}`, 'allow']),
      ...ask.map((t) => [`${SERVER}_${t}`, 'ask']),
    ]),
  }),
};

const buildPermissions = (
  target: LoadedContract<'targets'>,
  tools: LoadedContract<'tools'>[],
): GeneratedFile => {
  const format = PERMISSION_FORMATS[target.data.name];
  if (!format) {
    throw new Error(`${target.file}: declares a permissions file but no permission format is known for '${target.data.name}'`);
  }
  const allow: string[] = [];
  const ask: string[] = [];
  for (const tool of tools) {
    const level = tool.data.permissions?.[target.data.name];
    const id = tool.data.name;
    if (level === 'auto-allow' || level === 'allow') allow.push(id);
    else if (level === 'ask') ask.push(id);
  }
  return {
    path: `installer/${target.data.name}.permissions.json`,
    content: JSON.stringify(format({ allow, ask }), null, 2) + '\n',
    source: [target.file, ...tools.map((t) => t.file)],
  };
};

const buildInstructions = (
  target: LoadedContract<'targets'>,
  tools: LoadedContract<'tools'>[],
): GeneratedFile => {
  const lines = [`# Rig — ${target.data.display_name} instructions`, ''];
  lines.push('Rig exposes these MCP tools. Always prefer them over file reads for graph questions.', '');
  for (const tier of ['light', 'heavy', 'write', 'live'] as const) {
    const inTier = tools.filter((t) => t.data.tier === tier);
    if (!inTier.length) continue;
    lines.push(`## ${tier} tools`, '');
    for (const tool of inTier) {
      lines.push(`### \`${tool.data.name}\``, '', tool.data.description, '');
    }
  }
  lines.push('## Context budget', '');
  lines.push(
    '`rig_explore` and `rig_context` return full source bodies, so a call costs far more context than the light tools. Navigate with the light tools first and call a heavy tool once you know which code you need. They work from any session; if you can hand heavy exploration to a sub-agent, doing so keeps the main context lean.',
    '',
  );
  lines.push(
    'Heavy responses are capped at about 60,000 characters. A source cut to fit ends with a `… [truncated: N of M lines shown]` line and the result has `truncated: true` — lower `max_anchors` / `max_nodes` or narrow the query to get whole bodies.',
    '',
  );
  lines.push('## Session bootstrap', '');
  lines.push(
    'At the start of a new conversation, before responding to the user, call `rig_waypoints` with `session_id="last"` and `limit=20`. The returned waypoints are the prior session\'s structured decision/observation markers — read them to reorient on what was decided, what constraints are in play, and what open questions remain. Do not re-derive context the prior session already settled.',
    '',
  );
  lines.push(
    'Drop a waypoint via `rig_drop_waypoint` when: a real decision is locked, the user states a hard constraint, an observation recurs across turns, or an open question emerges that should outlive context compaction. Aim for at most one waypoint per ~5 turns — they are not a running summary.',
  );
  return {
    path: `installer/${target.data.name}.instructions.md`,
    content: mdHeader([target.file]) + lines.join('\n') + '\n',
    source: [target.file, ...tools.map((t) => t.file)],
  };
};
