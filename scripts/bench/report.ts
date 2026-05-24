import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface RunResult {
  query_id: string;
  path: 'baseline' | 'rig';
  trial: number;
  total_input_tokens: number;
  total_output_tokens: number;
  tool_turns: number;
  final_text: string;
  error?: string;
}
interface BenchFile { model: string; target: string; results: RunResult[]; }

const argValue = (n: string): string | undefined => {
  const i = process.argv.indexOf(n);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
};

const inPath = argValue('--in');
const outPath = argValue('--out');
if (!inPath) {
  console.error('usage: bun scripts/bench/report.ts --in results.json [--out report.md]');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(inPath, 'utf-8')) as BenchFile;

const byQuery = new Map<string, { baseline: RunResult[]; rig: RunResult[] }>();
for (const r of raw.results) {
  const entry = byQuery.get(r.query_id) ?? { baseline: [], rig: [] };
  entry[r.path].push(r);
  byQuery.set(r.query_id, entry);
}

const lines: string[] = [];
lines.push(`# Rig vs baseline — bench report`, '');
lines.push(`- **Model**: \`${raw.model}\``);
lines.push(`- **Target**: \`${raw.target}\``);
lines.push(`- **Queries**: ${byQuery.size}`);
lines.push(`- **Trials per (query, path)**: ${[...byQuery.values()][0]?.baseline.length ?? 0}`);
lines.push('');

lines.push('## Token totals (median across trials)', '');
lines.push('| query | baseline (in+out) | rig (in+out) | ratio | baseline turns | rig turns |');
lines.push('|---|---:|---:|---:|---:|---:|');
let weightedB = 0, weightedR = 0;
for (const [qid, runs] of byQuery) {
  const bT = runs.baseline.map((r) => r.total_input_tokens + r.total_output_tokens);
  const rT = runs.rig.map((r) => r.total_input_tokens + r.total_output_tokens);
  const bMed = Math.round(median(bT));
  const rMed = Math.round(median(rT));
  const ratio = bMed > 0 ? (rMed / bMed) : NaN;
  const bTurns = Math.round(median(runs.baseline.map((r) => r.tool_turns)));
  const rTurns = Math.round(median(runs.rig.map((r) => r.tool_turns)));
  lines.push(`| \`${qid}\` | ${bMed.toLocaleString()} | ${rMed.toLocaleString()} | ${(ratio * 100).toFixed(1)}% | ${bTurns} | ${rTurns} |`);
  weightedB += bMed; weightedR += rMed;
}
const perQueryRatios: number[] = [];
for (const rs of byQuery.values()) {
  const b = median(rs.baseline.map((r) => r.total_input_tokens + r.total_output_tokens));
  const r = median(rs.rig.map((rr) => rr.total_input_tokens + rr.total_output_tokens));
  if (b > 0) perQueryRatios.push((r / b) * 100);
}
const medianPct = median(perQueryRatios).toFixed(1);
const summedPct = weightedB > 0 ? ((weightedR / weightedB) * 100).toFixed(1) : 'NaN';
lines.push(`| **median across queries** |  |  | **${medianPct}%** |  |  |`);
lines.push(`| **summed** | ${weightedB.toLocaleString()} | ${weightedR.toLocaleString()} | ${summedPct}% |  |  |`);
lines.push('');

lines.push('## Read', '');
const medianRatios = [...byQuery.values()].map((rs) => {
  const b = median(rs.baseline.map((r) => r.total_input_tokens + r.total_output_tokens));
  const r = median(rs.rig.map((rr) => rr.total_input_tokens + rr.total_output_tokens));
  return b > 0 ? r / b : NaN;
}).filter((r) => !Number.isNaN(r));
const med = median(medianRatios);
if (med <= 0.15) lines.push(`Median ratio **${(med * 100).toFixed(1)}%** — cost story is real. F1 (HNSW) is the priority; build a public benchmark page.`);
else if (med <= 0.6) lines.push(`Median ratio **${(med * 100).toFixed(1)}%** — interesting but not the headline. Pivot Rig to audit-workspace product; cost is one feature among many.`);
else lines.push(`Median ratio **${(med * 100).toFixed(1)}%** — value isn't where the marketing has been pointing. Reset the pitch.`);
lines.push('');

lines.push('## Side-by-side answers (judge correctness here)', '');
for (const [qid, runs] of byQuery) {
  lines.push(`### \`${qid}\``, '');
  for (const path of ['baseline', 'rig'] as const) {
    const first = runs[path][0];
    if (!first) continue;
    lines.push(`**${path}**${first.error ? ` (error: ${first.error})` : ''}:`, '');
    lines.push('```');
    lines.push((first.final_text || '(empty)').slice(0, 1200));
    lines.push('```', '');
  }
}

const report = lines.join('\n') + '\n';
if (outPath) {
  writeFileSync(resolve(outPath), report);
  console.log(`wrote ${resolve(outPath)}`);
} else {
  process.stdout.write(report);
}
