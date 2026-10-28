// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { SqliteAdapter } from '../db/adapter.ts';
import { getEmbeddingFingerprint, upsertEmbedding } from '../db/embed-queries.ts';
import { splitIdentifier } from '../search/query.ts';
import type { Embedder } from './types.ts';

// What embedding needs of a node: its kind and name, and the fields of its
// data (an extracted node's own fields, or a stored row's parsed data JSON).
export interface EmbeddableNode {
  id: string;
  kind: string;
  name: string;
  data: Readonly<Record<string, unknown>>;
}

// Agent-written kinds that are embedded alongside extracted nodes.
export const EMBEDDED_AGENT_KINDS: readonly string[] = ['conversation-waypoint', 'skill'];

type Family = 'code' | 'markdown' | 'waypoint' | 'skill';

const familyOf = (kind: string): Family =>
  kind === 'markdown-section'
    ? 'markdown'
    : kind === 'conversation-waypoint'
      ? 'waypoint'
      : kind === 'skill'
        ? 'skill'
        : 'code';

// The version of each family's embedding text. Stored text hashes carry it
// as a prefix ("c2:…"), so bumping one re-embeds exactly that family's nodes:
// the update pipeline treats a hash without the current prefix as missing
// (STALE_EMBEDDING_SQL). Bump it whenever embeddingText changes for a family.
// Hashes written before versioning have no prefix and are all stale.
export const TEXT_VERSIONS: Readonly<Record<Family, string>> = {
  code: 'c2',
  markdown: 'm2',
  waypoint: 'w1',
  skill: 's1',
};

// SQL (on aliases n, e): the node's embedding was computed from an older
// version of its family's text.
export const STALE_EMBEDDING_SQL = `e.text_hash NOT LIKE (CASE n.type
    WHEN 'markdown-section' THEN '${TEXT_VERSIONS.markdown}:%'
    WHEN 'conversation-waypoint' THEN '${TEXT_VERSIONS.waypoint}:%'
    WHEN 'skill' THEN '${TEXT_VERSIONS.skill}:%'
    ELSE '${TEXT_VERSIONS.code}:%' END)`;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// The text a node is embedded from: the fields that make it semantically
// distinct, empty ones dropped. Identifiers are also given as words
// ("refreshExpiredSessions" → "refresh expired sessions"): the model's
// vocabulary is English, and a split name lands much nearer a question about
// it (rig's own eval: MRR 0.41 → 0.50 for vector search).
export const embeddingText = (node: EmbeddableNode): string => {
  const d = node.data;
  const words = (s: string): string => splitIdentifier(s).join(' ');
  let parts: string[];
  switch (familyOf(node.kind)) {
    case 'waypoint': {
      const terms = Array.isArray(d.key_terms)
        ? d.key_terms.filter((t) => typeof t === 'string')
        : [];
      parts = [node.name, str(d.summary), terms.join(', '), str(d.rationale)];
      break;
    }
    case 'skill':
      parts = [words(node.name), node.name, str(d.description)];
      break;
    case 'markdown': {
      const qn = str(d.qualifiedName);
      parts = [node.name, qn !== node.name ? qn : '', str(d.excerpt)];
      break;
    }
    default: {
      const qn = str(d.qualifiedName) || node.name;
      parts = [
        words(node.name),
        node.name,
        qn !== node.name ? qn : '',
        str(d.signature),
        str(d.docstring),
      ];
    }
  }
  return parts.filter((p) => p.length > 0).join('\n');
};

export const embeddingHash = (node: EmbeddableNode, text: string): string =>
  `${TEXT_VERSIONS[familyOf(node.kind)]}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;

// An extracted node as an EmbeddableNode (its fields are its data).
export const embeddableOf = (n: { id: string; kind: string; name: string }): EmbeddableNode => ({
  id: n.id,
  kind: n.kind,
  name: n.name,
  data: n as unknown as Record<string, unknown>,
});

export interface EmbedResult {
  embedded: number;
  skipped: number;
  durationMs: number;
}

// Nodes are embedded and stored this many at a time, so a long run (the
// re-embed after a text version bump) keeps what it finished if it stops.
const CHUNK = 128;

// Batch-embed and upsert. Skips nodes whose embedding text hash matches the
// existing row (same model + same content) — re-running `rig index --force`
// on an unchanged repo now becomes O(0) instead of O(N) on the bge inference.
export async function embedAndStore(
  embedder: Embedder,
  adapter: SqliteAdapter,
  nodes: readonly EmbeddableNode[],
): Promise<EmbedResult> {
  const start = Date.now();
  if (nodes.length === 0) return { embedded: 0, skipped: 0, durationMs: 0 };

  const toEmbed: { node: EmbeddableNode; text: string; hash: string }[] = [];
  for (const node of nodes) {
    const text = embeddingText(node);
    const hash = embeddingHash(node, text);
    const fp = getEmbeddingFingerprint(adapter, node.id);
    if (fp && fp.model === embedder.model && fp.text_hash === hash) continue;
    toEmbed.push({ node, text, hash });
  }

  let embedded = 0;
  for (let i = 0; i < toEmbed.length; i += CHUNK) {
    const chunk = toEmbed.slice(i, i + CHUNK);
    const vectors = await embedder.embed(chunk.map((e) => e.text));
    if (!adapter.open) break;
    adapter.transaction(() => {
      const exists = adapter.prepare(`SELECT 1 AS x FROM nodes WHERE id = ?`);
      for (let j = 0; j < chunk.length; j++) {
        const { node, hash } = chunk[j]!;
        const vector = vectors[j];
        // The node may have been deleted while the model ran.
        if (!vector || !exists.get(node.id)) continue;
        upsertEmbedding(adapter, node.id, embedder.model, vector, hash);
        embedded++;
      }
    })();
  }
  return {
    embedded,
    skipped: nodes.length - toEmbed.length,
    durationMs: Date.now() - start,
  };
}
