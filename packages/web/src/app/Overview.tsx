// SPDX-License-Identifier: Apache-2.0
import { RotateCcw, Unlink } from 'lucide-react';
import { Fragment, useEffect, useState, type JSX, type ReactNode } from 'react';
import {
  api,
  absTime,
  relTime,
  type Activity,
  type Orphan,
  type Overview as OverviewData,
  type Status,
} from './api.ts';
import { useToast } from './Toasts.tsx';

// The orientation map (what rig_overview / rig://overview hands an agent at
// the start of a session), the graph's vital signs, orphaned memory, and
// the recent write log with what Undo would revert.

const inline = (text: string, onCode: (code: string) => void): ReactNode[] =>
  text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
      <code
        key={i}
        onClick={() => onCode(part.slice(1, -1))}
        style={{ cursor: 'pointer' }}
        title="Search for this"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );

// Just enough markdown for the orientation map: headings, two levels of
// bullets, paragraphs and inline code.
export function MapDoc({
  md,
  onCode,
}: {
  md: string;
  onCode: (code: string) => void;
}): JSX.Element {
  const out: ReactNode[] = [];
  let list: { text: string; sub: string[] }[] | null = null;
  const flush = (): void => {
    if (!list) return;
    out.push(
      <ul key={out.length}>
        {list.map((li, i) => (
          <li key={i}>
            {inline(li.text, onCode)}
            {li.sub.length > 0 && (
              <ul>
                {li.sub.map((s, j) => (
                  <li key={j}>{inline(s, onCode)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>,
    );
    list = null;
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (/^#\s/.test(line)) {
      flush();
      out.push(<h1 key={out.length}>{line.slice(2)}</h1>);
    } else if (/^##+\s/.test(line)) {
      flush();
      out.push(<h2 key={out.length}>{line.replace(/^##+\s/, '')}</h2>);
    } else if (/^\s{2,}[-*]\s/.test(line) && list && list.length) {
      list[list.length - 1]!.sub.push(line.replace(/^\s+[-*]\s/, ''));
    } else if (/^[-*]\s/.test(line)) {
      list ??= [];
      list.push({ text: line.slice(2), sub: [] });
    } else if (line.trim()) {
      flush();
      out.push(<p key={out.length}>{inline(line, onCode)}</p>);
    } else flush();
  }
  flush();
  return <>{out}</>;
}

const REASON: Record<string, string> = {
  'symbol-removed': 'symbol removed',
  'file-deleted': 'file deleted',
  'endpoint-missing': 'endpoint missing',
  'import-unmatched': 'not in this graph',
};

const describe = (kind: string, payload: unknown): string => {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (kind) {
    case 'propose_edge':
      return `proposed link #${String(p.pendingId ?? '')}`;
    case 'accept_edge':
      return `accepted link #${String(p.pendingId ?? '')}`;
    case 'reject_edge':
      return `rejected link #${String(p.pendingId ?? '')}`;
    case 'drop_waypoint':
      return `waypoint “${String(p.title ?? '')}”`;
    case 'annotate':
      return 'added a note';
    case 'undo':
      return `undid ${String(p.undoneKind ?? '').replace('_', ' ')}`;
    case 'add_alias':
      return `alias “${String(p.alias ?? '')}”`;
    case 'promote_hub':
      return 'promoted a hub';
    default:
      return kind.replace('_', ' ');
  }
};

export function Overview({
  status,
  pending,
  waypoints,
  version,
  onSearch,
}: {
  status: Status | null;
  pending: number;
  waypoints: number | null;
  version: number;
  onSearch: (q: string) => void;
}): JSX.Element {
  const [doc, setDoc] = useState<OverviewData | null>(null);
  const [docErr, setDocErr] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<Orphan[] | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    api
      .overview()
      .then((d) => !cancelled && (setDoc(d), setDocErr(null)))
      .catch((e: unknown) => !cancelled && setDocErr(e instanceof Error ? e.message : String(e)));
    api
      .orphans()
      .then((d) => !cancelled && setOrphans(d.orphans))
      .catch(() => !cancelled && setOrphans([]));
    api
      .activity()
      .then((d) => !cancelled && setActivity(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [version]);

  const tiles: { label: string; value: string; hint: string; tone?: string }[] = status
    ? [
        {
          label: 'Nodes',
          value: status.nodes.toLocaleString(),
          hint: `${status.files.toLocaleString()} files`,
        },
        {
          label: 'Links',
          value: (status.edges_structural + status.edges_semantic).toLocaleString(),
          hint: `${status.edges_semantic.toLocaleString()} accepted by you`,
        },
        {
          label: 'Pending review',
          value: pending.toLocaleString(),
          hint: pending ? 'proposals waiting' : 'all caught up',
        },
        {
          label: 'Waypoints',
          value: waypoints === null ? '…' : waypoints.toLocaleString(),
          hint: 'agent decisions and notes',
        },
        {
          label: 'Orphaned memory',
          value: (status.orphans ?? 0).toLocaleString(),
          hint: 'waiting to re-attach',
        },
        {
          label: 'Last sync',
          value: relTime(status.last_sync_ts),
          hint: status.last_sync_ts ? absTime(status.last_sync_ts) : 'run rig index',
        },
      ]
    : [];

  return (
    <div className="overview">
      <div className="overview-main">
        <div style={{ padding: '22px 26px 0' }}>
          <div className="tiles">
            {status
              ? tiles.map((t) => (
                  <div key={t.label} className="tile panel">
                    <div className="eyebrow">{t.label}</div>
                    <div className="v">{t.value}</div>
                    <div className="h truncate" title={t.hint}>
                      {t.hint}
                    </div>
                  </div>
                ))
              : [0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="skeleton" style={{ height: 82 }} />
                ))}
          </div>
        </div>
        <article className="doc" aria-label="Orientation map">
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Orientation map{' '}
            {doc
              ? `· ${doc.est_tokens.toLocaleString()} tokens · generated ${relTime(doc.generated_at)}`
              : ''}
          </div>
          {docErr && (
            <div className="banner banner-danger" role="alert">
              {docErr}
            </div>
          )}
          {!doc && !docErr && (
            <div style={{ display: 'grid', gap: 8 }}>
              {[70, 92, 60, 85, 40].map((w, i) => (
                <div key={i} className="skeleton" style={{ height: 14, width: `${w}%` }} />
              ))}
            </div>
          )}
          {doc && <MapDoc md={doc.map} onCode={onSearch} />}
        </article>
      </div>
      <aside className="overview-side" aria-label="Memory health">
        <div className="section">
          <div className="section-head">
            <span className="eyebrow">Orphaned memory</span>
            {orphans && orphans.length > 0 && (
              <span className="badge badge-warning">{orphans.length}</span>
            )}
          </div>
          <p className="quiet" style={{ fontSize: 'var(--t-xs)', marginBottom: 8 }}>
            Notes, aliases and links whose symbol was deleted. They re-attach when a symbol with the
            same name comes back in that file.
          </p>
          {orphans === null && <div className="skeleton" style={{ height: 60 }} />}
          {orphans?.length === 0 && (
            <p className="quiet">None. Every piece of agent memory is attached.</p>
          )}
          <div style={{ display: 'grid', gap: 6 }}>
            {orphans?.map((o) => (
              <div key={o.id} className="note">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <Unlink
                    size={13}
                    aria-hidden
                    style={{ color: 'var(--warning-text)', flex: 'none' }}
                  />
                  <span className="truncate" style={{ fontWeight: 550 }}>
                    {o.name}
                  </span>
                  <span className="badge" style={{ marginLeft: 'auto' }}>
                    {REASON[o.reason] ?? o.reason}
                  </span>
                </div>
                <div className="mono quiet truncate" style={{ fontSize: 10.5, marginTop: 3 }}>
                  {o.kind} · {o.file_path}
                </div>
                {o.notes.map((n, i) => (
                  <div
                    key={i}
                    style={{ marginTop: 5, color: 'var(--text-2)', fontSize: 'var(--t-xs)' }}
                  >
                    “{n}”
                  </div>
                ))}
                <div className="note-meta">
                  {[
                    o.memory.annotations &&
                      `${o.memory.annotations} note${o.memory.annotations === 1 ? '' : 's'}`,
                    o.memory.aliases &&
                      `${o.memory.aliases} alias${o.memory.aliases === 1 ? '' : 'es'}`,
                    o.memory.edges && `${o.memory.edges} link${o.memory.edges === 1 ? '' : 's'}`,
                    o.memory.pending_edges &&
                      `${o.memory.pending_edges} proposal${o.memory.pending_edges === 1 ? '' : 's'}`,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'no memory'}{' '}
                  · orphaned {relTime(o.orphaned_at)}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="section">
          <div className="section-head">
            <span className="eyebrow">Recent writes</span>
            <button
              className="btn btn-sm btn-outline"
              disabled={!activity?.next_undo}
              title={
                activity?.next_undo
                  ? `Undo ${describe(activity.next_undo.kind, activity.next_undo.payload)}`
                  : 'Nothing the map did can be undone'
              }
              onClick={() =>
                void api.undo().then(
                  (r) =>
                    r.undone
                      ? toast({
                          tone: 'info',
                          title: 'Undone',
                          detail: r.undone.kind.replace('_', ' '),
                        })
                      : toast({ tone: 'warning', title: 'Nothing undone', detail: r.reason ?? '' }),
                  (e: unknown) =>
                    toast({ tone: 'danger', title: "Couldn't undo", detail: String(e) }),
                )
              }
            >
              <RotateCcw /> Undo
            </button>
          </div>
          {activity?.next_undo && (
            <p className="quiet" style={{ fontSize: 'var(--t-xs)', marginBottom: 8 }}>
              Undo reverts the map's last write:{' '}
              {describe(activity.next_undo.kind, activity.next_undo.payload)},{' '}
              {relTime(activity.next_undo.ts)}.
            </p>
          )}
          {!activity && <div className="skeleton" style={{ height: 80 }} />}
          {activity?.items.length === 0 && <p className="quiet">No writes yet.</p>}
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 1 }}>
            {activity?.items.map((m) => (
              <li
                key={m.id}
                style={{
                  display: 'flex',
                  gap: 8,
                  minWidth: 0,
                  padding: '5px 0',
                  fontSize: 'var(--t-xs)',
                  opacity: m.undone ? 0.55 : 1,
                }}
              >
                <span className="mono quiet" style={{ minWidth: 64 }} title={absTime(m.ts)}>
                  {relTime(m.ts)}
                </span>
                <span
                  className="truncate"
                  style={{ flex: 1, textDecoration: m.undone ? 'line-through' : undefined }}
                >
                  {describe(m.kind, m.payload)}
                </span>
                <span className="mono quiet truncate" style={{ maxWidth: 110 }}>
                  {m.actor}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </div>
  );
}
