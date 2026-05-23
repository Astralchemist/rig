import { useEffect, useMemo, useState } from 'react';
import { Chat } from './Chat.tsx';
import { Map, type Snapshot } from './Map.tsx';
import { NodeDetail } from './NodeDetail.tsx';
import { SearchPalette } from './SearchPalette.tsx';

interface Status {
  initialized: boolean;
  nodes: number;
  edges_structural: number;
  edges_semantic: number;
  files: number;
  last_sync_ts: number | null;
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState<{ id: string; ts: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const selectedName = useMemo(
    () => snap?.nodes.find((n) => n.id === selected)?.name ?? null,
    [snap, selected],
  );

  const refresh = async (): Promise<void> => {
    try {
      const [s, g] = await Promise.all([
        fetch('/api/status').then((r) => r.json() as Promise<Status>),
        fetch('/api/graph?limit=2000').then((r) => r.json() as Promise<Snapshot>),
      ]);
      setStatus(s);
      setSnap(g);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.addEventListener('message', (ev) => {
      const data = JSON.parse(ev.data as string) as { type?: string };
      if (data.type === 'db:changed') void refresh();
    });
    return () => ws.close();
  }, []);

  // URL hash → initial selection (shareable links). #node:abc123 selects + focuses.
  useEffect(() => {
    const fromHash = (): void => {
      const h = location.hash.replace(/^#/, '');
      if (h) {
        setSelected(h);
        setFocusToken({ id: h, ts: Date.now() });
      }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  // Selection → URL hash. Always replace so back-button doesn't trap users.
  useEffect(() => {
    const next = selected ? `#${selected}` : '';
    if (location.hash !== next) {
      history.replaceState(null, '', `${location.pathname}${location.search}${next}`);
    }
  }, [selected]);

  // Post selection changes so an agent polling rig_subscribe can follow gaze.
  useEffect(() => {
    void fetch('/api/selection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ node_id: selected }),
    });
  }, [selected]);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <header
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: '12px 20px',
          background: 'rgba(11,13,18,0.85)',
          borderBottom: '1px solid #1f2937',
          zIndex: 10,
          display: 'flex',
          gap: 16,
          alignItems: 'baseline',
        }}
      >
        <strong style={{ color: '#e5e7eb' }}>Rig</strong>
        {status && (
          <span style={{ color: '#9ca3af', fontSize: 12 }}>
            {status.nodes} nodes · {status.edges_structural + status.edges_semantic} edges ·{' '}
            {status.files} files
          </span>
        )}
        {selected && (
          <span style={{ color: '#60a5fa', fontSize: 12 }}>selected: {selected}</span>
        )}
        {snap && snap.pending_edges.length > 0 && (
          <span style={{ color: '#fbbf24', fontSize: 12 }}>
            {snap.pending_edges.length} pending
          </span>
        )}
        {err && <span style={{ color: '#f87171' }}>error: {err}</span>}
        <button
          onClick={async () => {
            await fetch('/api/undo', { method: 'POST' });
            await refresh();
          }}
          style={{
            marginLeft: 'auto',
            background: '#374151',
            color: '#e5e7eb',
            border: 'none',
            borderRadius: 4,
            padding: '4px 12px',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          undo
        </button>
      </header>
      {snap && snap.nodes.length > 0 && (
        <Map
          snapshot={snap}
          onSelect={setSelected}
          focusToken={focusToken}
          selectedId={selected}
          onAccept={async (id) => {
            await fetch(`/api/pending-edges/${id}/accept`, { method: 'POST' });
            await refresh();
          }}
          onReject={async (id) => {
            await fetch(`/api/pending-edges/${id}/reject`, { method: 'POST' });
            await refresh();
          }}
        />
      )}
      <SearchPalette
        onPick={(id) => {
          setSelected(id);
          setFocusToken({ id, ts: Date.now() });
        }}
      />
      <kbd
        style={{
          position: 'absolute',
          bottom: 12,
          left: 12,
          padding: '4px 8px',
          background: '#111827',
          border: '1px solid #1f2937',
          borderRadius: 4,
          color: '#9ca3af',
          fontSize: 11,
          zIndex: 10,
        }}
      >
        ⌘K to search
      </kbd>
      {selected && (
        <NodeDetail
          id={selected}
          onClose={() => setSelected(null)}
          onJump={(id) => {
            setSelected(id);
            setFocusToken({ id, ts: Date.now() });
          }}
        />
      )}
      <Chat selected={selected} selectedName={selectedName} />
      {snap && snap.nodes.length === 0 && (
        <div style={{ padding: 80, textAlign: 'center', color: '#6b7280' }}>
          <p>The graph is empty.</p>
          <p>
            Run <code style={{ color: '#60a5fa' }}>rig index</code> in your project, then refresh.
          </p>
        </div>
      )}
    </div>
  );
}
