// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useEffect, useState, type JSX, type ReactNode } from 'react';
import { DEFAULT_THEME_ID, THEME_IDS, THEMES, resolveTheme, type Theme } from './themes.ts';

interface ThemeCtx {
  // The active preset (system already resolved).
  theme: Theme;
  // What the user picked: a preset id or 'system'.
  themeId: string;
  setThemeId: (id: string) => void;
  themes: Theme[];
}

const Ctx = createContext<ThemeCtx | null>(null);

// The last choice is also kept in localStorage so the sign-in gate, which
// can't read /api/config before the token is set, paints in the right
// theme. .rig/config.json stays the source of truth once signed in.
export const THEME_STORAGE_KEY = 'rig.theme';

const remember = (id: string): void => {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // storage blocked: the config file still has it
  }
};

export const storedThemeId = (): string => {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v && THEME_IDS.has(v)) return v;
  } catch {
    // fall through to the default
  }
  return DEFAULT_THEME_ID;
};

const apply = (theme: Theme): void => {
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.scheme;
};

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [themeId, setThemeIdState] = useState(storedThemeId);
  // Bumped when the OS scheme flips, so `system` re-resolves.
  const [osTick, setOsTick] = useState(0);
  const theme = resolveTheme(themeId);
  void osTick;

  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((r) => (r.ok ? (r.json() as Promise<{ theme?: string }>) : null))
      .then((cfg) => {
        if (!cancelled && cfg?.theme && THEME_IDS.has(cfg.theme)) {
          setThemeIdState(cfg.theme);
          remember(cfg.theme);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: light)');
    const on = (): void => setOsTick((t) => t + 1);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => apply(theme), [theme]);

  const setThemeId = (id: string): void => {
    setThemeIdState(id);
    remember(id);
    void fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: id }),
    }).catch(() => {});
  };

  return (
    <Ctx.Provider value={{ theme, themeId, setThemeId, themes: THEMES }}>{children}</Ctx.Provider>
  );
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
