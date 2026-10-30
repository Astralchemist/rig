// SPDX-License-Identifier: Apache-2.0
import { Search } from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';
import { api, type SearchHit, type SearchMode } from './api.ts';
import { kindLabel } from './kinds.ts';
import { Glyph } from './NodeDetail.tsx';

export interface SearchPaletteProps {
  open: boolean;
  initialQuery: string;
  onClose: () => void;
  onPick: (id: string) => void;
}

const MODE_LABEL: Record<string, string> = {
  hybrid: 'Hybrid: names, keywords and meaning',
  'keyword-only': 'Keywords only: the embedding model is loading',
  'keyword-fallback': 'Keywords only',
  keyword: 'Keywords only',
};

// ⌘K / Ctrl-K or `/`. A combobox over hybrid search (/api/search, the
// ranking the MCP tools use): ↑/↓ move, Enter opens, Esc closes.
export function SearchPalette({
  open,
  initialQuery,
  onClose,
  onPick,
}: SearchPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [mode, setMode] = useState<SearchMode>(null);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      restore.current = document.activeElement as HTMLElement | null;
      setQuery(initialQuery);
    } else {
      setHits([]);
      setCursor(0);
      restore.current?.focus?.();
    }
  }, [open, initialQuery]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      api
        .search(q, 14)
        .then((r) => {
          if (cancelled) return;
          setHits(r.hits);
          setMode(r.mode);
          setCursor(0);
          setError(null);
        })
        .catch(
          () =>
            !cancelled && (setHits([]), setError('Search failed. Is the server still running?')),
        )
        .finally(() => !cancelled && setLoading(false));
    }, 90);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, open]);

  if (!open) return null;

  const pick = (h: SearchHit | undefined): void => {
    if (!h) return;
    onPick(h.id);
    onClose();
  };
  const active = hits[cursor];

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="palette float" role="dialog" aria-modal="true" aria-label="Search the graph">
        <div className="palette-input">
          <Search aria-hidden />
          <input
            ref={inputRef}
            // Focus on mount, synchronously, so the first keystroke lands.
            autoFocus
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="palette-list"
            aria-activedescendant={active ? `hit-${cursor}` : undefined}
            aria-autocomplete="list"
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
                pick(active);
              } else if (ev.key === 'Escape') {
                ev.preventDefault();
                onClose();
              } else if (ev.key === 'Tab') {
                ev.preventDefault();
              }
            }}
            placeholder="Search symbols, files, docs and waypoints…"
            aria-label="Search"
          />
          {loading && <span className="spinner" aria-hidden />}
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" aria-label="Results">
          {error && (
            <div style={{ padding: 14 }} className="quiet">
              {error}
            </div>
          )}
          {!error && hits.length === 0 && query.trim() && !loading && (
            <div style={{ padding: '18px 14px' }} className="quiet">
              No matches for “{query.trim()}”.
            </div>
          )}
          {!query.trim() && (
            <div style={{ padding: '18px 14px' }} className="quiet">
              Try a symbol name, a file path, or what the code does (“where sessions expire”).
            </div>
          )}
          {hits.map((h, i) => (
            <div
              key={h.id}
              id={`hit-${i}`}
              role="option"
              aria-selected={i === cursor}
              className="palette-item"
              onClick={() => pick(h)}
              onMouseMove={() => i !== cursor && setCursor(i)}
            >
              <Glyph kind={h.type} />
              <div style={{ minWidth: 0 }}>
                <div className="name truncate">{h.name}</div>
                <div className="path truncate">
                  {kindLabel(h.type)}
                  {h.data?.filePath
                    ? ` · ${h.data.filePath}${h.data.startLine ? `:${h.data.startLine}` : ''}`
                    : ''}
                </div>
              </div>
              <div className="src">
                {(h.matched_by ?? [])
                  .filter((m) => m !== 'keyword')
                  .map((m) => (
                    <span
                      key={m}
                      className={`badge${m === 'vector' ? ' badge-accent' : ''}`}
                      title={`Matched by ${m}`}
                    >
                      {m === 'vector' ? 'meaning' : m}
                    </span>
                  ))}
              </div>
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> move
          </span>
          <span>
            <span className="kbd">↵</span> open
          </span>
          {mode && <span className="mode">{MODE_LABEL[mode] ?? mode}</span>}
        </div>
      </div>
    </>
  );
}
