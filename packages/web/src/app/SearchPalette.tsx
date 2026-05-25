// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';

interface SearchHit {
  id: string;
  name: string;
  type: string;
  data?: { filePath?: string };
}

export interface SearchPaletteProps {
  onPick: (id: string) => void;
}

// Cmd-K / Ctrl-K opens a search overlay. ↑/↓ navigate, Enter picks, Esc closes.
export function SearchPalette({ onPick }: SearchPaletteProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        setOpen((o) => !o);
      } else if (ev.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery('');
      setHits([]);
      setCursor(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !query.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=12`);
        const data = (await res.json()) as SearchHit[];
        if (!cancelled) {
          setHits(data);
          setCursor(0);
        }
      } catch {
        if (!cancelled) setHits([]);
      }
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, open]);

  if (!open) return null;

  const pick = (h: SearchHit | undefined): void => {
    if (!h) return;
    onPick(h.id);
    setOpen(false);
  };

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        zIndex: 30,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '15vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: '90vw',
          background: 'var(--surface2)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'ArrowDown') {
              ev.preventDefault();
              setCursor((c) => Math.min(hits.length - 1, c + 1));
            } else if (ev.key === 'ArrowUp') {
              ev.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (ev.key === 'Enter') {
              ev.preventDefault();
              pick(hits[cursor]);
            }
          }}
          placeholder="Search anchors (name, qualified name, alias)…"
          style={{
            width: '100%',
            padding: '14px 18px',
            background: 'transparent',
            border: 'none',
            borderBottom: '1px solid var(--border)',
            color: 'var(--text)',
            fontSize: 15,
            outline: 'none',
          }}
        />
        <div style={{ maxHeight: '40vh', overflowY: 'auto' }}>
          {hits.length === 0 && query.trim() && (
            <div style={{ padding: 16, color: 'var(--muted)', fontSize: 12 }}>no matches</div>
          )}
          {hits.map((h, i) => (
            <div
              key={h.id}
              onClick={() => pick(h)}
              onMouseEnter={() => setCursor(i)}
              style={{
                padding: '8px 18px',
                background: i === cursor ? 'var(--surface)' : 'transparent',
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--text)',
                display: 'flex',
                gap: 10,
                alignItems: 'baseline',
              }}
            >
              <span style={{ color: 'var(--accent)', minWidth: 80, fontSize: 11 }}>{h.type}</span>
              <span style={{ flex: 1 }}>{h.name}</span>
              {h.data?.filePath && (
                <span style={{ color: 'var(--muted)', fontSize: 11 }}>{h.data.filePath}</span>
              )}
            </div>
          ))}
        </div>
        <div
          style={{
            padding: '6px 18px',
            borderTop: '1px solid var(--border)',
            color: 'var(--muted)',
            fontSize: 11,
          }}
        >
          ↑↓ navigate · ⏎ select · esc close · ⌘K toggle
        </div>
      </div>
    </div>
  );
}
