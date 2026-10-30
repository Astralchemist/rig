// SPDX-License-Identifier: Apache-2.0
// What a change can break, and which recorded memory it may invalidate.
//
// A unified diff (`git diff -U0`) is mapped to the symbols whose line ranges
// it touches (the innermost symbol per hunk, so a changed method doesn't also
// count its class), then the graph is walked backwards over dependency edges
// to the symbols that depend on them. Waypoints anchored to a changed symbol,
// or to a changed file, are the memory at risk. This is the core of
// `rig impact --diff` and of the PR action (backlog E5).
import type { SqliteAdapter } from '../db/adapter.ts';
import type { WaypointRow } from '../db/waypoint-queries.ts';

/** Changed line ranges in the new version of a file, 1-based and inclusive. */
export type LineRange = [number, number];

/**
 * New-side line ranges per file from a unified diff. A hunk that only deletes
 * lines (`+l,0`) is kept as the line it sits after, so the symbol around the
 * deletion still counts as changed. Deleted files are left out: nothing in
 * the new version is there to depend on them.
 */
export const parseUnifiedDiff = (
  diff: string,
  side: 'new' | 'old' = 'new',
): Map<string, LineRange[]> => {
  // `side: 'old'` reads the removed side instead (paths from `--- a/…`,
  // ranges from `-l,n`): the parent's lines a change touches.
  const out = new Map<string, LineRange[]>();
  let file: string | null = null;
  const header = side === 'new' ? '+++ ' : '--- ';
  const prefix = side === 'new' ? /^b\// : /^a\//;
  for (const line of diff.split('\n')) {
    if (line.startsWith(header)) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(prefix, '');
      continue;
    }
    if (!file || !line.startsWith('@@')) continue;
    const m =
      side === 'new'
        ? /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
        : /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const range: LineRange =
      count === 0 ? [Math.max(1, start), Math.max(1, start)] : [start, start + count - 1];
    const list = out.get(file);
    if (list) list.push(range);
    else out.set(file, [range]);
  }
  return out;
};

/** Files the diff creates (`--- /dev/null`): their code is new, so nothing existing depends on it yet. */
export const addedFilesInDiff = (diff: string): Set<string> => {
  const out = new Set<string>();
  let fromNull = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) fromNull = line.slice(4).trim() === '/dev/null';
    else if (line.startsWith('+++ ') && fromNull) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') out.add(p.replace(/^b\//, ''));
    }
  }
  return out;
};

/** Edge kinds that mean "src depends on dst". `contains` is structure, not use. */
export const DEPENDENCY_EDGE_KINDS = [
  'calls',
  'references',
  'imports',
  'extends',
  'implements',
] as const;

export interface ImpactNode {
  id: string;
  type: string;
  name: string;
  filePath: string | null;
  startLine: number | null;
}

export interface ChangedSymbol extends ImpactNode {
  /** The changed ranges that fall inside this symbol. */
  ranges: LineRange[];
}

export interface Dependent extends ImpactNode {
  /** Steps from the nearest changed symbol (1 = depends on it directly). */
  hops: number;
}

export interface ImpactEdge {
  src: string;
  dst: string;
  kind: string;
  /** Extracted from the code, or a link an agent proposed and a human accepted. */
  origin: 'structural' | 'accepted';
}

export interface MemoryAtRisk {
  waypoint: Pick<WaypointRow, 'id' | 'kind' | 'title' | 'summary' | 'ts' | 'source'>;
  /** The changed symbols (or files) it is anchored to. */
  anchors: string[];
  /** Anchored to a changed symbol, or only to a changed file. */
  via: 'symbol' | 'file';
}

export interface DiffImpact {
  files: string[];
  changed: ChangedSymbol[];
  /** Symbols in files the change creates: reported, not walked. */
  added: ImpactNode[];
  /** Changed documentation sections (markdown), counted apart from code. */
  docs: ImpactNode[];
  dependents: Dependent[];
  /** Dependency edges among changed symbols and dependents. */
  edges: ImpactEdge[];
  edgeCounts: { structural: number; accepted: number };
  memoryAtRisk: MemoryAtRisk[];
  depth: number;
}

interface NodeRow {
  id: string;
  type: string;
  name: string;
  data: string;
}

const toImpactNode = (r: NodeRow): ImpactNode & { endLine: number | null } => {
  const d = JSON.parse(r.data) as { filePath?: unknown; startLine?: unknown; endLine?: unknown };
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    filePath: typeof d.filePath === 'string' ? d.filePath : null,
    startLine: typeof d.startLine === 'number' ? d.startLine : null,
    endLine: typeof d.endLine === 'number' ? d.endLine : null,
  };
};

// Node types that never stand for code a change can touch.
const NOT_SYMBOLS = new Set(['file', 'conversation-waypoint', 'cluster', 'skill', 'concept']);

type Located = ImpactNode & { endLine: number | null };

/** A file's symbols with line ranges (functions, methods, classes, …; not the file node or memory). */
export const symbolsInFile = (db: SqliteAdapter, file: string): Located[] =>
  (
    db
      .prepare(`SELECT id, type, name, data FROM nodes WHERE json_extract(data, '$.filePath') = ?`)
      .all(file) as NodeRow[]
  )
    .map(toImpactNode)
    .filter((n) => !NOT_SYMBOLS.has(n.type) && n.startLine !== null && n.endLine !== null);

/**
 * The innermost symbols overlapping `range`: a symbol is dropped when another
 * overlapping symbol sits inside it, so a changed method doesn't also count
 * its class. The one line-to-symbol mapping, used by the prediction and by
 * the evaluation's oracle alike.
 */
export const innermostSymbols = <T extends Located>(
  symbols: readonly T[],
  range: LineRange,
): T[] => {
  const hits = symbols.filter((n) => n.startLine! <= range[1] && n.endLine! >= range[0]);
  return hits.filter(
    (a) =>
      !hits.some(
        (b) =>
          b !== a &&
          b.startLine! >= a.startLine! &&
          b.endLine! <= a.endLine! &&
          b.endLine! - b.startLine! < a.endLine! - a.startLine!,
      ),
  );
};

/** The innermost symbol whose line range contains `line`, or null. */
export const innermostSymbolAt = <T extends Located>(
  symbols: readonly T[],
  line: number,
): T | null =>
  innermostSymbols(symbols, [line, line]).sort(
    (a, b) => a.endLine! - a.startLine! - (b.endLine! - b.startLine!),
  )[0] ?? null;

export interface DiffImpactOptions {
  /** How many dependency steps to follow back from the changed symbols. */
  depth?: number;
  /** Files the change creates (addedFilesInDiff), in the same path form as `changes`. */
  addedFiles?: Set<string>;
}

export const diffImpact = (
  db: SqliteAdapter,
  changes: Map<string, LineRange[]>,
  waypoints: WaypointRow[],
  opts: DiffImpactOptions = {},
): DiffImpact => {
  const depth = opts.depth ?? 2;
  const byFile = db.prepare(
    `SELECT id, type, name, data FROM nodes WHERE json_extract(data, '$.filePath') = ?`,
  );

  const changed = new Map<string, ChangedSymbol>();
  const added: ImpactNode[] = [];
  const docs = new Map<string, ImpactNode>();
  const changedFileNodes = new Map<string, string>(); // file node id -> path
  for (const [file, ranges] of changes) {
    const rows = (byFile.all(file) as NodeRow[]).map(toImpactNode);
    for (const r of rows) if (r.type === 'file') changedFileNodes.set(r.id, file);
    if (opts.addedFiles?.has(file)) {
      for (const n of rows)
        if (!NOT_SYMBOLS.has(n.type) && n.type !== 'markdown-section') {
          const { endLine: _end, ...node } = n;
          added.push(node);
        }
      continue;
    }
    const symbols = rows.filter(
      (n) => !NOT_SYMBOLS.has(n.type) && n.startLine !== null && n.endLine !== null,
    );
    for (const range of ranges) {
      for (const n of innermostSymbols(symbols, range)) {
        const { endLine: _end, ...node } = n;
        if (n.type === 'markdown-section') {
          docs.set(n.id, node);
          continue;
        }
        const prev = changed.get(n.id);
        if (prev) prev.ranges.push(range);
        else changed.set(n.id, { ...node, ranges: [range] });
      }
    }
  }

  // Walk dependency edges backwards: who depends on what changed.
  const kinds = DEPENDENCY_EDGE_KINDS.map(() => '?').join(', ');
  const incomingStructural = db.prepare(
    `SELECT src, dst, kind FROM edges WHERE dst = ? AND kind IN (${kinds})`,
  );
  let incomingAccepted: { all: (id: string) => unknown[] } | null = null;
  try {
    incomingAccepted = db.prepare(
      `SELECT src, dst, COALESCE(kind, 'related') AS kind FROM edges_semantic WHERE dst = ?`,
    );
  } catch {
    incomingAccepted = null; // older schema without edges_semantic.kind
  }
  const getNode = db.prepare('SELECT id, type, name, data FROM nodes WHERE id = ?');

  const hops = new Map<string, number>();
  for (const id of changed.keys()) hops.set(id, 0);
  const edges: ImpactEdge[] = [];
  const seenEdge = new Set<string>();
  let frontier = [...changed.keys()];
  for (let step = 1; step <= depth && frontier.length; step++) {
    const next: string[] = [];
    for (const id of frontier) {
      const rows = [
        ...(
          incomingStructural.all(id, ...DEPENDENCY_EDGE_KINDS) as Omit<ImpactEdge, 'origin'>[]
        ).map((e) => ({ ...e, origin: 'structural' as const })),
        ...((incomingAccepted?.all(id) ?? []) as Omit<ImpactEdge, 'origin'>[]).map((e) => ({
          ...e,
          origin: 'accepted' as const,
        })),
      ];
      for (const e of rows) {
        if (e.src === e.dst) continue;
        const key = `${e.src}>${e.dst}>${e.kind}>${e.origin}`;
        if (!seenEdge.has(key)) {
          seenEdge.add(key);
          edges.push(e);
        }
        if (!hops.has(e.src)) {
          hops.set(e.src, step);
          next.push(e.src);
        }
      }
    }
    frontier = next;
  }

  const dependents: Dependent[] = [];
  for (const [id, h] of hops) {
    if (h === 0) continue;
    const row = getNode.get(id) as NodeRow | undefined;
    if (!row || NOT_SYMBOLS.has(row.type)) continue;
    const { endLine: _end, ...node } = toImpactNode(row);
    dependents.push({ ...node, hops: h });
  }
  dependents.sort((a, b) => a.hops - b.hops || a.name.localeCompare(b.name));

  const kept = new Set([...changed.keys(), ...dependents.map((d) => d.id)]);
  const keptEdges = edges.filter((e) => kept.has(e.src) && kept.has(e.dst));

  const memoryAtRisk: MemoryAtRisk[] = [];
  for (const w of waypoints) {
    const onSymbols = w.constellation_refs.filter((r) => changed.has(r));
    const onFiles = w.constellation_refs.filter((r) => changedFileNodes.has(r));
    if (!onSymbols.length && !onFiles.length) continue;
    memoryAtRisk.push({
      waypoint: {
        id: w.id,
        kind: w.kind,
        title: w.title,
        summary: w.summary,
        ts: w.ts,
        ...(w.source !== undefined ? { source: w.source } : {}),
      },
      anchors: onSymbols.length
        ? onSymbols.map((r) => changed.get(r)!.name)
        : onFiles.map((r) => changedFileNodes.get(r)!),
      via: onSymbols.length ? 'symbol' : 'file',
    });
  }

  return {
    files: [...changes.keys()],
    changed: [...changed.values()],
    added,
    docs: [...docs.values()],
    dependents,
    edges: keptEdges,
    edgeCounts: {
      structural: keptEdges.filter((e) => e.origin === 'structural').length,
      accepted: keptEdges.filter((e) => e.origin === 'accepted').length,
    },
    memoryAtRisk,
    depth,
  };
};

const mermaidId = (i: number): string => `n${i}`;
const mermaidLabel = (s: string): string => s.replace(/["<>]/g, (c) => `#${c.charCodeAt(0)};`);

/**
 * A Mermaid flowchart of the impact: changed symbols highlighted, the
 * nearest dependents up to `maxNodes` in total, accepted (agent-proposed,
 * human-accepted) links dashed. Renders in GitHub comments and markdown.
 */
export const impactToMermaid = (impact: DiffImpact, maxNodes = 15): string => {
  // Changed symbols that something depends on come first, most-depended-on
  // first, and take at most half the slots; dependents (nearest first) fill
  // the rest, so a large change still shows what it can break.
  const fanIn = new Map<string, number>();
  for (const e of impact.edges) fanIn.set(e.dst, (fanIn.get(e.dst) ?? 0) + 1);
  const changedRanked = [...impact.changed].sort(
    (a, b) => (fanIn.get(b.id) ?? 0) - (fanIn.get(a.id) ?? 0),
  );
  const changedSlots = Math.min(
    changedRanked.length,
    impact.dependents.length ? Math.max(1, Math.floor(maxNodes / 2)) : maxNodes,
  );
  const picked: (ImpactNode & { changed: boolean })[] = changedRanked
    .slice(0, changedSlots)
    .map((n) => ({ ...n, changed: true }));
  const pickedIds = new Set(picked.map((n) => n.id));
  // Prefer dependents linked to a picked changed symbol or to each other.
  const linked = (id: string): boolean =>
    impact.edges.some((e) => e.src === id && pickedIds.has(e.dst));
  const deps = [...impact.dependents].sort(
    (a, b) => a.hops - b.hops || Number(linked(b.id)) - Number(linked(a.id)),
  );
  for (const d of deps) {
    if (picked.length >= maxNodes) break;
    picked.push({ ...d, changed: false });
    pickedIds.add(d.id);
  }
  for (const c of changedRanked.slice(changedSlots)) {
    if (picked.length >= maxNodes) break;
    picked.push({ ...c, changed: true });
  }
  const nodes = picked;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const L = ['flowchart RL'];
  nodes.forEach((n, i) => {
    const where = n.filePath ? `<br/><small>${mermaidLabel(n.filePath)}</small>` : '';
    L.push(`  ${mermaidId(i)}["${mermaidLabel(n.name)}${where}"]`);
  });
  for (const e of impact.edges) {
    const a = index.get(e.src);
    const b = index.get(e.dst);
    if (a === undefined || b === undefined) continue;
    L.push(
      `  ${mermaidId(a)} ${e.origin === 'accepted' ? '-.->' : '-->'}|${e.kind}| ${mermaidId(b)}`,
    );
  }
  const changedIds = nodes.flatMap((n, i) => (n.changed ? [mermaidId(i)] : []));
  if (changedIds.length) {
    L.push('  classDef changed stroke-width:3px');
    L.push(`  class ${changedIds.join(',')} changed`);
  }
  const hidden = impact.changed.length + impact.dependents.length - nodes.length;
  if (hidden > 0) L.push(`  more["+${hidden} more"]`);
  return L.join('\n');
};
