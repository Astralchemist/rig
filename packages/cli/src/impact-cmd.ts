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
  if (r.blindSpots.length) {
    L.push('', 'Blind spots (passed as a value; calls through these are not traced):');
    for (const b of r.blindSpots) L.push(`  ${b.symbol}  by ${b.passedBy.join(', ')}`);
  }
  L.push(
    '',
    `Edges: ${r.edgeCounts.structural} from the code, ${r.edgeCounts.accepted} accepted links (dashed in --format mermaid).`,
  );
  return L.join('\n') + '\n';
};

/** Marks rig's PR comment so the action edits it instead of posting another. */
export const COMMENT_MARKER = '<!-- rig-impact -->';

/**
 * The PR comment (backlog E5): a summary line first, recorded decisions at
 * risk as checkboxes, the drawing collapsed, and what static analysis can't
 * see. Empty when the change touches no indexed code, so the action stays
 * silent.
 */
export const renderImpactComment = (
  r: DiffImpact,
  opts: { commit?: string; maxNodes?: number } = {},
): string => {
  if (!r.changed.length && !r.memoryAtRisk.length) return '';
  const L: string[] = [COMMENT_MARKER];
  L.push(
    `**rig impact** · ${plural(r.changed.length, 'changed symbol')} · ` +
      `${plural(r.dependents.length, 'dependent')} within ${plural(r.depth, 'step')} · ` +
      `${r.memoryAtRisk.length} recorded ${r.memoryAtRisk.length === 1 ? 'decision' : 'decisions'} at risk`,
  );
  if (r.memoryAtRisk.length) {
    L.push(
      '',
      '**Recorded decisions anchored to the changed code.** Do they still hold? Tick one:',
      '',
    );
    for (const m of r.memoryAtRisk) {
      const id = m.waypoint.id.replace(/^waypoint:/, '');
      L.push(
        `- **${m.waypoint.title}** (${m.waypoint.kind}, on \`${m.anchors.join('`, `')}\`${m.via === 'file' ? ', file only' : ''})`,
        `  - [ ] still holds <!-- rig:${id}:holds -->`,
        `  - [ ] outdated <!-- rig:${id}:outdated -->`,
        `  - [ ] can't tell <!-- rig:${id}:unsure -->`,
      );
    }
  }
  if (r.changed.length) {
    L.push(
      '',
      `<details><summary>Blast radius: ${plural(r.dependents.length, 'dependent')}</summary>`,
      '',
    );
    L.push('```mermaid', impactToMermaid(r, opts.maxNodes ?? 15), '```', '');
    L.push(
      'Changed: ' +
        r.changed
          .slice(0, 12)
          .map((n) => `\`${n.name}\``)
          .join(', ') +
        (r.changed.length > 12 ? ` and ${r.changed.length - 12} more` : ''),
    );
    if (r.dependents.length)
      L.push(
        '',
        'Nearest dependents: ' +
          r.dependents
            .slice(0, 12)
            .map((n) => `\`${n.name}\``)
            .join(', ') +
          (r.dependents.length > 12 ? ` and ${r.dependents.length - 12} more` : ''),
      );
    L.push('', '</details>');
  }
  if (r.blindSpots.length) {
    L.push(
      '',
      "**Blind spots.** Passed around as a value, so calls made through these aren't traced: " +
        r.blindSpots
          .slice(0, 6)
          .map(
            (b) =>
              `\`${b.symbol}\` (by ${b.passedBy
                .slice(0, 3)
                .map((x) => `\`${x}\``)
                .join(', ')}${b.passedBy.length > 3 ? '…' : ''})`,
          )
          .join('; ') +
        (r.blindSpots.length > 6 ? ` and ${r.blindSpots.length - 6} more` : ''),
    );
  }
  L.push(
    '',
    `<sub>Static analysis of rig's graph${opts.commit ? ` at ${opts.commit.slice(0, 7)}` : ''}. Calls through callbacks, dispatch tables and middleware aren't seen: on rig's own history it found about half of what the tests showed calling into a change.</sub>`,
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
      'usage: rig impact <symbol|id> | --diff [<base>[...<head>]]  [--depth <n>] [--format text|json|mermaid|comment] [--max-nodes <n>] [--no-sync]\n',
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
    else if (format === 'comment') {
      let commit: string | undefined;
      try {
        commit = git(cwd, ['rev-parse', 'HEAD']).trim();
      } catch {
        commit = undefined;
      }
      process.stdout.write(
        renderImpactComment(result, { ...(commit ? { commit } : {}), maxNodes }),
      );
    } else if (format === 'mermaid') process.stdout.write(impactToMermaid(result, maxNodes) + '\n');
    else process.stdout.write(renderImpactText(result));
  } finally {
    rig.close();
  }
}
