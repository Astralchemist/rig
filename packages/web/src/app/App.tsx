import { useEffect, useState } from 'react';
import { Map as RigMap, type Snapshot } from './Map.tsx';
import { NodeDetail } from './NodeDetail.tsx';
import { NodePopover } from './NodePopover.tsx';
import { SearchPalette } from './SearchPalette.tsx';
import { Settings } from './Settings.tsx';

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
  const [popover, setPopover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [pulses, setPulses] = useState<Map<string, number>>(() => new Map());
  const [err, setErr] = useState<string | null>(null);

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
      const data = JSON.parse(ev.data as string) as {
        type?: string;
        payload?: { ids?: string[] };
      };
      if (data.type === 'db:changed') void refresh();
      if (data.type === 'activation:fired' && data.payload?.ids) {
        const now = Date.now();
        setPulses((prev) => {
          const next = new Map(prev);
          for (const id of data.payload!.ids!) next.set(id, now);
          return next;
        });
        // Garbage-collect entries older than the pulse window so the map
        // doesn't grow unbounded.
        setTimeout(() => {
          setPulses((prev) => {
            const next = new Map<string, number>();
            const cutoff = Date.now() - 1500;
            for (const [k, v] of prev) if (v > cutoff) next.set(k, v);
            return next;
          });
        }, 1600);
      }
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
          height: 44,
          padding: '0 16px',
          background: 'color-mix(in srgb, var(--bg) 82%, transparent)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid var(--border)',
          zIndex: 10,
          display: 'flex',
          gap: 14,
          alignItems: 'center',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: 'var(--accent)',
              boxShadow: '0 0 8px var(--accent)',
            }}
          />
          <strong style={{ color: 'var(--text)', letterSpacing: 0.2 }}>Rig</strong>
        </span>
        {status && (
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {status.nodes.toLocaleString()} nodes ·{' '}
            {(status.edges_structural + status.edges_semantic).toLocaleString()} edges ·{' '}
            {status.files.toLocaleString()} files
          </span>
        )}
        {selected && (
          <span
            style={{
              color: 'var(--accent)',
              fontSize: 11,
              fontFamily: 'ui-monospace, monospace',
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {selected}
          </span>
        )}
        {snap && snap.pending_edges.length > 0 && (
          <span
            style={{
              color: 'var(--pending)',
              fontSize: 11,
              border: '1px solid var(--pending)',
              borderRadius: 999,
              padding: '1px 8px',
            }}
          >
            {snap.pending_edges.length} pending
          </span>
        )}
        {err && <span style={{ color: 'var(--danger)', fontSize: 12 }}>error: {err}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={async () => {
              await fetch('/api/undo', { method: 'POST' });
              await refresh();
            }}
            style={{
              background: 'var(--surface)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '5px 12px',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Undo
          </button>
          <Settings />
        </span>
      </header>
      {snap && snap.nodes.length > 0 && (
        <RigMap
          snapshot={snap}
          onSelect={(id, pos) => {
            setSelected(id);
            if (pos) setPopover({ id, x: pos.x, y: pos.y });
            else setPopover(null);
          }}
          focusToken={focusToken}
          selectedId={selected}
          pulses={pulses}
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
      {popover && (
        <NodePopover
          nodeId={popover.id}
          x={popover.x}
          y={popover.y}
          onClose={() => setPopover(null)}
          onJump={(id) => {
            setSelected(id);
            setFocusToken({ id, ts: Date.now() });
            setPopover(null);
          }}
          onOpenDetail={() => {
            setShowDetail(true);
            setPopover(null);
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
          padding: '5px 10px',
          background: 'color-mix(in srgb, var(--surface) 88%, transparent)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          color: 'var(--muted)',
          fontSize: 11,
          fontFamily: 'ui-monospace, monospace',
          zIndex: 10,
        }}
      >
        ⌘K to search
      </kbd>
      {selected && showDetail && (
        <NodeDetail
          id={selected}
          onClose={() => setShowDetail(false)}
          onJump={(id) => {
            setSelected(id);
            setFocusToken({ id, ts: Date.now() });
          }}
        />
      )}
      {snap && snap.nodes.length === 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
            color: 'var(--muted)',
          }}
        >
          <div>
            <p style={{ fontSize: 15, color: 'var(--text)', margin: '0 0 6px' }}>
              The graph is empty.
            </p>
            <p style={{ margin: 0 }}>
              Run{' '}
              <code
                style={{
                  color: 'var(--accent)',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '2px 6px',
                  fontFamily: 'ui-monospace, monospace',
                }}
              >
                rig index
              </code>{' '}
              in your project, then refresh.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
