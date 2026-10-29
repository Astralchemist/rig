// SPDX-License-Identifier: Apache-2.0
// Theme presets. The tokens themselves live in styles.css under
// :root[data-theme=<id>]; this file names the presets, says which scheme
// each one is, and resolves `system` to a concrete preset. The canvas map
// reads the resolved colours off the root element (readGraphPalette) since
// canvas can't use CSS variables.

export type Scheme = 'dark' | 'light';

export interface Theme {
  id: string;
  name: string;
  scheme: Scheme;
  // Swatch for the picker (the preset's accent on its canvas).
  swatch: { accent: string; canvas: string };
}

export const THEMES: Theme[] = [
  {
    id: 'observatory',
    name: 'Observatory',
    scheme: 'dark',
    swatch: { accent: '#3ddbc3', canvas: '#0a0d13' },
  },
  {
    id: 'warm',
    name: 'Warm instrument',
    scheme: 'dark',
    swatch: { accent: '#f2a93b', canvas: '#0d0b09' },
  },
  {
    id: 'nebula',
    name: 'Indigo nebula',
    scheme: 'dark',
    swatch: { accent: '#b58eff', canvas: '#0c0b14' },
  },
  {
    id: 'light',
    name: 'Daylight',
    scheme: 'light',
    swatch: { accent: '#0b7d70', canvas: '#f5f7fa' },
  },
];

// `system` follows the OS: Daylight when it prefers light, else Observatory.
export const SYSTEM_THEME_ID = 'system';
export const DEFAULT_THEME_ID = SYSTEM_THEME_ID;
export const THEME_IDS = new Set([SYSTEM_THEME_ID, ...THEMES.map((t) => t.id)]);

export const prefersLight = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;

export const resolveTheme = (id: string | undefined): Theme => {
  if (!id || id === SYSTEM_THEME_ID || !THEME_IDS.has(id)) {
    return prefersLight() ? THEMES[3]! : THEMES[0]!;
  }
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
};

// Colours the canvas needs, resolved from the active theme's CSS tokens.
export interface GraphPalette {
  canvas: string;
  text1: string;
  text2: string;
  text3: string;
  accent: string;
  series: [string, string, string];
  neutral: string;
  memory: string;
  edge: string;
  edgeStrong: string;
  pending: string;
  surface: string;
  fontCanvas: string;
}

export const readGraphPalette = (): GraphPalette => {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    canvas: v('--canvas', '#0a0d13'),
    text1: v('--text-1', '#e7eaf0'),
    text2: v('--text-2', '#aab2c0'),
    text3: v('--text-3', '#8790a0'),
    accent: v('--accent', '#3ddbc3'),
    series: [v('--series-1', '#3987e5'), v('--series-2', '#d95926'), v('--series-3', '#199e70')],
    neutral: v('--node-neutral', '#6b7488'),
    memory: v('--node-memory', '#c7cdd8'),
    edge: v('--edge', 'rgba(170,185,210,.11)'),
    edgeStrong: v('--edge-strong', 'rgba(200,212,232,.55)'),
    pending: v('--pending', '#fab219'),
    surface: v('--surface-2', '#141924'),
    fontCanvas: v('--font-canvas', 'system-ui, sans-serif'),
  };
};
