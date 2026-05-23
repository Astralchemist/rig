import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';

export interface SnapshotNode {
  id: string;
  type: string;
  name: string;
  pull_score: number;
  is_hub?: number;
  hubness?: number;
  community_id?: number;
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
  'markdown-section': '#fcd34d',
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

// Community palette — distinct hues that round-trip the wheel; index modulo
// length so any community count works. The first ~12 are well-separated.
const COMMUNITY_PALETTE = [
  '#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c',
  '#22d3ee', '#c084fc', '#ec4899', '#facc15', '#4ade80', '#f87171',
  '#818cf8', '#fcd34d', '#2dd4bf', '#e879f9',
];
const communityColor = (cid: number | undefined): string =>
  cid === undefined ? '#9ca3af' : COMMUNITY_PALETTE[cid % COMMUNITY_PALETTE.length]!;
const radiusFor = (n: SnapshotNode): number => {
  const base = 4 + Math.max(0, Math.min(1, n.pull_score)) * 14;
  const hubBoost = n.is_hub ? 6 + (n.hubness ?? 0) * 8 : 0;
  return base + hubBoost;
};

export interface MapProps {
  snapshot: Snapshot;
  onSelect: (id: string, clickPos?: { x: number; y: number }) => void;
  onAccept: (pendingId: number) => void;
  onReject: (pendingId: number) => void;
  // Bump the token to programmatically zoom-to-node (e.g. from the Cmd-K palette).
  // Plain selection via canvas click does NOT bump this — only intentional jumps.
  focusToken?: { id: string; ts: number } | null;
  selectedId?: string | null;
  // Map from node id → timestamp of last pulse. Used to render a fading halo
  // when the AI (or any tool) touches that anchor.
  pulses?: Map<string, number>;
}

export function Map({ snapshot, onSelect, onAccept, onReject, focusToken, selectedId, pulses }: MapProps): JSX.Element {
  // Visible-kind set. Mutable via filter chips above the canvas. `null` means
  // "show everything"; a Set means "show only these kinds".
  const allKinds = useMemo(
    () =>
      Array.from(new Set(snapshot.nodes.map((n) => n.type))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [snapshot.nodes],
  );
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [hubsOnly, setHubsOnly] = useState(false);
  const [colorMode, setColorMode] = useState<'kind' | 'community'>('kind');

  const graphData = useMemo(() => {
    const visible = (n: SnapshotNode): boolean => {
      if (hubsOnly && !n.is_hub) return false;
      return !hiddenKinds.has(n.type);
    };
    const visibleNodes = snapshot.nodes.filter(visible);
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const nodes: GraphNode[] = visibleNodes.map((n) => ({ ...n }));
    const linkFilter = <T extends { src: string; dst: string }>(e: T): boolean =>
      visibleIds.has(e.src) && visibleIds.has(e.dst);
    const links: GraphLink[] = [
      ...snapshot.edges_structural.filter(linkFilter).map((e) => ({
        source: e.src,
        target: e.dst,
        table: 'structural' as const,
      })),
      ...snapshot.edges_semantic.filter(linkFilter).map((e) => ({
        source: e.src,
        target: e.dst,
        table: 'semantic' as const,
        weight: e.weight,
      })),
      ...snapshot.pending_edges
        .filter((p) => visibleIds.has(p.src) && visibleIds.has(p.dst))
        .map((p) => ({
          source: p.src,
          target: p.dst,
          table: 'pending' as const,
          pending: p,
        })),
    ];
    return { nodes, links };
  }, [snapshot, hiddenKinds, hubsOnly]);

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

  // Camera pan to the focused node when the parent bumps focusToken.
  useEffect(() => {
    if (!focusToken) return;
    const node = graphData.nodes.find((n) => n.id === focusToken.id);
    if (!node || node.x === undefined || node.y === undefined) return;
    ref.current?.centerAt(node.x, node.y, 600);
    ref.current?.zoom(4, 600);
  }, [focusToken, graphData.nodes]);

  // Force a redraw while a pulse halo is fading. force-graph normally only
  // redraws on simulation tick / pan / zoom; without this the halo would
  // freeze at its initial radius.
  useEffect(() => {
    if (!pulses || pulses.size === 0) return;
    const id = setInterval(() => {
      // refresh() schedules a single repaint without disrupting the layout.
      ref.current?.refresh();
    }, 50);
    return () => clearInterval(id);
  }, [pulses]);

  const toggleKind = (k: string): void => {
    setHiddenKinds((s) => {
      const next = new Set(s);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  };

  return (
    <>
      <div
        style={{
          position: 'absolute',
          top: 56,
          left: 12,
          zIndex: 10,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          maxWidth: 'calc(100vw - 24px)',
        }}
      >
        <button
          onClick={() => setHubsOnly((v) => !v)}
          title="Show only hub nodes"
          style={{
            padding: '4px 10px',
            fontSize: 11,
            border: '1px solid #1f2937',
            borderRadius: 12,
            background: hubsOnly ? '#fbbf24' : '#111827',
            color: hubsOnly ? '#0b0d12' : '#fbbf24',
            cursor: 'pointer',
          }}
        >
          {hubsOnly ? '◉ hubs only' : '○ hubs only'}
        </button>
        <button
          onClick={() => setColorMode((m) => (m === 'kind' ? 'community' : 'kind'))}
          title="Toggle node coloring between anchor kind and community"
          style={{
            padding: '4px 10px',
            fontSize: 11,
            border: '1px solid #1f2937',
            borderRadius: 12,
            background: '#111827',
            color: colorMode === 'community' ? '#60a5fa' : '#9ca3af',
            cursor: 'pointer',
          }}
        >
          color: {colorMode}
        </button>
        {allKinds.map((k) => {
          const hidden = hiddenKinds.has(k);
          return (
            <button
              key={k}
              onClick={() => toggleKind(k)}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                border: `1px solid ${hidden ? '#1f2937' : colorFor(k)}`,
                borderRadius: 12,
                background: hidden ? '#0b0d12' : `${colorFor(k)}22`,
                color: hidden ? '#6b7280' : colorFor(k),
                cursor: 'pointer',
                opacity: hidden ? 0.5 : 1,
              }}
            >
              {k}
            </button>
          );
        })}
      </div>
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
          const r = radiusFor(n);
          const x = n.x ?? 0;
          const y = n.y ?? 0;
          if (n.is_hub) {
            // Halo ring for hubs — wider when hubness is higher.
            const haloR = r + 3 + (n.hubness ?? 0) * 4;
            ctx.beginPath();
            ctx.arc(x, y, haloR, 0, 2 * Math.PI);
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
          // Pulse halo — fades over PULSE_MS after the activation timestamp.
          const PULSE_MS = 1500;
          const pulseTs = pulses?.get(n.id);
          if (pulseTs !== undefined) {
            const age = Date.now() - pulseTs;
            if (age < PULSE_MS) {
              const t = 1 - age / PULSE_MS;
              const pr = r + 6 + (1 - t) * 18;
              ctx.beginPath();
              ctx.arc(x, y, pr, 0, 2 * Math.PI);
              ctx.strokeStyle = `rgba(244, 114, 182, ${t.toFixed(2)})`;
              ctx.lineWidth = 2;
              ctx.stroke();
            }
          }
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fillStyle = colorMode === 'community' ? communityColor(n.community_id) : colorFor(n.type);
          ctx.fill();
          if (selectedId === n.id) {
            ctx.beginPath();
            ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
            ctx.strokeStyle = '#60a5fa';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          if (scale > 1.2 || n.is_hub) {
            ctx.fillStyle = n.is_hub ? '#fbbf24' : '#e5e7eb';
            ctx.font = `${(n.is_hub ? 11 : 10) / scale}px ui-sans-serif`;
            ctx.fillText(n.name, x + r + 2, y + 3);
          }
        }}
        onNodeClick={(n, ev) => {
          const clickEv = ev as MouseEvent | undefined;
          onSelect(
            (n as GraphNode).id,
            clickEv ? { x: clickEv.clientX, y: clickEv.clientY } : undefined,
          );
        }}
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
