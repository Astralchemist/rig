// SPDX-License-Identifier: Apache-2.0
import { Check, Monitor, Settings as Gear } from 'lucide-react';
import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { useTheme } from './theme.tsx';
import { SYSTEM_THEME_ID } from './themes.ts';

export const DENSITIES = [300, 500, 1000, 2000];

// Gear menu in the top bar: theme (persisted to .rig/config.json) and how
// many nodes the constellation draws.
export function Settings({
  density,
  onDensity,
}: {
  density: number;
  onDensity: (n: number) => void;
}): JSX.Element {
  const { themeId, setThemeId, themes } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    button.current?.focus();
  };

  // Roving focus through the items; Esc closes and returns focus.
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const options = [
    { id: SYSTEM_THEME_ID, name: 'Match system', swatch: null },
    ...themes.map((t) => ({ id: t.id, name: t.name, swatch: t.swatch })),
  ];

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        ref={button}
        className="btn btn-ghost icon-btn"
        onClick={() => setOpen((o) => !o)}
        title="Settings"
        aria-label="Theme settings"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Gear />
      </button>
      {open && (
        <div
          ref={menu}
          className="menu float"
          role="menu"
          aria-label="Settings"
          style={{ top: 38, right: 0 }}
          onKeyDown={onKey}
        >
          <div className="menu-label eyebrow">Theme</div>
          {options.map((t) => {
            const active = t.id === themeId;
            return (
              <button
                key={t.id}
                className="menu-item"
                role="menuitemradio"
                aria-checked={active}
                tabIndex={-1}
                onClick={() => setThemeId(t.id)}
              >
                {t.swatch ? (
                  <span
                    className="swatch"
                    style={{
                      background: `linear-gradient(135deg, ${t.swatch.canvas} 50%, ${t.swatch.accent} 50%)`,
                    }}
                  />
                ) : (
                  <Monitor size={14} aria-hidden />
                )}
                {t.name}
                {active && <Check size={14} className="check" aria-hidden />}
              </button>
            );
          })}
          <div className="menu-sep" />
          <div className="menu-label eyebrow">Map density</div>
          {DENSITIES.map((d) => (
            <button
              key={d}
              className="menu-item"
              role="menuitemradio"
              aria-checked={d === density}
              tabIndex={-1}
              onClick={() => onDensity(d)}
            >
              <span className="num">{d.toLocaleString()} nodes</span>
              {d === 500 && (
                <span className="quiet" style={{ fontSize: 'var(--t-2xs)' }}>
                  default
                </span>
              )}
              {d === density && <Check size={14} className="check" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
