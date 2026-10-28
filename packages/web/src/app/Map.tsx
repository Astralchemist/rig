// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { useTheme } from './theme.tsx';

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

// Compose an #rrggbb hex with an alpha (0–1) into an rgba() string — canvas
// strokes/fills need a real color value, not a CSS var.
const withAlpha = (hex: string, a: number): string => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

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
  const { theme } = useTheme();
  const colorFor = (kind: string): string => theme.nodeKinds[kind] ?? theme.tokens.muted;
  const communityColor = (cid: number | undefined): string =>
    cid === undefined ? theme.tokens.muted : theme.community[cid % theme.community.length]!;

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

  const ref = useRef<ForceGraphMethods<GraphNode, GraphLink>>(undefined);
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

  // Drive repaints while a pulse halo fades. force-graph only repaints on
  // simulation ticks, so we reheat the sim when a pulse batch arrives — the
  // resulting frames animate the halo over its fade window.
  useEffect(() => {
    if (!pulses || pulses.size === 0) return;
    ref.current?.d3ReheatSimulation();
  }, [pulses]);

  // Repaint when the theme swaps. backgroundColor changing already triggers a
  // canvas repaint (which re-runs the node/edge draw closures with the new
  // colors); a brief reheat guarantees it even if two themes shared a bg.
  useEffect(() => {
    ref.current?.d3ReheatSimulation();
  }, [theme]);

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
          top: 52,
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
            border: `1px solid ${hubsOnly ? theme.tokens.hub : 'var(--border)'}`,
            borderRadius: 999,
            background: hubsOnly ? theme.tokens.hub : 'var(--surface)',
            color: hubsOnly ? theme.tokens.bg : theme.tokens.hub,
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
            border: '1px solid var(--border)',
            borderRadius: 999,
            background: 'var(--surface)',
            color: colorMode === 'community' ? 'var(--accent)' : 'var(--muted)',
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
                border: `1px solid ${hidden ? 'var(--border)' : colorFor(k)}`,
                borderRadius: 999,
                background: hidden ? 'var(--surface)' : withAlpha(colorFor(k), 0.13),
                color: hidden ? 'var(--muted)' : colorFor(k),
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
        backgroundColor={theme.tokens.bg}
        nodeId="id"
        linkColor={(l) => {
          const t = (l as GraphLink).table;
          if (t === 'pending') return theme.tokens.pending;
          if (t === 'semantic') return withAlpha(theme.tokens.semantic, 0.33);
          return theme.tokens.structural;
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
            ctx.strokeStyle = withAlpha(theme.tokens.hub, 0.55);
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
              ctx.strokeStyle = withAlpha(theme.tokens.pulse, Number(t.toFixed(2)));
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
            ctx.strokeStyle = theme.tokens.accent;
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          if (scale > 1.2 || n.is_hub) {
            ctx.fillStyle = n.is_hub ? theme.tokens.hub : theme.tokens.text;
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
            background: 'var(--surface2)',
            border: `1px solid ${theme.tokens.pending}`,
            borderRadius: 10,
            padding: 12,
            maxWidth: 320,
            zIndex: 20,
            fontSize: 12,
            color: 'var(--text)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
          }}
        >
          <div style={{ color: 'var(--pending)', marginBottom: 6, fontWeight: 600 }}>
            pending edge
          </div>
          <div style={{ color: 'var(--muted)', marginBottom: 6 }}>
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
                background: 'var(--success)',
                color: 'var(--bg)',
                border: 'none',
                borderRadius: 6,
                padding: '5px 12px',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 600,
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
                background: 'var(--surface)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '5px 12px',
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
