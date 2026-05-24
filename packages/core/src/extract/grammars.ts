import { extname } from 'node:path';
import { Language as WasmLanguage, Parser } from 'web-tree-sitter';
import type { Language } from './upstream-types.ts';
import * as wasm from './wasm-embedded.ts';

const WASM_BY_LANGUAGE: Partial<Record<Language, Uint8Array>> = {
  typescript: wasm.typescript,
  tsx: wasm.tsx,
  javascript: wasm.javascript,
  jsx: wasm.javascript,
  python: wasm.python,
};

const EXTENSION_LANGUAGE: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.py': 'python',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

let parserReady: Promise<void> | null = null;
const languageCache = new Map<Language, WasmLanguage>();

export const detectLanguage = (filePath: string): Language => {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGE[ext] ?? 'unknown';
};

export const isSupportedSource = (filePath: string): boolean => {
  const lang = detectLanguage(filePath);
  return lang !== 'unknown';
};

export async function getParser(lang: Language): Promise<Parser | null> {
  if (lang === 'markdown' || lang === 'unknown') return null;
  if (!parserReady) parserReady = Parser.init({ wasmBinary: wasm.runtime });
  await parserReady;
  let wasmLang = languageCache.get(lang);
  if (!wasmLang) {
    const bytes = WASM_BY_LANGUAGE[lang];
    if (!bytes) return null;
    wasmLang = await WasmLanguage.load(bytes);
    languageCache.set(lang, wasmLang);
  }
  const parser = new Parser();
  parser.setLanguage(wasmLang);
  return parser;
}
