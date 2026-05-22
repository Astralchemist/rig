import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';

export interface SnapshotNode {
  id: string;
  type: string;
  name: string;
  pull_score: number;
}

export interface SnapshotEdge {
  src: string;
  dst: string;
  kind?: string;
  weight?: number;
}

export interface Snapshot {
  nodes: SnapshotNode[];
  edges_structural: Array<{ src: string; dst: string; kind: string }>;
  edges_semantic: Array<{ src: string; dst: string; weight: number }>;
}

interface GraphNode extends SnapshotNode {
  // d3-force will mutate these.
  x?: number;
  y?: number;
}

interface GraphLink {
  source: string;
  target: string;
  table: 'structural' | 'semantic';
  weight?: number;
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
};

const colorFor = (kind: string): string => KIND_COLOR[kind] ?? '#9ca3af';
const radiusFor = (pull: number): number => 4 + Math.max(0, Math.min(1, pull)) * 20;

export interface MapProps {
  snapshot: Snapshot;
  onSelect: (id: string) => void;
}

export function Map({ snapshot, onSelect }: MapProps): JSX.Element {
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
    ];
    return { nodes, links };
  }, [snapshot]);

  const ref = useRef<ForceGraphMethods<GraphNode, GraphLink>>();
  const [size, setSize] = useState({ w: 800, h: 600 });
  useEffect(() => {
    const onResize = (): void =>
      setSize({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <ForceGraph2D
      ref={ref}
      width={size.w}
      height={size.h}
      graphData={graphData}
      backgroundColor="#0b0d12"
      nodeId="id"
      linkColor={(l) => ((l as GraphLink).table === 'semantic' ? '#3b82f655' : '#374151')}
      linkWidth={(l) => ((l as GraphLink).table === 'semantic' ? 1.5 : 0.8)}
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
    />
  );
}
