// SPDX-License-Identifier: Apache-2.0
// Verify-on-read (research report, step 1): a memory remembers what the code
// it is about looked like, and every read compares that with the code now.
//
// The fingerprint of a symbol is a hash of its source lines with comments and
// whitespace removed, so reformatting or editing a comment keeps a memory
// verified while any change to the code itself flags it. The normaliser only
// has to be deterministic: the same function hashes the old and the new text.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteAdapter } from '../db/adapter.ts';

/** How a memory's anchor compares with the code now. */
export type AnchorStatus = 'verified' | 'changed' | 'missing' | 'unverified';

/** A waypoint's status is its worst anchor's; `unanchored` when it has none. */
export type MemoryStatus = AnchorStatus | 'unanchored';

const SEVERITY: Record<AnchorStatus, number> = {
  verified: 0,
  unverified: 1,
  changed: 2,
  missing: 3,
};

/** Source with comments and all whitespace removed (C-style and `#` comments). */
export const normalizeSource = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
    .replace(/^\s*#[^\n]*$/gm, '')
    .replace(/\s+/g, '');

export const fingerprintText = (text: string): string =>
  createHash('sha256').update(normalizeSource(text)).digest('hex').slice(0, 16);

interface NodeLocation {
  filePath: string;
  startLine: number;
  endLine: number;
}

const locationOf = (db: SqliteAdapter, nodeId: string): NodeLocation | null => {
  const row = db.prepare('SELECT data FROM nodes WHERE id = ?').get(nodeId) as
    | { data: string }
    | undefined;
  if (!row) return null;
  const d = JSON.parse(row.data) as { filePath?: unknown; startLine?: unknown; endLine?: unknown };
  if (typeof d.filePath !== 'string' || typeof d.startLine !== 'number') return null;
  return {
    filePath: d.filePath,
    startLine: d.startLine,
    endLine: typeof d.endLine === 'number' ? d.endLine : d.startLine,
  };
};

/**
 * Fingerprints symbols from the files on disk, reading each file once per
 * instance. Make one per read or write; files change between them.
 */
export class Fingerprinter {
  private readonly files = new Map<string, string[] | null>();
  constructor(
    private readonly db: SqliteAdapter,
    private readonly projectRoot: string,
  ) {}

  /** The node's fingerprint, or null when it doesn't exist or has no source location. */
  of(nodeId: string): string | null {
    const loc = locationOf(this.db, nodeId);
    if (!loc) return null;
    let lines = this.files.get(loc.filePath);
    if (lines === undefined) {
      try {
        lines = readFileSync(join(this.projectRoot, loc.filePath), 'utf-8').split('\n');
      } catch {
        lines = null;
      }
      this.files.set(loc.filePath, lines);
    }
    if (!lines) return null;
    return fingerprintText(lines.slice(loc.startLine - 1, loc.endLine).join('\n'));
  }

  /**
   * The node's fingerprint as if it still had `oldName`: its own name swapped
   * back, so a function that was only renamed matches the fingerprint stored
   * under the old name. Null without a source location.
   */
  ofRenamed(nodeId: string, oldName: string): string | null {
    const loc = locationOf(this.db, nodeId);
    const row = this.db.prepare('SELECT name FROM nodes WHERE id = ?').get(nodeId) as
      | { name: string }
      | undefined;
    if (!loc || !row) return null;
    const lines = this.lines(loc.filePath);
    if (!lines) return null;
    const esc = row.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const text = lines
      .slice(loc.startLine - 1, loc.endLine)
      .join('\n')
      .replace(new RegExp(`\\b${esc}\\b`, 'g'), oldName);
    return fingerprintText(text);
  }

  private lines(filePath: string): string[] | null {
    let lines = this.files.get(filePath);
    if (lines === undefined) {
      try {
        lines = readFileSync(join(this.projectRoot, filePath), 'utf-8').split('\n');
      } catch {
        lines = null;
      }
      this.files.set(filePath, lines);
    }
    return lines;
  }

  /** Fingerprints of every ref that has a source location (files and memory have none). */
  ofAll(nodeIds: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of nodeIds) {
      const fp = this.of(id);
      if (fp) out[id] = fp;
    }
    return out;
  }

  /** Each anchor's status against the fingerprints stored with the memory. */
  verify(
    refs: readonly string[],
    stored: Readonly<Record<string, string>> | undefined,
  ): { status: MemoryStatus; anchors: Record<string, AnchorStatus> } {
    const anchors: Record<string, AnchorStatus> = {};
    const exists = this.db.prepare('SELECT 1 AS x FROM nodes WHERE id = ?');
    for (const id of refs) {
      if (!exists.get(id)) {
        anchors[id] = 'missing';
        continue;
      }
      const then = stored?.[id];
      if (!then) {
        // No source location now and none then (a file or a memory node) is
        // nothing to compare: leave it out rather than call it unverified.
        if (locationOf(this.db, id) || stored === undefined) anchors[id] = 'unverified';
        continue;
      }
      const now = this.of(id);
      anchors[id] = now === null ? 'missing' : now === then ? 'verified' : 'changed';
    }
    const statuses = Object.values(anchors);
    const status: MemoryStatus = statuses.length
      ? statuses.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a))
      : 'unanchored';
    return { status, anchors };
  }
}
