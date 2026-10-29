// GENERATED FILE — DO NOT EDIT.
// Source: .contracts/anchors/cluster.contract.ts, .contracts/anchors/code-symbol.contract.ts, .contracts/anchors/conversation-waypoint.contract.ts, .contracts/anchors/declared-dependency.contract.ts, .contracts/anchors/markdown-section.contract.ts, .contracts/anchors/skill.contract.ts
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
  'cluster': {
    type: 'cluster',
    description: "AI-curated grouping of related anchors; created by rig_cluster",
    extractor: 'manual',
    ui: {"icon":"layers","color":"c-violet","label_field":"name","detail_fields":["rationale","members"]},
    allowed_edges: {"outgoing":["contains"],"incoming":["references"]},
    embeddable: true,
    embedding_text: ["name","rationale"],
  },
  'code-symbol': {
    type: 'code-symbol',
    description: "A function, class, method, or other code-level identifier",
    extractor: 'tree-sitter',
    ui: {"icon":"function","color":"c-teal","label_field":"name","detail_fields":["qualified_name","file_path","signature"]},
    allowed_edges: {"outgoing":["calls","imports","extends","implements","contains","references"],"incoming":["calls","extends","implements","contains","references"]},
    embeddable: true,
    embedding_text: ["name","qualified_name","docstring","signature"],
  },
  'conversation-waypoint': {
    type: 'conversation-waypoint',
    description: "A discrete decision/observation/constraint/open-question/principle/dead-end marker, dropped by the AI during a session or captured automatically from the conversation by a hook. Carries an analogy + summary + refs into the graph so future sessions can rehydrate the reasoning thread.",
    extractor: 'manual',
    ui: {"icon":"flag","color":"c-cyan","label_field":"title","detail_fields":["type","summary","analogy","key_terms"]},
    allowed_edges: {"outgoing":["waypoint_succeeds","waypoint_references"],"incoming":["waypoint_succeeds"]},
    embeddable: true,
    embedding_text: ["title","summary","analogy","key_terms"],
  },
  'declared-dependency': {
    type: 'declared-dependency',
    description: "A dependency declared in a package-manifest file (package.json, requirements.txt, pyproject.toml, etc.). Carries its version spec + dev/runtime classification on the node.",
    extractor: 'custom',
    ui: {"icon":"package","color":"c-violet","label_field":"name","detail_fields":["spec","manifest_path","source"]},
    allowed_edges: {"outgoing":["resolves_to"],"incoming":["manifest_declares","imports_package"]},
    embeddable: false,
    embedding_text: [],
  },
  'markdown-section': {
    type: 'markdown-section',
    description: "A heading inside a markdown document; nests by ATX heading level",
    extractor: 'custom',
    ui: {"icon":"heading","color":"c-amber","label_field":"name","detail_fields":["heading_path","file_path","level"]},
    allowed_edges: {"outgoing":["contains","references"],"incoming":["contains","references"]},
    embeddable: true,
    embedding_text: ["name","heading_path"],
  },
  'skill': {
    type: 'skill',
    description: "An AI-callable tool exposed by the MCP server (e.g. rig_pull, rig_search). Seeded from the tools-manifest at session startup.",
    extractor: 'manual',
    ui: {"icon":"wrench","color":"c-fuchsia","label_field":"name","detail_fields":["tier","summary"]},
    allowed_edges: {"outgoing":["references"],"incoming":["references","invoked_in_session"]},
    embeddable: true,
    embedding_text: ["name","description","summary"],
  },
};
