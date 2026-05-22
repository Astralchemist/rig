import type { LoadedContract, GeneratedFile } from '../types.ts';
import { tsHeader } from '../header.ts';

export const emitAnchorRegistry = (anchors: LoadedContract<'anchors'>[]): GeneratedFile => {
  const entries = anchors
    .map((a) => {
      const d = a.data;
      return `  '${d.type}': {
    type: '${d.type}',
    description: ${JSON.stringify(d.description)},
    extractor: '${d.extractor}',
    ui: ${JSON.stringify(d.ui)},
    allowed_edges: ${JSON.stringify(d.allowed_edges)},
    embeddable: ${d.embeddable ?? false},
    embedding_text: ${JSON.stringify(d.embedding_text ?? [])},
  }`;
    })
    .join(',\n');
  return {
    path: 'core/anchors-registry.ts',
    content:
      tsHeader(anchors.map((a) => a.file)) +
      `export interface AnchorTypeMeta {
  type: string;
  description: string;
  extractor: 'tree-sitter' | 'custom' | 'manual';
  ui: { icon: string; color: string; label_field: string; detail_fields?: string[] };
  allowed_edges: { outgoing?: string[]; incoming?: string[] };
  embeddable: boolean;
  embedding_text: string[];
}

export const ANCHOR_REGISTRY: Record<string, AnchorTypeMeta> = {
${entries},
};
`,
    source: anchors.map((a) => a.file),
  };
};
