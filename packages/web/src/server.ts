import compress from '@fastify/compress';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Rig } from '@rig/core';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from './routes.ts';
import { attachWs, type WsHandle } from './ws.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/web/src → packages/web → dist/
const DIST_DIR = resolve(HERE, '..', 'dist');

export interface ServeWebOptions {
  projectRoot: string;
  host?: string;
  port?: number;
}

export interface WebHandle {
  app: FastifyInstance;
  rig: Rig;
  url: string;
  ws: WsHandle;
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
  await app.register(compress, { global: true, encodings: ['gzip', 'deflate'], threshold: 1024 });

  app.get('/health', async () => ({ ok: true, name: 'rig-web', version: '0.0.1' }));
  registerRoutes(app, rig);

  // Serve the built React app from packages/web/dist/. If dist/ is missing
  // (no `vite build` yet) we fall through to a one-line placeholder so the
  // browser doesn't hang on an empty 404.
  if (existsSync(DIST_DIR)) {
    await app.register(fastifyStatic, { root: DIST_DIR, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url === '/ws') {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_, reply) => {
      return reply.type('text/html').send(
        `<!doctype html><meta charset="utf-8"><title>Rig</title><body style="font:14px sans-serif;padding:40px;background:#0b0d12;color:#e5e7eb">` +
          `<h1>Rig web server is running</h1>` +
          `<p>UI bundle not built yet. Run <code>cd packages/web &amp;&amp; bunx vite build</code> then refresh.</p>` +
          `<p>API surface available now at <code>/api/status</code>, <code>/api/graph</code>, etc.</p></body>`,
      );
    });
  }

  const address = await app.listen({ host, port });
  const ws = attachWs(app.server, rig);
  return {
    app,
    rig,
    url: address,
    ws,
    close: async () => {
      await ws.close();
      await app.close();
      rig.close();
    },
  };
}
