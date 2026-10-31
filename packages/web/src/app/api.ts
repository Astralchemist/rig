// SPDX-License-Identifier: Apache-2.0
// Typed client for the map's REST surface. Every call throws ApiError with
// the server's message on a non-2xx, so views can show what failed.

export interface Status {
  initialized: boolean;
  nodes: number;
  edges_structural: number;
  edges_semantic: number;
  files: number;
  last_sync_ts: number | null;
  last_index_ts?: number | null;
  orphans?: number;
}

export interface SnapshotNode {
  id: string;
  type: string;
  name: string;
  pull_score: number;
  is_hub?: number;
  hubness?: number;
  community_id?: number;
  file_path?: string | null;
}

export interface SnapshotPending {
  id: number;
  src: string;
  dst: string;
  kind: string;
  weight: number;
  rationale: string;
  provenance: string;
}

export interface BlueprintBox {
  id: string;
  label: string;
  kind: 'package' | 'store' | 'external' | 'io';
  detail?: string;
  evidence?: string;
  inferred: boolean;
}

export interface Blueprint {
  level: 'site' | 'floor';
  commit: string | null;
  boxes: BlueprintBox[];
  edges: { from: string; to: string; weight: number; inferred: boolean }[];
  folded: string[];
}

export interface Snapshot {
  nodes: SnapshotNode[];
  edges_structural: Array<{ src: string; dst: string; kind: string }>;
  edges_semantic: Array<{
    src: string;
    dst: string;
    weight: number;
    kind?: string;
    source_urls?: string[];
  }>;
  pending_edges: SnapshotPending[];
}

export interface NodeCard {
  id: string;
  kind: string;
  name: string;
  file: string | null;
  line: number | null;
  signature: string | null;
  is_hub: boolean;
  hubness: number;
  annotations: number;
  waypoints: number;
  orphans: number;
}

export interface ViewEdge {
  src: string;
  dst: string;
  kind: string;
  table: 'structural' | 'semantic' | 'pending';
  weight?: number;
  source_urls?: string[];
  pending_id?: number;
}

export interface Annotation {
  id: number;
  node_id: string;
  note: string;
  ts: number;
  actor: string;
  rationale: string | null;
}

export interface NodeDetail {
  id: string;
  type: string;
  name: string;
  data: Record<string, unknown>;
  neighbor_counts: Record<string, number>;
  card?: NodeCard | null;
  annotations?: Annotation[];
  aliases?: { alias: string; provenance: string }[];
}

export interface Neighborhood {
  center: NodeCard;
  nodes: NodeCard[];
  edges: ViewEdge[];
  truncated: number;
}

export interface ImpactTree {
  root: NodeCard;
  nodes: (NodeCard & { depth: number })[];
  edges: { src: string; dst: string; kind: string }[];
  truncated: boolean;
}

export interface CriticalStep {
  id: string;
  name: string;
  type: string;
  hubness: number;
  activation_count: number;
  step_weight: number;
  card: NodeCard | null;
}

export interface PullEntry {
  nodeId: string;
  score: number;
  components: { structural: number; semantic: number; recency: number };
}

export interface PendingEdge {
  id: number;
  src: string;
  dst: string;
  kind: string;
  weight: number;
  provenance: string;
  rationale: string;
  proposed_at: number;
  session_id: string;
  status: 'pending' | 'accepted' | 'rejected';
  source_urls: string[];
}

export type WaypointKind =
  | 'decision'
  | 'observation'
  | 'constraint'
  | 'open-question'
  | 'principle';
export const WAYPOINT_KINDS: WaypointKind[] = [
  'decision',
  'observation',
  'constraint',
  'open-question',
  'principle',
];

export interface Waypoint {
  id: string;
  ts: number;
  session_id: string;
  kind: WaypointKind;
  title: string;
  summary: string;
  analogy: string | null;
  constellation_refs: string[];
  predecessors: string[];
  key_terms: string[];
  rationale?: string;
}

export interface WaypointDetail {
  waypoint: Waypoint;
  chain: Waypoint[];
  refs: NodeCard[];
}

export interface Orphan {
  id: number;
  node_id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  reason: string;
  orphaned_at: number;
  memory: { annotations: number; aliases: number; edges: number; pending_edges: number };
  notes: string[];
}

export interface Overview {
  map: string;
  generated_at: number;
  nodes: number;
  budget: number;
  est_tokens: number;
  cached: boolean;
}

export interface Activity {
  next_undo: { id: number; ts: number; kind: string; payload: unknown } | null;
  items: {
    id: number;
    ts: number;
    session_id: string;
    kind: string;
    actor: string;
    payload: unknown;
    undone: boolean;
  }[];
}

export interface SearchHit {
  id: string;
  name: string;
  type: string;
  data?: { filePath?: string; startLine?: number };
  score?: number;
  matched_by?: string[];
}

export type SearchMode = 'hybrid' | 'keyword-only' | 'keyword-fallback' | 'keyword' | null;

export interface UndoResult {
  undone: { id: number; kind: string; ts: number } | null;
  reason?: string;
  failed?: { id: number; kind: string; ts: number };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'The map server is not reachable. Is `rig start` still running?');
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
};

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });

const enc = encodeURIComponent;

export const api = {
  status: () => request<Status>('/api/status'),
  graph: (limit: number) => request<Snapshot>(`/api/graph?limit=${limit}`),
  node: (id: string) => request<NodeDetail>(`/api/node/${enc(id)}`),
  neighborhood: (id: string, limit = 40) =>
    request<Neighborhood>(`/api/node/${enc(id)}/neighborhood?limit=${limit}`),
  impact: (id: string, depth = 3) =>
    request<ImpactTree>(`/api/node/${enc(id)}/impact?depth=${depth}`),
  criticalPath: (id: string) =>
    request<{ path: CriticalStep[] }>(`/api/node/${enc(id)}/critical-path`),
  pull: (id: string, k = 6) => request<PullEntry[]>(`/api/node/${enc(id)}/pull?k=${k}`),
  cards: (ids: string[]) =>
    ids.length === 0
      ? Promise.resolve([] as NodeCard[])
      : request<NodeCard[]>(`/api/cards?ids=${ids.map(enc).join(',')}`),
  pending: () => request<PendingEdge[]>('/api/pending-edges'),
  accept: (id: number) => post<{ ok: true }>(`/api/pending-edges/${id}/accept`),
  reject: (id: number) => post<{ ok: true }>(`/api/pending-edges/${id}/reject`),
  undo: () => post<UndoResult>('/api/undo'),
  select: (id: string | null) => post<{ ok: true }>('/api/selection', { node_id: id }),
  overview: () => request<Overview>('/api/overview'),
  blueprint: (level: 'site' | 'floor') => request<Blueprint>(`/api/blueprint?level=${level}`),
  blueprintMermaid: async (level: 'site' | 'floor'): Promise<string> => {
    const res = await fetch(`/api/blueprint?level=${level}&format=mermaid`);
    if (!res.ok) throw new Error(`blueprint: HTTP ${res.status}`);
    return res.text();
  },
  waypoints: (q: { kind?: string; q?: string }) => {
    const p = new URLSearchParams();
    if (q.kind) p.set('kind', q.kind);
    if (q.q) p.set('q', q.q);
    return request<{ waypoints: Waypoint[]; degraded?: string }>(`/api/waypoints?${p}`);
  },
  waypoint: (id: string) => request<WaypointDetail>(`/api/waypoints/${enc(id)}`),
  orphans: () => request<{ orphans: Orphan[] }>('/api/orphans'),
  activity: () => request<Activity>('/api/activity?limit=25'),
  config: () => request<{ name?: string; theme?: string; density?: number }>('/api/config'),
  saveConfig: (patch: Record<string, unknown>) =>
    request<Record<string, unknown>>('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  search: async (q: string, limit = 12): Promise<{ hits: SearchHit[]; mode: SearchMode }> => {
    const res = await fetch(`/api/search?q=${enc(q)}&limit=${limit}`);
    if (!res.ok) throw new ApiError(res.status, `${res.status}`);
    return {
      hits: (await res.json()) as SearchHit[],
      mode: res.headers.get('x-rig-search') as SearchMode,
    };
  },
};

export const relTime = (ts: number | null | undefined): string => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
};

export const absTime = (ts: number): string => new Date(ts).toLocaleString();
