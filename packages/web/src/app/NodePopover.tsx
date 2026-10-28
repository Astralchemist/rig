// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type JSX } from 'react';

interface PullEntry {
  nodeId: string;
  score: number;
  components: { structural: number; semantic: number; recency: number };
}

interface NodeMeta {
  id: string;
  name: string;
  type: string;
  data: { filePath?: string; qualifiedName?: string; signature?: string };
  neighbor_counts: Record<string, number>;
}

export interface NodePopoverProps {
  nodeId: string;
  x: number;
  y: number;
  onClose: () => void;
  onJump: (id: string) => void;
  onOpenDetail: () => void;
}

// A compact popover anchored at the click point. Shows the node's identity +
// top magnetic pulls in one glance, without committing to the full side panel.
export function NodePopover({
  nodeId,
  x,
  y,
  onClose,
  onJump,
  onOpenDetail,
}: NodePopoverProps): JSX.Element | null {
  const [meta, setMeta] = useState<NodeMeta | null>(null);
  const [pulls, setPulls] = useState<{ entry: PullEntry; name: string; kind: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [nodeRes, pullRes] = await Promise.all([
          fetch(`/api/node/${encodeURIComponent(nodeId)}`),
          fetch(`/api/node/${encodeURIComponent(nodeId)}/pull?k=6`),
        ]);
        if (!nodeRes.ok || !pullRes.ok) return;
        const nodeJson = (await nodeRes.json()) as NodeMeta;
        const pullJson = (await pullRes.json()) as PullEntry[];
        if (cancelled) return;
        setMeta(nodeJson);
        // Resolve neighbor names — one shot via /api/search batch isn't there yet,
        // so fetch each (cheap on a small k).
        const named = await Promise.all(
          pullJson.map(async (p) => {
            const r = await fetch(`/api/node/${encodeURIComponent(p.nodeId)}`);
            if (!r.ok) return null;
            const n = (await r.json()) as NodeMeta;
            return { entry: p, name: n.name, kind: n.type };
          }),
        );
        if (!cancelled) {
          setPulls(named.filter((x): x is { entry: PullEntry; name: string; kind: string } => x !== null));
        }
      } catch {
        /* ignore */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!meta) return null;

  // Clamp position to viewport so the popover never falls off-screen.
  const W = 320;
  const H = 280;
  const left = Math.min(Math.max(x + 16, 8), window.innerWidth - W - 8);
  const top = Math.min(Math.max(y + 16, 8), window.innerHeight - H - 8);
  const totalNeighbors = Object.values(meta.neighbor_counts).reduce((s, n) => s + n, 0);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left,
        top,
        width: W,
        zIndex: 25,
        background: 'var(--surface2)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
        color: 'var(--text)',
        fontSize: 12,
      }}
    >
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{meta.name}</div>
        <div style={{ color: 'var(--muted)', marginTop: 2 }}>
          <span style={{ color: 'var(--accent)' }}>{meta.type}</span>
          {meta.data?.filePath && <> · {meta.data.filePath}</>}
        </div>
        {meta.data?.signature && (
          <div
            style={{
              color: 'var(--muted)',
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11,
              marginTop: 4,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {meta.data.signature}
          </div>
        )}
        <div style={{ color: 'var(--muted)', marginTop: 4, fontSize: 11 }}>
          {totalNeighbors} neighbor{totalNeighbors === 1 ? '' : 's'}
          {meta.neighbor_counts.contains ? ` · ${meta.neighbor_counts.contains} contains` : ''}
          {meta.neighbor_counts.references ? ` · ${meta.neighbor_counts.references} refs` : ''}
        </div>
      </div>
      <div style={{ padding: '8px 12px' }}>
        <div style={{ color: 'var(--muted)', fontSize: 10, marginBottom: 4, textTransform: 'uppercase' }}>
          magnetic pull
        </div>
        {pulls.length === 0 && <div style={{ color: 'var(--muted)' }}>no nearby anchors</div>}
        {pulls.map((p) => (
          <div
            key={p.entry.nodeId}
            onClick={() => onJump(p.entry.nodeId)}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'baseline',
              padding: '3px 0',
              cursor: 'pointer',
            }}
            title={`s=${p.entry.components.structural.toFixed(2)} m=${p.entry.components.semantic.toFixed(2)} r=${p.entry.components.recency.toFixed(2)}`}
          >
            <span style={{ color: 'var(--hub)', minWidth: 36, fontSize: 11 }}>
              {p.entry.score.toFixed(2)}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.name}
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 10 }}>{p.kind}</span>
          </div>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: 8,
          borderTop: '1px solid var(--border)',
          justifyContent: 'space-between',
        }}
      >
        <button
          onClick={onOpenDetail}
          style={{
            background: 'var(--surface)',
            color: 'var(--text)',
            border: 'none',
            borderRadius: 4,
            padding: '4px 10px',
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          open details
        </button>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            color: 'var(--muted)',
            border: 'none',
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          esc
        </button>
      </div>
    </div>
  );
}
