// SPDX-License-Identifier: Apache-2.0
import { Maximize2, Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import type { Snapshot, SnapshotNode } from './api.ts';
import type { TrailPoint } from './App.tsx';
import { GROUPS, groupOf, kindLabel, type GroupId, type Shape } from './kinds.ts';
import { useTheme } from './theme.tsx';
import { readGraphPalette, type GraphPalette } from './themes.ts';

// The whole-repo constellation, drawn on canvas (react-force-graph-2d).
// Canvas because the measured alternative, React Flow, drops to 54-70 fps
// with 58-75 ms p95 frames at 5,000 nodes and needs a precomputed layout;
// force-graph holds 98-120 fps at every size the map serves. React Flow is
// used for the focused views instead (flow/).

interface GraphNode extends SnapshotNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
  __deg: number;
  __group: GroupId;
  __shape: Shape;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  table: 'structural' | 'semantic' | 'pending';
  kind: string;
}

export interface MapFilters {
  hidden: Set<GroupId>;
  hubsOnly: boolean;
}

export interface MapProps {
  snapshot: Snapshot;
  filters: MapFilters;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  // Bump to fly the camera to a node (search, deep link, list view).
  focusToken: { id: string; ts: number } | null;
  // node id -> when an agent last touched it; drawn as a fading ring.
  pulses: Map<string, number>;
  // Nodes an agent asked the user to look at (focus:requested).
  highlight: Set<string>;
  // Recent activations with the agent that made each (C5 trails).
  trail: TrailPoint[];
  // Agents in order of first appearance; the order picks the colour.
  agents: string[];
  onOpenNeighbourhood: (id: string) => void;
}

const PULSE_MS = 1600;
// Dot-grid pitch in CSS pixels, before snapping to a power of two in graph
// units so the grid doesn't swim while zooming.
const GRID_PX = 22;

// `#rrggbb` (the theme tokens' form) at an alpha; anything else unchanged.
const withAlpha = (color: string, a: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgb(${n >> 16} ${(n >> 8) & 255} ${n & 255} / ${a})`;
};
const endId = (e: string | GraphNode): string => (typeof e === 'string' ? e : e.id);

const radiusFor = (n: GraphNode): number => {
  const base = 2.2 + Math.min(4.5, Math.sqrt(n.__deg) * 0.6);
  return n.is_hub ? base + 1.5 + (n.hubness ?? 0) * 2.5 : base;
};

// A weak pull toward the origin. Without it, nodes with no links in the
// snapshot drift into a wide ring and zoom-to-fit shrinks everything else.
const gravity = (strength: number) => {
  let nodes: GraphNode[] = [];
  const force = (alpha: number): void => {
    for (const n of nodes) {
      const k = (n.__deg === 0 ? strength * 3 : strength) * alpha;
      n.vx = (n.vx ?? 0) - (n.x ?? 0) * k;
      n.vy = (n.vy ?? 0) - (n.y ?? 0) * k;
    }
  };
  force.initialize = (ns: GraphNode[]): void => {
    nodes = ns;
  };
  return force;
};

const fillFor = (p: GraphPalette, g: GroupId): string =>
  g === 'callable'
    ? p.series[0]
    : g === 'type'
      ? p.series[1]
      : g === 'value'
        ? p.series[2]
        : g === 'memory'
          ? p.memory
          : p.neutral;

// Filled marks get a knockout: a thin outline in the canvas colour drawn
// under the fill, so marks that touch stay separate and edges stop short of
// them instead of running into the fill.
const drawShape = (
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  x: number,
  y: number,
  r: number,
  scale: number,
  knockout: string,
): void => {
  const fill = (): void => {
    ctx.lineWidth = 2.4 / scale;
    ctx.lineJoin = 'round';
    const ink = ctx.fillStyle;
    ctx.strokeStyle = knockout;
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.fill();
  };
  ctx.beginPath();
  switch (shape) {
    case 'square': {
      const s = r * 1.7;
      ctx.roundRect(x - s / 2, y - s / 2, s, s, Math.max(0.6, s * 0.18));
      fill();
      return;
    }
    case 'diamond': {
      const s = r * 1.3;
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      fill();
      return;
    }
    case 'triangle': {
      const s = r * 1.35;
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s * 0.95, y + s * 0.7);
      ctx.lineTo(x - s * 0.95, y + s * 0.7);
      ctx.closePath();
      fill();
      return;
    }
    case 'ring':
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.lineWidth = Math.max(1.2 / scale, r * 0.32) + 2.4 / scale;
      ctx.strokeStyle = knockout;
      ctx.stroke();
      ctx.lineWidth = Math.max(1.2 / scale, r * 0.32);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.stroke();
      return;
    default:
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      fill();
  }
};

function Constellation({
  snapshot,
  filters,
  selectedId,
  onSelect,
  focusToken,
  pulses,
  highlight,
  trail,
  agents,
  onOpenNeighbourhood,
}: MapProps): JSX.Element {
  const { theme } = useTheme();
  const [palette, setPalette] = useState<GraphPalette>(() => readGraphPalette());
  // Tokens change with the [data-theme] stamp, which lands after render.
  useEffect(() => {
    const id = requestAnimationFrame(() => setPalette(readGraphPalette()));
    return () => cancelAnimationFrame(id);
  }, [theme]);

  // Positions survive refreshes: a db change re-fetches the snapshot, and
  // without this every accept, note or selection re-ran the whole layout.
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const pinned = useRef(new Set<string>());
  const settled = useRef(false);

  const graphData = useMemo(() => {
    const keep = (n: SnapshotNode): boolean => {
      if (filters.hubsOnly && !n.is_hub) return false;
      return !filters.hidden.has(groupOf(n.type).id);
    };
    const visible = snapshot.nodes.filter(keep);
    const ids = new Set(visible.map((n) => n.id));
    const deg = new Map<string, number>();
    const links: GraphLink[] = [];
    const add = (src: string, dst: string, table: GraphLink['table'], kind: string): void => {
      if (!ids.has(src) || !ids.has(dst) || src === dst) return;
      links.push({ source: src, target: dst, table, kind });
      deg.set(src, (deg.get(src) ?? 0) + 1);
      deg.set(dst, (deg.get(dst) ?? 0) + 1);
    };
    for (const e of snapshot.edges_structural) add(e.src, e.dst, 'structural', e.kind);
    for (const e of snapshot.edges_semantic) add(e.src, e.dst, 'semantic', e.kind ?? 'related');
    for (const e of snapshot.pending_edges) add(e.src, e.dst, 'pending', e.kind);
    pinned.current.clear();
    const nodes: GraphNode[] = visible.map((n) => {
      const g = groupOf(n.type);
      const at = positions.current.get(n.id);
      const node: GraphNode = { ...n, __deg: deg.get(n.id) ?? 0, __group: g.id, __shape: g.shape };
      if (at && settled.current) {
        // Hold known nodes still while newcomers find their place.
        node.x = node.fx = at.x;
        node.y = node.fy = at.y;
        pinned.current.add(n.id);
      } else if (at) {
        node.x = at.x;
        node.y = at.y;
      }
      return node;
    });
    return { nodes, links };
  }, [snapshot, filters]);

  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of graphData.links) {
      const s = endId(l.source);
      const t = endId(l.target);
      if (!m.has(s)) m.set(s, new Set());
      if (!m.has(t)) m.set(t, new Set());
      m.get(s)!.add(t);
      m.get(t)!.add(s);
    }
    return m;
  }, [graphData]);

  // Label priority: hubs, then by degree. Computed once per data change.
  const labelOrder = useMemo(
    () =>
      [...graphData.nodes].sort(
        (a, b) =>
          (b.is_hub ?? 0) - (a.is_hub ?? 0) ||
          (b.hubness ?? 0) - (a.hubness ?? 0) ||
          b.__deg - a.__deg,
      ),
    [graphData],
  );

  const ref = useRef<ForceGraphMethods<GraphNode, GraphLink>>(undefined);
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<{ node: GraphNode; x: number; y: number } | null>(null);
  const mouse = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Spread the layout a little more than the defaults so labels fit.
  useEffect(() => {
    const fg = ref.current;
    if (!fg) return;
    const charge = fg.d3Force('charge') as unknown as
      | { strength?: (n: number) => void }
      | undefined;
    charge?.strength?.(-38);
    const link = fg.d3Force('link') as unknown as { distance?: (n: number) => void } | undefined;
    link?.distance?.(34);
    fg.d3Force('gravity', gravity(0.045) as never);
  }, []);

  useEffect(() => {
    if (!focusToken) return;
    const n = graphData.nodes.find((x) => x.id === focusToken.id);
    if (!n || n.x === undefined || n.y === undefined) return;
    ref.current?.centerAt(n.x, n.y, 600);
    ref.current?.zoom(2.4, 600);
  }, [focusToken, graphData.nodes]);

  // Trails fade over time, so the canvas keeps drawing while one is visible.
  const pulsing = pulses.size > 0 || trail.length > 0;
  const agentColor = (agent: string | null): string =>
    agent === null
      ? palette.text3
      : palette.agents[Math.max(0, agents.indexOf(agent)) % palette.agents.length]!;
  // The agent that last touched each node, for its pulse colour.
  const lastAgent = new Map<string, string | null>();
  for (const t of trail) lastAgent.set(t.id, t.agent);
  // A selection the canvas can't show: outside the loaded snapshot (search
  // and deep links reach the whole graph), or hidden by the filters.
  const offMap: 'missing' | 'filtered' | null =
    selectedId === null || graphData.nodes.some((n) => n.id === selectedId)
      ? null
      : snapshot.nodes.some((n) => n.id === selectedId)
        ? 'filtered'
        : 'missing';
  const neighbours = selectedId ? adjacency.get(selectedId) : undefined;
  const dimOthers = selectedId !== null && graphData.nodes.some((n) => n.id === selectedId);

  const nodeAlpha = (id: string): number => {
    if (!dimOthers) return 1;
    if (id === selectedId || neighbours?.has(id)) return 1;
    return 0.16;
  };

  const linkInvolves = (l: GraphLink): boolean =>
    selectedId !== null && (endId(l.source) === selectedId || endId(l.target) === selectedId);

  // Label widths at 11px, measured once per name.
  const widths = useRef(new Map<string, number>());

  const drawLabels = (ctx: CanvasRenderingContext2D, scale: number): void => {
    // Greedy placement in screen space: highest priority first, skip any
    // label that would overlap one already drawn (checked against a coarse
    // grid of placed boxes). The budget grows with zoom.
    const budget = Math.round(Math.min(400, 22 * scale * scale + 18));
    const fontPx = 11;
    // The font is set in graph units (fontPx / scale), so measureText returns
    // graph units; the cache holds screen pixels, which don't change with zoom.
    ctx.font = `500 ${fontPx / scale}px ${palette.fontCanvas}`;
    const width = (name: string): number => {
      let w = widths.current.get(name);
      if (w === undefined) {
        w = ctx.measureText(name).width * scale;
        widths.current.set(name, w);
      }
      return w / scale;
    };
    ctx.textBaseline = 'middle';
    // `must`: always labelled. `near`: the selection's neighbours, labelled
    // first and kept while the rest are dimmed, but they still give way to
    // labels already placed, so a dense neighbourhood doesn't stack text.
    const must = new Set<string>(highlight);
    if (selectedId) must.add(selectedId);
    const near = new Set<string>([...must, ...(neighbours ?? [])]);
    const rank = (n: GraphNode): number => (must.has(n.id) ? 0 : near.has(n.id) ? 1 : 2);
    const order = near.size ? [...labelOrder].sort((a, b) => rank(a) - rank(b)) : labelOrder;
    const cell = 80 / scale;
    const grid = new Map<string, { x0: number; y0: number; x1: number; y1: number }[]>();
    const cellsOf = (b: { x0: number; y0: number; x1: number; y1: number }): string[] => {
      const out: string[] = [];
      for (let gx = Math.floor(b.x0 / cell); gx <= Math.floor(b.x1 / cell); gx++)
        for (let gy = Math.floor(b.y0 / cell); gy <= Math.floor(b.y1 / cell); gy++)
          out.push(`${gx},${gy}`);
      return out;
    };
    let drawn = 0;
    for (const n of order) {
      if (n.x === undefined || n.y === undefined) continue;
      const forced = must.has(n.id);
      if (!near.has(n.id) && drawn >= budget) break;
      if (dimOthers && !near.has(n.id)) continue;
      const r = radiusFor(n);
      const w = width(n.name);
      const h = (fontPx + 3) / scale;
      const x0 = n.x + r + (n.id === selectedId || n.is_hub ? 5 : 1) + 3 / scale;
      const box = { x0: x0 - 2 / scale, y0: n.y - h / 2, x1: x0 + w + 2 / scale, y1: n.y + h / 2 };
      const keys = cellsOf(box);
      const hit = keys.some((k) =>
        grid.get(k)?.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0),
      );
      if (!forced && hit) continue;
      for (const k of keys) {
        const list = grid.get(k);
        if (list) list.push(box);
        else grid.set(k, [box]);
      }
      drawn++;
      // An opaque, round-joined halo in the canvas colour keeps labels
      // legible over edges (mitred joins leave spikes on glyph corners).
      ctx.lineWidth = 3.5 / scale;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = palette.canvas;
      ctx.strokeText(n.name, x0, n.y);
      const strong = n.id === selectedId || n.is_hub || forced;
      // Paths read as breadcrumbs: the directory recedes, the name leads.
      const cut = n.__group === 'file' ? n.name.lastIndexOf('/') + 1 : 0;
      if (cut > 0) {
        const dir = n.name.slice(0, cut);
        ctx.fillStyle = palette.text3;
        ctx.fillText(dir, x0, n.y);
        ctx.fillStyle = strong ? palette.text1 : palette.text2;
        // Measured live, not from the cache: glyph advances at the scaled
        // font size aren't exactly linear in zoom, and a cached width leaves
        // the name overlapping its directory.
        ctx.fillText(n.name.slice(cut), x0 + ctx.measureText(dir).width, n.y);
      } else {
        ctx.fillStyle = strong ? palette.text1 : palette.text2;
        ctx.fillText(n.name, x0, n.y);
      }
    }
  };

  // A dot grid in graph space: it pans and zooms with the nodes, so the eye
  // has a fixed frame while the layout moves. Faint enough to sit under edges.
  const drawGrid = (ctx: CanvasRenderingContext2D, scale: number): void => {
    const t = ctx.getTransform();
    if (t.a === 0) return;
    const dpr = t.a / scale;
    const step = 2 ** Math.ceil(Math.log2((GRID_PX * dpr) / t.a));
    const x0 = Math.floor(-t.e / t.a / step) * step;
    const y0 = Math.floor(-t.f / t.d / step) * step;
    const x1 = (ctx.canvas.width - t.e) / t.a;
    const y1 = (ctx.canvas.height - t.f) / t.d;
    const d = (1.6 * dpr) / t.a;
    ctx.fillStyle = palette.text3;
    ctx.globalAlpha = palette.scheme === 'light' ? 0.2 : 0.13;
    for (let x = x0; x <= x1; x += step)
      for (let y = y0; y <= y1; y += step) ctx.fillRect(x - d / 2, y - d / 2, d, d);
    ctx.globalAlpha = 1;
  };

  // C5: each agent's recent path through the graph, oldest steps faintest,
  // drawn under the nodes. Steps on nodes the map hasn't loaded are skipped.
  const TRAIL_MS = 45_000;
  const drawTrails = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (!trail.length) return;
    const at = new Map(graphData.nodes.map((n) => [n.id, n]));
    const now = Date.now();
    const byAgent = new Map<string | null, TrailPoint[]>();
    for (const t of trail) {
      const list = byAgent.get(t.agent);
      if (list) list.push(t);
      else byAgent.set(t.agent, [t]);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [agent, steps] of byAgent) {
      const pts = steps.flatMap((t) => {
        const n = at.get(t.id);
        return n && n.x !== undefined && n.y !== undefined ? [{ x: n.x, y: n.y, ts: t.ts }] : [];
      });
      ctx.strokeStyle = agentColor(agent);
      ctx.lineWidth = 2 / scale;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        if (a.x === b.x && a.y === b.y) continue;
        ctx.globalAlpha = 0.75 * Math.max(0, 1 - (now - b.ts) / TRAIL_MS);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  };

  const zoomBy = (f: number): void => {
    const fg = ref.current;
    if (!fg) return;
    fg.zoom(fg.zoom() * f, 250);
  };

  return (
    <div
      ref={wrap}
      className="canvas-wrap"
      tabIndex={0}
      role="application"
      aria-label={`Constellation of ${graphData.nodes.length} nodes. Use the search (Control K) or the List view to pick a node with the keyboard.`}
      onMouseMove={(e) => {
        const r = wrap.current!.getBoundingClientRect();
        mouse.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      }}
      onKeyDown={(e) => {
        if (e.key === '+' || e.key === '=') zoomBy(1.3);
        else if (e.key === '-') zoomBy(1 / 1.3);
        else if (e.key === '0') ref.current?.zoomToFit(400, 40);
      }}
    >
      <ForceGraph2D
        ref={ref}
        width={size.w}
        height={size.h}
        graphData={graphData}
        backgroundColor={palette.canvas}
        nodeId="id"
        autoPauseRedraw={!pulsing}
        cooldownTicks={220}
        d3VelocityDecay={0.32}
        minZoom={0.15}
        maxZoom={12}
        onEngineStop={() => {
          for (const n of graphData.nodes) {
            if (n.x !== undefined && n.y !== undefined)
              positions.current.set(n.id, { x: n.x, y: n.y });
            if (pinned.current.has(n.id)) {
              delete n.fx;
              delete n.fy;
            }
          }
          pinned.current.clear();
          if (!settled.current) {
            settled.current = true;
            ref.current?.zoomToFit(500, 48);
          }
        }}
        linkColor={(raw) => {
          const l = raw as GraphLink;
          const on = linkInvolves(l);
          if (l.table === 'pending') return palette.pending;
          if (on) return withAlpha(palette.accent, 0.7);
          if (dimOthers) return palette.edge;
          if (l.table === 'semantic') return palette.edgeStrong;
          return palette.edge;
        }}
        linkWidth={(raw) => {
          const l = raw as GraphLink;
          if (l.table === 'pending') return 1.8;
          if (linkInvolves(l)) return 1.4;
          return l.table === 'semantic' ? 1.3 : 0.7;
        }}
        linkLineDash={(raw) => ((raw as GraphLink).table === 'pending' ? [5, 4] : null)}
        nodeVal={(raw) => radiusFor(raw as GraphNode) ** 2 / 4}
        nodeLabel={() => ''}
        nodeCanvasObjectMode={() => 'replace'}
        nodeCanvasObject={(raw, ctx, scale) => {
          const n = raw as GraphNode;
          const x = n.x ?? 0;
          const y = n.y ?? 0;
          const r = radiusFor(n);
          const alpha = nodeAlpha(n.id);
          ctx.globalAlpha = alpha;
          const ink = fillFor(palette, n.__group);
          if (n.is_hub) {
            // Hubs carry a soft halo in their own colour, not a grey ring.
            ctx.beginPath();
            ctx.arc(x, y, r + 4.5, 0, 2 * Math.PI);
            ctx.fillStyle = withAlpha(ink, palette.scheme === 'light' ? 0.16 : 0.22);
            ctx.fill();
          }
          if (hover?.node.id === n.id && n.id !== selectedId) {
            ctx.beginPath();
            ctx.arc(x, y, r + 3.5, 0, 2 * Math.PI);
            ctx.lineWidth = 1.5 / scale;
            ctx.strokeStyle = palette.text2;
            ctx.stroke();
          }
          ctx.fillStyle = ink;
          drawShape(ctx, n.__shape, x, y, r, scale, palette.canvas);
          if (highlight.has(n.id)) {
            ctx.beginPath();
            ctx.arc(x, y, r + 5, 0, 2 * Math.PI);
            ctx.setLineDash([3 / scale, 3 / scale]);
            ctx.lineWidth = 1.5 / scale;
            ctx.strokeStyle = palette.accent;
            ctx.stroke();
            ctx.setLineDash([]);
          }
          if (n.id === selectedId) {
            ctx.beginPath();
            ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
            ctx.lineWidth = 2.2 / scale;
            ctx.strokeStyle = palette.accent;
            ctx.stroke();
          }
          const ts = pulses.get(n.id);
          if (ts !== undefined) {
            const age = Date.now() - ts;
            if (age < PULSE_MS) {
              const t = age / PULSE_MS;
              ctx.beginPath();
              ctx.arc(x, y, r + 3 + t * 16, 0, 2 * Math.PI);
              ctx.lineWidth = 1.6 / scale;
              ctx.strokeStyle = lastAgent.has(n.id)
                ? agentColor(lastAgent.get(n.id)!)
                : palette.accent;
              ctx.globalAlpha = (1 - t) * 0.9;
              ctx.stroke();
            }
          }
          ctx.globalAlpha = 1;
        }}
        nodePointerAreaPaint={(raw, color, ctx) => {
          const n = raw as GraphNode;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, radiusFor(n) + 3, 0, 2 * Math.PI);
          ctx.fill();
        }}
        onRenderFramePre={(ctx, scale) => {
          drawGrid(ctx, scale);
          drawTrails(ctx, scale);
        }}
        onRenderFramePost={drawLabels}
        onNodeHover={(raw) => {
          const n = raw as GraphNode | null;
          if (wrap.current) wrap.current.style.cursor = n ? 'pointer' : 'grab';
          setHover(n ? { node: n, x: mouse.current.x, y: mouse.current.y } : null);
        }}
        onNodeClick={(raw) => onSelect((raw as GraphNode).id)}
        onBackgroundClick={() => onSelect(null)}
        onNodeDragEnd={(raw) => {
          const n = raw as GraphNode;
          if (n.x !== undefined && n.y !== undefined)
            positions.current.set(n.id, { x: n.x, y: n.y });
        }}
      />
      {offMap && (
        <div className="map-note island" role="status">
          <span>
            {offMap === 'filtered'
              ? 'The selected node is hidden by the filters.'
              : `The selected node isn't among the ${snapshot.nodes.length.toLocaleString()} nodes on the map.`}
          </span>
          <button className="btn btn-sm" onClick={() => onOpenNeighbourhood(selectedId!)}>
            Open its neighbourhood
          </button>
        </div>
      )}
      {hover && (
        <div
          className="hovercard float"
          style={{
            left: Math.min(hover.x + 14, size.w - 330),
            top: Math.min(hover.y + 14, size.h - 70),
          }}
        >
          <div className="t">
            <span
              className="glyph"
              data-shape={hover.node.__shape}
              style={{
                ['--g' as string]: `var(${GROUPS.find((g) => g.id === hover.node.__group)!.cssVar})`,
              }}
            />
            <span className="truncate">{hover.node.name}</span>
          </div>
          <div className="s">
            {kindLabel(hover.node.type)} · {hover.node.__deg} link
            {hover.node.__deg === 1 ? '' : 's'}
            {hover.node.is_hub ? ` · hub ${(hover.node.hubness ?? 0).toFixed(2)}` : ''}
          </div>
          {hover.node.file_path && hover.node.type !== 'file' && (
            <div className="s truncate">{hover.node.file_path}</div>
          )}
        </div>
      )}
      <div className="zoom-ctl island">
        <button
          className="btn btn-sm btn-ghost icon-btn"
          aria-label="Zoom in"
          title="Zoom in (+)"
          onClick={() => zoomBy(1.3)}
        >
          <Plus />
        </button>
        <button
          className="btn btn-sm btn-ghost icon-btn"
          aria-label="Zoom out"
          title="Zoom out (−)"
          onClick={() => zoomBy(1 / 1.3)}
        >
          <Minus />
        </button>
        <button
          className="btn btn-sm btn-ghost icon-btn"
          aria-label="Fit to screen"
          title="Fit (0)"
          onClick={() => ref.current?.zoomToFit(400, 40)}
        >
          <Maximize2 />
        </button>
      </div>
    </div>
  );
}

export { Constellation as Map };

const AGENT_VARS = ['--accent', '--agent-2', '--agent-3', '--agent-4'];

export const Legend = ({
  shown,
  total,
  agents = [],
  allAgents = [],
}: {
  shown: number;
  total: number;
  // Agents with a trail on the map now, and every agent seen (for colour order).
  agents?: string[];
  allAgents?: string[];
}): JSX.Element => (
  <div className="legend island" aria-label="Legend">
    {GROUPS.map((g) => (
      <span key={g.id}>
        <i
          className="glyph"
          data-shape={g.shape}
          style={{ ['--g' as string]: `var(${g.cssVar})` }}
        />
        {g.label}
      </span>
    ))}
    <span>
      <i className="line faint" /> Structural
    </span>
    <span>
      <i className="line" /> Accepted link
    </span>
    <span>
      <i className="line dash" /> Pending review
    </span>
    {agents.map((a) => (
      <span key={a} title={`${a}: recent activity`}>
        <i
          className="agent-dot"
          style={{
            ['--a' as string]: `var(${AGENT_VARS[Math.max(0, allAgents.indexOf(a)) % AGENT_VARS.length]})`,
          }}
        />
        {a}
      </span>
    ))}
    {shown < total && (
      <span className="legend-count" title="Raise Map density in Settings to load more">
        <span className="num">{shown.toLocaleString()}</span> of{' '}
        <span className="num">{total.toLocaleString()}</span> nodes, by hubness
      </span>
    )}
  </div>
);
