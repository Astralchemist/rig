// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';

// `--path <dir>` / `--path=<dir>` names the project root for `rig serve`.
// Hosts that spawn MCP servers from the wrong cwd (Cursor) pass it explicitly.
// Returns null when the flag is absent, '' when it has no value.
export const pathArg = (argv: readonly string[]): string | null => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--path') return argv[i + 1] ?? '';
    if (a.startsWith('--path=')) return a.slice('--path='.length);
  }
  return null;
};

// The project root: `--path` resolved against cwd, else cwd itself. A value
// the host left unexpanded (e.g. a literal `${workspaceFolder}` from a Cursor
// that predates config interpolation) or an empty one is ignored with a
// warning, so the server falls back to cwd instead of a path that can't exist.
export const resolveProjectRoot = (
  argv: readonly string[],
  cwd: string,
  warn: (msg: string) => void = (msg) => void process.stderr.write(msg),
): string => {
  const raw = pathArg(argv);
  if (raw === null) return resolve(cwd);
  if (!raw.trim() || raw.startsWith('--') || /\$\{[^}]*\}/.test(raw)) {
    warn(`rig: ignoring --path ${JSON.stringify(raw)} (empty or unexpanded) — serving ${resolve(cwd)}\n`);
    return resolve(cwd);
  }
  return resolve(cwd, raw);
};
