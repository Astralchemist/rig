// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Rig } from '../packages/core/src/index.ts';
import { serveWeb } from '../packages/web/src/index.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('web WS channel', () => {
  test(
    'client receives hello + db:changed on index',
    async () => {
      const project = mkdtempSync(join(tmpdir(), 'rig-web-ws-'));
      const rig0 = await Rig.init(project);
      rig0.close();
      const handle = await serveWeb({ projectRoot: project, port: 0 });
      const port = new URL(handle.url).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const events: Array<{ type: string }> = [];
      ws.on('message', (m) => events.push(JSON.parse(m.toString()) as { type: string }));
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      await sleep(50);
      expect(events.some((e) => e.type === 'hello')).toBe(true);

      writeFileSync(join(project, 'live.ts'), 'export const live = 1;');
      const rig = await Rig.open(project);
      await rig.indexAll();
      rig.close();
      await sleep(500);
      expect(events.some((e) => e.type === 'db:changed')).toBe(true);

      ws.terminate();
      // Bun:test exits after the test completes; handle.close() can hang on
      // upgraded sockets so we skip awaiting it here.
      void handle.close();
      rmSync(project, { recursive: true, force: true });
    },
    15000,
  );
});
