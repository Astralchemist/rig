import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { Language as WasmLanguage, Parser } from 'web-tree-sitter';
import type { Language } from './upstream-types.ts';

const require = createRequire(import.meta.url);

const WASM_BY_LANGUAGE: Partial<Record<Language, string>> = {
  typescript: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-wasms/out/tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
  python: 'tree-sitter-wasms/out/tree-sitter-python.wasm',
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
  if (!parserReady) parserReady = Parser.init();
  await parserReady;
  let wasmLang = languageCache.get(lang);
  if (!wasmLang) {
    const wasmRel = WASM_BY_LANGUAGE[lang];
    if (!wasmRel) return null;
    const wasmPath = require.resolve(wasmRel);
    const wasmBytes = await readFile(wasmPath);
    wasmLang = await WasmLanguage.load(wasmBytes);
    languageCache.set(lang, wasmLang);
  }
  const parser = new Parser();
  parser.setLanguage(wasmLang);
  return parser;
}
