import { useEffect, useState } from 'react';

interface Status {
  initialized: boolean;
  nodes: number;
  edges_structural: number;
  edges_semantic: number;
  files: number;
  last_sync_ts: number | null;
}

interface SnapshotNode {
  id: string;
  type: string;
  name: string;
  pull_score: number;
}

interface Snapshot {
  nodes: SnapshotNode[];
  edges_structural: Array<{ src: string; dst: string; kind: string }>;
  edges_semantic: Array<{ src: string; dst: string; weight: number }>;
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
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
    <div style={{ padding: 24, maxWidth: 980, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>Rig</h1>
      {err && <p style={{ color: '#f87171' }}>error: {err}</p>}
      {status && (
        <div style={{ color: '#9ca3af', marginBottom: 24 }}>
          {status.nodes} nodes · {status.edges_structural} edges · {status.files} files
        </div>
      )}
      {snap && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {snap.nodes.slice(0, 50).map((n) => (
            <li key={n.id} style={{ padding: '6px 0', borderBottom: '1px solid #1f2937' }}>
              <code style={{ color: '#60a5fa' }}>{n.type}</code>{' '}
              <strong>{n.name}</strong>{' '}
              <span style={{ color: '#6b7280' }}>{n.id.slice(0, 16)}…</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
