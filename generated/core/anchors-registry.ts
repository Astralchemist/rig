// GENERATED FILE — DO NOT EDIT.
// Source: .contracts/anchors/code-symbol.contract.ts
// Edit the .contract.ts file(s), then run `bun run gen`.

export interface AnchorTypeMeta {
  type: string;
  description: string;
  extractor: 'tree-sitter' | 'custom' | 'manual';
  ui: { icon: string; color: string; label_field: string; detail_fields?: string[] };
  allowed_edges: { outgoing?: string[]; incoming?: string[] };
  embeddable: boolean;
  embedding_text: string[];
}

export const ANCHOR_REGISTRY: Record<string, AnchorTypeMeta> = {
  'code-symbol': {
    type: 'code-symbol',
    description: "A function, class, method, or other code-level identifier",
    extractor: 'tree-sitter',
    ui: {"icon":"function","color":"c-teal","label_field":"name","detail_fields":["qualified_name","file_path","signature"]},
    allowed_edges: {"outgoing":["calls","imports","extends","implements","contains","references"],"incoming":["calls","extends","implements","contains","references"]},
    embeddable: true,
    embedding_text: ["name","qualified_name","docstring","signature"],
  },
};
