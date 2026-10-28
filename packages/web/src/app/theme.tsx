// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useEffect, useState, type JSX, type ReactNode } from 'react';
import { DEFAULT_THEME_ID, THEMES, type Theme, themeById } from './themes.ts';

interface ThemeCtx {
  theme: Theme;
  themeId: string;
  setThemeId: (id: string) => void;
  themes: Theme[];
}

const Ctx = createContext<ThemeCtx | null>(null);

// Push every token to a CSS custom property on :root so DOM components can use
// `var(--accent)` etc. in inline styles, and flip color-scheme for native UI.
const applyTheme = (theme: Theme): void => {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--${camelToKebab(k)}`, v);
  }
  root.style.setProperty('color-scheme', theme.scheme);
};

const camelToKebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [themeId, setThemeIdState] = useState(DEFAULT_THEME_ID);
  const [loaded, setLoaded] = useState(false);
  const theme = themeById(themeId);

  // Load the persisted choice from .rig/config.json once on mount.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((r) => (r.ok ? (r.json() as Promise<{ theme?: string }>) : null))
      .then((cfg) => {
        if (!cancelled && cfg?.theme && THEMES.some((t) => t.id === cfg.theme)) {
          setThemeIdState(cfg.theme);
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply on every change (including the initial default, before load lands).
  useEffect(() => applyTheme(theme), [theme]);

  const setThemeId = (id: string): void => {
    setThemeIdState(id);
    void fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: id }),
    });
  };

  // Render children immediately; the default theme is already applied, and the
  // persisted choice swaps in without a flash once /api/config resolves.
  void loaded;
  return <Ctx.Provider value={{ theme, themeId, setThemeId, themes: THEMES }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
