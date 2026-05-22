import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LoadedContract, GeneratedFile } from '../types.ts';
import { tsHeader } from '../header.ts';

export const emitToolsManifest = (tools: LoadedContract<'tools'>[]): GeneratedFile => {
  const entries = tools.map((t) => ({
    name: t.data.name,
    description: t.data.summary,
    tier: t.data.tier,
    inputSchema: zodToJsonSchema(t.data.input, { target: 'jsonSchema7' }),
    outputSchema: zodToJsonSchema(t.data.output, { target: 'jsonSchema7' }),
    errors: t.data.errors ?? [],
  }));
  return {
    path: 'mcp/tools-manifest.json',
    content: JSON.stringify({ version: 1, tools: entries }, null, 2) + '\n',
    source: tools.map((t) => t.file),
  };
};

const tierGuards = (t: LoadedContract<'tools'>): string => {
  const lines: string[] = [];
  if (t.data.tier === 'heavy') {
    lines.push(
      `    if (ctx.isMainSession) {`,
      `      throw new ToolError('MAIN_SESSION_FORBIDDEN', '${t.data.name} cannot run in the main session');`,
      `    }`,
    );
  }
  if (t.data.tier === 'write') {
    lines.push(
      `    if (!ctx.provenance) {`,
      `      throw new ToolError('PROVENANCE_REQUIRED', '${t.data.name} requires provenance');`,
      `    }`,
    );
  }
  return lines.length ? lines.join('\n') + '\n' : '';
};

const rationaleGuard = (t: LoadedContract<'tools'>): string => {
  if (t.data.tier !== 'write' || !t.data.requires_rationale) return '';
  return (
    `    const rationale = (parsedIn.data as { rationale?: unknown }).rationale;\n` +
    `    if (typeof rationale !== 'string' || rationale.trim().length === 0) {\n` +
    `      throw new ToolError('RATIONALE_REQUIRED', '${t.data.name} requires a non-empty rationale');\n` +
    `    }\n`
  );
};

export const emitToolHandlerStubs = (tools: LoadedContract<'tools'>[]): GeneratedFile[] =>
  tools.map((t) => {
    const camel = t.basename.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const flags =
      (t.data.main_session_forbidden ? `  mainSessionForbidden: true,\n` : '') +
      (t.data.provenance_required ? `  provenanceRequired: true,\n` : '') +
      (t.data.requires_rationale ? `  requiresRationale: true,\n` : '');
    const body = `${tsHeader([t.file])}import type { ToolHandler } from '@rig/mcp/dispatch.ts';
import { ToolError } from '@rig/mcp/dispatch.ts';
import contract from '../../../.contracts/tools/${t.basename}.contract.ts';
import { run as impl } from '@rig/mcp/tool-impls/${t.basename}.ts';

export const ${camel}Handler: ToolHandler = {
  name: '${t.data.name}',
  tier: '${t.data.tier}',
${flags}  run: async (args, ctx) => {
${tierGuards(t)}    const parsedIn = contract.input.safeParse(args);
    if (!parsedIn.success) {
      throw new ToolError('INPUT_INVALID', parsedIn.error.message);
    }
${rationaleGuard(t)}    const out = await impl(parsedIn.data, ctx);
    const parsedOut = contract.output.safeParse(out);
    if (!parsedOut.success) {
      throw new ToolError('OUTPUT_INVALID', parsedOut.error.message);
    }
    return parsedOut.data;
  },
};
`;
    return { path: `mcp/handlers/${t.basename}.handler.ts`, content: body, source: [t.file] };
  });

export const emitToolNamesIndex = (tools: LoadedContract<'tools'>[]): GeneratedFile => {
  const lines = tools.map((t) => {
    const camel = t.basename.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return `export { ${camel}Handler } from './handlers/${t.basename}.handler.ts';`;
  });
  return {
    path: 'mcp/handlers-index.ts',
    content: tsHeader(tools.map((t) => t.file)) + lines.join('\n') + '\n',
    source: tools.map((t) => t.file),
  };
};
