// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type JSX } from 'react';
import { useTheme } from './theme.tsx';

// Gear button + theme picker popover, mounted in the header. Selecting a theme
// recolors the whole UI + canvas map instantly and persists to .rig/config.json.
export function Settings(): JSX.Element {
  const { theme, themeId, setThemeId, themes } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Theme"
        aria-label="Theme settings"
        style={{
          background: open ? 'var(--surface2)' : 'transparent',
          color: 'var(--muted)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          width: 28,
          height: 28,
          display: 'grid',
          placeItems: 'center',
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        ⚙
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 36,
            right: 0,
            width: 200,
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
            padding: 6,
            zIndex: 40,
          }}
        >
          <div
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              color: 'var(--muted)',
              padding: '4px 8px',
            }}
          >
            Theme
          </div>
          {themes.map((t) => {
            const active = t.id === themeId;
            return (
              <button
                key={t.id}
                onClick={() => setThemeId(t.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  background: active ? 'var(--surface)' : 'transparent',
                  border: 'none',
                  borderRadius: 6,
                  padding: '7px 8px',
                  cursor: 'pointer',
                  color: 'var(--text)',
                  fontSize: 13,
                  textAlign: 'left',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: t.tokens.accent,
                    border: `2px solid ${t.tokens.bg}`,
                    boxShadow: `0 0 0 1px ${t.tokens.border}`,
                  }}
                />
                <span style={{ flex: 1 }}>{t.name}</span>
                {active && <span style={{ color: 'var(--accent)' }}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
