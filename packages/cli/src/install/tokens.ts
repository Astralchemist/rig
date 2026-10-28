// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TokenContext {
  rigBin: string;
  generatedDir: string;
}

const WHOLE = /^\{\{GENERATED:([^}]+)\}\}$/;
const INLINE = /\{\{GENERATED:([^}]+)\}\}/g;

const substituteScalars = (s: string, ctx: TokenContext): string =>
  s.replaceAll('{{RIG_BIN}}', ctx.rigBin);

const loadRaw = (name: string, ctx: TokenContext): Promise<string> =>
  readFile(join(ctx.generatedDir, name), 'utf-8');

async function expandString(s: string, ctx: TokenContext): Promise<unknown> {
  // Whole-string token: parse JSON for *.json, raw text otherwise.
  const whole = WHOLE.exec(s);
  if (whole) {
    const name = whole[1]!;
    const raw = await loadRaw(name, ctx);
    return name.endsWith('.json') ? (JSON.parse(raw) as unknown) : raw;
  }
  // Inline tokens inside a longer string: always raw text. JSON parsing makes
  // no sense when the result must remain a string.
  let result = s;
  for (const m of [...s.matchAll(INLINE)]) {
    const raw = await loadRaw(m[1]!, ctx);
    result = result.split(m[0]).join(raw);
  }
  return substituteScalars(result, ctx);
}

export async function expandTokens(value: unknown, ctx: TokenContext): Promise<unknown> {
  if (typeof value === 'string') return expandString(value, ctx);
  if (Array.isArray(value)) return Promise.all(value.map((v) => expandTokens(v, ctx)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await expandTokens(v, ctx);
    }
    return out;
  }
  return value;
}
