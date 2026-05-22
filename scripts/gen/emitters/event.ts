import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LoadedContract, GeneratedFile } from '../types.ts';
import { tsHeader } from '../header.ts';

export const emitEventTypes = (events: LoadedContract<'events'>[]): GeneratedFile => {
  const lines: string[] = [];
  for (const e of events) {
    const schema = JSON.stringify(zodToJsonSchema(e.data.payload, { target: 'jsonSchema7' }), null, 2);
    lines.push(`// ${e.data.name}\n// payload (JSON Schema):\n// ${schema.replace(/\n/g, '\n// ')}`);
  }
  const union = events
    .map((e) => `  | { type: '${e.data.name}'; payload: unknown /* see schema above */ }`)
    .join('\n');
  return {
    path: 'web/ws-events.ts',
    content:
      tsHeader(events.map((e) => e.file)) +
      `${lines.join('\n\n')}\n\nexport type WsEvent =\n${union || '  | never'};\n`,
    source: events.map((e) => e.file),
  };
};
