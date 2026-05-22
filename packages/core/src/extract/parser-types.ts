export interface ParsedNode {
  type: string;
  name: string;
  data: Record<string, unknown>;
}

export interface ParsedEdge {
  srcName: string;
  dstName: string;
  kind: string;
}

export interface ParseResult {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  unresolved: { srcName: string; targetName: string; line: number }[];
}

export interface Parser {
  readonly language: string;
  parse(source: string, filePath: string): ParseResult;
}
