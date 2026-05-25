// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Rig } from '@rig/core';
import type { WaypointKind, WaypointPayload, WaypointRow } from '@rig/core';

const optionValue = (n: string): string | undefined => {
  const i = process.argv.indexOf(n);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

const KIND_DIR: Record<WaypointKind, string> = {
  decision: 'decisions',
  observation: 'observations',
  constraint: 'constraints',
  'open-question': 'open-questions',
  principle: 'principles',
};

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'untitled';

const isoDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

const renderPayload = (p: WaypointPayload): string => {
  switch (p.type) {
    case 'text-summary':
      return p.content + '\n';
    case 'mermaid-diagram':
      return '```mermaid\n' + p.content + '\n```\n';
    case 'code-snippet':
      return '```' + p.lang + '\n' + p.content + '\n```\n';
    case 'doc-fragment':
      return p.content + '\n';
    case 'image-ref':
      return `![${p.alt ?? ''}](${p.path})\n`;
    case 'dataset-pointer':
      return `> dataset query: \`${p.query}\`\n`;
  }
};

const renderWaypoint = (w: WaypointRow): string => {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`id: ${w.id}`);
  lines.push(`kind: ${w.kind}`);
  lines.push(`session_id: ${w.session_id}`);
  lines.push(`ts: ${w.ts}`);
  lines.push(`date: ${isoDate(w.ts)}`);
  if (w.key_terms.length) lines.push(`key_terms: [${w.key_terms.map((t) => JSON.stringify(t)).join(', ')}]`);
  lines.push('---', '');
  lines.push(`# ${w.title}`, '');
  if (w.analogy) lines.push(`> **Analogy.** ${w.analogy}`, '');
  lines.push(w.summary, '');
  if (w.constellation_refs.length) {
    lines.push('## References', '');
    for (const r of w.constellation_refs) lines.push(`- \`${r}\``);
    lines.push('');
  }
  if (w.predecessors.length) {
    lines.push('## Succeeds', '');
    for (const p of w.predecessors) lines.push(`- [\`${p}\`](../by-id/${p}.md)`);
    lines.push('');
  }
  if (w.payloads.length) {
    lines.push('## Payloads', '');
    for (const p of w.payloads) {
      lines.push(`### ${p.type}`, '');
      lines.push(renderPayload(p), '');
    }
  }
  return lines.join('\n');
};

const renderIndex = (byKind: Map<WaypointKind, WaypointRow[]>, total: number): string => {
  const lines: string[] = ['# Rig — exported waypoints', ''];
  lines.push(`Generated ${new Date().toISOString()} from ${total} waypoint(s).`, '');
  for (const [kind, rows] of byKind) {
    if (!rows.length) continue;
    lines.push(`## ${KIND_DIR[kind]} (${rows.length})`, '');
    for (const w of rows) {
      const file = `${KIND_DIR[kind]}/${isoDate(w.ts)}-${slug(w.title)}.md`;
      lines.push(`- [${w.title}](${file}) — ${isoDate(w.ts)} · session \`${w.session_id}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
};

export const runExportDocs = async (cwd: string): Promise<void> => {
  const out = optionValue('--out') ?? join(cwd, 'docs');
  if (!Rig.isInitialized(cwd)) {
    console.error('rig: not initialized. Run `rig init` first.');
    process.exit(2);
  }
  const rig = await Rig.open(cwd);
  try {
    const waypoints = rig.getWaypoints({ limit: 10000 });
    if (waypoints.length === 0) {
      console.log('no waypoints to export.');
      return;
    }
    const byKind = new Map<WaypointKind, WaypointRow[]>([
      ['decision', []],
      ['principle', []],
      ['constraint', []],
      ['open-question', []],
      ['observation', []],
    ]);
    for (const w of waypoints) byKind.get(w.kind)?.push(w);

    const outAbs = resolve(out);
    await mkdir(outAbs, { recursive: true });
    let written = 0;
    for (const [kind, rows] of byKind) {
      if (!rows.length) continue;
      const dir = join(outAbs, KIND_DIR[kind]);
      await mkdir(dir, { recursive: true });
      for (const w of rows) {
        const file = join(dir, `${isoDate(w.ts)}-${slug(w.title)}.md`);
        await writeFile(file, renderWaypoint(w));
        written++;
      }
    }
    await writeFile(join(outAbs, 'index.md'), renderIndex(byKind, waypoints.length));
    console.log(`rig export-docs: wrote ${written + 1} files to ${outAbs}`);
  } finally {
    rig.close();
  }
};
