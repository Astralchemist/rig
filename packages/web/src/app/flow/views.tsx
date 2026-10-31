// SPDX-License-Identifier: Apache-2.0
import '@xyflow/react/dist/base.css';
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  GitFork,
  Inbox,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import {
  api,
  relTime,
  absTime,
  WAYPOINT_KINDS,
  type Blueprint,
  type CriticalStep,
  type ImpactTree,
  type Neighborhood,
  type NodeCard,
  type PendingEdge,
  type Waypoint,
  type WaypointDetail,
} from '../api.ts';
import { Glyph } from '../NodeDetail.tsx';
import { useToast } from '../Toasts.tsx';
import {
  CARD_W,
  CENTER_W,
  WAY_H,
  WAY_W,
  edgeTypes,
  fanLayout,
  layout,
  nodeTypes,
  waypointTone,
  type CardData,
  type FlowEdgeData,
  type WaypointData,
  BP_H,
  BP_W,
  type BlueprintData,
} from './parts.tsx';

type AnyNode =
  | Node<CardData, 'card'>
  | Node<WaypointData, 'waypoint'>
  | Node<BlueprintData, 'blueprint'>;
type FlowEdge = Edge<FlowEdgeData, 'typed'>;

const cardHeight = (c: NodeCard, center: boolean): number => {
  const badges = c.is_hub || c.annotations > 0 || c.waypoints > 0 || c.orphans > 0;
  return 50 + (c.file ? 14 : 0) + (badges ? 27 : 0) + (center && c.signature ? 44 : 0);
};

const cardNode = (
  c: NodeCard,
  opts: { center?: boolean; dim?: boolean } = {},
): Node<CardData, 'card'> => ({
  id: c.id,
  type: 'card',
  position: { x: 0, y: 0 },
  data: { card: c, ...(opts.center ? { center: true } : {}), ...(opts.dim ? { dim: true } : {}) },
  width: opts.center ? CENTER_W : CARD_W,
  height: cardHeight(c, opts.center === true),
});

const sizeOf = (n: AnyNode): { w: number; h: number } => ({
  w: n.width ?? CARD_W,
  h: n.height ?? 80,
});

const marker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--text-3)' };

// Flow canvas with the shared chrome; refits whenever the node set changes.
function FlowCanvas({
  nodes,
  edges,
  onNodeClick,
  onNodeDoubleClick,
  onEdgeClick,
  label,
}: {
  nodes: AnyNode[];
  edges: FlowEdge[];
  onNodeClick?: (id: string) => void;
  onNodeDoubleClick?: (id: string) => void;
  onEdgeClick?: (e: FlowEdge) => void;
  label: string;
}): JSX.Element {
  const rf = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  const key = nodes.map((n) => n.id).join('|');
  useEffect(() => {
    const t = requestAnimationFrame(
      () => void rf.fitView({ padding: 0.18, duration: 300, maxZoom: 1.15 }),
    );
    return () => cancelAnimationFrame(t);
  }, [key, rf]);
  // Refit when the pane changes size (a sheet opens, a list collapses on a
  // phone, the window resizes): a fit taken at zero size leaves a speck.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let last = '';
    const ro = new ResizeObserver(() => {
      const sz = `${el.clientWidth}x${el.clientHeight}`;
      if (sz === last || el.clientWidth === 0) return;
      last = sz;
      void rf.fitView({ padding: 0.18, maxZoom: 1.15 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rf]);
  return (
    <div ref={box} style={{ position: 'absolute', inset: 0 }}>
      <ReactFlow
        aria-label={label}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesConnectable={false}
        nodesDraggable
        elementsSelectable
        minZoom={0.15}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.15 }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => onNodeClick?.(n.id)}
        onNodeDoubleClick={(_, n) => onNodeDoubleClick?.(n.id)}
        onEdgeClick={(_, e) => onEdgeClick?.(e as FlowEdge)}
        // Enter on a focused card does what a click does.
        onKeyDown={(e) => {
          const el = (e.target as HTMLElement).closest('.react-flow__node');
          const id = el?.getAttribute('data-id');
          if (id && e.key === 'Enter') onNodeClick?.(id);
        }}
      >
        <Background gap={20} size={1} color="var(--grid-dot)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}

const Loading = ({ label }: { label: string }): JSX.Element => (
  <div className="state" role="status">
    <div className="state-inner">
      <div className="spinner" />
      <p>{label}</p>
    </div>
  </div>
);

const Failed = ({ message, retry }: { message: string; retry: () => void }): JSX.Element => (
  <div className="state" role="alert">
    <div className="state-inner">
      <div className="state-icon">
        <X />
      </div>
      <h2>Couldn't load this view</h2>
      <p>{message}</p>
      <button className="btn btn-outline" onClick={retry}>
        <RotateCcw /> Retry
      </button>
    </div>
  </div>
);

const useLoad = <T,>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | null; err: string | null; retry: () => void } => {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setErr(null);
    load()
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, err, retry: () => setN((x) => x + 1) };
};

// ── Neighbourhood ──────────────────────────────────────────────────────

export interface FocusProps {
  id: string;
  version: number;
  onNavigate: (id: string) => void;
  onReview: (pendingId: number) => void;
  onBackToMap: (id: string) => void;
}

const LIMITS = [24, 48, 96];

export function FocusView(props: FocusProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <FocusInner {...props} />
    </ReactFlowProvider>
  );
}

function FocusInner({ id, version, onNavigate, onReview, onBackToMap }: FocusProps): JSX.Element {
  const [limit, setLimit] = useState(LIMITS[0]!);
  const { data, err, retry } = useLoad<Neighborhood>(
    () => api.neighborhood(id, limit),
    [id, limit, version],
  );
  const graph = useMemo(() => {
    if (!data || data.center.id !== id) return null;
    const center = cardNode(data.center, { center: true });
    const others: AnyNode[] = data.nodes.map((c) => cardNode(c));
    // One label per (direction, kind) group; the rest of the fan stays quiet.
    const labelled = new Set<string>();
    const edges: FlowEdge[] = data.edges.map((e, i) => {
      const group = `${e.dst === id ? 'in' : 'out'}:${e.table}:${e.kind}`;
      const label = e.table !== 'structural' || !labelled.has(group);
      labelled.add(group);
      return {
        id: `${e.table}:${e.src}:${e.dst}:${e.kind}:${i}`,
        source: e.src,
        target: e.dst,
        type: 'typed',
        data: {
          table: e.table,
          kind: e.kind,
          label,
          ...(e.weight !== undefined ? { weight: e.weight } : {}),
          ...(e.pending_id !== undefined ? { pending: e.pending_id } : {}),
        } as FlowEdgeData,
        markerEnd: marker,
      };
    });
    return { nodes: fanLayout<AnyNode>(center, others, edges, sizeOf), edges };
  }, [data, id]);
  if (err) return <Failed message={err} retry={retry} />;
  if (!graph || !data) return <Loading label="Gathering the neighbourhood…" />;
  return (
    <div className="detail-flow" style={{ position: 'absolute', inset: 0 }}>
      <FlowCanvas
        label={`Neighbourhood of ${data.center.name}`}
        nodes={graph.nodes}
        edges={graph.edges}
        onNodeClick={(nid) => nid !== id && onNavigate(nid)}
        onNodeDoubleClick={onBackToMap}
        onEdgeClick={(e) => {
          const pid = (e.data as FlowEdgeData & { pending?: number })?.pending;
          if (pid !== undefined) onReview(pid);
        }}
      />
      <div className="flow-note island">
        {data.nodes.length} neighbour{data.nodes.length === 1 ? '' : 's'}
        {data.truncated > 0 ? ` shown, ${data.truncated} more` : ''} · click a card to recentre ·
        double-click to find it on the map
      </div>
      {data.truncated > 0 || limit > LIMITS[0]! ? (
        <div className="flow-toolbar">
          <div className="seg" role="group" aria-label="Neighbours shown">
            {LIMITS.map((l) => (
              <button key={l} aria-pressed={limit === l} onClick={() => setLimit(l)}>
                {l}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Impact ─────────────────────────────────────────────────────────────

export interface ImpactProps {
  id: string;
  version: number;
  onNavigate: (id: string) => void;
  onBackToMap: (id: string) => void;
}

export function ImpactView(props: ImpactProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <ImpactInner {...props} />
    </ReactFlowProvider>
  );
}

function ImpactInner({ id, version, onNavigate, onBackToMap }: ImpactProps): JSX.Element {
  const [mode, setMode] = useState<'tree' | 'path'>('tree');
  const [depth, setDepth] = useState(2);
  const tree = useLoad<ImpactTree | null>(
    () => (mode === 'tree' ? api.impact(id, depth) : Promise.resolve(null)),
    [id, depth, mode, version],
  );
  const path = useLoad<{ path: CriticalStep[] } | null>(
    () => (mode === 'path' ? api.criticalPath(id) : Promise.resolve(null)),
    [id, mode, version],
  );

  const graph = useMemo(() => {
    if (mode === 'tree') {
      const t = tree.data;
      if (!t || t.root.id !== id) return null;
      const nodes: AnyNode[] = [
        cardNode(t.root, { center: true }),
        ...t.nodes.map((c) => cardNode(c, { dim: c.depth > 1 })),
      ];
      const edges: FlowEdge[] = t.edges.map((e, i) => ({
        id: `i:${i}`,
        source: e.src,
        target: e.dst,
        type: 'typed',
        data: { table: 'structural', kind: e.kind },
      }));
      return {
        nodes: layout(nodes, edges, { rankdir: 'LR', ranksep: 100, nodesep: 12, size: sizeOf }),
        edges,
        count: t.nodes.length,
        truncated: t.truncated,
      };
    }
    const p = path.data?.path;
    if (!p) return null;
    const cards = p.map((s) => s.card).filter((c): c is NodeCard => c !== null);
    const nodes: AnyNode[] = cards.map((c, i) => cardNode(c, { center: i === 0 }));
    const edges: FlowEdge[] = p.slice(1).map((s, i) => ({
      id: `p:${i}`,
      source: p[i]!.id,
      target: s.id,
      type: 'typed',
      data: { table: 'semantic', kind: `step ${i + 1}`, weight: s.step_weight },
      markerEnd: marker,
    }));
    return {
      nodes: layout(nodes, edges, { rankdir: 'LR', ranksep: 70, size: sizeOf }),
      edges,
      count: Math.max(0, cards.length - 1),
      truncated: false,
    };
  }, [mode, tree.data, path.data, id]);

  const active = mode === 'tree' ? tree : path;
  return (
    <div className="detail-flow" style={{ position: 'absolute', inset: 0 }}>
      {active.err ? (
        <Failed message={active.err} retry={active.retry} />
      ) : !graph ? (
        <Loading
          label={mode === 'tree' ? 'Walking what depends on it…' : 'Tracing the critical path…'}
        />
      ) : graph.count === 0 ? (
        <div className="state">
          <div className="state-inner">
            <div className="state-icon">
              <GitFork />
            </div>
            <h2>{mode === 'tree' ? 'Nothing depends on this' : 'No onward path'}</h2>
            <p>
              {mode === 'tree'
                ? 'No other node in the graph calls, imports, contains or references it.'
                : 'The critical path stops here: there are no outbound links worth following.'}
            </p>
          </div>
        </div>
      ) : (
        <FlowCanvas
          label={mode === 'tree' ? 'Impact tree' : 'Critical path'}
          nodes={graph.nodes}
          edges={graph.edges}
          onNodeClick={(nid) => nid !== id && onNavigate(nid)}
          onNodeDoubleClick={onBackToMap}
        />
      )}
      <div className="flow-toolbar">
        <div className="seg" role="group" aria-label="Impact view">
          <button aria-pressed={mode === 'tree'} onClick={() => setMode('tree')}>
            Dependents
          </button>
          <button aria-pressed={mode === 'path'} onClick={() => setMode('path')}>
            Critical path
          </button>
        </div>
        {mode === 'tree' && (
          <div className="seg" role="group" aria-label="Depth">
            {[1, 2, 3, 4].map((d) => (
              <button
                key={d}
                aria-pressed={depth === d}
                onClick={() => setDepth(d)}
                aria-label={`Depth ${d}`}
              >
                {d}
              </button>
            ))}
          </div>
        )}
      </div>
      {graph && graph.count > 0 && (
        <div className="flow-note island">
          {mode === 'tree'
            ? `${graph.count} dependent${graph.count === 1 ? '' : 's'} within ${depth} hop${depth === 1 ? '' : 's'}${graph.truncated ? ' (capped)' : ''} · what rig_impact walks`
            : `${graph.count} step${graph.count === 1 ? '' : 's'} · what rig_critical_path follows`}
        </div>
      )}
    </div>
  );
}

// ── Pending review ─────────────────────────────────────────────────────

export interface ReviewProps {
  version: number;
  focusPending: number | null;
  onOpenNode: (id: string) => void;
}

export function ReviewView(props: ReviewProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <ReviewInner {...props} />
    </ReactFlowProvider>
  );
}

function ReviewInner({ version, focusPending, onOpenNode }: ReviewProps): JSX.Element {
  const toast = useToast();
  const [local, setLocal] = useState(0);
  const list = useLoad<{ pending: PendingEdge[]; cards: Map<string, NodeCard> }>(async () => {
    const all = (await api.pending()).filter((p) => p.status === 'pending');
    all.sort((a, b) => b.proposed_at - a.proposed_at);
    const cards = await api.cards([...new Set(all.flatMap((p) => [p.src, p.dst]))]);
    return { pending: all, cards: new Map(cards.map((c) => [c.id, c])) };
  }, [version, local]);
  const [sel, setSel] = useState<number | null>(focusPending);
  const [busy, setBusy] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusPending !== null) setSel(focusPending);
  }, [focusPending]);

  const items = list.data?.pending ?? [];
  const current = items.find((p) => p.id === sel) ?? items[0] ?? null;
  const cards = list.data?.cards;
  const name = (id: string): string => cards?.get(id)?.name ?? id;

  const context = useLoad<{ src: Neighborhood; dst: Neighborhood } | null>(
    async () =>
      current
        ? {
            src: await api.neighborhood(current.src, 3),
            dst: await api.neighborhood(current.dst, 3),
          }
        : null,
    [current?.id, version, local],
  );

  const graph = useMemo(() => {
    if (!current || !cards || !context.data) return null;
    const srcCard = cards.get(current.src);
    const dstCard = cards.get(current.dst);
    if (!srcCard || !dstCard) return null;
    // The proposal reads left to right: source, the dashed proposed link,
    // target; each end's existing neighbours sit dimmed on its outer side.
    // On a phone there is no room for context, so it stacks src over dst.
    const src = cardNode(srcCard, { center: true });
    const dst = cardNode(dstCard, { center: true });
    const narrow = window.innerWidth <= 760;
    const GAP = 200;
    const nodes: AnyNode[] = [];
    const edges: FlowEdge[] = [
      {
        id: `pending:${current.id}`,
        source: current.src,
        target: current.dst,
        type: 'typed',
        data: { table: 'pending', kind: current.kind, weight: current.weight },
        markerEnd: { ...marker, color: 'var(--pending)' },
      },
    ];
    const sh = src.height ?? 80;
    const dh = dst.height ?? 80;
    if (narrow) {
      nodes.push({ ...src, position: { x: 0, y: 0 } }, { ...dst, position: { x: 0, y: sh + 150 } });
      return { nodes, edges };
    }
    nodes.push(
      { ...src, position: { x: 0, y: -sh / 2 } },
      { ...dst, position: { x: CENTER_W + GAP, y: -dh / 2 } },
    );
    const taken = new Set([srcCard.id, dstCard.id]);
    const column = (h: Neighborhood, x: number): void => {
      const ctx = h.nodes
        .filter((c) => !taken.has(c.id) && c.kind !== 'conversation-waypoint')
        .slice(0, 3);
      const cs = ctx.map((c) => cardNode(c, { dim: true }));
      const total = cs.reduce((t, n) => t + (n.height ?? 80), 0) + 14 * Math.max(0, cs.length - 1);
      let y = -total / 2;
      for (const n of cs) {
        taken.add(n.id);
        nodes.push({ ...n, position: { x, y } });
        y += (n.height ?? 80) + 14;
      }
      for (const [i, e] of h.edges.entries()) {
        if (e.table === 'pending' && e.pending_id === current.id) continue;
        const ends = [e.src, e.dst];
        if (!ends.includes(h.center.id) || !cs.some((n) => ends.includes(n.id))) continue;
        edges.push({
          id: `ctx:${h.center.id}:${i}`,
          source: e.src,
          target: e.dst,
          type: 'typed',
          data: { table: e.table, kind: e.kind, label: false },
        });
      }
    };
    column(context.data.src, -(CARD_W + 110));
    column(context.data.dst, CENTER_W * 2 + GAP + 110);
    return { nodes, edges };
  }, [current, cards, context.data]);

  const decide = async (verb: 'accept' | 'reject'): Promise<void> => {
    if (!current || busy) return;
    setBusy(true);
    const idx = items.findIndex((p) => p.id === current.id);
    const next = items[idx + 1] ?? items[idx - 1] ?? null;
    try {
      await (verb === 'accept' ? api.accept(current.id) : api.reject(current.id));
      setCanUndo(true);
      toast({
        tone: 'success',
        title: verb === 'accept' ? 'Link accepted' : 'Proposal rejected',
        detail: `${name(current.src)} → ${name(current.dst)} · ${current.kind}`,
        action: { label: 'Undo', run: () => void undo() },
      });
      setSel(next?.id ?? null);
      setLocal((x) => x + 1);
    } catch (e) {
      toast({
        tone: 'danger',
        title: `Couldn't ${verb} the proposal`,
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const undo = async (): Promise<void> => {
    try {
      const r = await api.undo();
      if (r.undone)
        toast({ tone: 'info', title: 'Undone', detail: r.undone.kind.replace('_', ' ') });
      else toast({ tone: 'warning', title: 'Nothing undone', detail: r.reason ?? '' });
      setCanUndo(false);
      setLocal((x) => x + 1);
    } catch (e) {
      toast({
        tone: 'danger',
        title: "Couldn't undo",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const idx = items.findIndex((p) => p.id === current?.id);
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      const n = items[Math.min(items.length - 1, idx + 1)];
      if (n) setSel(n.id);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      const n = items[Math.max(0, idx - 1)];
      if (n) setSel(n.id);
    } else if (e.key === 'a' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void decide('accept');
    } else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void decide('reject');
    } else if (e.key === 'u' || ((e.metaKey || e.ctrlKey) && e.key === 'z')) {
      e.preventDefault();
      void undo();
    }
  };

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-pid="${current?.id}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [current?.id]);

  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="split" data-open={mobileOpen && current ? 'true' : 'false'} onKeyDown={onKey}>
      <section className="split-list" aria-label="Pending proposals">
        <div className="split-list-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1 style={{ fontSize: 'var(--t-lg)' }}>Review</h1>
            {items.length > 0 && (
              <span className="badge badge-warning">{items.length} pending</span>
            )}
            <span style={{ flex: 1 }} />
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => void undo()}
              disabled={!canUndo}
              title="Undo the last decision (U)"
            >
              <RotateCcw /> Undo
            </button>
          </div>
          <p className="quiet" style={{ fontSize: 'var(--t-xs)', marginTop: 4 }}>
            Links your agent proposed. Accepted ones join the graph and shape what it pulls next.
          </p>
        </div>
        <div
          ref={listRef}
          className="split-list-body"
          role="listbox"
          aria-label="Proposals"
          aria-activedescendant={current ? `pending-${current.id}` : undefined}
          tabIndex={0}
        >
          {list.err && <Failed message={list.err} retry={list.retry} />}
          {!list.data &&
            !list.err &&
            [0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 54, margin: 6 }} />
            ))}
          {list.data && items.length === 0 && (
            <div className="state" style={{ height: 'auto', paddingTop: 48 }}>
              <div className="state-inner">
                <div className="state-icon">
                  <Inbox />
                </div>
                <h2>Nothing to review</h2>
                <p>
                  When your agent calls rig_propose_edge, its proposals land here for you to accept
                  or reject.
                </p>
              </div>
            </div>
          )}
          {items.map((p) => (
            <div
              key={p.id}
              id={`pending-${p.id}`}
              data-pid={p.id}
              role="option"
              aria-selected={p.id === current?.id}
              className="row list-item"
              onClick={() => {
                setSel(p.id);
                setMobileOpen(true);
              }}
            >
              <div className="top">
                {cards?.get(p.src) && <Glyph kind={cards.get(p.src)!.kind} />}
                <span className="truncate" style={{ fontWeight: 550 }}>
                  {name(p.src)}
                </span>
                <ArrowRight size={13} className="arrow" aria-label="to" />
                {cards?.get(p.dst) && <Glyph kind={cards.get(p.dst)!.kind} />}
                <span className="truncate" style={{ fontWeight: 550 }}>
                  {name(p.dst)}
                </span>
              </div>
              <div className="top sub">
                <span className="mono">{p.kind}</span>
                <span className="meter" title={`weight ${p.weight.toFixed(2)}`}>
                  <i style={{ width: `${Math.round(p.weight * 100)}%` }} />
                </span>
                <span className="num">{p.weight.toFixed(2)}</span>
                <span style={{ flex: 1 }} />
                <span title={absTime(p.proposed_at)}>{relTime(p.proposed_at)}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="split-detail" aria-label="Proposal">
        {current ? (
          <>
            <div className="detail-head">
              <button
                className="btn btn-sm btn-ghost only-narrow"
                onClick={() => setMobileOpen(false)}
                style={{ marginBottom: 8 }}
              >
                <ArrowLeft /> All proposals
              </button>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                  <div className="eyebrow">
                    Proposed {relTime(current.proposed_at)} by{' '}
                    <span className="mono">{current.provenance}</span>
                  </div>
                  <h2
                    style={{
                      marginTop: 4,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <button
                      className="btn btn-ghost"
                      style={{ padding: '0 4px', fontSize: 'inherit', fontWeight: 600 }}
                      onClick={() => onOpenNode(current.src)}
                    >
                      {name(current.src)}
                    </button>
                    <span className="badge badge-warning mono">{current.kind}</span>
                    <button
                      className="btn btn-ghost"
                      style={{ padding: '0 4px', fontSize: 'inherit', fontWeight: 600 }}
                      onClick={() => onOpenNode(current.dst)}
                    >
                      {name(current.dst)}
                    </button>
                  </h2>
                  <p style={{ marginTop: 6, color: 'var(--text-2)' }}>{current.rationale}</p>
                  {current.source_urls.length > 0 && (
                    <div style={{ display: 'grid', gap: 2, marginTop: 6 }}>
                      {current.source_urls.map((u) => (
                        <a
                          key={u}
                          className="url"
                          href={u}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          <ExternalLink aria-hidden /> <span className="truncate">{u}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void decide('accept')}
                    aria-keyshortcuts="a"
                  >
                    <Check /> Accept{' '}
                    <span
                      className="kbd"
                      style={{
                        background: 'transparent',
                        color: 'inherit',
                        borderColor: 'currentColor',
                        opacity: 0.6,
                      }}
                    >
                      A
                    </span>
                  </button>
                  <button
                    className="btn btn-outline"
                    disabled={busy}
                    onClick={() => void decide('reject')}
                    aria-keyshortcuts="r"
                  >
                    <X /> Reject <span className="kbd">R</span>
                  </button>
                </div>
              </div>
            </div>
            <div className="detail-flow">
              {context.err ? (
                <Failed message={context.err} retry={context.retry} />
              ) : graph ? (
                <FlowCanvas
                  label="Proposed link in context"
                  nodes={graph.nodes}
                  edges={graph.edges}
                  onNodeDoubleClick={onOpenNode}
                />
              ) : (
                <Loading label="Loading context…" />
              )}
              <div className="flow-note island">
                <span className="kbd">↑</span> <span className="kbd">↓</span> move ·{' '}
                <span className="kbd">A</span> accept · <span className="kbd">R</span> reject ·{' '}
                <span className="kbd">U</span> undo · dimmed cards are existing neighbours
              </div>
            </div>
          </>
        ) : list.data ? (
          <div className="state">
            <div className="state-inner">
              <div className="state-icon">
                <Check />
              </div>
              <h2>All caught up</h2>
              <p>No proposals are waiting.</p>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

// ── Waypoints ──────────────────────────────────────────────────────────

export interface WaypointsProps {
  version: number;
  focusWaypoint: string | null;
  freshIds: Set<string>;
  onOpenNode: (id: string) => void;
}

export function WaypointsView(props: WaypointsProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <WaypointsInner {...props} />
    </ReactFlowProvider>
  );
}

function WaypointsInner({
  version,
  focusWaypoint,
  freshIds,
  onOpenNode,
}: WaypointsProps): JSX.Element {
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);
  const list = useLoad<{ waypoints: Waypoint[]; degraded?: string }>(
    () => api.waypoints({ ...(kind ? { kind } : {}), ...(query ? { q: query } : {}) }),
    [kind, query, version],
  );
  const [sel, setSel] = useState<string | null>(focusWaypoint);
  useEffect(() => {
    if (focusWaypoint) setSel(focusWaypoint);
  }, [focusWaypoint]);
  const items = list.data?.waypoints ?? [];
  const current = items.find((w) => w.id === sel) ?? items[0] ?? null;
  const detail = useLoad<WaypointDetail | null>(
    () => (current ? api.waypoint(current.id) : Promise.resolve(null)),
    [current?.id, version],
  );
  const [mobileOpen, setMobileOpen] = useState(false);

  const graph = useMemo(() => {
    const d = detail.data;
    if (!d || d.waypoint.id !== current?.id) return null;
    // Oldest first, top to bottom; anchored code in a column to the right.
    const chain = [...d.chain].sort((a, b) => a.ts - b.ts);
    if (!chain.some((w) => w.id === d.waypoint.id)) chain.push(d.waypoint);
    const nodes: AnyNode[] = [];
    const edges: FlowEdge[] = [];
    chain.forEach((w, i) => {
      nodes.push({
        id: w.id,
        type: 'waypoint',
        position: { x: 0, y: i * (WAY_H + 70) },
        data: { waypoint: w, current: w.id === d.waypoint.id },
        width: WAY_W,
      });
      if (i > 0) {
        edges.push({
          id: `succ:${i}`,
          source: chain[i - 1]!.id,
          sourceHandle: 'next',
          target: w.id,
          type: 'typed',
          data: { table: 'semantic', kind: 'then' },
        });
      }
    });
    const cards = new Map(d.refs.map((c) => [c.id, c]));
    const placed = new Set<string>();
    let y = 0;
    for (const w of chain) {
      for (const rid of w.constellation_refs) {
        const c = cards.get(rid);
        if (!c) continue;
        if (!placed.has(rid)) {
          const n = cardNode(c);
          nodes.push({ ...n, position: { x: WAY_W + 150, y } });
          y += (n.height ?? 80) + 16;
          placed.add(rid);
        }
        edges.push({
          id: `ref:${w.id}:${rid}`,
          source: w.id,
          sourceHandle: 'refs',
          target: rid,
          type: 'typed',
          data: { table: 'structural', kind: 'anchors', label: false },
        });
      }
    }
    return { nodes, edges };
  }, [detail.data, current?.id]);

  return (
    <div className="split" data-open={mobileOpen && current ? 'true' : 'false'}>
      <section className="split-list" aria-label="Waypoints">
        <div className="split-list-head" style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1 style={{ fontSize: 'var(--t-lg)' }}>Waypoints</h1>
            {list.data && <span className="badge">{items.length}</span>}
          </div>
          <div style={{ position: 'relative' }}>
            <Search
              size={14}
              style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-3)' }}
              aria-hidden
            />
            <input
              className="input"
              style={{ paddingLeft: 30 }}
              placeholder="Search titles, summaries, terms…"
              aria-label="Search waypoints"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select
            className="select"
            aria-label="Filter by kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">All kinds</option>
            {WAYPOINT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace('-', ' ')}
              </option>
            ))}
          </select>
          {list.data?.degraded && (
            <span className="quiet" style={{ fontSize: 'var(--t-2xs)' }}>
              Ranked by keywords only: the embedding model isn't loaded yet.
            </span>
          )}
        </div>
        <div className="split-list-body" role="listbox" aria-label="Waypoints" tabIndex={-1}>
          {list.err && <Failed message={list.err} retry={list.retry} />}
          {!list.data &&
            !list.err &&
            [0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 60, margin: 6 }} />
            ))}
          {list.data && items.length === 0 && (
            <div className="state" style={{ height: 'auto', paddingTop: 48 }}>
              <div className="state-inner">
                <div className="state-icon">
                  <Inbox />
                </div>
                <h2>{query || kind ? 'No matching waypoints' : 'No waypoints yet'}</h2>
                <p>
                  {query || kind
                    ? 'Try another search or kind.'
                    : 'Agents drop waypoints with rig_drop_waypoint to record decisions, constraints and open questions. They appear here live.'}
                </p>
              </div>
            </div>
          )}
          {items.map((w) => (
            <div
              key={w.id}
              role="option"
              tabIndex={0}
              aria-selected={w.id === current?.id}
              className="row list-item"
              onClick={() => {
                setSel(w.id);
                setMobileOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSel(w.id);
                  setMobileOpen(true);
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
                }
              }}
            >
              <div className="top">
                <span
                  className="glyph"
                  data-shape="triangle"
                  style={{ ['--g' as string]: waypointTone(w.kind) }}
                  aria-hidden
                />
                <span className="truncate" style={{ fontWeight: 550 }}>
                  {w.title}
                </span>
                {freshIds.has(w.id) && <span className="badge badge-accent">new</span>}
              </div>
              <div className="top sub">
                <span>{w.kind.replace('-', ' ')}</span>
                <span>·</span>
                <span className="truncate mono">{w.session_id}</span>
                <span style={{ flex: 1 }} />
                <span title={absTime(w.ts)}>{relTime(w.ts)}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="split-detail" aria-label="Waypoint">
        {current ? (
          <>
            <div className="detail-head">
              <button
                className="btn btn-sm btn-ghost only-narrow"
                onClick={() => setMobileOpen(false)}
                style={{ marginBottom: 8 }}
              >
                <ArrowLeft /> All waypoints
              </button>
              <div className="eyebrow" style={{ color: 'var(--text-3)' }}>
                {current.kind.replace('-', ' ')} · {relTime(current.ts)} ·{' '}
                <span className="mono">{current.session_id}</span>
              </div>
              <h2 style={{ marginTop: 4 }}>{current.title}</h2>
              {current.summary && (
                <p style={{ marginTop: 6, color: 'var(--text-2)' }}>{current.summary}</p>
              )}
              {current.rationale && (
                <p className="quiet" style={{ marginTop: 4, fontSize: 'var(--t-xs)' }}>
                  Why: {current.rationale}
                </p>
              )}
              {current.key_terms.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                  {current.key_terms.map((t) => (
                    <span key={t} className="badge mono">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="detail-flow">
              {detail.err ? (
                <Failed message={detail.err} retry={detail.retry} />
              ) : graph ? (
                <FlowCanvas
                  label="Waypoint chain and anchored code"
                  nodes={graph.nodes}
                  edges={graph.edges}
                  onNodeClick={(id) => !id.startsWith('waypoint:') && onOpenNode(id)}
                />
              ) : (
                <Loading label="Loading the chain…" />
              )}
              <div className="flow-note island">
                Earlier waypoints above, the code each one is anchored to on the right · click code
                to open it
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

// --- Blueprint (E4) ----------------------------------------------------------

export interface BlueprintProps {
  version: number;
}

export function BlueprintView(props: BlueprintProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <BlueprintInner {...props} />
    </ReactFlowProvider>
  );
}

function BlueprintInner({ version }: BlueprintProps): JSX.Element {
  const [level, setLevel] = useState<'floor' | 'site' | 'room'>('floor');
  // Room plan: the package opened from the floor plan.
  const [scope, setScope] = useState<{ dir: string; label: string } | null>(null);
  const toast = useToast();
  const plan = useLoad<Blueprint>(
    () => api.blueprint(level, level === 'room' ? scope?.dir : undefined),
    [level, scope?.dir, version],
  );

  const graph = useMemo(() => {
    const b = plan.data;
    if (!b) return null;
    const kindOf = new Map(b.boxes.map((x) => [x.id, x.kind]));
    const isPkg = (id: string): boolean => kindOf.get(id) === 'package';
    const nodes: AnyNode[] = b.boxes.map((x) => ({
      id: x.id,
      type: 'blueprint',
      position: { x: 0, y: 0 },
      data: {
        label: x.label,
        kind: x.kind,
        inferred: x.inferred,
        ...(x.detail ? { detail: x.detail } : {}),
        ...(x.evidence ? { evidence: x.evidence } : {}),
      },
    }));
    const edges: FlowEdge[] = b.edges.map((e, i) => ({
      id: `b:${i}`,
      source: e.from,
      target: e.to,
      type: 'typed',
      markerEnd: marker,
      // Only package-to-package edges are counted imports; the rest say
      // where a surface or store attaches.
      data: e.inferred
        ? { table: 'structural', kind: '', label: false, dashed: true }
        : (isPkg(e.from) && isPkg(e.to)) || b.level === 'room'
          ? { table: 'semantic', kind: `${e.weight} import${e.weight === 1 ? '' : 's'}` }
          : { table: 'semantic', kind: '', label: false },
    }));
    return {
      nodes: layout(nodes, edges, {
        rankdir: 'LR',
        ranksep: 90,
        nodesep: 22,
        size: () => ({ w: BP_W, h: BP_H }),
      }),
      edges,
      plan: b,
    };
  }, [plan.data]);

  const copyMermaid = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(
        await api.blueprintMermaid(level, level === 'room' ? scope?.dir : undefined),
      );
      toast({
        tone: 'success',
        title: 'Mermaid copied',
        detail: 'Paste it into a README or a PR: GitHub renders it.',
      });
    } catch (e) {
      toast({
        tone: 'danger',
        title: 'Could not copy',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="detail-flow" style={{ position: 'absolute', inset: 0 }}>
      {plan.err ? (
        <Failed message={plan.err} retry={plan.retry} />
      ) : !graph ? (
        <Loading label="Drawing the plan…" />
      ) : graph.nodes.length === 0 ? (
        <div className="state">
          <div className="state-inner">
            <h2>No packages to draw</h2>
            <p>
              The blueprint draws declared packages: add a package.json or pyproject.toml, then
              re-index.
            </p>
          </div>
        </div>
      ) : (
        <FlowCanvas
          label={
            level === 'floor'
              ? 'Floor plan'
              : level === 'room'
                ? `Room plan: ${scope?.label ?? ''}`
                : 'Site plan'
          }
          nodes={graph.nodes}
          edges={graph.edges}
          onNodeClick={(id) => {
            // A package on the floor plan opens its room plan.
            const box = graph.plan.boxes.find((x) => x.id === id);
            if (level === 'floor' && box?.kind === 'package' && box.dir !== undefined) {
              setScope({ dir: box.dir, label: box.label });
              setLevel('room');
            }
          }}
        />
      )}
      <div className="flow-toolbar">
        <div className="seg" role="group" aria-label="Plan">
          <button aria-pressed={level === 'floor'} onClick={() => setLevel('floor')}>
            Floor plan
          </button>
          <button aria-pressed={level === 'site'} onClick={() => setLevel('site')}>
            Site plan
          </button>
          {scope && (
            <button aria-pressed={level === 'room'} onClick={() => setLevel('room')}>
              {scope.label}
            </button>
          )}
        </div>
        <button className="btn island" style={{ height: 32 }} onClick={() => void copyMermaid()}>
          <Copy /> Copy Mermaid
        </button>
      </div>
      {graph && (
        <div className="flow-note island bp-legend">
          <span>
            <i className="bp-swatch" data-kind="package" /> package
          </span>
          <span>
            <i className="bp-swatch" data-kind="store" /> data store
          </span>
          <span>
            <i className="bp-swatch" data-kind="io" /> input / output
          </span>
          <span>
            <i className="bp-swatch" data-kind="external" /> external service
          </span>
          <span>dashed: inferred from a dependency</span>
          {graph.plan.commit && <span className="num">at {graph.plan.commit.slice(0, 7)}</span>}
          {graph.plan.folded.length > 0 && (
            <span>
              {graph.plan.folded.length} small{' '}
              {graph.plan.level === 'room' ? 'files and folders' : 'packages'} folded
            </span>
          )}
          {(graph.plan.hiddenEdges ?? 0) > 0 && (
            <span>{graph.plan.hiddenEdges} weaker links hidden</span>
          )}
        </div>
      )}
    </div>
  );
}
