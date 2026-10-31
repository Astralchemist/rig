// SPDX-License-Identifier: Apache-2.0
// Memory that travels with the repo (backlog B5, first version).
//
// One file per record under `.rig-memory/<id[0:2]>/<id>.jsonl`, committed with
// the code, so different records never conflict in a merge, two edits to one
// record conflict in one small file, and removing a record is deleting
// lines from its own file. Lines are versions: `put` (the record as of that
// version) or `tombstone` (unshared). Import is a set-union keyed on
// (id, version): the highest version wins.
//
// Nothing is shared unless a person promotes it. Promotion refuses text with
// a secret in it or hidden Unicode (bidi overrides, zero-width characters),
// and refuses captured records, which quote the user's own words, unless
// asked. Records hold no machine-local fields, so every clone converges.
//
// Top-level `.rig-memory/` rather than `.rig/memory/`: `rig init` ignores
// `.rig/`, and git can't re-include a directory under an ignored parent.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasSecret } from '../capture/redact.ts';
import type { Rig } from '../rig.ts';

export const SHARED_DIR = '.rig-memory';
export const SHARED_PROVENANCE = 'git:shared';

/** Bidi overrides and isolates, zero-width and other invisible characters. */
export const HIDDEN_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

export interface PortableAnchor {
  kind: string;
  filePath: string;
  qualifiedName: string;
}

export interface SharedWaypoint {
  waypoint_kind: string;
  title: string;
  summary: string;
  rationale?: string;
  key_terms: string[];
  anchors: PortableAnchor[];
}

export type SharedLine =
  | { v: 1; id: string; version: number; op: 'put'; by: string; record: SharedWaypoint }
  | { v: 1; id: string; version: number; op: 'tombstone'; by: string };

const fileFor = (root: string, id: string): string =>
  join(root, SHARED_DIR, id.slice(0, 2), `${id}.jsonl`);

const hashOf = (l: SharedLine): string =>
  createHash('sha256').update(JSON.stringify(l)).digest('hex');

export interface SharedState {
  /** Live records, highest version per id. */
  records: Map<string, { version: number; by: string; record: SharedWaypoint }>;
  /** Ids whose highest version is a tombstone. */
  tombstoned: Set<string>;
  /** Problems a CI check should fail on. */
  errors: string[];
}

/** Read every record file. Identical duplicate lines (a union merge) are harmless; differing ones are errors. */
export const loadShared = (root: string): SharedState => {
  const state: SharedState = { records: new Map(), tombstoned: new Set(), errors: [] };
  const base = join(root, SHARED_DIR);
  if (!existsSync(base)) return state;
  const latest = new Map<string, SharedLine>();
  const seen = new Map<string, string>(); // id@version -> hash
  for (const shard of readdirSync(base)) {
    const dir = join(base, shard);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const lines = readFileSync(join(dir, f), 'utf-8').split('\n');
      lines.forEach((raw, i) => {
        if (!raw.trim()) return;
        const where = `${SHARED_DIR}/${shard}/${f}:${i + 1}`;
        if (HIDDEN_UNICODE.test(raw)) state.errors.push(`${where}: hidden Unicode`);
        let l: SharedLine;
        try {
          l = JSON.parse(raw) as SharedLine;
        } catch {
          state.errors.push(`${where}: not JSON`);
          return;
        }
        if (
          l.v !== 1 ||
          typeof l.id !== 'string' ||
          typeof l.version !== 'number' ||
          `${l.id}.jsonl` !== f
        ) {
          state.errors.push(`${where}: malformed record`);
          return;
        }
        if (l.op === 'put' && hasSecret(JSON.stringify(l.record)))
          state.errors.push(`${where}: looks like a secret`);
        const key = `${l.id}@${l.version}`;
        const h = hashOf(l);
        const prev = seen.get(key);
        if (prev && prev !== h)
          state.errors.push(`${where}: two different versions ${l.version} of ${l.id}`);
        seen.set(key, h);
        const cur = latest.get(l.id);
        if (!cur || l.version > cur.version) latest.set(l.id, l);
      });
    }
  }
  for (const [id, l] of latest) {
    if (l.op === 'tombstone') state.tombstoned.add(id);
    else state.records.set(id, { version: l.version, by: l.by, record: l.record });
  }
  return state;
};

const nextVersion = (root: string, id: string): number => {
  const f = fileFor(root, id);
  if (!existsSync(f)) return 1;
  let max = 0;
  for (const raw of readFileSync(f, 'utf-8').split('\n')) {
    try {
      max = Math.max(max, (JSON.parse(raw) as SharedLine).version);
    } catch {
      // skip blank or broken lines
    }
  }
  return max + 1;
};

const append = (root: string, line: SharedLine): void => {
  const f = fileFor(root, line.id);
  mkdirSync(join(root, SHARED_DIR, line.id.slice(0, 2)), { recursive: true });
  appendFileSync(f, JSON.stringify(line) + '\n');
};

export class PromoteError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
  }
}

const sharedIdOf = (waypointId: string): string => waypointId.replace(/^waypoint:/, '');

/**
 * Share one waypoint: append a new version of its record. Refuses captured
 * records unless `includeCaptured`, and any text with a secret or hidden Unicode.
 */
export const promoteWaypoint = (
  rig: Rig,
  waypointId: string,
  opts: { by: string; includeCaptured?: boolean },
): { id: string; version: number; file: string } => {
  const w = rig.getWaypoint(waypointId);
  if (!w) throw new PromoteError([`no waypoint ${waypointId}`]);
  const problems: string[] = [];
  if (w.source === 'hook' && !opts.includeCaptured)
    problems.push(
      'captured from a conversation (it quotes your words); pass --include-captured to share it anyway',
    );
  const text = [w.title, w.summary, w.rationale ?? '', ...w.key_terms].join('\n');
  if (HIDDEN_UNICODE.test(text))
    problems.push('contains hidden Unicode (bidi or zero-width characters)');
  if (hasSecret(text)) problems.push('looks like it contains a secret');
  const anchors: PortableAnchor[] = [];
  for (const ref of w.constellation_refs) {
    const n = rig.getNode(ref);
    const d = (n?.data ?? {}) as { filePath?: unknown; qualifiedName?: unknown };
    if (n && typeof d.filePath === 'string')
      anchors.push({
        kind: n.type,
        filePath: d.filePath,
        qualifiedName: typeof d.qualifiedName === 'string' ? d.qualifiedName : n.name,
      });
  }
  if (problems.length) throw new PromoteError(problems);
  const id = sharedIdOf(w.id);
  const version = nextVersion(rig.projectRoot, id);
  append(rig.projectRoot, {
    v: 1,
    id,
    version,
    op: 'put',
    by: opts.by,
    record: {
      waypoint_kind: w.kind,
      title: w.title,
      summary: w.summary,
      ...(w.rationale ? { rationale: w.rationale } : {}),
      key_terms: w.key_terms,
      anchors,
    },
  });
  return { id, version, file: fileFor(rig.projectRoot, id) };
};

/** Stop sharing: append a tombstone. Local copies elsewhere are removed on their next import. */
export const unshare = (root: string, id: string, by: string): number => {
  const sid = sharedIdOf(id);
  const version = nextVersion(root, sid);
  append(root, { v: 1, id: sid, version, op: 'tombstone', by });
  return version;
};

/** A one-line report of an import, or '' when there was nothing to say. */
export const describeImport = (r: ImportResult): string => {
  const parts = [
    r.added ? `${r.added} imported` : '',
    r.removed ? `${r.removed} unshared` : '',
    r.unanchored ? `${r.unanchored} waiting for symbols` : '',
    r.errors.length ? `${r.errors.length} problem(s): run rig memory check` : '',
  ].filter(Boolean);
  return parts.length ? `shared memory: ${parts.join(', ')}` : '';
};

export interface ImportResult {
  added: number;
  /** Shared records anchored to symbols this index doesn't have (yet). */
  unanchored: number;
  /** Local copies of tombstoned records removed. */
  removed: number;
  errors: string[];
}

/**
 * Bring shared records into the local graph as waypoints with provenance
 * `git:shared` (an id per record, so importing again adds nothing), and drop
 * local copies of records that have since been unshared.
 */
export const importShared = (rig: Rig): ImportResult => {
  const state = loadShared(rig.projectRoot);
  const db = rig.database.adapter;
  const res: ImportResult = { added: 0, unanchored: 0, removed: 0, errors: state.errors };
  const find = db.prepare(
    `SELECT id FROM nodes WHERE type = ? AND json_extract(data, '$.filePath') = ?
       AND COALESCE(json_extract(data, '$.qualifiedName'), name) = ?`,
  );
  for (const [id, { by, record }] of state.records) {
    const wid = `waypoint:${id}`;
    if (rig.getWaypoint(wid)) continue;
    const refs: string[] = [];
    for (const a of record.anchors) {
      const row = find.get(a.kind, a.filePath, a.qualifiedName) as { id: string } | undefined;
      if (row) refs.push(row.id);
    }
    if (record.anchors.length && !refs.length) {
      res.unanchored++;
      continue;
    }
    rig.writes.dropWaypoint(
      {
        id: wid,
        kind: record.waypoint_kind as never,
        title: record.title,
        summary: record.summary,
        ...(record.rationale ? { rationale: record.rationale } : {}),
        keyTerms: record.key_terms,
        constellationRefs: refs,
        source: 'agent',
        provenance: SHARED_PROVENANCE,
      },
      { sessionId: `shared:${by}`, actor: SHARED_PROVENANCE },
    );
    res.added++;
  }
  for (const id of state.tombstoned) {
    const w = rig.getWaypoint(`waypoint:${id}`);
    if (w && w.provenance === SHARED_PROVENANCE) {
      rig.writes.deleteWaypoint(w.id);
      res.removed++;
    }
  }
  return res;
};
