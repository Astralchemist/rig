import { useEffect, useState } from 'react';
import { Map, type Snapshot } from './Map.tsx';

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
  const [err, setErr] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const [s, g] = await Promise.all([
        fetch('/api/status').then((r) => r.json() as Promise<Status>),
        fetch('/api/graph?limit=500').then((r) => r.json() as Promise<Snapshot>),
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
        {err && <span style={{ color: '#f87171' }}>error: {err}</span>}
      </header>
      {snap && snap.nodes.length > 0 && <Map snapshot={snap} onSelect={setSelected} />}
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
