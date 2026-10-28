// SPDX-License-Identifier: Apache-2.0

// Agent names are valid arguments to `install`, not commands — `rig claude`
// almost always means `rig install claude`.
const AGENTS = ['claude', 'cursor', 'codex', 'opencode', 'openrouter'];

// Words people reach for instead of a command's name. Without this `remove`
// would be "corrected" to `serve` by edit distance, and `import` or `backup`
// would find nothing.
const SYNONYMS: Record<string, string> = {
  remove: 'uninstall',
  rm: 'uninstall',
  unwire: 'uninstall',
  unlink: 'uninstall',
  deinstall: 'uninstall',
  wire: 'install',
  backup: 'export-memory',
  'save-memory': 'export-memory',
  import: 'import-memory',
  restore: 'import-memory',
  'load-memory': 'import-memory',
};

// Levenshtein edit distance — small inputs, so the simple O(n·m) table is fine.
const editDistance = (a: string, b: string): number => {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, tmp, row[j - 1]!);
      prev = tmp;
    }
  }
  return row[n]!;
};

// Suggest the closest real command for an unknown one. Returns the suggestion
// as the user would type it (e.g. `serve`, or `install claude`), or null when
// nothing is close enough to be worth showing.
export const suggestCommand = (input: string, commands: string[]): string | null => {
  if (AGENTS.includes(input)) return `install ${input}`;
  const synonym = SYNONYMS[input];
  if (synonym && commands.includes(synonym)) return synonym;
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of commands) {
    const d = editDistance(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  // Only suggest when the typo is plausibly that command: within 2 edits, or
  // within half the input length for longer words (e.g. "exprt-docs").
  const threshold = Math.max(2, Math.floor(input.length / 2));
  return best !== null && bestDist <= threshold ? best : null;
};
