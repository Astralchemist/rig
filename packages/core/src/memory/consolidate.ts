// SPDX-License-Identifier: Apache-2.0
// Consolidation (research roadmap step 5, first version): near-duplicate
// memories become one lesson that points at its sources.
//
// Additive, never a summary that throws the originals away: the lesson is a
// new waypoint (`sources` lists what it merged, and it succeeds them in the
// chain), and each merged record stays in the graph, marked
// `consolidated_into` and hidden from listings and the session brief. No
// model call: records cluster when they are the same kind, say nearly the
// same thing (lexical similarity, as capture's dedupe uses) and share an
// anchor, or say almost exactly the same thing with no anchors at all.
import { lexicalSimilarity } from '../capture/store.ts';
import type { WaypointRow } from '../db/waypoint-queries.ts';
import type { Rig } from '../rig.ts';

export const SIMILAR = 0.6;
export const SIMILAR_UNANCHORED = 0.8;

export interface Cluster {
  kind: string;
  members: WaypointRow[];
}

const textOf = (w: WaypointRow): string => `${w.title}. ${w.summary}`;

/** Groups of two or more near-duplicate records (newest first within each). */
export const findClusters = (rig: Rig): Cluster[] => {
  const all = rig.getWaypoints({ limit: Number.MAX_SAFE_INTEGER });
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const w of all) parent.set(w.id, w.id);
  const byKind = new Map<string, WaypointRow[]>();
  for (const w of all) {
    const list = byKind.get(w.kind);
    if (list) list.push(w);
    else byKind.set(w.kind, [w]);
  }
  for (const list of byKind.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const shared = a.constellation_refs.some((r) => b.constellation_refs.includes(r));
        const bothBare = !a.constellation_refs.length && !b.constellation_refs.length;
        if (!shared && !bothBare) continue;
        const sim = lexicalSimilarity(textOf(a), textOf(b));
        if (sim >= (shared ? SIMILAR : SIMILAR_UNANCHORED)) parent.set(find(a.id), find(b.id));
      }
  const groups = new Map<string, WaypointRow[]>();
  for (const w of all) {
    const r = find(w.id);
    const g = groups.get(r);
    if (g) g.push(w);
    else groups.set(r, [w]);
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => ({ kind: g[0]!.kind, members: g.sort((x, y) => y.ts - x.ts) }));
};

const day = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/**
 * Merge each cluster into a lesson. With `apply: false` nothing is written;
 * the result says what would be merged.
 */
export const consolidate = (
  rig: Rig,
  opts: { apply?: boolean; sessionId?: string } = {},
): { lessons: { id: string | null; title: string; sources: string[] }[] } => {
  const out: { id: string | null; title: string; sources: string[] }[] = [];
  for (const c of findClusters(rig)) {
    const newest = c.members[0]!;
    const oldest = c.members[c.members.length - 1]!;
    const sources = c.members.map((m) => m.id);
    if (!opts.apply) {
      out.push({ id: null, title: newest.title, sources });
      continue;
    }
    const refs = [...new Set(c.members.flatMap((m) => m.constellation_refs))];
    const terms = [...new Set(c.members.flatMap((m) => m.key_terms))].slice(0, 12);
    const id = rig.writes.dropWaypoint(
      {
        kind: c.kind as never,
        title: newest.title,
        summary: `${newest.summary} (Recorded ${c.members.length} times, ${day(oldest.ts)} to ${day(newest.ts)}.)`,
        constellationRefs: refs,
        predecessors: sources,
        keyTerms: terms,
        rationale:
          newest.rationale ?? `Consolidated from ${c.members.length} near-duplicate records.`,
        source: 'agent',
        provenance: 'consolidation',
      },
      { sessionId: opts.sessionId ?? 'consolidation', actor: 'consolidation' },
    );
    const db = rig.database.adapter;
    db.transaction(() => {
      db.prepare(`UPDATE nodes SET data = json_set(data, '$.sources', json(?)) WHERE id = ?`).run(
        JSON.stringify(sources),
        id,
      );
      const mark = db.prepare(
        `UPDATE nodes SET data = json_set(data, '$.consolidated_into', ?) WHERE id = ?`,
      );
      for (const s of sources) mark.run(id, s);
    })();
    out.push({ id, title: newest.title, sources });
  }
  return { lessons: out };
};
