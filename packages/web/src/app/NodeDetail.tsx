import { useEffect, useState } from 'react';

interface NodeDetailData {
  id: string;
  type: string;
  name: string;
  data: Record<string, unknown>;
  pull_score: number;
  neighbor_counts: Record<string, number>;
}

interface PullEntry {
  nodeId: string;
  score: number;
  components: { structural: number; semantic: number; recency: number };
}

const fmt = (n: number): string => n.toFixed(2);

export interface NodeDetailProps {
  id: string;
  onClose: () => void;
  onJump: (id: string) => void;
}

export function NodeDetail({ id, onClose, onJump }: NodeDetailProps): JSX.Element {
  const [node, setNode] = useState<NodeDetailData | null>(null);
  const [pull, setPull] = useState<PullEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setNode(null);
    setPull([]);
    setErr(null);
    Promise.all([
      fetch(`/api/node/${encodeURIComponent(id)}`).then((r) => r.json()),
      fetch(`/api/node/${encodeURIComponent(id)}/pull?k=6`).then((r) => r.json()),
    ])
      .then(([n, p]) => {
        setNode(n as NodeDetailData);
        setPull(p as PullEntry[]);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [id]);

  const filePath = node?.data && typeof node.data.filePath === 'string' ? node.data.filePath : null;
  const signature = node?.data && typeof node.data.signature === 'string' ? node.data.signature : null;

  return (
    <aside
      style={{
        position: 'absolute',
        top: 56,
        right: 0,
        bottom: 0,
        width: 360,
        background: 'rgba(11,13,18,0.96)',
        borderLeft: '1px solid #1f2937',
        padding: 20,
        overflowY: 'auto',
        zIndex: 9,
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{node?.name ?? '…'}</h2>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#9ca3af',
            cursor: 'pointer',
            fontSize: 18,
          }}
        >
          ×
        </button>
      </header>
      {err && <p style={{ color: '#f87171' }}>{err}</p>}
      {node && (
        <>
          <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 12 }}>
            <code style={{ color: '#60a5fa' }}>{node.type}</code>
            {filePath && (
              <>
                {' · '}
                <span>{filePath}</span>
              </>
            )}
          </div>
          {signature && (
            <pre
              style={{
                background: '#111827',
                padding: 8,
                borderRadius: 4,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                margin: '8px 0',
              }}
            >
              {signature}
            </pre>
          )}
          <section style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 13, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Neighbors
            </h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {Object.entries(node.neighbor_counts).map(([k, c]) => (
                <li key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                  <span>{k}</span>
                  <span style={{ color: '#6b7280' }}>{c}</span>
                </li>
              ))}
              {Object.keys(node.neighbor_counts).length === 0 && (
                <li style={{ color: '#6b7280' }}>(none)</li>
              )}
            </ul>
          </section>
          <section style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 13, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Magnetic pull
            </h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {pull.map((p) => (
                <li
                  key={p.nodeId}
                  onClick={() => onJump(p.nodeId)}
                  style={{ padding: '4px 0', cursor: 'pointer', fontSize: 12 }}
                >
                  <div style={{ color: '#60a5fa' }}>{p.nodeId.slice(0, 28)}…</div>
                  <div style={{ color: '#6b7280' }}>
                    score {fmt(p.score)} · s {fmt(p.components.structural)} · e{' '}
                    {fmt(p.components.semantic)} · r {fmt(p.components.recency)}
                  </div>
                </li>
              ))}
              {pull.length === 0 && <li style={{ color: '#6b7280' }}>(none)</li>}
            </ul>
          </section>
        </>
      )}
    </aside>
  );
}
