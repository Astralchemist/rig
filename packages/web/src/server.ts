import cors from '@fastify/cors';
import { Rig } from '@rig/core';
import Fastify, { type FastifyInstance } from 'fastify';

export interface ServeWebOptions {
  projectRoot: string;
  host?: string;
  port?: number;
}

export interface WebHandle {
  app: FastifyInstance;
  rig: Rig;
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7474;

export async function serveWeb(opts: ServeWebOptions): Promise<WebHandle> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;

  const rig = await Rig.open(opts.projectRoot);
  const app = Fastify({ logger: false });

  // Loopback-only by default — when binding outside 127.0.0.1 the bearer-token
  // gate lands in a follow-up. Same-origin browser clients work without CORS,
  // but allow localhost for dev tools / curl checks.
  await app.register(cors, {
    origin: [`http://${host}:${port}`, 'http://localhost:7474', 'http://127.0.0.1:7474'],
  });

  app.get('/health', async () => ({ ok: true, name: 'rig-web', version: '0.0.1' }));

  const address = await app.listen({ host, port });
  return {
    app,
    rig,
    url: address,
    close: async () => {
      await app.close();
      rig.close();
    },
  };
}
