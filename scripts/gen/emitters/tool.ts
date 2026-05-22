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

export const emitToolHandlerStubs = (tools: LoadedContract<'tools'>[]): GeneratedFile[] =>
  tools.map((t) => {
    const camel = t.basename.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const body = `${tsHeader([t.file])}import type { ToolHandler } from '@rig/mcp/dispatch.ts';
import { run as impl } from '@rig/mcp/tool-impls/${t.basename}.ts';

export const ${camel}Handler: ToolHandler = {
  name: '${t.data.name}',
  tier: '${t.data.tier}',
  ${t.data.main_session_forbidden ? 'mainSessionForbidden: true,\n  ' : ''}${t.data.provenance_required ? 'provenanceRequired: true,\n  ' : ''}${t.data.requires_rationale ? 'requiresRationale: true,\n  ' : ''}run: impl,
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
