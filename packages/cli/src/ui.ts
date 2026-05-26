// SPDX-License-Identifier: Apache-2.0
// Dependency-free terminal UI: plain ANSI escapes, no runtime deps. Every color
// helper no-ops on a non-TTY or when NO_COLOR is set, so CI logs stay clean and
// pipe-friendly. The progress renderer rewrites a single line in place on a TTY
// and degrades to one line per event everywhere else.

const isTty = (): boolean => process.stderr.isTTY === true;
const plain = (): boolean => !isTty() || process.env.NO_COLOR !== undefined;
const wrap = (code: string) => (s: string): string => (plain() ? s : `\x1b[${code}m${s}\x1b[0m`);

export const dim = wrap('2');
export const bold = wrap('1');
export const cyan = wrap('36');
export const green = wrap('32');
export const yellow = wrap('33');
export const red = wrap('31');

export const sym = { ok: '✓', hub: '⬡', dot: '·', arrow: '→' } as const;

const write = (s: string): void => void process.stderr.write(s);
const clearLine = (): void => {
  if (isTty()) write('\r\x1b[K');
};

// Header for `rig start`: a hex glyph, project name, and the resolved URL.
export const banner = (project: string, url: string): void => {
  write('\n');
  write(`  ${cyan(sym.hub)} ${bold('Rig')} ${dim('— mapping')} ${bold(project)}\n`);
  write(`  ${dim(url)}\n\n`);
};

export const line = (symbol: string, label: string, detail = ''): void => {
  clearLine();
  write(`  ${symbol} ${label}${detail ? '  ' + dim(detail) : ''}\n`);
};

const PHASES = ['extract', 'resolve', 'embed', 'tests-edges', 'hubness', 'communities'] as const;
const BAR_WIDTH = 18;

const bar = (current: number, total: number): string => {
  const ratio = total > 0 ? Math.min(1, current / total) : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  return `${'█'.repeat(filled)}${dim('░'.repeat(BAR_WIDTH - filled))}`;
};

// Renders indexing progress. On a TTY it overwrites one line with a phase
// stepper, an in-place bar, and a current/total count. Off-TTY it emits a
// terse one-liner per distinct (phase,count) tick — no escape codes.
export interface ProgressArgs {
  phase: string;
  current?: number;
  total?: number;
  detail?: string;
}

export const makeProgress = (): ((p: ProgressArgs) => void) => {
  let lastLog = '';
  return (p: ProgressArgs): void => {
    const idx = PHASES.indexOf(p.phase as (typeof PHASES)[number]);
    const step = idx >= 0 ? `${idx + 1}/${PHASES.length}` : '·';
    const count =
      p.total !== undefined
        ? `${p.current ?? p.total}/${p.total}`
        : p.current !== undefined
          ? String(p.current)
          : '';
    if (plain()) {
      const log = `  indexing ${step} ${p.phase} ${count}`.trimEnd();
      if (log !== lastLog) {
        write(log + '\n');
        lastLog = log;
      }
      return;
    }
    const meter = p.total !== undefined ? `${bar(p.current ?? p.total, p.total)} ` : '';
    const tail = p.detail ? dim(' ' + p.detail) : '';
    clearLine();
    write(`  ${cyan(sym.arrow)} ${dim(step)} ${bold(p.phase.padEnd(12))} ${meter}${dim(count)}${tail}`);
  };
};

// Clear the in-place progress line once indexing finishes (TTY only).
export const endProgress = (): void => clearLine();

export const isTtyOut = isTty;
