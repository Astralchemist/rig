// SPDX-License-Identifier: Apache-2.0
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Rig } from '@rig/core';
import { findAssetRoot } from '@rig/core/asset-root.ts';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadOrCreateToken, registerAuthRoutes, requireBearer } from './auth.ts';
import { registerConfigRoutes } from './config-route.ts';
import { registerRoutes } from './routes.ts';
import { attachWs, type WsHandle } from './ws.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolve the built UI in both dev (packages/web/dist) and published
// (node_modules/rig/packages/web/dist) layouts.
const DIST_DIR = join(findAssetRoot(HERE), 'packages/web/dist');

export interface ServeWebOptions {
  projectRoot: string;
  host?: string;
  port?: number;
  // 'auto' (default): require bearer iff host is non-loopback.
  // true: always require bearer (recommended for any sharing scenario).
  // false: open. Only safe on loopback.
  auth?: boolean | 'auto';
}

export interface WebHandle {
  app: FastifyInstance;
  rig: Rig;
  url: string;
  ws: WsHandle;
  token: string | null;
  close: () => Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7474;

export async function serveWeb(opts: ServeWebOptions): Promise<WebHandle> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const isLoopback = LOOPBACK_HOSTS.has(host);
  const authMode = opts.auth ?? 'auto';
  const authOn = authMode === true || (authMode === 'auto' && !isLoopback);

  if (!isLoopback && !authOn) {
    throw new Error(
      `rig serve: refusing to bind ${host} without auth. Pass --auth or use a loopback address.`,
    );
  }

  const rig = await Rig.open(opts.projectRoot);
  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: [`http://${host}:${port}`, 'http://localhost:7474', 'http://127.0.0.1:7474'],
  });
  await app.register(compress, { global: true, encodings: ['gzip', 'deflate'], threshold: 1024 });

  let token: string | null = null;
  if (authOn) {
    token = loadOrCreateToken(join(opts.projectRoot, '.rig'));
    app.addHook('preHandler', requireBearer(token));
    registerAuthRoutes(app, { token, cookieMaxAgeSec: 60 * 60 * 24 * 7 });
  } else {
    // Always expose /api/session/me so the React TokenGate probe doesn't 404.
    // When auth is off, every caller is "authed".
    app.get('/api/session/me', async () => ({ authed: true, auth_required: false }));
  }

  app.get('/health', async () => ({ ok: true, name: 'rig-web', version: '0.0.1', auth: authOn }));
  registerRoutes(app, rig);
  registerConfigRoutes(app, opts.projectRoot);

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
    token,
    close: async () => {
      await ws.close();
      await app.close();
      rig.close();
    },
  };
}
