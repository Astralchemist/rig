// SPDX-License-Identifier: Apache-2.0
import { basename } from 'node:path';
import { visit } from './ast-visitor.ts';
import { detectLanguage, getParser } from './grammars.ts';
import { EXTRACTORS } from './languages/index.ts';
import { extractPackageJson } from './manifests/package-json.ts';
import { extractPyprojectToml } from './manifests/pyproject-toml.ts';
import { extractRequirementsTxt } from './manifests/requirements-txt.ts';
import { extractMarkdown } from './markdown.ts';
import { fileIdOf, makeFileNode } from './node-builders.ts';
import type {
  Edge,
  ExtractionResult,
  Language,
  Node,
  UnresolvedReference,
} from './upstream-types.ts';

// Version of the extraction output (nodes, ids, direct edges, refs). Index and
// sync skip a file only when its content hash AND the version stored with it
// match, so bump this whenever an extractor change would produce different
// rows for the same source; otherwise unchanged files keep stale extraction.
// 2: markdown sections carry a body excerpt.
export const EXTRACTOR_VERSION = 2;

export async function extractFromSource(
  filePath: string,
  source: string,
  langOverride?: Language,
): Promise<ExtractionResult> {
  const start = Date.now();
  const language = langOverride ?? detectLanguage(filePath);
  const empty: ExtractionResult = {
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [],
    durationMs: 0,
  };

  if (language === 'markdown') {
    return { ...extractMarkdown(filePath, source), durationMs: Date.now() - start };
  }

  if (language === 'json') {
    const base = basename(filePath).toLowerCase();
    if (base === 'package.json') {
      return { ...extractPackageJson(filePath, source), durationMs: Date.now() - start };
    }
    if (base.endsWith('requirements.txt') || base.endsWith('requirements-dev.txt') || base.endsWith('dev-requirements.txt') || base.endsWith('requirements-test.txt')) {
      return { ...extractRequirementsTxt(filePath, source), durationMs: Date.now() - start };
    }
    if (base === 'pyproject.toml') {
      return { ...extractPyprojectToml(filePath, source), durationMs: Date.now() - start };
    }
  }

  const parser = await getParser(language);
  const extractor = EXTRACTORS[language];
  if (!parser || !extractor) return { ...empty, durationMs: Date.now() - start };

  const tree = parser.parse(source);
  if (!tree) return { ...empty, durationMs: Date.now() - start };

  const fileId = fileIdOf(filePath);
  const nodes: Node[] = [makeFileNode(fileId, filePath, language)];
  const refs: UnresolvedReference[] = [];
  const edges: Edge[] = [];
  visit(tree.rootNode, {
    extractor,
    filePath,
    language,
    nodes,
    edges,
    refs,
    scope: [{ id: fileId, name: filePath, kind: 'file' }],
    source,
  });
  return {
    nodes,
    edges,
    unresolvedReferences: refs,
    errors: [],
    durationMs: Date.now() - start,
  };
}

export type { ExtractionResult, Node, UnresolvedReference } from './upstream-types.ts';
