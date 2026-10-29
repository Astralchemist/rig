// SPDX-License-Identifier: Apache-2.0
// SVG building blocks for the bench charts: the light/dark theme, text and
// mark helpers, and linear scales. No dependencies and no clock or random
// input, so the same data always gives the same bytes.
//
// Colours are the dataviz reference palette: chart surface, ink and hairline
// tokens, and categorical slots 1-3, validated as a set (all pairs, light and
// dark) with the dataviz skill's validate_palette.js. Slot 3 (aqua) is under
// 3:1 on the light surface, so every value it marks is also printed as text.

export const FONT = "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const LIGHT = {
  bg: '#fcfcfb',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  border: 'rgba(11,11,11,0.10)',
  s1: '#2a78d6',
  s2: '#eb6834',
  s3: '#1baf7a',
};
const DARK: typeof LIGHT = {
  bg: '#1a1a19',
  ink: '#ffffff',
  ink2: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  border: 'rgba(255,255,255,0.10)',
  s1: '#3987e5',
  s2: '#d95926',
  s3: '#199e70',
};

const vars = (t: typeof LIGHT): string =>
  Object.entries(t)
    .map(([k, v]) => `--${k}:${v}`)
    .join(';');

// The stylesheet every chart carries. The media query follows the viewer's
// colour scheme, which is how GitHub and npm pick README image themes.
export const STYLE = [
  `svg{${vars(LIGHT)}}`,
  `@media (prefers-color-scheme: dark){svg{${vars(DARK)}}}`,
  `text{font-family:${FONT};font-size:12px;fill:var(--ink2)}`,
  '.bg{fill:var(--bg);stroke:var(--border)}',
  '.title{font-size:15px;font-weight:600;fill:var(--ink)}',
  '.sub{fill:var(--ink2)}',
  '.head{font-weight:600;fill:var(--ink)}',
  '.lab{fill:var(--ink)}',
  '.val{fill:var(--ink2);font-variant-numeric:tabular-nums}',
  '.tick{font-size:11px;fill:var(--muted);font-variant-numeric:tabular-nums}',
  '.note{font-size:11px;fill:var(--muted)}',
  '.empty{font-size:11px;fill:var(--muted);font-style:italic}',
  '.grid{stroke:var(--grid);stroke-width:1}',
  '.axis{stroke:var(--axis);stroke-width:1}',
  '.ref{stroke:var(--ink2);stroke-width:1.5}',
  '.hit{fill:transparent}',
  '.ring{stroke:var(--bg);stroke-width:2}',
  ...(['s1', 's2', 's3', 'muted'] as const).flatMap((s) => [
    `.f-${s}{fill:var(--${s})}`,
    `.w-${s}{stroke:var(--${s});stroke-width:2;stroke-linecap:round;fill:none}`,
  ]),
].join('\n');

export type Series = 's1' | 's2' | 's3' | 'muted';

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Coordinates to at most two decimals, so output never depends on float noise.
export const n = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

export interface TextOpts {
  cls?: string;
  anchor?: 'start' | 'middle' | 'end';
  baseline?: 'middle' | 'auto';
}

export const text = (x: number, y: number, s: string, o: TextOpts = {}): string =>
  `<text x="${n(x)}" y="${n(y)}"${o.cls ? ` class="${o.cls}"` : ''}` +
  `${o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : ''}` +
  `${o.baseline === 'middle' ? ' dominant-baseline="middle"' : ''}>${esc(s)}</text>`;

export const line = (x1: number, y1: number, x2: number, y2: number, cls: string): string =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" class="${cls}"/>`;

// A point estimate: an 8px+ dot with a 2px surface ring.
export const dot = (x: number, y: number, s: Series, r = 5): string =>
  `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" class="f-${s} ring"/>`;

// A 95% CI: a 2px line with 8px end caps.
export const whisker = (x1: number, x2: number, y: number, s: Series): string =>
  `<path d="M${n(x1)} ${n(y)}H${n(x2)}M${n(x1)} ${n(y - 4)}V${n(y + 4)}M${n(x2)} ${n(y - 4)}V${n(y + 4)}" class="w-${s}"/>`;

// A row's hover target, at least 24px tall, carrying its values as a title
// (a native tooltip where the SVG is opened directly; the same values are
// printed as text beside the marks).
export const hit = (x: number, y: number, w: number, h: number, tip: string): string =>
  `<g><title>${esc(tip)}</title><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(Math.max(24, h))}" class="hit"/></g>`;

export interface Scale {
  (v: number): number;
  domain: [number, number];
  ticks: number[];
}

// Linear scale over [lo, hi] onto [x0, x1], with ticks every `step`.
export const scale = (lo: number, hi: number, x0: number, x1: number, step: number): Scale => {
  const f = ((v: number) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0)) as Scale;
  f.domain = [lo, hi];
  const count = Math.round((hi - lo) / step);
  f.ticks = Array.from({ length: count + 1 }, (_, i) => Math.round((lo + i * step) * 1e9) / 1e9);
  return f;
};

// A domain that covers `values` and [minLo, minHi], snapped out to `step`.
export const niceDomain = (
  values: readonly number[],
  minLo: number,
  minHi: number,
  step: number,
): [number, number] => {
  const lo = Math.min(minLo, ...values);
  const hi = Math.max(minHi, ...values);
  // The epsilon keeps a value already on a step (0.2 / 0.2) from snapping out
  // a further step through float error.
  const snap = (v: number) => Math.round(v * 1e9) / 1e9;
  return [snap(Math.floor(lo / step + 1e-9) * step), snap(Math.ceil(hi / step - 1e-9) * step)];
};

// Vertical gridlines and tick labels for a horizontal scale.
export const xAxis = (
  s: Scale,
  yTop: number,
  yBottom: number,
  label: (v: number) => string,
): string =>
  s.ticks
    .map(
      (t) =>
        line(s(t), yTop, s(t), yBottom, 'grid') +
        text(s(t), yBottom + 15, label(t), { cls: 'tick', anchor: 'middle' }),
    )
    .join('');

// Greedy word wrap by character count: the renderer can't measure text, so
// widths are budgeted at ~6.2px per 12px character.
export const wrap = (s: string, maxChars: number): string[] => {
  const out: string[] = [];
  let cur = '';
  for (const word of s.split(' ')) {
    if (cur && (cur + ' ' + word).length > maxChars) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
};

export const svgDoc = (opts: {
  width: number;
  height: number;
  id: string;
  title: string;
  desc: string;
  body: string;
}): string =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${n(opts.height)}" viewBox="0 0 ${opts.width} ${n(opts.height)}" role="img" aria-labelledby="${opts.id}-title ${opts.id}-desc">`,
    `<title id="${opts.id}-title">${esc(opts.title)}</title>`,
    `<desc id="${opts.id}-desc">${esc(opts.desc)}</desc>`,
    `<style>\n${STYLE}\n</style>`,
    `<rect x="0.5" y="0.5" width="${opts.width - 1}" height="${n(opts.height - 1)}" rx="8" class="bg"/>`,
    opts.body,
    '</svg>',
    '',
  ].join('\n');

// Shared number formats: the title/desc text and the printed labels use these,
// and the tests check them against the data.
export const pct0 = (v: number): string => `${Math.round(v * 100)}%`;
export const pct1 = (v: number): string => `${(v * 100).toFixed(1)}%`;
export const pp1 = (v: number): string =>
  `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(1)} pp`;
// Axis ticks in percentage points: signed whole numbers.
export const ppTick = (v: number): string => {
  const r = Math.round(v * 100);
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : '0';
};
export const ciPct = (ci: readonly [number, number]): string =>
  `${Math.round(ci[0] * 100)}–${Math.round(ci[1] * 100)}%`;
export const ciPp = (ci: readonly [number, number]): string =>
  `${pp1(ci[0]).replace(' pp', '')} to ${pp1(ci[1])}`;
