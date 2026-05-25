// Theme presets. Each theme is a set of design tokens (chrome + graph colors).
// Tokens are pushed to CSS custom properties for the DOM (see theme.tsx); the
// canvas map reads the resolved Theme object directly since canvas can't use
// CSS vars. Node-kind + community palettes are shared unless a theme overrides.

export interface ThemeTokens {
  bg: string; // page + canvas background
  surface: string; // panels, inputs, chips
  surface2: string; // raised surfaces (popover, palette)
  border: string; // hairlines
  text: string;
  muted: string;
  accent: string; // selection ring, primary actions, focus
  accentText: string; // text/icon on an accent fill
  hub: string; // hub halo + hub labels
  structural: string; // structural edges
  semantic: string; // semantic edges (alpha applied at draw time)
  pending: string; // pending edges + accept/reject affordances
  pulse: string; // AI activation halo
  danger: string;
  success: string;
}

export interface Theme {
  id: string;
  name: string;
  scheme: 'dark' | 'light';
  tokens: ThemeTokens;
  nodeKinds: Record<string, string>;
  community: string[];
}

// Shared node-kind fills — vibrant enough to read on any of the backgrounds.
const KINDS: Record<string, string> = {
  file: '#94a3b8',
  module: '#a78bfa',
  'markdown-section': '#fcd34d',
  class: '#fbbf24',
  function: '#34d399',
  method: '#60a5fa',
  property: '#f472b6',
  variable: '#f87171',
  constant: '#fb923c',
  enum: '#c084fc',
  interface: '#22d3ee',
  type_alias: '#22d3ee',
  cluster: '#ec4899',
};

const COMMUNITY = [
  '#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c',
  '#22d3ee', '#c084fc', '#ec4899', '#facc15', '#4ade80', '#f87171',
  '#818cf8', '#fcd34d', '#2dd4bf', '#e879f9',
];

export const THEMES: Theme[] = [
  {
    id: 'observatory',
    name: 'Observatory',
    scheme: 'dark',
    tokens: {
      bg: '#0a0c10', surface: '#12151c', surface2: '#171b24', border: '#232834',
      text: '#e6e9ef', muted: '#7d8694', accent: '#38e1c6', accentText: '#04110e',
      hub: '#f5b544', structural: '#2c3340', semantic: '#38e1c6', pending: '#f5b544',
      pulse: '#f472b6', danger: '#f87171', success: '#34d399',
    },
    nodeKinds: KINDS,
    community: COMMUNITY,
  },
  {
    id: 'warm',
    name: 'Warm instrument',
    scheme: 'dark',
    tokens: {
      bg: '#0d0b09', surface: '#17130f', surface2: '#1d1813', border: '#2b2620',
      text: '#ece6dd', muted: '#8a8175', accent: '#f5a623', accentText: '#1a1206',
      hub: '#ffd27d', structural: '#3a332a', semantic: '#5ec8c0', pending: '#f5a623',
      pulse: '#ff9e7d', danger: '#f08a6c', success: '#7fce8c',
    },
    nodeKinds: KINDS,
    community: COMMUNITY,
  },
  {
    id: 'nebula',
    name: 'Indigo nebula',
    scheme: 'dark',
    tokens: {
      bg: '#0b0a14', surface: '#15131f', surface2: '#1b1828', border: '#272336',
      text: '#e8e6f0', muted: '#837e98', accent: '#b16cff', accentText: '#120a1f',
      hub: '#fbbf24', structural: '#322c47', semantic: '#7c6cff', pending: '#fbbf24',
      pulse: '#f472b6', danger: '#f87171', success: '#4ade80',
    },
    nodeKinds: KINDS,
    community: COMMUNITY,
  },
  {
    id: 'light',
    name: 'Daylight',
    scheme: 'light',
    tokens: {
      bg: '#eef1f5', surface: '#ffffff', surface2: '#ffffff', border: '#d4dae2',
      text: '#1b2430', muted: '#5f6b7a', accent: '#0ea5a0', accentText: '#ffffff',
      hub: '#b45309', structural: '#b8c1cd', semantic: '#0ea5a0', pending: '#b45309',
      pulse: '#db2777', danger: '#dc2626', success: '#059669',
    },
    nodeKinds: { ...KINDS, 'markdown-section': '#d97706', class: '#d97706' },
    community: COMMUNITY,
  },
];

export const DEFAULT_THEME_ID = 'observatory';

export const themeById = (id: string | undefined): Theme =>
  THEMES.find((t) => t.id === id) ?? THEMES[0]!;
