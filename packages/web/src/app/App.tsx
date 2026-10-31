// SPDX-License-Identifier: Apache-2.0
import {
  AlertTriangle,
  Copy,
  GitFork,
  Inbox,
  LayoutDashboard,
  List,
  Network,
  Orbit,
  LayoutPanelLeft,
  PanelRightOpen,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Waypoints as WaypointsIcon,
  Zap,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { api, relTime, type Snapshot, type Status } from './api.ts';
import { GROUPS, groupOf, type GroupId } from './kinds.ts';
import { useLive, type LiveEvent } from './live.ts';
import { Legend, Map as RigMap, type MapFilters } from './Map.tsx';
import { NodeDetail } from './NodeDetail.tsx';
import { NodeList } from './NodeList.tsx';
import { Overview } from './Overview.tsx';
import { SearchPalette } from './SearchPalette.tsx';
import { DENSITIES, Settings } from './Settings.tsx';
import { useToast } from './Toasts.tsx';
import { BrandMark } from './TokenGate.tsx';

// React Flow and dagre load only when a focused view opens.
const flow = () => import('./flow/views.tsx');
const FocusView = lazy(() => flow().then((m) => ({ default: m.FocusView })));
const ImpactView = lazy(() => flow().then((m) => ({ default: m.ImpactView })));
const ReviewView = lazy(() => flow().then((m) => ({ default: m.ReviewView })));
const WaypointsView = lazy(() => flow().then((m) => ({ default: m.WaypointsView })));
const BlueprintView = lazy(() => flow().then((m) => ({ default: m.BlueprintView })));

type View = 'map' | 'focus' | 'impact' | 'blueprint' | 'review' | 'waypoints' | 'overview';
const VIEWS = new Set<View>([
  'map',
  'focus',
  'impact',
  'blueprint',
  'review',
  'waypoints',
  'overview',
]);

// Hash routes: #<view>, #<view>/<id>, and the 0.3 form #<node id>.
const parseHash = (): { view: View; id: string | null } => {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!h) return { view: 'map', id: null };
  const slash = h.indexOf('/');
  const head = (slash < 0 ? h : h.slice(0, slash)) as View;
  if (VIEWS.has(head)) return { view: head, id: slash < 0 ? null : h.slice(slash + 1) || null };
  return { view: 'map', id: h };
};

// Events that change nothing the map draws: skip the refetch.
const QUIET = new Set(['selection:changed', 'focus:requested', 'hello', 'activation:fired']);

const PulseWindow = 1600;

function Fallback(): JSX.Element {
  return (
    <div className="state" role="status">
      <div className="state-inner">
        <div className="spinner" />
      </div>
    </div>
  );
}

export function App(): JSX.Element {
  const toast = useToast();
  const initial = useMemo(parseHash, []);
  const [view, setView] = useState<View>(initial.view);
  const [status, setStatus] = useState<Status | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [density, setDensity] = useState(500);
  const [project, setProject] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [waypointCount, setWaypointCount] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(
    initial.view === 'map' || initial.view === 'focus' || initial.view === 'impact'
      ? initial.id
      : null,
  );
  const [focusPending, setFocusPending] = useState<number | null>(
    initial.view === 'review' && initial.id ? Number(initial.id) : null,
  );
  const [focusWaypoint, setFocusWaypoint] = useState<string | null>(
    initial.view === 'waypoints' ? initial.id : null,
  );
  const [inspector, setInspector] = useState(
    selected !== null && (initial.view === 'map' || window.innerWidth > 760),
  );
  const [focusToken, setFocusToken] = useState<{ id: string; ts: number } | null>(
    selected ? { id: selected, ts: Date.now() } : null,
  );
  const [pulses, setPulses] = useState<Map<string, number>>(() => new Map());
  const [highlight, setHighlight] = useState<Set<string>>(() => new Set());
  const [version, setVersion] = useState(0);
  const [palette, setPalette] = useState<{ open: boolean; q: string }>({ open: false, q: '' });
  const [mapMode, setMapMode] = useState<'graph' | 'list'>('graph');
  const [filters, setFilters] = useState<MapFilters>({
    hidden: new Set<GroupId>(),
    hubsOnly: false,
  });
  const [filtersOpen, setFiltersOpen] = useState(() => window.innerWidth > 760);
  const [freshWaypoints, setFreshWaypoints] = useState<Set<string>>(() => new Set());
  const densityRef = useRef(density);
  densityRef.current = density;

  const refresh = useCallback(async (limit = densityRef.current): Promise<void> => {
    try {
      const [s, g, p] = await Promise.all([api.status(), api.graph(limit), api.pending()]);
      setStatus(s);
      setSnap(g);
      setPendingCount(p.filter((x) => x.status === 'pending').length);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    api
      .waypoints({})
      .then((w) => setWaypointCount(w.waypoints.length))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void api
      .config()
      .then((c) => {
        if (c.name) {
          setProject(c.name);
          document.title = `Rig — ${c.name}`;
        }
        const d = typeof c.density === 'number' && DENSITIES.includes(c.density) ? c.density : 500;
        setDensity(d);
        return refresh(d);
      })
      .catch(() => refresh());
  }, [refresh]);

  // Live: coalesce each db:changed with the typed events that follow it.
  const burst = useRef<{ timer: ReturnType<typeof setTimeout> | null; types: string[] }>({
    timer: null,
    types: [],
  });
  const onEvent = (e: LiveEvent): void => {
    const b = burst.current;
    if (e.type === 'db:changed' || !QUIET.has(e.type)) {
      b.types.push(e.type);
      if (!b.timer) {
        b.timer = setTimeout(() => {
          const types = b.types;
          b.types = [];
          b.timer = null;
          const meaningful = types.filter((t) => t !== 'db:changed');
          // A db change with no typed event is an index or sync: refetch too.
          if (meaningful.length > 0 || types.length > 0) {
            if (meaningful.length === 0 || meaningful.some((t) => !QUIET.has(t))) {
              void refresh();
              setVersion((v) => v + 1);
            }
          }
        }, 140);
      }
    }
    const p = e.payload ?? {};
    switch (e.type) {
      case 'activation:fired': {
        const ids = p.ids ?? [];
        const now = Date.now();
        setPulses((prev) => {
          const next = new Map(prev);
          for (const id of ids) next.set(id, now);
          return next;
        });
        setTimeout(() => {
          setPulses((prev) => {
            const next = new Map<string, number>();
            const cutoff = Date.now() - PulseWindow;
            for (const [k, v] of prev) if (v > cutoff) next.set(k, v);
            return next;
          });
        }, PulseWindow + 100);
        break;
      }
      case 'edge:proposed':
        toast({
          tone: 'warning',
          title: 'Your agent proposed a link',
          detail: `${String(p.kind ?? 'related')} · ${String(p.rationale ?? '')}`,
          action: { label: 'Review', run: () => openReview(Number(p.pending_id)) },
        });
        break;
      case 'waypoint:dropped': {
        const id = String(p.id);
        setFreshWaypoints((s) => new Set(s).add(id));
        toast({
          tone: 'info',
          title: `Waypoint: ${String(p.title ?? '')}`,
          detail: String(p.kind ?? ''),
          action: { label: 'Open', run: () => openWaypoint(id) },
        });
        break;
      }
      case 'node:annotated': {
        const id = String(p.node_id);
        toast({
          tone: 'info',
          title: 'Your agent left a note',
          detail: String(p.note ?? ''),
          action: { label: 'Show', run: () => select(id, true) },
        });
        break;
      }
      case 'focus:requested': {
        const ids = Array.isArray(p.node_ids) ? (p.node_ids as string[]) : [];
        if (ids.length === 0) break;
        setHighlight(new Set(ids));
        setTimeout(() => setHighlight(new Set()), 12000);
        toast({
          tone: 'info',
          title: `Your agent is pointing at ${ids.length} node${ids.length === 1 ? '' : 's'}`,
          action: { label: 'Show', run: () => select(ids[0]!, true) },
        });
        break;
      }
      default:
        break;
    }
  };
  const live = useLive(onEvent);

  // State → hash (replace, so Back never traps you in the app).
  useEffect(() => {
    let next = '';
    if (view === 'map') next = selected ? `#${selected}` : '';
    else if (view === 'focus' || view === 'impact')
      next = selected ? `#${view}/${selected}` : `#${view}`;
    else if (view === 'review')
      next = focusPending !== null ? `#review/${focusPending}` : '#review';
    else if (view === 'waypoints')
      next = focusWaypoint ? `#waypoints/${focusWaypoint}` : '#waypoints';
    else next = `#${view}`;
    if (decodeURIComponent(location.hash) !== next)
      history.replaceState(null, '', `${location.pathname}${location.search}${next}`);
  }, [view, selected, focusPending, focusWaypoint]);

  useEffect(() => {
    const on = (): void => {
      const h = parseHash();
      setView(h.view);
      if ((h.view === 'map' || h.view === 'focus' || h.view === 'impact') && h.id) {
        setSelected(h.id);
        setInspector(h.view === 'map' || window.innerWidth > 760);
        setFocusToken({ id: h.id, ts: Date.now() });
      } else if (h.view === 'review') {
        setFocusPending(h.id ? Number(h.id) : null);
      } else if (h.view === 'waypoints') {
        setFocusWaypoint(h.id);
      }
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // Tell an agent following rig_subscribe where the user is looking.
  useEffect(() => {
    void api.select(selected).catch(() => {});
  }, [selected]);

  const narrow = (): boolean => window.innerWidth <= 760;
  // On a phone the inspector is a sheet over the stage; the focused views
  // need the whole screen, so opening one folds the sheet away.
  const openLens = (v: 'map' | 'focus' | 'impact'): void => {
    setView(v);
    if (v !== 'map' && narrow()) setInspector(false);
  };

  const select = (id: string | null, fly = false): void => {
    setSelected(id);
    setInspector(id !== null && !((view === 'focus' || view === 'impact') && narrow()));
    if (id && fly) setFocusToken({ id, ts: Date.now() });
    if (id && view !== 'focus' && view !== 'impact') setView('map');
  };
  const openReview = (pid: number | null): void => {
    setFocusPending(pid);
    setView('review');
  };
  const openWaypoint = (id: string): void => {
    setFocusWaypoint(id);
    setView('waypoints');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => ({ open: !p.open, q: '' }));
      } else if (e.key === '/' && !typing && !palette.open) {
        e.preventDefault();
        setPalette({ open: true, q: '' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette.open]);

  const undo = async (): Promise<void> => {
    try {
      const r = await api.undo();
      if (r.undone)
        toast({ tone: 'info', title: 'Undone', detail: r.undone.kind.replace(/_/g, ' ') });
      else toast({ tone: 'warning', title: 'Nothing to undo', detail: r.reason ?? '' });
      await refresh();
      setVersion((v) => v + 1);
    } catch (e) {
      toast({
        tone: 'danger',
        title: "Couldn't undo",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const changeDensity = (d: number): void => {
    setDensity(d);
    void refresh(d);
    void api.saveConfig({ density: d }).catch(() => {});
  };

  const counts = useMemo(() => {
    const m = new Map<GroupId, number>();
    for (const n of snap?.nodes ?? []) {
      const id = groupOf(n.type).id;
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  }, [snap]);

  const toggleGroup = (g: GroupId): void =>
    setFilters((f) => {
      const hidden = new Set(f.hidden);
      hidden.has(g) ? hidden.delete(g) : hidden.add(g);
      return { ...f, hidden };
    });

  const lens = view === 'focus' || view === 'impact' || view === 'blueprint' ? view : 'map';
  const nodeStage = view === 'map' || view === 'focus' || view === 'impact' || view === 'blueprint';
  const empty = snap !== null && snap.nodes.length === 0;

  const stage = (): JSX.Element => {
    if (view === 'review')
      return (
        <ReviewView
          version={version}
          focusPending={focusPending}
          onOpenNode={(id) => select(id, true)}
        />
      );
    if (view === 'waypoints')
      return (
        <WaypointsView
          version={version}
          focusWaypoint={focusWaypoint}
          freshIds={freshWaypoints}
          onOpenNode={(id) => select(id, true)}
        />
      );
    if (view === 'overview')
      return (
        <Overview
          status={status}
          pending={pendingCount}
          waypoints={waypointCount}
          version={version}
          onSearch={(q) => setPalette({ open: true, q })}
        />
      );
    if (loading && !snap)
      return (
        <div className="state" role="status" aria-live="polite">
          <div className="state-inner">
            <div className="spinner" />
            <h2>Mapping the constellation…</h2>
            <p>Loading the top {density.toLocaleString()} nodes by hubness.</p>
          </div>
        </div>
      );
    if (!snap && loadErr)
      return (
        <div className="state" role="alert">
          <div className="state-inner">
            <div className="state-icon">
              <AlertTriangle />
            </div>
            <h2>Couldn't load the graph</h2>
            <p>{loadErr}</p>
            <button className="btn btn-outline" onClick={() => void refresh()}>
              <RotateCcw /> Retry
            </button>
          </div>
        </div>
      );
    if (empty)
      return (
        <div className="state">
          <div className="state-inner">
            <div className="state-icon">
              <Orbit />
            </div>
            <h2>The graph is empty.</h2>
            <p>Index the project and the constellation appears here, live.</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <code className="code" style={{ padding: '6px 10px' }}>
                rig index
              </code>
              <button
                className="btn btn-sm btn-ghost icon-btn"
                aria-label="Copy command"
                onClick={() => void navigator.clipboard?.writeText('rig index')}
              >
                <Copy />
              </button>
            </div>
          </div>
        </div>
      );
    if (view === 'blueprint') return <BlueprintView version={version} />;
    if (view === 'focus' || view === 'impact') {
      if (!selected)
        return (
          <div className="state">
            <div className="state-inner">
              <div className="state-icon">{view === 'focus' ? <Network /> : <GitFork />}</div>
              <h2>Pick a node first</h2>
              <p>Select a node on the map or search for one with ⌘K.</p>
            </div>
          </div>
        );
      return view === 'focus' ? (
        <FocusView
          id={selected}
          version={version}
          onNavigate={(id) => select(id)}
          onReview={(pid) => openReview(pid)}
          onBackToMap={(id) => {
            setView('map');
            select(id, true);
          }}
        />
      ) : (
        <ImpactView
          id={selected}
          version={version}
          onNavigate={(id) => select(id)}
          onBackToMap={(id) => {
            setView('map');
            select(id, true);
          }}
        />
      );
    }
    if (!snap) return <Fallback />;
    return mapMode === 'list' ? (
      <NodeList
        snapshot={snap}
        filters={filters}
        selectedId={selected}
        onOpen={(id) => select(id, true)}
      />
    ) : (
      <>
        <RigMap
          snapshot={snap}
          filters={filters}
          selectedId={selected}
          onSelect={(id) => select(id)}
          focusToken={focusToken}
          pulses={pulses}
          highlight={highlight}
          onOpenNeighbourhood={(id) => {
            select(id);
            openLens('focus');
          }}
        />
        <Legend shown={snap.nodes.length} total={status?.nodes ?? snap.nodes.length} />
      </>
    );
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Rig</span>
          {project && <span className="brand-project truncate only-wide">{project}</span>}
        </div>
        {status && (
          <div className="topbar-stats only-wide" aria-label="Graph size">
            <span>
              <b className="num">{status.nodes.toLocaleString()}</b> nodes
            </span>
            <span>
              <b className="num">
                {(status.edges_structural + status.edges_semantic).toLocaleString()}
              </b>{' '}
              links
            </span>
            <span
              title={
                status.last_sync_ts ? new Date(status.last_sync_ts).toLocaleString() : undefined
              }
            >
              synced {relTime(status.last_sync_ts)}
            </span>
          </div>
        )}
        <div className="topbar-spacer" />
        <button
          className="search-trigger only-wide"
          onClick={() => setPalette({ open: true, q: '' })}
          aria-label="Search (Control K)"
        >
          <Search size={14} aria-hidden /> Search the graph… <span className="kbd">⌘K</span>
        </button>
        <button
          className="btn btn-ghost icon-btn only-narrow"
          aria-label="Search"
          onClick={() => setPalette({ open: true, q: '' })}
        >
          <Search />
        </button>
        <span
          className="live only-wide"
          data-state={live}
          title={live === 'open' ? 'Receiving live updates' : 'Reconnecting to the map server'}
        >
          <span className="live-dot" aria-hidden />
          {live === 'open' ? 'Live' : live === 'connecting' ? 'Connecting' : 'Offline'}
        </span>
        <button
          className="btn btn-ghost"
          onClick={() => void undo()}
          title="Undo the map's last write"
        >
          <RotateCcw /> <span className="only-wide">Undo</span>
        </button>
        <Settings density={density} onDensity={changeDensity} />
      </header>

      <nav className="rail" aria-label="Views">
        {(
          [
            { id: 'map', label: 'Map', icon: <Orbit size={18} /> },
            { id: 'review', label: 'Review', icon: <Inbox size={18} />, count: pendingCount },
            { id: 'waypoints', label: 'Waypoints', icon: <WaypointsIcon size={18} /> },
            { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={18} /> },
          ] as { id: View; label: string; icon: JSX.Element; count?: number }[]
        ).map((item) => {
          const current = item.id === 'map' ? nodeStage : view === item.id;
          return (
            <button
              key={item.id}
              className="rail-item"
              aria-current={current ? 'page' : undefined}
              onClick={() =>
                item.id === 'review'
                  ? openReview(null)
                  : setView(item.id === 'map' ? (nodeStage ? view : 'map') : item.id)
              }
              aria-label={item.count ? `${item.label}, ${item.count} pending` : item.label}
            >
              {item.icon}
              {item.label}
              {item.count ? (
                <span className="count">{item.count > 99 ? '99+' : item.count}</span>
              ) : null}
            </button>
          );
        })}
        <span className="rail-gap" />
      </nav>

      <main className="stage" aria-label="Map">
        {nodeStage && !empty && snap && (
          <div className="stage-bar">
            <div className="island seg" role="tablist" aria-label="Lens">
              <button role="tab" aria-selected={lens === 'map'} onClick={() => setView('map')}>
                <Orbit /> <span className="only-wide">Constellation</span>
              </button>
              <button
                role="tab"
                aria-selected={lens === 'focus'}
                disabled={!selected}
                title={selected ? 'Typed links around the selected node' : 'Select a node first'}
                onClick={() => openLens('focus')}
              >
                <Network /> Neighbourhood
              </button>
              <button
                role="tab"
                aria-selected={lens === 'impact'}
                disabled={!selected}
                title={selected ? 'What depends on the selected node' : 'Select a node first'}
                onClick={() => openLens('impact')}
              >
                <GitFork /> Impact
              </button>
              <button
                role="tab"
                aria-selected={lens === 'blueprint'}
                title="The project drawn like a floor plan: packages, imports, and what they talk to"
                onClick={() => setView('blueprint')}
              >
                <LayoutPanelLeft /> <span className="only-wide">Blueprint</span>
              </button>
            </div>
            {selected && !inspector && (
              <button
                className="btn island"
                style={{ height: 32 }}
                onClick={() => setInspector(true)}
                aria-label="Show node details"
              >
                <PanelRightOpen /> <span className="only-wide">Details</span>
              </button>
            )}
            {view === 'map' && (
              <>
                <div className="island seg" role="group" aria-label="Display">
                  <button
                    aria-pressed={mapMode === 'graph'}
                    onClick={() => setMapMode('graph')}
                    aria-label="Graph view"
                    title="Graph"
                  >
                    <Orbit />
                  </button>
                  <button
                    aria-pressed={mapMode === 'list'}
                    onClick={() => setMapMode('list')}
                    aria-label="List view"
                    title="List (keyboard friendly)"
                  >
                    <List />
                  </button>
                </div>
                <button
                  className="btn island"
                  style={{ height: 32 }}
                  aria-expanded={filtersOpen}
                  aria-controls="map-filters"
                  onClick={() => setFiltersOpen((o) => !o)}
                >
                  <SlidersHorizontal /> <span className="only-wide">Filters</span>
                  {(filters.hidden.size > 0 || filters.hubsOnly) && (
                    <span className="badge badge-accent">
                      {filters.hidden.size + (filters.hubsOnly ? 1 : 0)}
                    </span>
                  )}
                </button>
                {filtersOpen && (
                  <div
                    id="map-filters"
                    className="filters island"
                    role="group"
                    aria-label="Filter nodes"
                  >
                    <button
                      className="chip"
                      aria-pressed={filters.hubsOnly}
                      onClick={() => setFilters((f) => ({ ...f, hubsOnly: !f.hubsOnly }))}
                    >
                      <Zap size={12} aria-hidden /> Hubs only
                    </button>
                    {GROUPS.filter((g) => (counts.get(g.id) ?? 0) > 0).map((g) => (
                      <button
                        key={g.id}
                        className="chip"
                        aria-pressed={!filters.hidden.has(g.id)}
                        onClick={() => toggleGroup(g.id)}
                      >
                        <i
                          className="glyph"
                          data-shape={g.shape}
                          style={{ ['--g' as string]: `var(${g.cssVar})` }}
                          aria-hidden
                        />
                        {g.label} <span className="n">{counts.get(g.id)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            <span className="grow" />
            {loadErr && snap && (
              <div
                className="banner banner-danger island"
                role="alert"
                style={{ padding: '6px 10px' }}
              >
                <AlertTriangle /> {loadErr}
                <button className="btn btn-sm btn-outline" onClick={() => void refresh()}>
                  Retry
                </button>
              </div>
            )}
          </div>
        )}
        <Suspense fallback={<Fallback />}>{stage()}</Suspense>
      </main>

      {nodeStage && selected && inspector && (
        <div className="side">
          <NodeDetail
            id={selected}
            version={version}
            onClose={() => setInspector(false)}
            onJump={(id) => select(id, true)}
            onOpenView={(v) => openLens(v)}
            onOpenWaypoint={openWaypoint}
            onReview={(pid) => openReview(pid)}
          />
        </div>
      )}

      <SearchPalette
        open={palette.open}
        initialQuery={palette.q}
        onClose={() => setPalette({ open: false, q: '' })}
        onPick={(id) => {
          if (id.startsWith('waypoint:')) openWaypoint(id);
          else select(id, true);
        }}
      />
    </div>
  );
}
