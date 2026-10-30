// SPDX-License-Identifier: Apache-2.0
import type { Rig } from '@rig/core';
import { activationsSince, activationAgentsSince } from '@rig/core/db/activation-queries.ts';
import { unwatchFile, watch, watchFile, type FSWatcher } from 'node:fs';
import { STATUS_CODES, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { hasToken } from './auth.ts';
import type { RequestGuard } from './request-guard.ts';
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

// What a /ws upgrade must pass. Upgrades never reach Fastify's hooks, so the
// HTTP checks are repeated here.
export interface WsGate {
  guard: RequestGuard;
  // Session token the upgrade must carry (cookie, Bearer or ?t=); null = --no-auth.
  token: string | null;
}

const RIG_DIR = '.rig';

// Debounce the rapid-fire writes WAL produces during a single transaction. We
// emit one db:changed event 200ms after the last observed change.
const DEBOUNCE_MS = 200;

// Browsers send an Origin on every WebSocket handshake, so a cross-site page
// is turned away here even though the handshake is a GET.
const upgradeStatus = (req: IncomingMessage, gate: WsGate): number => {
  if (req.url?.split('?')[0] !== '/ws') return 404;
  if (!gate.guard.hostAllowed(req.headers.host)) return 403;
  if (!gate.guard.originAllowed(req.headers.origin)) return 403;
  if (gate.token !== null && !hasToken(req, gate.token)) return 401;
  return 101;
};

// Answer an upgrade we won't take with a plain HTTP status, then hang up.
const refuse = (socket: Duplex, status: number): void => {
  socket.on('error', () => socket.destroy());
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
};

export const attachWs = (httpServer: HttpServer, rig: Rig, gate: WsGate): WsHandle => {
  const projectRoot = rig.projectRoot;
  let lastMutationTs = Date.now();
  let lastActivationTs = Date.now();

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const status = upgradeStatus(req, gate);
    if (status !== 101) return refuse(socket, status);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  httpServer.on('upgrade', onUpgrade);

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
          // Which agent touched each node, where its session is known (C5).
          let agents: Record<string, string> = {};
          try {
            agents = activationAgentsSince(rig.database.adapter, lastActivationTs);
          } catch {
            agents = {};
          }
          broadcast({
            type: 'activation:fired',
            ts,
            payload: Object.keys(agents).length
              ? { ids, count: acts.length, agents }
              : { ids, count: acts.length },
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

  // On macOS fs.watch reports in-place writes to the open WAL only once, so
  // only the first commit after startup ever reached clients. Stat-polling the
  // WAL every 250ms catches every commit, from any process, on any OS.
  const walFile = join(root, RIG_DIR, 'rig.db-wal');
  watchFile(walFile, { persistent: false, interval: 250 }, onDbChange);

  return {
    close: async () => {
      httpServer.off('upgrade', onUpgrade);
      if (timer) clearTimeout(timer);
      unwatchFile(walFile, onDbChange);
      for (const w of watchers) w.close();
      for (const ws of clients) ws.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
    },
    broadcast,
  };
};
