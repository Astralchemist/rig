// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, relative, sep } from 'node:path';
import type { SqliteAdapter } from '../db/adapter.ts';
import { getEmbedding } from '../db/embed-queries.ts';
import type { WaypointKind, WaypointRow } from '../db/waypoint-queries.ts';
import { embeddingText } from '../embed/index-embeddings.ts';
import type { Rig } from '../rig.ts';
import { redact } from './redact.ts';
import { clip } from './text.ts';
import type { SettledKind, SettledRecord } from './types.ts';

// Persist extractor records as waypoints. Each is redacted, mapped to a
// waypoint kind, anchored to the graph nodes it names and checked against
// the waypoints already stored: a near-duplicate (same kind, the same thing
// said again — in this session or an earlier one) is skipped.

export const WAYPOINT_KIND_OF: Readonly<Record<SettledKind, WaypointKind>> = {
  agreed: 'decision',
  decision: 'decision',
  correction: 'decision',
  constraint: 'constraint',
  rejected: 'dead-end',
  'dead-end': 'dead-end',
};

export interface StoreOptions {
  sessionId: string;
  // The host the conversation came from; provenance is `hook:<client>`.
  client: string;
  // How long one dedupe search waits for the embedding model. Default 1500.
  searchWaitMs?: number;
  // Date.now() past which no more records are stored (the rest are reported
  // as skipped; the next run's cursor has moved on, so keep it generous).
  deadline?: number;
}

export interface StoredRecord {
  id: string;
  kind: WaypointKind;
  record: SettledRecord;
}

export interface StoreOutcome {
  stored: StoredRecord[];
  duplicates: Array<{ record: SettledRecord; of: string }>;
  skipped: SettledRecord[];
}

const STOP = new Set(
  'the a an and or but of to in on for with at by from is are was were be been it this that these those we you i our your as so not no do does did into than then use using'.split(
    ' ',
  ),
);

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/^(?:rejected|declined):\s*/, '')
      .split(/[^a-z0-9_./-]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  );

// Identifiers, paths and versions: the words that make two otherwise alike
// statements about different things ("never change C0.run" vs "C1.run").
const specific = (s: string): Set<string> =>
  new Set(
    (
      s.match(/[A-Za-z_$][\w$]*(?:[./:#-][\w$]+)+|\b[a-z]+[A-Z]\w*|\b\w*\d\w*|\b\w+_\w+/g) ?? []
    ).map((t) => t.toLowerCase()),
  );

const sameSubject = (a: string, b: string): boolean => {
  const sa = specific(a);
  const sb = specific(b);
  return !sa.size || !sb.size || [...sa].some((t) => sb.has(t));
};

// Word overlap of two summaries: Jaccard, or containment when one is a
// shorter restatement of the other. Zero when both name specific things and
// none of them in common.
export const lexicalSimilarity = (a: string, b: string): number => {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  if (!sameSubject(a, b)) return 0;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  const jaccard = both / (A.size + B.size - both);
  const small = Math.min(A.size, B.size);
  const containment = small >= 4 ? both / small : 0;
  return Math.max(jaccard, containment * 0.85);
};

const LEXICAL_DUP = 0.6;
// bge-small cosine of two statements of the same thing; unrelated text in
// one project sits well below.
const VECTOR_DUP = 0.92;

const cosine = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([p.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

// ── anchors ─────────────────────────────────────────────────────────────────

const toRepoPath = (p: string, root: string): string | null => {
  let rel = p.replace(/\\/g, '/');
  if (rel.startsWith('~')) return null;
  if (isAbsolute(p)) {
    const r = relative(root, p);
    if (r.startsWith('..') || isAbsolute(r)) return null;
    rel = r.split(sep).join('/');
  }
  return rel.replace(/^\.\//, '');
};

const resolveFile = (db: SqliteAdapter, path: string): string | null => {
  if (!path || path.endsWith('/')) return null;
  const exact = db
    .prepare(`SELECT id FROM nodes WHERE type = 'file' AND json_extract(data, '$.filePath') = ?`)
    .get(path) as { id: string } | null;
  if (exact) return exact.id;
  // A bare or partial name ("bootstrap.ts", "db/schema.ts"): the one file
  // whose path ends with it, if exactly one does.
  const like = `%/${path.replace(/[\\%_]/g, (c) => `\\${c}`)}`;
  const rows = db
    .prepare(
      `SELECT id FROM nodes WHERE type = 'file' AND json_extract(data, '$.filePath') LIKE ? ESCAPE '\\' LIMIT 2`,
    )
    .all(like) as { id: string }[];
  return rows.length === 1 ? rows[0]!.id : null;
};

const NOT_CODE = `('conversation-waypoint', 'skill', 'cluster', 'file', 'markdown-section', 'declared-dependency')`;

const resolveSymbol = (db: SqliteAdapter, name: string, files: ReadonlySet<string>): string[] => {
  const rows = db
    .prepare(
      `SELECT id, json_extract(data, '$.filePath') AS fp FROM nodes
       WHERE (name = ? OR json_extract(data, '$.qualifiedName') = ?) AND type NOT IN ${NOT_CODE}
       LIMIT 8`,
    )
    .all(name, name) as { id: string; fp: string | null }[];
  if (rows.length <= 2) return rows.map((r) => r.id);
  // Ambiguous: keep the ones in a file the record names, else none.
  return rows.filter((r) => r.fp && files.has(r.fp)).map((r) => r.id);
};

interface ResolvedAnchors {
  refs: string[];
  files: string[];
  symbols: string[];
  keyTerms: string[];
}

const resolveAnchors = (rig: Rig, rec: SettledRecord): ResolvedAnchors => {
  const db = rig.database.adapter;
  const files = [
    ...new Set(
      rec.anchors.files
        .map((f) => toRepoPath(f, rig.projectRoot))
        .filter((f): f is string => !!f)
        .map(redact),
    ),
  ];
  const symbols = [...new Set(rec.anchors.symbols.map(redact))];
  const refs = new Set<string>();
  const filePaths = new Set<string>();
  for (const f of files) {
    const id = resolveFile(db, f);
    if (!id) continue;
    refs.add(id);
    const fp = db
      .prepare(`SELECT json_extract(data, '$.filePath') AS fp FROM nodes WHERE id = ?`)
      .get(id) as { fp: string } | null;
    if (fp) filePaths.add(fp.fp);
  }
  for (const s of symbols) for (const id of resolveSymbol(db, s, filePaths)) refs.add(id);
  return {
    refs: [...refs].slice(0, 12),
    files,
    symbols,
    keyTerms: [...new Set([...symbols, ...[...filePaths].map((p) => p.split('/').at(-1)!)])].slice(
      0,
      10,
    ),
  };
};

// ── dedupe ──────────────────────────────────────────────────────────────────

const findDuplicate = async (
  rig: Rig,
  kind: WaypointKind,
  summary: string,
  probe: () => Promise<Float32Array | null>,
  waitMs: number,
): Promise<string | null> => {
  // Hybrid search (names, keywords and vectors) for the closest stored
  // waypoints of the same kind, then a direct comparison with each.
  const { waypoints } = await rig.searchWaypoints(summary, { kind, limit: 5 }, { waitMs });
  const recent = rig.getWaypoints({ kind, limit: 20 });
  const candidates = new Map<string, WaypointRow>();
  for (const w of [...waypoints, ...recent]) candidates.set(w.id, w);
  for (const w of candidates.values()) {
    if (lexicalSimilarity(summary, w.summary) >= LEXICAL_DUP) return w.id;
  }
  if (!rig.embedder || !waypoints.length) return null;
  const v = await probe();
  if (!v) return null;
  for (const w of waypoints) {
    const stored = getEmbedding(rig.database.adapter, w.id);
    if (stored && sameSubject(summary, w.summary) && cosine(v, stored) >= VECTOR_DUP) return w.id;
  }
  return null;
};

// ── store ───────────────────────────────────────────────────────────────────

export const storeSettled = async (
  rig: Rig,
  records: readonly SettledRecord[],
  opts: StoreOptions,
): Promise<StoreOutcome> => {
  const waitMs = opts.searchWaitMs ?? 1500;
  const provenance = `hook:${opts.client}`;
  const out: StoreOutcome = { stored: [], duplicates: [], skipped: [] };
  for (const raw of records) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) {
      out.skipped.push(raw);
      continue;
    }
    const record: SettledRecord = {
      ...raw,
      summary: redact(raw.summary),
      rationale: redact(raw.rationale),
    };
    const kind = WAYPOINT_KIND_OF[record.kind];
    const title = clip(record.summary, 120);
    const anchors = resolveAnchors(rig, record);
    const probe = async (): Promise<Float32Array | null> => {
      const text = embeddingText({
        id: 'probe',
        kind: 'conversation-waypoint',
        name: title,
        data: { summary: record.summary, key_terms: anchors.keyTerms },
      });
      const vs = await withTimeout(rig.embedder!.embed([text]), waitMs);
      return vs?.[0] ?? null;
    };
    const dup = await findDuplicate(rig, kind, record.summary, probe, waitMs);
    if (dup) {
      out.duplicates.push({ record, of: dup });
      continue;
    }
    const id = rig.writes.dropWaypoint(
      {
        kind,
        title: title.length >= 3 ? title : `${record.kind}: ${title}`,
        summary: record.summary,
        rationale: record.rationale,
        constellationRefs: anchors.refs,
        keyTerms: anchors.keyTerms,
        source: 'hook',
        provenance,
        confidence: record.confidence,
        capture: {
          kind: record.kind,
          cue: record.cue,
          span: record.span,
          files: anchors.files,
          symbols: anchors.symbols,
        },
      },
      { sessionId: opts.sessionId, actor: provenance },
    );
    out.stored.push({ id, kind, record });
  }
  return out;
};
