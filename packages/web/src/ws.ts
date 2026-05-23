import type { Rig } from '@rig/core';
import { activationsSince } from '@rig/core/db/activation-queries.ts';
import { watch, type FSWatcher } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { deriveEvents } from './ws-derive.ts';

export interface WsHandle {
  close: () => Promise<void>;
  broadcast: (event: WsEvent) => void;
}

export interface WsEvent {
  type: string;
  ts: number;
  [k: string]: unknown;
}

const RIG_DIR = '.rig';

// Debounce the rapid-fire writes WAL produces during a single transaction. We
// emit one db:changed event 200ms after the last observed change.
const DEBOUNCE_MS = 200;

export const attachWs = (httpServer: HttpServer, rig: Rig): WsHandle => {
  const projectRoot = rig.projectRoot;
  let lastMutationTs = Date.now();
  let lastActivationTs = Date.now();

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() } satisfies WsEvent));
  });

  const broadcast = (event: WsEvent): void => {
    const json = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(json);
    }
  };

  const root = resolve(projectRoot);
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onDbChange = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const ts = Date.now();
      broadcast({ type: 'db:changed', ts });
      try {
        const mutations = rig.writes.mutationsSince(lastMutationTs);
        const derived = deriveEvents(rig, mutations);
        for (const e of derived) {
          broadcast({ type: e.type, ts: e.ts, payload: e.payload });
        }
        if (mutations.length) {
          lastMutationTs = Math.max(lastMutationTs, ...mutations.map((m) => m.ts));
        }
      } catch {
        // Mutation log unavailable (e.g., DB closing) — stick with db:changed.
      }
      try {
        const acts = activationsSince(rig.database.adapter, lastActivationTs);
        if (acts.length > 0) {
          // Coalesce into one event with all touched node IDs — the UI can
          // animate them together. Cap at 50 per tick so a runaway query
          // doesn't drown the WS.
          const ids = Array.from(new Set(acts.map((a) => a.node_id))).slice(0, 50);
          broadcast({
            type: 'activation:fired',
            ts,
            payload: { ids, count: acts.length },
          });
          lastActivationTs = Math.max(lastActivationTs, ...acts.map((a) => a.ts));
        }
      } catch {
        // activations table missing or db closing — no-op.
      }
    }, DEBOUNCE_MS);
  };

  try {
    const w = watch(join(root, RIG_DIR), { persistent: false }, (_evt, filename) => {
      if (filename && filename.startsWith('rig.db')) onDbChange();
    });
    w.on('error', () => {
      // Watcher dies if the dir is replaced; tolerate silently.
    });
    watchers.push(w);
  } catch {
    // .rig/ may not exist yet — Rig hasn't been initialised. WS still works.
  }

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
      for (const ws of clients) ws.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
    },
    broadcast,
  };
};
