// SPDX-License-Identifier: Apache-2.0
// Compatibility classifier for the MCP tool surface. Diffs a blessed snapshot
// of tools-manifest.json against the freshly-built manifest and classifies each
// change as additive (allowed) or breaking (fails the gate). Only `stable`
// tools are protected; `experimental` and `deprecated` tools are exempt so the
// surface can still move where it hasn't been promised. See COMPATIBILITY.md.

export interface ToolEntry {
  name: string;
  tier: string;
  stability?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
  outputSchema?: { properties?: Record<string, unknown> };
  errors?: string[];
}

export interface CompatChange {
  severity: 'breaking' | 'additive';
  tool: string;
  detail: string;
}

const props = (s?: { properties?: Record<string, unknown> }): Set<string> =>
  new Set(Object.keys(s?.properties ?? {}));
const required = (s?: { required?: string[] }): Set<string> => new Set(s?.required ?? []);
const minus = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => !b.has(x));

export const classifyCompat = (base: ToolEntry[], next: ToolEntry[]): CompatChange[] => {
  const changes: CompatChange[] = [];
  const nextByName = new Map(next.map((t) => [t.name, t]));

  for (const b of base) {
    // Only tools promised stable in the baseline are protected.
    const protectedTool = (b.stability ?? 'experimental') === 'stable';
    const n = nextByName.get(b.name);
    const sev = (detail: string) =>
      changes.push({ severity: protectedTool ? 'breaking' : 'additive', tool: b.name, detail });

    if (!n) {
      sev('tool removed');
      continue;
    }
    if (n.tier !== b.tier) sev(`tier changed ${b.tier} → ${n.tier}`);

    // input: removing an accepted property or adding a newly-required one breaks callers.
    for (const p of minus(props(b.inputSchema), props(n.inputSchema))) sev(`input '${p}' removed`);
    for (const r of minus(required(n.inputSchema), required(b.inputSchema))) {
      sev(`input '${r}' newly required`);
    }
    // output: removing a field breaks readers.
    for (const p of minus(props(b.outputSchema), props(n.outputSchema))) sev(`output '${p}' removed`);
    // errors: removing a code breaks branches.
    for (const e of minus(new Set(b.errors ?? []), new Set(n.errors ?? []))) sev(`error '${e}' removed`);
  }

  // additive: brand-new tools.
  const baseNames = new Set(base.map((t) => t.name));
  for (const n of next) if (!baseNames.has(n.name)) changes.push({ severity: 'additive', tool: n.name, detail: 'new tool' });

  return changes;
};
