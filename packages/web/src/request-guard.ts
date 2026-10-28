// SPDX-License-Identifier: Apache-2.0
import { hostname, networkInterfaces } from 'node:os';
import type { FastifyInstance } from 'fastify';

// Any page open in the user's browser can send requests to a loopback server
// (the CVE-2025-49596 / CVE-2025-52882 class). Two checks close that off:
//  - Host allowlist: a DNS-rebinding page reaches us under its own name
//    (evil.example:7474), so only names this server answers to get through.
//  - Origin check: a cross-site page can still POST or open a WebSocket at
//    us; those must come from our own origin, or carry no Origin at all
//    (curl, agents and other non-browser clients).

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]']);
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RequestGuard {
  hostAllowed: (host: string | undefined) => boolean;
  originAllowed: (origin: string | undefined) => boolean;
}

// Host-header form: lowercase, IPv6 literals in brackets.
const asHostName = (name: string): string => {
  const n = name.toLowerCase();
  return n.includes(':') && !n.startsWith('[') ? `[${n}]` : n;
};

// A wildcard bind answers on every interface, so a remote browser arrives
// under one of this machine's addresses or its hostname.
const machineNames = (): string[] => [
  hostname(),
  ...Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address)),
];

/**
 * Names allowed in Host: localhost, 127.0.0.1 and [::1], plus the configured
 * bind host, each with the port actually bound. `port` is read per request
 * because it's only known once listen() has walked past any busy ports.
 */
export const makeRequestGuard = (
  bindHost: string,
  port: () => number | undefined,
): RequestGuard => {
  const allowedHosts = (): Set<string> => {
    const p = port();
    const allowed = new Set<string>();
    if (p === undefined) return allowed;
    const names = [...LOOPBACK_NAMES, bindHost];
    if (WILDCARD_BINDS.has(bindHost)) names.push(...machineNames());
    for (const name of names) {
      allowed.add(`${asHostName(name)}:${p}`);
      if (p === 80) allowed.add(asHostName(name)); // browsers omit the default port
    }
    return allowed;
  };
  const hostAllowed = (host: string | undefined): boolean =>
    host !== undefined && allowedHosts().has(host.toLowerCase());
  // A browser Origin is scheme://host[:port]; this server only speaks http.
  const originAllowed = (origin: string | undefined): boolean =>
    origin === undefined ||
    (origin.startsWith('http://') && hostAllowed(origin.slice('http://'.length)));
  return { hostAllowed, originAllowed };
};

/** 403 any request with a foreign Host, and state-changing ones with a foreign Origin. */
export const guardRequests = (app: FastifyInstance, guard: RequestGuard): void => {
  app.addHook('onRequest', async (req, reply) => {
    if (!guard.hostAllowed(req.headers.host)) {
      return reply.code(403).send({ error: 'forbidden_host' });
    }
    if (UNSAFE_METHODS.has(req.method) && !guard.originAllowed(req.headers.origin)) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }
  });
};
