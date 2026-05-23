import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

const TOKEN_FILE = '.runtime';
const COOKIE_NAME = 'rig_token';

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

const tokenFromRequest = (req: FastifyRequest): string | null => {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === 'string') {
    for (const c of cookie.split(/;\s*/)) {
      const [k, v] = c.split('=');
      if (k === COOKIE_NAME && v) return decodeURIComponent(v);
    }
  }
  const qt = (req.query as { t?: string } | undefined)?.t;
  if (typeof qt === 'string' && qt) return qt;
  return null;
};

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
    const token = tokenFromRequest(req);
    if (token !== expected) {
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
  app.get<{ Querystring: { t?: string } }>('/auth', async (req, reply) => {
    const t = req.query.t ?? '';
    if (t !== ctx.token) return reply.code(401).send({ error: 'invalid_token' });
    reply.header(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(t)}; Path=/; Max-Age=${ctx.cookieMaxAgeSec}; HttpOnly; SameSite=Strict`,
    );
    return reply.redirect('/', 302);
  });

  app.get('/api/session/me', async (req, reply) => {
    const tok = tokenFromRequest(req);
    if (tok === ctx.token) return { authed: true };
    return reply.code(401).send({ authed: false });
  });
};

// Re-export so callers don't need to know where the file lives.
export { dirname };
