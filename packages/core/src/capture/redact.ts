// SPDX-License-Identifier: Apache-2.0

// Secrets never reach the graph or the capture spool: every captured string
// passes through redact() first. Known token shapes are replaced whole;
// key=value pairs whose key names a secret keep the key and lose the value;
// a long high-entropy run (mixed case and digits, not a hex hash) goes too.
// Over-redaction is the cheap failure here.

const R = (what: string): string => `[REDACTED:${what}]`;

const kv = (key: string, flags: string): RegExp =>
  new RegExp(
    String.raw`\b(${key})(["']?\s*[=:]\s*)(?:"([^"\n]{4,})"|'([^'\n]{4,})'|([^\s"'\`,;}]{4,}))`,
    flags,
  );

const keepKey = (_m: string, key: string, sep: string, dq?: string, sq?: string): string =>
  `${key}${sep}${dq !== undefined ? `"${R('secret')}"` : sq !== undefined ? `'${R('secret')}'` : R('secret')}`;

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    R('private-key'),
  ],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, R('api-key')],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, R('api-key')],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, R('api-key')],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R('token')],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R('token')],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, R('token')],
  [/\bnpm_[A-Za-z0-9]{30,}/g, R('token')],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R('token')],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, R('aws-key')],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, R('api-key')],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R('jwt')],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/g, (_m, kind) => `${kind} ${R('token')}`],
  // Credentials in a URL: scheme://user:pass@host
  [
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi,
    (_m, scheme) => `${scheme}${R('credentials')}@`,
  ],
  // .env-style lines (UPPER_SNAKE keys naming a secret) and config pairs
  // whose whole key is a secret's name (api_key, password, "token": …). A
  // quoted value may hold spaces; a bare one ends at whitespace.
  [
    kv(
      String.raw`[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|PRIVATE|DSN|CONN(?:ECTION)?_?STRING)[A-Z0-9_]*`,
      'g',
    ),
    keepKey,
  ],
  [
    kv(
      String.raw`(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)`,
      'gi',
    ),
    keepKey,
  ],
];

// Long runs of mixed-case letters and digits that look random (a token with
// no known prefix). Hex strings (commit hashes, digests) stay.
const LONG_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

const looksRandom = (s: string): boolean => {
  if (/^[0-9a-f]+$/i.test(s)) return false;
  if (/[/_-]/.test(s) && s.split(/[/_-]/).every((p) => p.length < 16)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(s)).length;
  if (classes < 3) return false;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h >= 4;
};

export const redact = (text: string): string => {
  let out = text;
  for (const [re, rep] of PATTERNS) {
    out = out.replace(re, rep as (substring: string, ...args: string[]) => string);
  }
  return out.replace(LONG_RUN, (m) => (looksRandom(m) ? R('token') : m));
};

export const hasSecret = (text: string): boolean => redact(text) !== text;
