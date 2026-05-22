import type { LoadedContract, GeneratedFile } from '../types.ts';
import { mdHeader } from '../header.ts';

export const emitTargetArtifacts = (
  targets: LoadedContract<'targets'>[],
  tools: LoadedContract<'tools'>[],
): GeneratedFile[] => {
  const out: GeneratedFile[] = [];
  for (const t of targets) {
    out.push(buildPermissions(t, tools));
    out.push(buildInstructions(t, tools));
  }
  return out;
};

const buildPermissions = (
  target: LoadedContract<'targets'>,
  tools: LoadedContract<'tools'>[],
): GeneratedFile => {
  const allow: string[] = [];
  const ask: string[] = [];
  for (const tool of tools) {
    const level = tool.data.permissions?.[target.data.name];
    const id = `mcp__rig__${tool.data.name}`;
    if (level === 'auto-allow' || level === 'allow') allow.push(id);
    else if (level === 'ask') ask.push(id);
  }
  return {
    path: `installer/${target.data.name}.permissions.json`,
    content: JSON.stringify({ permissions: { allow, ask } }, null, 2) + '\n',
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
  lines.push('## Two-tier gate', '');
  lines.push('NEVER call `rig_explore` or `rig_context` directly in the main session — spawn a sub-agent for these.');
  return {
    path: `installer/${target.data.name}.instructions.md`,
    content: mdHeader([target.file]) + lines.join('\n') + '\n',
    source: [target.file, ...tools.map((t) => t.file)],
  };
};
