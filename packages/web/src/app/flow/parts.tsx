// SPDX-License-Identifier: Apache-2.0
import { Graph, layout as dagreLayout } from '@dagrejs/dagre';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { memo, type JSX } from 'react';
import type { NodeCard, ViewEdge, Waypoint } from '../api.ts';
import { kindLabel } from '../kinds.ts';
import { CardBadges, Glyph, locOf } from '../NodeDetail.tsx';

// Shared React Flow pieces for the focused views: node cards, waypoint
// cards, typed edges, and a dagre layout. These views hold tens to a few
// hundred nodes, where React Flow stays at 120 fps (bench: 500 nodes,
// p95 frame 9 ms) and its DOM cards can carry real content.

export type CardData = { card: NodeCard; center?: boolean; dim?: boolean };
export type WaypointData = { waypoint: Waypoint; current?: boolean };
export type FlowEdgeData = {
  table: ViewEdge['table'];
  kind: string;
  weight?: number;
  label?: boolean;
};

export const CARD_W = 232;
export const CARD_H = 92;
export const CENTER_W = 260;
export const WAY_W = 280;
export const WAY_H = 104;

export const CardNode = memo(function CardNode({ data }: NodeProps<Node<CardData>>): JSX.Element {
  const c = data.card;
  const loc = locOf(c);
  return (
    <div
      className="ncard"
      data-center={data.center ? 'true' : 'false'}
      style={data.dim ? { opacity: 0.55 } : undefined}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="ncard-kind">
        <Glyph kind={c.kind} />
        {kindLabel(c.kind)}
      </div>
      <div className="ncard-name truncate" title={c.name}>
        {c.name}
      </div>
      {loc && (
        <div className="ncard-loc truncate" title={loc}>
          {loc}
        </div>
      )}
      {data.center && c.signature && <div className="ncard-sig">{c.signature}</div>}
      <div className="ncard-badges">
        <CardBadges card={c} />
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

const WAYPOINT_TONE: Record<string, string> = {
  decision: 'var(--accent)',
  constraint: 'var(--status-serious)',
  'open-question': 'var(--status-warning)',
  observation: 'var(--node-memory)',
  principle: 'var(--series-1)',
};

export const waypointTone = (kind: string): string => WAYPOINT_TONE[kind] ?? 'var(--node-memory)';

export const WaypointNode = memo(function WaypointNode({
  data,
}: NodeProps<Node<WaypointData>>): JSX.Element {
  const w = data.waypoint;
  return (
    <div
      className="wcard"
      style={{
        borderLeftColor: waypointTone(w.kind),
        boxShadow: data.current ? 'var(--ring)' : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="ncard-kind">{w.kind.replace('-', ' ')}</div>
      <div className="t">{w.title}</div>
      {w.summary && <div className="s">{w.summary}</div>}
      <Handle type="source" position={Position.Right} id="refs" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} id="next" isConnectable={false} />
    </div>
  );
});

export const TypedEdge = memo(function TypedEdge(
  props: EdgeProps<Edge<FlowEdgeData>>,
): JSX.Element {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    markerEnd,
  } = props;
  const [path, lx, ly] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const table = data?.table ?? 'structural';
  const style =
    table === 'pending'
      ? { stroke: 'var(--pending)', strokeWidth: 2, strokeDasharray: '6 5' }
      : table === 'semantic'
        ? { stroke: 'var(--edge-strong)', strokeWidth: 1.8 }
        : { stroke: 'color-mix(in oklab, var(--text-3) 50%, transparent)', strokeWidth: 1.1 };
  return (
    <>
      <BaseEdge id={id} path={path} style={style} {...(markerEnd ? { markerEnd } : {})} />
      {data?.label !== false && (
        <EdgeLabelRenderer>
          <div
            className="edge-label nodrag nopan"
            data-table={table}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          >
            {data?.kind}
            {data?.weight !== undefined && table !== 'structural'
              ? ` · ${data.weight.toFixed(2)}`
              : ''}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const nodeTypes = { card: CardNode, waypoint: WaypointNode };
export const edgeTypes = { typed: TypedEdge };

// Top-left positions from dagre's centres.
export const layout = <N extends Node>(
  nodes: N[],
  edges: { source: string; target: string }[],
  opts: {
    rankdir?: 'LR' | 'TB';
    nodesep?: number;
    ranksep?: number;
    size?: (n: N) => { w: number; h: number };
  } = {},
): N[] => {
  const g = new Graph();
  g.setGraph({
    rankdir: opts.rankdir ?? 'LR',
    nodesep: opts.nodesep ?? 18,
    ranksep: opts.ranksep ?? 90,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));
  const size = opts.size ?? (() => ({ w: CARD_W, h: CARD_H }));
  for (const n of nodes) {
    const s = size(n);
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  for (const e of edges)
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  dagreLayout(g);
  return nodes.map((n) => {
    const p = g.node(n.id) as { x: number; y: number } | undefined;
    const s = size(n);
    return { ...n, position: { x: (p?.x ?? 0) - s.w / 2, y: (p?.y ?? 0) - s.h / 2 } };
  });
};

// Neighbourhood layout: the centre card, what points at it in columns to
// the left, what it points at in columns to the right. Siblings sharing an
// edge kind stay together, memory (pending, accepted) first. Dagre puts
// every sibling in one rank, which turns 60 `contains` children into one
// unreadable column; a grid of short columns keeps cards legible at fit.
export const fanLayout = <N extends Node>(
  center: N,
  others: N[],
  edges: { source: string; target: string; data?: { table?: string; kind?: string } }[],
  sizeOf: (n: N) => { w: number; h: number },
): N[] => {
  const ROWS = 9;
  const GAP_X = 32;
  const GAP_Y = 14;
  const REACH = 90;
  const rank = (t?: string): number => (t === 'pending' ? 0 : t === 'semantic' ? 1 : 2);
  const info = new Map<string, { side: 'in' | 'out'; key: string }>();
  for (const e of edges) {
    const other = e.source === center.id ? e.target : e.target === center.id ? e.source : null;
    if (!other || info.has(other)) continue;
    info.set(other, {
      side: e.target === center.id ? 'in' : 'out',
      key: `${rank(e.data?.table)}:${e.data?.kind ?? ''}`,
    });
  }
  const c = sizeOf(center);
  const out: N[] = [{ ...center, position: { x: -c.w / 2, y: -c.h / 2 } }];
  for (const side of ['in', 'out'] as const) {
    const list = others
      .filter((n) => (info.get(n.id)?.side ?? 'out') === side)
      .sort(
        (a, b) =>
          (info.get(a.id)?.key ?? '').localeCompare(info.get(b.id)?.key ?? '') ||
          String(a.id).localeCompare(String(b.id)),
      );
    const rows = Math.min(ROWS, Math.max(1, Math.ceil(Math.sqrt(list.length * 2.6))));
    for (let col = 0; col * rows < list.length; col++) {
      const chunk = list.slice(col * rows, (col + 1) * rows);
      const heights = chunk.map((n) => sizeOf(n).h);
      const total = heights.reduce((s, h) => s + h, 0) + GAP_Y * (chunk.length - 1);
      let y = -total / 2;
      chunk.forEach((n, i) => {
        const w = sizeOf(n).w;
        const x =
          side === 'out'
            ? c.w / 2 + REACH + col * (w + GAP_X)
            : -c.w / 2 - REACH - w - col * (w + GAP_X);
        out.push({ ...n, position: { x, y } });
        y += heights[i]! + GAP_Y;
      });
    }
  }
  return out;
};
