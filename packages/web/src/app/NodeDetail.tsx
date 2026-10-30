// SPDX-License-Identifier: Apache-2.0
import {
  Check,
  Copy,
  ExternalLink,
  GitFork,
  Network,
  StickyNote,
  Waypoints as WaypointsIcon,
  X,
  Zap,
  Unlink,
} from 'lucide-react';
import { useEffect, useState, type JSX } from 'react';
import {
  api,
  relTime,
  absTime,
  type Neighborhood,
  type NodeCard,
  type NodeDetail as Detail,
  type PullEntry,
} from './api.ts';
import { groupOf, kindLabel } from './kinds.ts';
import { useToast } from './Toasts.tsx';

// The inspector: everything Rig knows about one node, in one panel. Docked
// right on wide screens, a bottom sheet on narrow ones.

export interface NodeDetailProps {
  id: string;
  // Bumped by the parent when the graph changes, to refetch.
  version: number;
  onClose: () => void;
  onJump: (id: string) => void;
  onOpenView: (view: 'focus' | 'impact') => void;
  onOpenWaypoint: (id: string) => void;
  onReview: (pendingId: number) => void;
}

export function Glyph({ kind }: { kind: string }): JSX.Element {
  const g = groupOf(kind);
  return (
    <span
      className="glyph"
      aria-hidden
      data-shape={g.shape}
      style={{ ['--g' as string]: `var(${g.cssVar})` }}
    />
  );
}

export function CardBadges({ card }: { card: NodeCard }): JSX.Element {
  return (
    <>
      {card.is_hub && (
        <span className="badge" title={`Hubness ${card.hubness.toFixed(2)}`}>
          <Zap aria-hidden /> Hub
        </span>
      )}
      {card.annotations > 0 && (
        <span className="badge badge-accent" title="Agent notes on this node">
          <StickyNote aria-hidden /> {card.annotations} note{card.annotations === 1 ? '' : 's'}
        </span>
      )}
      {card.waypoints > 0 && (
        <span className="badge" title="Waypoints anchored here">
          <WaypointsIcon aria-hidden /> {card.waypoints} waypoint{card.waypoints === 1 ? '' : 's'}
        </span>
      )}
      {card.orphans > 0 && (
        <span
          className="badge badge-warning"
          title="Memory of deleted symbols in this file, waiting to re-attach"
        >
          <Unlink aria-hidden /> {card.orphans} orphaned
        </span>
      )}
    </>
  );
}

export const locOf = (c: { file: string | null; line: number | null }): string | null =>
  c.file ? (c.line ? `${c.file}:${c.line}` : c.file) : null;

export function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn btn-sm btn-ghost icon-btn"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check /> : <Copy />}
    </button>
  );
}

export function NodeDetail({
  id,
  version,
  onClose,
  onJump,
  onOpenView,
  onOpenWaypoint,
  onReview,
}: NodeDetailProps): JSX.Element {
  const [node, setNode] = useState<Detail | null>(null);
  const [hood, setHood] = useState<Neighborhood | null>(null);
  const [pull, setPull] = useState<{ entry: PullEntry; card: NodeCard }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    if (version === 0) {
      setNode(null);
      setHood(null);
      setPull([]);
    }
    Promise.all([api.node(id), api.neighborhood(id, 60), api.pull(id, 6)])
      .then(async ([n, h, p]) => {
        const cards = await api.cards(p.map((x) => x.nodeId));
        if (cancelled) return;
        const byId = new Map(cards.map((c) => [c.id, c]));
        setNode(n);
        setHood(h);
        setPull(
          p.flatMap((entry) =>
            byId.has(entry.nodeId) ? [{ entry, card: byId.get(entry.nodeId)! }] : [],
          ),
        );
      })
      .catch((e: unknown) => !cancelled && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [id, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.palette, .menu')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const card = node?.card ?? hood?.center ?? null;
  const names = new Map((hood?.nodes ?? []).map((c) => [c.id, c]));
  const other = (e: { src: string; dst: string }): NodeCard | undefined =>
    names.get(e.src === id ? e.dst : e.src);
  const accepted = (hood?.edges ?? []).filter((e) => e.table === 'semantic');
  const pending = (hood?.edges ?? []).filter((e) => e.table === 'pending');
  const waypoints = (hood?.nodes ?? []).filter((c) => c.kind === 'conversation-waypoint');
  const counts = Object.entries(node?.neighbor_counts ?? {}).sort((a, b) => b[1] - a[1]);
  const maxPull = Math.max(0.0001, ...pull.map((p) => p.entry.score));

  const decide = async (pid: number, verb: 'accept' | 'reject'): Promise<void> => {
    try {
      await (verb === 'accept' ? api.accept(pid) : api.reject(pid));
      toast({
        tone: 'success',
        title: verb === 'accept' ? 'Link accepted' : 'Proposal rejected',
        action: { label: 'Undo', run: () => void api.undo() },
      });
    } catch (e) {
      toast({
        tone: 'danger',
        title: `Couldn't ${verb}`,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <aside className="inspector" aria-label="Node details" data-testid="inspector">
      <div className="inspector-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {card ? (
            <Glyph kind={card.kind} />
          ) : (
            <span className="skeleton" style={{ width: 10, height: 10 }} />
          )}
          <span className="eyebrow">{card ? kindLabel(card.kind) : 'Loading'}</span>
          <span style={{ flex: 1 }} />
          <CopyButton text={id} label="Copy node id" />
          <button
            className="btn btn-sm btn-ghost icon-btn"
            aria-label="Close details"
            title="Close (Esc)"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        {card ? (
          <h2 style={{ marginTop: 6, wordBreak: 'break-word' }}>{card.name}</h2>
        ) : (
          <div className="skeleton" style={{ height: 22, width: '60%', marginTop: 8 }} />
        )}
        {card && locOf(card) && (
          <div
            className="mono quiet truncate"
            style={{ marginTop: 3, fontSize: 11 }}
            title={locOf(card)!}
          >
            {locOf(card)}
          </div>
        )}
        {card && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10 }}>
            <CardBadges card={card} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <button className="btn btn-sm btn-outline" onClick={() => onOpenView('focus')}>
            <Network /> Neighbourhood
          </button>
          <button className="btn btn-sm btn-outline" onClick={() => onOpenView('impact')}>
            <GitFork /> Impact
          </button>
        </div>
      </div>
      <div className="inspector-body">
        {err && (
          <div className="section">
            <div className="banner banner-danger" role="alert">
              {err}
            </div>
          </div>
        )}
        {card?.signature && (
          <div className="section">
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              Signature
            </div>
            <pre className="code">{card.signature}</pre>
          </div>
        )}
        {pending.length > 0 && (
          <div className="section">
            <div className="section-head">
              <span className="eyebrow">Pending review</span>
              <span className="badge badge-warning">{pending.length}</span>
            </div>
            {pending.map((e) => (
              <div key={e.pending_id} style={{ display: 'grid', gap: 6, padding: '8px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span className="mono badge badge-warning">{e.kind}</span>
                  <span className="quiet">{e.src === id ? 'to' : 'from'}</span>
                  <button
                    className="btn btn-sm btn-ghost truncate"
                    style={{ padding: '0 4px' }}
                    onClick={() => onJump(other(e)?.id ?? e.src)}
                  >
                    {other(e)?.name ?? '…'}
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void decide(e.pending_id!, 'accept')}
                  >
                    Accept
                  </button>
                  <button
                    className="btn btn-sm btn-outline"
                    onClick={() => void decide(e.pending_id!, 'reject')}
                  >
                    Reject
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => onReview(e.pending_id!)}>
                    Review
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {(node?.annotations?.length ?? 0) > 0 && (
          <div className="section">
            <div className="section-head">
              <span className="eyebrow">Notes</span>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {node!.annotations!.map((a) => (
                <div key={a.id} className="note">
                  {a.note}
                  <div className="note-meta" title={absTime(a.ts)}>
                    {a.actor} · {relTime(a.ts)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {accepted.length > 0 && (
          <div className="section">
            <div className="section-head">
              <span className="eyebrow">Accepted links</span>
            </div>
            {accepted.map((e, i) => (
              <div key={i} style={{ padding: '5px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span className="mono badge">{e.kind}</span>
                  <span className="quiet">{e.src === id ? 'to' : 'from'}</span>
                  <button
                    className="btn btn-sm btn-ghost truncate"
                    style={{ padding: '0 4px' }}
                    onClick={() => onJump(other(e)?.id ?? e.src)}
                  >
                    {other(e)?.name ?? '…'}
                  </button>
                  {e.weight !== undefined && (
                    <span className="quiet num" style={{ marginLeft: 'auto', fontSize: 11 }}>
                      {e.weight.toFixed(2)}
                    </span>
                  )}
                </div>
                {(e.source_urls ?? []).map((u) => (
                  <a
                    key={u}
                    className="url truncate"
                    href={u}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <ExternalLink aria-hidden /> <span className="truncate">{u}</span>
                  </a>
                ))}
              </div>
            ))}
          </div>
        )}
        {waypoints.length > 0 && (
          <div className="section">
            <div className="section-head">
              <span className="eyebrow">Waypoints here</span>
            </div>
            {waypoints.map((w) => (
              <button key={w.id} className="row" onClick={() => onOpenWaypoint(w.id)}>
                <Glyph kind={w.kind} />
                <span className="truncate">{w.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="section">
          <div className="section-head">
            <span className="eyebrow">Links by kind</span>
          </div>
          {node ? (
            counts.length ? (
              <dl className="kv">
                {counts.map(([k, c]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt className="mono">{k}</dt>
                    <dd>{c}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="quiet">No links.</p>
            )
          ) : (
            <div className="skeleton" style={{ height: 48 }} />
          )}
        </div>
        <div className="section">
          <div className="section-head">
            <span className="eyebrow">Magnetic pull</span>
            <span className="quiet" style={{ fontSize: 11 }}>
              what an agent reaches for next
            </span>
          </div>
          {pull.length === 0 && node && <p className="quiet">Nothing nearby.</p>}
          <div style={{ display: 'grid', gap: 2 }}>
            {pull.map(({ entry, card: c }) => (
              <button
                key={entry.nodeId}
                className="row bar-row"
                onClick={() => onJump(entry.nodeId)}
                title={`structural ${entry.components.structural.toFixed(2)} · semantic ${entry.components.semantic.toFixed(2)} · recency ${entry.components.recency.toFixed(2)}`}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <Glyph kind={c.kind} />
                  <span className="truncate">{c.name}</span>
                </span>
                <span className="bar" aria-hidden>
                  <i style={{ width: `${(entry.score / maxPull) * 100}%` }} />
                </span>
                <span className="num quiet" style={{ fontSize: 11, textAlign: 'right' }}>
                  {entry.score.toFixed(2)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
