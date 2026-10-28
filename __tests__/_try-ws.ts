// SPDX-License-Identifier: Apache-2.0
import type { ClientRequest, IncomingMessage } from 'node:http';
import { WebSocket, type ClientOptions } from 'ws';

/** Opens a WebSocket: resolves 'open', or the HTTP status the server refused the upgrade with. */
export const tryWs = (url: string, opts: ClientOptions = {}): Promise<'open' | number> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    ws.on('error', reject); // no-op once settled
    ws.once('open', () => {
      resolve('open');
      ws.terminate();
    });
    ws.once('unexpected-response', (req: ClientRequest, res: IncomingMessage) => {
      resolve(res.statusCode ?? -1);
      req.destroy();
    });
  });
