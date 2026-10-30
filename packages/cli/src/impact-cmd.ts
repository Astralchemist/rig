// SPDX-License-Identifier: Apache-2.0
// `rig impact`: what a change can break, and which recorded memory it may
// invalidate. `--diff` reads `git diff -U0` (the PR action's input); a bare
// symbol shows the impact of changing that one symbol.
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import {
  Rig,
  addedFilesInDiff,
  diffImpact,
  impactToMermaid,
  parseUnifiedDiff,
  type DiffImpact,
  type LineRange,
} from '@rig/core';

const optionValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

// Diff paths are relative to the git root; rig stores paths relative to the
// project root, which may be a subdirectory of it.
const changesFromDiff = (
  cwd: string,
  range: string | undefined,
): { changes: Map<string, LineRange[]>; addedFiles: Set<string> } => {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const args = ['diff', '-U0', '--no-color', '--no-ext-diff', ...(range ? [range] : ['HEAD'])];
  const diff = git(cwd, args);
  const toProject = (file: string): string | null => {
    const rel = relative(cwd, join(top, file)).split(sep).join('/');
    return rel.startsWith('..') ? null : rel;
  };
  const changes = new Map<string, LineRange[]>();
  for (const [file, ranges] of parseUnifiedDiff(diff)) {
    const rel = toProject(file);
    if (rel) changes.set(rel, ranges);
  }
  const addedFiles = new Set<string>();
  for (const file of addedFilesInDiff(diff)) {
    const rel = toProject(file);
    if (rel) addedFiles.add(rel);
  }
  return { changes, addedFiles };
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export const renderImpactText = (r: DiffImpact): string => {
  const L: string[] = [];
  L.push(
    `${plural(r.changed.length, 'changed symbol')} in ${plural(r.files.length, 'file')} · ` +
      `${plural(r.dependents.length, 'dependent')} within ${plural(r.depth, 'step')} · ` +
      `${r.memoryAtRisk.length} recorded ${r.memoryAtRisk.length === 1 ? 'memory' : 'memories'} at risk`,
  );
  if (r.changed.length) {
    L.push('', 'Changed:');
    for (const n of r.changed)
      L.push(`  ${n.type.padEnd(10)} ${n.name}  ${n.filePath ?? ''}:${n.startLine ?? ''}`);
  }
  if (r.added.length) {
    const files = new Set(r.added.map((n) => n.filePath));
    L.push(
      '',
      `New: ${plural(r.added.length, 'symbol')} in ${plural(files.size, 'new file')} (nothing existing depends on them yet).`,
    );
  }
  if (r.docs.length) L.push('', `Docs: ${plural(r.docs.length, 'section')} changed.`);
  if (r.dependents.length) {
    L.push('', 'Depends on it:');
    for (const n of r.dependents)
      L.push(
        `  ${String(n.hops).padStart(2)} step${n.hops === 1 ? ' ' : 's'} ${n.type.padEnd(10)} ${n.name}  ${n.filePath ?? ''}:${n.startLine ?? ''}`,
      );
  }
  if (r.memoryAtRisk.length) {
    L.push('', 'Memory at risk (recorded decisions anchored to changed code):');
    for (const m of r.memoryAtRisk)
      L.push(
        `  [${m.waypoint.kind}] ${m.waypoint.title}  (on ${m.anchors.join(', ')}${m.via === 'file' ? ', file only' : ''})`,
      );
  }
  L.push(
    '',
    `Edges: ${r.edgeCounts.structural} from the code, ${r.edgeCounts.accepted} accepted links (dashed in --format mermaid).`,
  );
  return L.join('\n') + '\n';
};

export async function runImpact(cwd: string): Promise<void> {
  const args = process.argv.slice(3);
  const valued = new Set(['--depth', '--format', '--max-nodes', '--diff']);
  const useDiff = args.includes('--diff');
  const range = (() => {
    const v = optionValue('--diff');
    return v && !v.startsWith('--') ? v : undefined;
  })();
  const target = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
  if (!useDiff && !target) {
    process.stderr.write(
      'usage: rig impact <symbol|id> | --diff [<base>[...<head>]]  [--depth <n>] [--format text|json|mermaid] [--max-nodes <n>] [--no-sync]\n',
    );
    process.exit(2);
  }
  const depth = Number.parseInt(optionValue('--depth') ?? '2', 10);
  const format = optionValue('--format') ?? 'text';
  const maxNodes = Number.parseInt(optionValue('--max-nodes') ?? '15', 10);

  const rig = await Rig.open(cwd);
  try {
    if (!args.includes('--no-sync')) await rig.sync();
    let changes: Map<string, LineRange[]>;
    let addedFiles = new Set<string>();
    if (useDiff) {
      ({ changes, addedFiles } = changesFromDiff(cwd, range));
    } else {
      const node = rig.getNode(target!) ?? rig.searchNodes(target!, { limit: 1 })[0] ?? null;
      const d = (node?.data ?? {}) as {
        filePath?: unknown;
        startLine?: unknown;
        endLine?: unknown;
      };
      if (!node || typeof d.filePath !== 'string' || typeof d.startLine !== 'number') {
        process.stderr.write(`rig impact: no symbol with a location matches "${target}"\n`);
        process.exit(1);
      }
      const end = typeof d.endLine === 'number' ? d.endLine : d.startLine;
      changes = new Map([[d.filePath, [[d.startLine, end] as LineRange]]]);
    }
    const waypoints = rig.getWaypoints({ limit: Number.MAX_SAFE_INTEGER });
    const result = diffImpact(rig.database.adapter, changes, waypoints, { depth, addedFiles });
    if (format === 'json') process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else if (format === 'mermaid') process.stdout.write(impactToMermaid(result, maxNodes) + '\n');
    else process.stdout.write(renderImpactText(result));
  } finally {
    rig.close();
  }
}
