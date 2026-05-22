import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TokenContext {
  rigBin: string;
  cursorPath: string;
  generatedDir: string;
}

const GEN_PREFIX = '{{GENERATED:';
const GEN_SUFFIX = '}}';

const substituteScalars = (s: string, ctx: TokenContext): string =>
  s.replaceAll('{{RIG_BIN}}', ctx.rigBin).replaceAll('{{CURSOR_PATH}}', ctx.cursorPath);

async function loadGenerated(name: string, ctx: TokenContext): Promise<unknown> {
  const raw = await readFile(join(ctx.generatedDir, name), 'utf-8');
  return name.endsWith('.json') ? (JSON.parse(raw) as unknown) : raw;
}

// Walks the template tree. Strings get scalar substitution and the special
// {{GENERATED:name}} form, which loads + parses the matching file from the
// generated/installer/ tree.
export async function expandTokens(value: unknown, ctx: TokenContext): Promise<unknown> {
  if (typeof value === 'string') {
    if (value.startsWith(GEN_PREFIX) && value.endsWith(GEN_SUFFIX)) {
      const name = value.slice(GEN_PREFIX.length, -GEN_SUFFIX.length);
      return loadGenerated(name, ctx);
    }
    return substituteScalars(value, ctx);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => expandTokens(v, ctx)));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await expandTokens(v, ctx);
    }
    return out;
  }
  return value;
}
