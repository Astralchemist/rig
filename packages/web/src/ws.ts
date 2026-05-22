import { watch, type FSWatcher } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

export interface WsHandle {
  close: () => void;
  broadcast: (event: WsEvent) => void;
}

export interface WsEvent {
  type: string;
  ts: number;
  [k: string]: unknown;
}

const DB_FILE = '.rig/rig.db';
const WAL_FILE = '.rig/rig.db-wal';

// Debounce the rapid-fire writes WAL produces during a single transaction. We
// emit one db:changed event 200ms after the last observed change.
const DEBOUNCE_MS = 200;

export const attachWs = (httpServer: HttpServer, projectRoot: string): WsHandle => {
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
      broadcast({ type: 'db:changed', ts: Date.now() });
    }, DEBOUNCE_MS);
  };

  for (const f of [DB_FILE, WAL_FILE]) {
    try {
      const w = watch(join(root, f), { persistent: false });
      w.on('change', onDbChange);
      w.on('error', () => {
        // Watcher dies if the file is deleted/recreated; tolerate silently.
      });
      watchers.push(w);
    } catch {
      // File may not exist yet — Rig hasn't been initialised. WS still works.
    }
  }

  return {
    close: () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
      for (const ws of clients) ws.close();
      wss.close();
    },
    broadcast,
  };
};
