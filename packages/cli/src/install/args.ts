// SPDX-License-Identifier: Apache-2.0

export interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

// Minimal argv parser for `install` / `uninstall`: `--flag`, `--opt value`,
// `--opt=value`. Options listed in `withValue` consume the next argument, so
// `rig install --bin ./rig claude` doesn't mistake `./rig` for a target.
export const parseArgs = (argv: readonly string[], withValue: readonly string[] = []): ParsedArgs => {
  const out: ParsedArgs = { positionals: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      out.positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      out.values.set(a.slice(0, eq), a.slice(eq + 1));
    } else if (withValue.includes(a) && i + 1 < argv.length) {
      out.values.set(a, argv[++i]!);
    } else {
      out.flags.add(a);
    }
  }
  return out;
};
