import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';

export interface SnapshotNode {
  id: string;
  type: string;
  name: string;
  pull_score: number;
}

export interface SnapshotPending {
  id: number;
  src: string;
  dst: string;
  kind: string;
  weight: number;
  rationale: string;
  provenance: string;
}

export interface Snapshot {
  nodes: SnapshotNode[];
  edges_structural: Array<{ src: string; dst: string; kind: string }>;
  edges_semantic: Array<{ src: string; dst: string; weight: number }>;
  pending_edges: SnapshotPending[];
}

interface GraphNode extends SnapshotNode {
  x?: number;
  y?: number;
}

interface GraphLink {
  source: string;
  target: string;
  table: 'structural' | 'semantic' | 'pending';
  weight?: number;
  pending?: SnapshotPending;
}

const KIND_COLOR: Record<string, string> = {
  file: '#94a3b8',
  module: '#a78bfa',
  class: '#fbbf24',
  function: '#34d399',
  method: '#60a5fa',
  property: '#f472b6',
  variable: '#f87171',
  constant: '#fb923c',
  enum: '#c084fc',
  interface: '#22d3ee',
  type_alias: '#22d3ee',
  cluster: '#ec4899',
};

const colorFor = (kind: string): string => KIND_COLOR[kind] ?? '#9ca3af';
const radiusFor = (pull: number): number => 4 + Math.max(0, Math.min(1, pull)) * 20;

export interface MapProps {
  snapshot: Snapshot;
  onSelect: (id: string) => void;
  onAccept: (pendingId: number) => void;
  onReject: (pendingId: number) => void;
}

export function Map({ snapshot, onSelect, onAccept, onReject }: MapProps): JSX.Element {
  const graphData = useMemo(() => {
    const nodes: GraphNode[] = snapshot.nodes.map((n) => ({ ...n }));
    const links: GraphLink[] = [
      ...snapshot.edges_structural.map((e) => ({
        source: e.src,
        target: e.dst,
        table: 'structural' as const,
      })),
      ...snapshot.edges_semantic.map((e) => ({
        source: e.src,
        target: e.dst,
        table: 'semantic' as const,
        weight: e.weight,
      })),
      ...snapshot.pending_edges.map((p) => ({
        source: p.src,
        target: p.dst,
        table: 'pending' as const,
        pending: p,
      })),
    ];
    return { nodes, links };
  }, [snapshot]);

  const ref = useRef<ForceGraphMethods<GraphNode, GraphLink>>();
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hovered, setHovered] = useState<SnapshotPending | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onResize = (): void => setSize({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <>
      <ForceGraph2D
        ref={ref}
        width={size.w}
        height={size.h}
        graphData={graphData}
        backgroundColor="#0b0d12"
        nodeId="id"
        linkColor={(l) => {
          const t = (l as GraphLink).table;
          if (t === 'pending') return '#fbbf24';
          if (t === 'semantic') return '#3b82f655';
          return '#374151';
        }}
        linkWidth={(l) => ((l as GraphLink).table === 'pending' ? 2 : (l as GraphLink).table === 'semantic' ? 1.5 : 0.8)}
        linkLineDash={(l) => ((l as GraphLink).table === 'pending' ? [4, 4] : null)}
        nodeLabel={(n) => `${(n as GraphNode).type}: ${(n as GraphNode).name}`}
        nodeCanvasObject={(rawNode, ctx, scale) => {
          const n = rawNode as GraphNode;
          const r = radiusFor(n.pull_score);
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
          ctx.fillStyle = colorFor(n.type);
          ctx.fill();
          if (scale > 1.2) {
            ctx.fillStyle = '#e5e7eb';
            ctx.font = `${10 / scale}px ui-sans-serif`;
            ctx.fillText(n.name, (n.x ?? 0) + r + 2, (n.y ?? 0) + 3);
          }
        }}
        onNodeClick={(n) => onSelect((n as GraphNode).id)}
        onLinkHover={(l) => {
          const link = l as GraphLink | null;
          setHovered(link?.pending ?? null);
        }}
        onLinkClick={(_l, ev) => {
          setTooltipPos({ x: ev.clientX, y: ev.clientY });
        }}
      />
      {hovered && tooltipPos && (
        <div
          style={{
            position: 'fixed',
            left: tooltipPos.x + 12,
            top: tooltipPos.y + 12,
            background: '#111827',
            border: '1px solid #fbbf24',
            borderRadius: 6,
            padding: 12,
            maxWidth: 320,
            zIndex: 20,
            fontSize: 12,
            color: '#e5e7eb',
          }}
        >
          <div style={{ color: '#fbbf24', marginBottom: 6, fontWeight: 600 }}>
            pending edge
          </div>
          <div style={{ color: '#9ca3af', marginBottom: 6 }}>
            {hovered.provenance} · {hovered.kind} · weight {hovered.weight.toFixed(2)}
          </div>
          <div style={{ marginBottom: 8 }}>{hovered.rationale}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => {
                onAccept(hovered.id);
                setHovered(null);
                setTooltipPos(null);
              }}
              style={{
                background: '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                padding: '4px 10px',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              accept
            </button>
            <button
              onClick={() => {
                onReject(hovered.id);
                setHovered(null);
                setTooltipPos(null);
              }}
              style={{
                background: '#374151',
                color: '#e5e7eb',
                border: 'none',
                borderRadius: 4,
                padding: '4px 10px',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              reject
            </button>
          </div>
        </div>
      )}
    </>
  );
}
