import { Rig } from '@rig/core';

const isTty = process.stderr.isTTY === true;

// Repeat-flag parser: --include foo --include bar → ['foo', 'bar']
const collectFlag = (name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === name) out.push(process.argv[i + 1]!);
  }
  return out;
};

// Single-line stderr status updates while indexing. On a TTY we rewrite the
// line with \r so the user sees one updating row; otherwise we line-print so
// the trail survives in log files.
const writeStatus = (line: string): void => {
  if (isTty) process.stderr.write(`\r\x1b[K${line}`);
  else process.stderr.write(line + '\n');
};

const fmtPhase = (phase: string, current?: number, total?: number, detail?: string): string => {
  const counter =
    current !== undefined && total !== undefined
      ? `${current}/${total}`
      : current !== undefined
        ? `${current}`
        : total !== undefined
          ? `${total} pending`
          : '';
  const detailStr = detail ? `  ${detail}` : '';
  return `  ${phase.padEnd(12)} ${counter}${detailStr}`;
};

export const runIndex = async (cwd: string): Promise<void> => {
  if (!Rig.isInitialized(cwd)) {
    console.error('rig: not initialized. Run `rig init` first.');
    process.exit(2);
  }
  const include = collectFlag('--include');
  const exclude = collectFlag('--exclude');
  const rig = await Rig.open(cwd);
  try {
    process.stderr.write('rig: indexing...\n');
    if (include.length || exclude.length) {
      process.stderr.write(
        `  filters: include=${JSON.stringify(include)} exclude=${JSON.stringify(exclude)}\n`,
      );
    }
    const r = await rig.indexAll({
      onProgress: (p) => writeStatus(fmtPhase(p.phase, p.current, p.total, p.detail)),
      include,
      exclude,
    });
    if (isTty) process.stderr.write('\r\x1b[K');
    console.log(`rig: done`);
    console.log(`  files:            ${r.files}`);
    console.log(`  nodes:            ${r.nodes}`);
    console.log(`  edges:            ${r.edges}`);
    console.log(`  unresolved:       ${r.unresolved}`);
    console.log(`  elapsed:          ${r.elapsed_ms}ms`);
  } finally {
    rig.close();
  }
};
