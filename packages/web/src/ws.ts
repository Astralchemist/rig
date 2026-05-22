import { watch, type FSWatcher } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

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

  // Watch the .rig directory (catches db, db-wal, db-shm churn even if WAL
  // hadn't been created when the server booted).
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
