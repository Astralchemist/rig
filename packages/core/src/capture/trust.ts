// SPDX-License-Identifier: Apache-2.0
import type { WaypointKind, WaypointRow } from '../db/waypoint-queries.ts';

// Trust tiers for captured waypoints. Capture is automatic, so what it stores
// is unvetted: only the record kinds a user actually settled — agreed or
// stated decisions (corrections included), constraints and dead ends — at or
// above INJECT_THRESHOLD are put in front of an agent unasked (the
// SessionStart brief, the overview's recent decisions). Everything else stays
// retrievable through rig_waypoints and rig_search, and is never injected.
export const INJECT_THRESHOLD = 0.7;

export const INJECTABLE_KINDS: readonly WaypointKind[] = ['decision', 'constraint', 'dead-end'];

export const isInjectable = (w: WaypointRow): boolean =>
  w.source === 'hook' &&
  INJECTABLE_KINDS.includes(w.kind) &&
  typeof w.confidence === 'number' &&
  w.confidence >= INJECT_THRESHOLD;

// Agent-dropped waypoints are the agent's own deliberate record; a captured
// one has to clear the injection bar to be surfaced unasked.
export const isSurfaceable = (w: WaypointRow): boolean => w.source !== 'hook' || isInjectable(w);
