// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { dirname, join } from 'node:path';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

const TOKEN_FILE = '.runtime';

/**
 * Load the per-server bearer token from .rig/.runtime, or mint one if missing.
 * The token rotates only when the file is deleted — so restarts within a
 * project preserve sessions, but `rm .rig/.runtime` is the "log everyone out"
 * lever. Mode 0600 so only the user can read it.
 */
export const loadOrCreateToken = (rigDir: string): string => {
  mkdirSync(rigDir, { recursive: true });
  const path = join(rigDir, TOKEN_FILE);
  if (existsSync(path)) {
    const tok = readFileSync(path, 'utf-8').trim();
    if (tok.length >= 32) return tok;
  }
  const tok = randomBytes(32).toString('hex');
  writeFileSync(path, tok, { mode: 0o600 });
  return tok;
};

/**
 * Cookies ignore ports, so every map on 127.0.0.1 shares one cookie jar.
 * Naming the cookie after the token keeps two projects' maps (:7474, :7475…)
 * from overwriting each other's session.
 */
export const cookieNameFor = (token: string): string =>
  `rig_token_${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;

const decode = (v: string): string => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

// Bearer header first, then this server's cookie, then ?t=. Takes the raw
// headers + URL so /ws upgrades, which never reach Fastify, can use it too.
const presentedToken = (
  headers: IncomingHttpHeaders,
  url: string,
  cookieName: string,
): string | null => {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  const cookie = headers.cookie;
  if (typeof cookie === 'string') {
    for (const c of cookie.split(/;\s*/)) {
      const eq = c.indexOf('=');
      const v = c.slice(eq + 1);
      if (eq > 0 && v && c.slice(0, eq) === cookieName) return decode(v);
    }
  }
  const q = url.indexOf('?');
  return (q >= 0 && new URLSearchParams(url.slice(q + 1)).get('t')) || null;
};

const sameToken = (presented: string | null, expected: string): boolean => {
  if (presented === null) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** True when a request (Fastify or a raw upgrade) carries the session token. */
export const hasToken = (
  req: { headers: IncomingHttpHeaders; url?: string | undefined },
  token: string,
): boolean => sameToken(presentedToken(req.headers, req.url ?? '/', cookieNameFor(token)), token);

const PUBLIC_PATHS = new Set(['/health', '/auth']);
const isPublic = (url: string): boolean => {
  // Strip query string. Allow the SPA shell + static assets but gate /api/* and /ws.
  const path = url.split('?')[0] ?? '';
  if (PUBLIC_PATHS.has(path)) return true;
  if (path.startsWith('/api/')) return false;
  if (path === '/ws') return false;
  return true; // index.html + /assets/*
};

export const requireBearer = (expected: string): preHandlerHookHandler => {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (isPublic(req.url)) return;
    if (!hasToken(req, expected)) {
      reply.code(401).send({ error: 'auth_required', hint: 'GET /auth?t=<token> sets the cookie' });
    }
  };
};

export interface AuthRouteContext {
  token: string;
  cookieMaxAgeSec: number;
}

/**
 * /auth?t=X — if X matches, set cookie + redirect to /. Otherwise 401.
 * /api/session/me — 200 if the request is already authed; 401 otherwise.
 *                   Used by the React TokenGate to decide what to render.
 */
export const registerAuthRoutes = (
  app: import('fastify').FastifyInstance,
  ctx: AuthRouteContext,
): void => {
  const cookieName = cookieNameFor(ctx.token);
  app.get<{ Querystring: { t?: unknown } }>('/auth', async (req, reply) => {
    const t = typeof req.query.t === 'string' ? req.query.t : '';
    if (!sameToken(t, ctx.token)) return reply.code(401).send({ error: 'invalid_token' });
    reply.header(
      'Set-Cookie',
      `${cookieName}=${encodeURIComponent(t)}; Path=/; Max-Age=${ctx.cookieMaxAgeSec}; HttpOnly; SameSite=Strict`,
    );
    return reply.redirect('/', 302);
  });

  app.get('/api/session/me', async (req, reply) => {
    if (hasToken(req, ctx.token)) return { authed: true };
    return reply.code(401).send({ authed: false });
  });
};

// Re-export so callers don't need to know where the file lives.
export { dirname };
