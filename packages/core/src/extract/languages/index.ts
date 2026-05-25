// SPDX-License-Identifier: Apache-2.0
// Rig-native registry — Phase 1.2 ships only TS / JS / Python.
// (Original CodeGraph index.ts pulled in 19 languages; we add the rest lazily.)

import { javascriptExtractor } from './javascript.ts';
import { pythonExtractor } from './python.ts';
import { typescriptExtractor } from './typescript.ts';
import type { Language } from '../upstream-types.ts';
import type { LanguageExtractor } from '../tree-sitter-types.ts';

export const EXTRACTORS: Partial<Record<Language, LanguageExtractor>> = {
  typescript: typescriptExtractor,
  tsx: typescriptExtractor,
  javascript: javascriptExtractor,
  jsx: javascriptExtractor,
  python: pythonExtractor,
};
