// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';

// One /ws connection for the whole app, re-opened with backoff when it drops
// (server restart, laptop sleep). Subscribers get every event; the hook
// reports the connection state for the "Live" indicator.

export interface LiveEvent {
  type: string;
  ts: number;
  payload?: Record<string, unknown> & { ids?: string[] };
}

export type LiveState = 'connecting' | 'open' | 'closed';

export function useLive(onEvent: (e: LiveEvent) => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const open = (): void => {
      setState('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.addEventListener('open', () => {
        retry = 0;
        setState('open');
      });
      ws.addEventListener('message', (ev) => {
        try {
          handler.current(JSON.parse(ev.data as string) as LiveEvent);
        } catch {
          // not JSON: ignore
        }
      });
      ws.addEventListener('close', () => {
        if (stopped) return;
        setState('closed');
        const wait = Math.min(15000, 500 * 2 ** retry++);
        timer = setTimeout(open, wait);
      });
    };
    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return state;
}
