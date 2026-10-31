// SPDX-License-Identifier: Apache-2.0
// Score the hand labels in results/labels.json against results/flags.json.
//
//   bun run scripts/deps-eval/score.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Label = 'used' | 'unused' | 'unclear';
interface Flag {
  key: string;
  repo: string;
  name: string;
}
interface Labelled {
  label: Label;
  rule?: number;
  note: string;
}

const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const FLAGS = arg('--flags', 'flags.json');
const LABELS = arg('--labels', 'labels.json');
const TAG = arg('--tag', '');
const dir = resolve(import.meta.dir, 'results');
const { counts, flags } = JSON.parse(readFileSync(join(dir, FLAGS), 'utf-8')) as {
  counts: Record<string, { flagged: number; labelled: number; declared: number }>;
  flags: Flag[];
};
const labels = JSON.parse(readFileSync(join(dir, LABELS), 'utf-8')) as Record<string, Labelled>;

const missing = flags.filter((f) => !labels[f.key]);
if (missing.length) throw new Error(`unlabelled: ${missing.map((f) => f.key).join(', ')}`);

const tally = (fs: Flag[]) => {
  const t = { used: 0, unused: 0, unclear: 0 };
  for (const f of fs) t[labels[f.key]!.label]++;
  const n = t.used + t.unused + t.unclear;
  return { ...t, n, precision: n ? t.unused / n : 0 };
};
const pooled = tally(flags);
const byRule: Record<string, number> = {};
for (const f of flags) {
  const l = labels[f.key]!;
  if (l.label === 'used') byRule[String(l.rule ?? '?')] = (byRule[String(l.rule ?? '?')] ?? 0) + 1;
}
const verdict = pooled.precision >= 0.8 ? 'PASS' : 'FAIL';
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const RULES: Record<string, string> = {
  '1': 'imported or loaded in source',
  '2': 'run as a command',
  '3': 'named in a config file',
  '4': '@types for a used package or runtime',
  '5': 'plugin or peer loaded by a used tool',
  '6': "a library's peer dependency",
};

const md = [
  `# Dependency-report evaluation — ${verdict}`,
  '',
  `Pre-registered in \`scripts/deps-eval/README.md\`. Labels and evidence: \`results/${LABELS}\`, \`results/${FLAGS}\`.`,
  '',
  `Pooled precision of \`rig_unused_deps\`: **${pct(pooled.precision)}** (${pooled.unused} unused of ${pooled.n} labelled; bar ≥ 80%).`,
  '',
  '| repo | declared | flagged | labelled | unused | used | unclear | precision |',
  '|---|---:|---:|---:|---:|---:|---:|---:|',
  ...Object.entries(counts).map(([repo, c]) => {
    const t = tally(flags.filter((f) => f.repo === repo));
    return `| ${repo} | ${c.declared} | ${c.flagged} | ${c.labelled} | ${t.unused} | ${t.used} | ${t.unclear} | ${t.n ? pct(t.precision) : '–'} |`;
  }),
  '',
  'False positives by the rule that made them used:',
  '',
  '| rule | count |',
  '|---|---:|',
  ...Object.entries(byRule)
    .sort(([, a], [, b]) => b - a)
    .map(([r, n]) => `| ${r}. ${RULES[r] ?? 'unspecified'} | ${n} |`),
].join('\n');
const date = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(dir, `${date}-deps${TAG}.json`),
  JSON.stringify({ verdict, pooled, byRule, counts }, null, 2) + '\n',
);
writeFileSync(join(dir, `${date}-deps${TAG}.md`), md + '\n');
console.log(md);
