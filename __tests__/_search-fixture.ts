// SPDX-License-Identifier: Apache-2.0
// Retrieval-eval fixture: a small repo whose code says things in different
// words than the questions asked about it, plus a test embedder that knows
// which words mean the same thing. Shared by the search and embedding tests.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Embedder } from '@rig/core';
import { splitIdentifier, stem, STOPWORDS } from '@rig/core/search/query.ts';

// Words that mean the same thing here. The deterministic hash embedder makes
// every distinct text unrelated; this one maps each word to its concept and
// hashes concepts into the vector, so "refresh expired sessions" lands near
// "renew a lapsed access token" — what a real model does, minus the model.
const CONCEPTS: readonly (readonly string[])[] = [
  ['refresh', 'renew', 'reissue'],
  ['expire', 'expired', 'lapse', 'lapsed', 'stale', 'ttl', 'idle'],
  ['session', 'sessions', 'token', 'access'],
  ['login', 'authenticate', 'credential', 'credentials', 'password'],
  ['invoice', 'bill', 'owe', 'owes', 'total', 'charge', 'charges', 'amount'],
  ['refund', 'reimburse', 'back', 'return'],
  ['customer', 'buyer', 'client', 'account', 'user', 'someone'],
  ['money', 'payment', 'card', 'pay'],
  ['retry', 'again', 'backoff', 'reattempt'],
  ['fail', 'failed', 'failure', 'throw', 'throws', 'error'],
  ['network', 'request', 'requests', 'call', 'calls', 'http'],
  ['cache', 'memory', 'lru', 'entries', 'entry'],
  ['evict', 'drop', 'remove', 'purge'],
  ['email', 'mail', 'message'],
  ['signup', 'signs', 'register', 'registered', 'onboard', 'welcome'],
  ['image', 'picture', 'thumbnail', 'thumbnails', 'photo'],
  ['small', 'smaller', 'shrink', 'scale', 'resize', 'width'],
  ['config', 'configuration', 'settings', 'options', 'yaml'],
  ['load', 'read', 'parse'],
  ['throttle', 'rate', 'limit', 'limiting', 'bucket', 'window'],
  ['rank', 'order', 'score', 'relevance', 'sort'],
  ['result', 'results', 'documents', 'document', 'hits'],
  ['log', 'logs', 'journal'],
  ['compress', 'gzip', 'archive', 'zip'],
];

const conceptOf = new Map<string, string>();
CONCEPTS.forEach((group, i) => {
  for (const w of group) conceptOf.set(stem(w), `c${i}`);
});

const DIM = 384;

const bucket = (feature: string): { at: number; sign: number } => {
  const h = createHash('sha256').update(feature).digest();
  return { at: h.readUInt32BE(0) % DIM, sign: h[4]! & 1 ? 1 : -1 };
};

export class ConceptEmbedder implements Embedder {
  readonly model = 'rig-test-concepts-384';
  readonly dim = DIM;
  calls = 0;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls += texts.length;
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): Float32Array {
    const v = new Float32Array(DIM);
    const words = text
      .split(/\s+/)
      .flatMap(splitIdentifier)
      .filter((w) => !STOPWORDS.has(w));
    for (const w of words) {
      const s = stem(w);
      // A word with a concept counts double: concepts carry the meaning.
      const concept = conceptOf.get(s);
      const { at, sign } = bucket(concept ?? `w:${s}`);
      v[at]! += sign * (concept ? 2 : 1);
    }
    let sumsq = 0;
    for (let i = 0; i < DIM; i++) sumsq += v[i]! * v[i]!;
    if (sumsq > 0) for (let i = 0; i < DIM; i++) v[i] = v[i]! / Math.sqrt(sumsq);
    return v;
  }
}

// A ConceptEmbedder that can be switched to fail (the model won't load) or to
// hang until released (the model is still loading).
export class ControlledEmbedder extends ConceptEmbedder {
  mode: 'ok' | 'fail' | 'hang' = 'ok';
  private release: (() => void) | null = null;
  override async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (this.mode === 'fail') throw new Error('model missing');
    if (this.mode === 'hang') await new Promise<void>((r) => (this.release = r));
    return super.embed(texts);
  }
  unblock(): void {
    this.mode = 'ok';
    this.release?.();
  }
}

export const FIXTURE_FILES: Record<string, string> = {
  'src/auth/session.ts': `
export interface Token { value: string; issuedAt: number; ttlMs: number }

/** Issue a new access token in place of one whose TTL has lapsed. */
export function renewAccessToken(token: Token): Token {
  return { ...token, issuedAt: Date.now() };
}

export class SessionStore {
  private byId = new Map<string, Token>();
  /** Drop tokens idle past their TTL. */
  evictStale(now: number): number {
    let n = 0;
    for (const [id, t] of this.byId) if (now - t.issuedAt > t.ttlMs) { this.byId.delete(id); n++; }
    return n;
  }
}
`,
  'src/auth/login.ts': `
/** Check an email and password against the user table and start a session. */
export async function authenticateUser(email: string, password: string): Promise<boolean> {
  return email.length > 0 && password.length > 7;
}
`,
  'src/billing/invoice.ts': `
export interface LineItem { cents: number; qty: number }

/** Sum the line items of a bill, then apply tax. */
export function computeInvoiceTotal(lines: LineItem[], taxRate: number): number {
  const net = lines.reduce((s, l) => s + l.cents * l.qty, 0);
  return Math.round(net * (1 + taxRate));
}
`,
  'src/billing/refund.ts': `
/** Return a charge's amount to the customer's card. */
export function issueRefund(chargeId: string, cents: number): { chargeId: string; cents: number } {
  return { chargeId, cents: -cents };
}
`,
  'src/net/retry.ts': `
/** Run fn again, with exponential delay, each time it throws. */
export async function withBackoff<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i + 1 >= attempts) throw e; }
  }
}
`,
  'src/storage/cache.ts': `
/** Keeps the most recently read entries; evicts the oldest when full. */
export class LruCache<V> {
  private items = new Map<string, V>();
  constructor(private readonly capacity: number) {}
  get(key: string): V | undefined { return this.items.get(key); }
}
`,
  'src/mail/notify.ts': `
/** Mail a greeting to a newly registered account. */
export function sendWelcomeEmail(address: string): string {
  return \`Welcome, \${address}\`;
}
`,
  'src/upload/resize.ts': `
/** Scale a picture down to fit a maximum width. */
export function shrinkImage(pixels: Uint8Array, maxWidth: number): Uint8Array {
  return pixels.slice(0, maxWidth);
}
`,
  'src/ops/rotate.ts': `
/** Move yesterday's journal files aside and gzip them. */
export function rotateLogs(dir: string): string[] {
  return [dir];
}
`,
  'src/config/settings.ts': `
/** Parse the YAML options file and fill in defaults. */
export function readSettings(path: string): Record<string, unknown> {
  return { path };
}
`,
  'src/search/order.ts': `
/** Order documents by relevance to a query. */
export function scoreDocuments(query: string, docs: string[]): string[] {
  return docs.filter((d) => d.includes(query));
}
`,
  'src/api/bucket.ts': `
/** Allow N requests per window for each client. */
export class TokenBucket {
  constructor(readonly perWindow: number) {}
  take(clientId: string): boolean { return clientId.length < this.perWindow; }
}
`,
  'docs/ARCHITECTURE.md': `
# Architecture

## Rate limiting

Each client gets a bucket of N requests per window; when it is empty the API answers 429.

## Storage

Entries are kept in memory with an LRU policy.
`,
};

export const writeFixture = (root: string): void => {
  for (const [rel, body] of Object.entries(FIXTURE_FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body.trimStart());
  }
};

// Natural-language questions about the fixture and the anchors that answer
// them (any one in the top 5 is a hit). Each asks in other words than the
// code uses: keyword search alone finds few of them.
export const NL_QUERIES: readonly { query: string; expect: readonly string[] }[] = [
  { query: 'where do we refresh expired sessions?', expect: ['renewAccessToken', 'evictStale'] },
  { query: 'fix the login bug', expect: ['authenticateUser'] },
  { query: 'how much does a buyer owe?', expect: ['computeInvoiceTotal'] },
  { query: 'give the money back to a buyer', expect: ['issueRefund'] },
  { query: 'retry failed network calls', expect: ['withBackoff'] },
  { query: 'purge old items from memory', expect: ['LruCache'] },
  { query: 'send an email when someone signs up', expect: ['sendWelcomeEmail'] },
  { query: 'make thumbnails smaller', expect: ['shrinkImage'] },
  { query: 'compress old logs', expect: ['rotateLogs'] },
  { query: 'where is configuration loaded', expect: ['readSettings'] },
  { query: 'throttle requests per client', expect: ['TokenBucket', 'Rate limiting'] },
  { query: 'sort search results', expect: ['scoreDocuments'] },
];

// Symbol lookups: the named symbol must come first.
export const IDENTIFIER_QUERIES: readonly { query: string; expect: string }[] = [
  { query: 'renewAccessToken', expect: 'renewAccessToken' },
  { query: 'TokenBucket', expect: 'TokenBucket' },
  { query: 'issue_refund', expect: 'issueRefund' },
  { query: 'SessionStore.evictStale', expect: 'evictStale' },
  { query: 'LruCache', expect: 'LruCache' },
  { query: 'computeInvoice', expect: 'computeInvoiceTotal' },
];
