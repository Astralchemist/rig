// SPDX-License-Identifier: Apache-2.0
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Rig } from '@rig/core';
import { findAssetRoot } from '@rig/core/asset-root.ts';
import { writeWebAddress } from '@rig/core/web-address.ts';
import pkg from '../../../package.json' with { type: 'json' };
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadOrCreateToken, registerAuthRoutes, requireBearer } from './auth.ts';
import { registerConfigRoutes } from './config-route.ts';
import { listenWithFallback, resolvePort, resolveProjectName } from './listen.ts';
import { guardRequests, makeRequestGuard } from './request-guard.ts';
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
  // 'auto' (default) or true: require the session token from .rig/.runtime on
  // /api/* and /ws — on loopback too, since any page open in the browser can
  // reach a loopback server. `rig start` opens the map with it already set.
  // false: no token (`rig serve --no-auth`). Refused off loopback.
  auth?: boolean | 'auto';
  // Keep the graph live: watch the project and sync on change (one watcher
  // per project across rig processes; RIG_NO_WATCH=1 turns it off).
  // Default: true.
  watch?: boolean;
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

export async function serveWeb(opts: ServeWebOptions): Promise<WebHandle> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = resolvePort(opts.projectRoot, opts.port);
  const project = resolveProjectName(opts.projectRoot);
  const isLoopback = LOOPBACK_HOSTS.has(host);
  const authOn = opts.auth !== false;

  if (!isLoopback && !authOn) {
    throw new Error(
      `rig serve: refusing to bind ${host} without auth. Drop --no-auth or use a loopback address.`,
    );
  }

  const rig = await Rig.open(opts.projectRoot);
  // close() must not wait on clients: destroy every open connection (idle
  // keep-alive, in-flight or half-received request), not just idle ones. On
  // Bun 1.3 this also frees upgraded /ws sockets, which otherwise left
  // server.close() pending forever (#3).
  const app = Fastify({ logger: false, forceCloseConnections: true });

  // First hook: refuse foreign Host headers (DNS rebinding) and foreign-Origin
  // writes (CSRF) before any route, plugin or auth check runs.
  const guard = makeRequestGuard(host, () => {
    const addr = app.server.address();
    return addr && typeof addr === 'object' ? addr.port : undefined;
  });
  guardRequests(app, guard);

  // The UI is served from this origin, so no other origin may read the API:
  // send no CORS headers and fail every preflight.
  await app.register(cors, { origin: false });
  await app.register(compress, { global: true, encodings: ['gzip', 'deflate'], threshold: 1024 });

  let token: string | null = null;
  if (authOn) {
    token = loadOrCreateToken(join(opts.projectRoot, '.rig'));
    app.addHook('preHandler', requireBearer(token));
    registerAuthRoutes(app, { token, cookieMaxAgeSec: 60 * 60 * 24 * 7 });
  } else {
    // --no-auth: expose /api/session/me anyway so the React TokenGate probe
    // doesn't 404. Every caller is "authed".
    app.get('/api/session/me', async () => ({ authed: true, auth_required: false }));
  }

  const version = (pkg as { version: string }).version;
  app.get('/health', async () => ({ ok: true, name: 'rig-web', project, version, auth: authOn }));
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

  const address = await listenWithFallback(app, host, port);
  // Record where we actually landed — the port may have walked past a busy
  // one — so rig_session_token hands out a login URL that works.
  const bound = app.server.address();
  writeWebAddress(rig.projectRoot, {
    host,
    port: bound !== null && typeof bound === 'object' ? bound.port : port,
  });
  const ws = attachWs(app.server, rig, { guard, token });
  if (opts.watch !== false) rig.watch();
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
