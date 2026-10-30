// SPDX-License-Identifier: Apache-2.0
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { Snapshot } from './api.ts';
import { groupOf, kindLabel } from './kinds.ts';
import type { MapFilters } from './Map.tsx';

// The table view of the constellation: the same nodes the canvas shows,
// sortable and fully keyboard-driven (↑/↓ to move, Enter to open). It is the
// relief channel for colour and the way in for keyboard and screen-reader
// users, who can't point at canvas marks.

type Col = 'name' | 'kind' | 'links' | 'hubness';

export function NodeList({
  snapshot,
  filters,
  selectedId,
  onOpen,
}: {
  snapshot: Snapshot;
  filters: MapFilters;
  selectedId: string | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: 'hubness', dir: -1 });
  const body = useRef<HTMLTableSectionElement>(null);

  const rows = useMemo(() => {
    const deg = new Map<string, number>();
    const bump = (id: string): void => void deg.set(id, (deg.get(id) ?? 0) + 1);
    for (const e of snapshot.edges_structural) {
      bump(e.src);
      bump(e.dst);
    }
    for (const e of snapshot.edges_semantic) {
      bump(e.src);
      bump(e.dst);
    }
    const out = snapshot.nodes
      .filter((n) => (!filters.hubsOnly || n.is_hub) && !filters.hidden.has(groupOf(n.type).id))
      .map((n) => ({ ...n, links: deg.get(n.id) ?? 0, group: groupOf(n.type) }));
    const key = (r: (typeof out)[number]): string | number =>
      sort.col === 'name'
        ? r.name.toLowerCase()
        : sort.col === 'kind'
          ? r.type
          : sort.col === 'links'
            ? r.links
            : (r.hubness ?? 0);
    return out.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || a.name.localeCompare(b.name);
    });
  }, [snapshot, filters, sort]);

  const head = (col: Col, label: string, right = false): JSX.Element => {
    const active = sort.col === col;
    return (
      <th
        className={right ? 'r' : undefined}
        aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      >
        <button
          onClick={() =>
            setSort((s) => ({
              col,
              dir: s.col === col ? (-s.dir as 1 | -1) : col === 'name' || col === 'kind' ? 1 : -1,
            }))
          }
        >
          {label}
          {active && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
        </button>
      </th>
    );
  };

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, id: string): void => {
    const tr = e.currentTarget;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      (tr.nextElementSibling as HTMLElement | null)?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      (tr.previousElementSibling as HTMLElement | null)?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(id);
    }
  };

  return (
    <div className="table-wrap panel">
      <table className="data" aria-label="Nodes in the map" aria-rowcount={rows.length}>
        <thead>
          <tr>
            {head('name', 'Name')}
            {head('kind', 'Kind')}
            <th>File</th>
            {head('links', 'Links', true)}
            {head('hubness', 'Hubness', true)}
          </tr>
        </thead>
        <tbody ref={body}>
          {rows.slice(0, 1000).map((r) => (
            <tr
              key={r.id}
              tabIndex={0}
              aria-selected={r.id === selectedId}
              onClick={() => onOpen(r.id)}
              onKeyDown={(e) => onKey(e, r.id)}
            >
              <td style={{ maxWidth: 320 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    className="glyph"
                    data-shape={r.group.shape}
                    style={{ ['--g' as string]: `var(${r.group.cssVar})` }}
                  />
                  <span className="truncate" style={{ fontWeight: r.is_hub ? 600 : 450 }}>
                    {r.name}
                  </span>
                </span>
              </td>
              <td className="quiet">{kindLabel(r.type)}</td>
              <td className="quiet mono truncate" style={{ maxWidth: 360 }}>
                {r.type === 'file' ? '' : (r.file_path ?? '')}
              </td>
              <td className="r num">{r.links}</td>
              <td className="r num">{(r.hubness ?? 0).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
