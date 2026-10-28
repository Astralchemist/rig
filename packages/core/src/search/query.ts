// SPDX-License-Identifier: Apache-2.0

// Query parsing for the keyword side of search. Two shapes of query:
//
//   identifier — "AuthStore", "auth_store", "AuthStore.login", "authStor".
//     Every word is a quoted prefix match and all must hit (AND), restricted
//     to the name-like columns, so search behaves as it always has for
//     symbol lookups.
//   natural — "where do we refresh expired sessions?". Stopwords are dropped,
//     each remaining word is lightly stemmed and becomes a prefix match, and
//     any of them may hit (OR) in any column; bm25 ranks rows matching more
//     (and rarer) words higher.

export type QueryShape = 'identifier' | 'natural';

export interface ParsedQuery {
  shape: QueryShape;
  // Lower-case search terms (stems for natural queries), in query order.
  terms: string[];
  // The FTS5 MATCH expression, or '' when nothing is searchable.
  fts: string;
}

// Split an identifier into lower-case words: camelCase, PascalCase,
// snake_case, kebab-case, dotted and path forms all agree, and acronyms stay
// whole ("parseHTTPRequest" → parse http request).
export const splitIdentifier = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

// Function words plus the filler of questions and requests about code
// ("where do we…", "show me how…"). Kept short: words like "get", "set",
// "test" or "error" name code and stay searchable.
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a about after all also am an and any are as at be been before being both but by can ' +
    'could did do does doing done during each else for from had has have having he her here ' +
    'how i if in into is it its itself just me more most my no nor not of off on once only or ' +
    'other our ours out over own same she should so some such than that the their theirs them ' +
    'then there these they this those through to too under until up very was we were what ' +
    'when where which while who whom why will with would you your yours ' +
    'happen happens let lets look looking find show tell need want wants way ways thing ' +
    'things whats wheres hows'
  ).split(' '),
);

// A word reads as code when it carries an identifier signal: an inner
// capital, an underscore, a `$`, a dot, a `#`, a slash or `::`.
const CODE_SIGNAL = /[a-z0-9][A-Z]|[_$.#/]|::/;

const PUNCT_EDGES = /^[^\w$]+|[^\w$]+$/g;

const words = (raw: string): string[] =>
  raw
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(PUNCT_EDGES, ''))
    .filter(Boolean);

export const queryShape = (raw: string): QueryShape => {
  const ws = words(raw);
  if (ws.length <= 1) return 'identifier';
  return ws.every((w) => CODE_SIGNAL.test(w)) ? 'identifier' : 'natural';
};

// Light suffix stripping so "sessions", "expired" and "refreshing" prefix-
// match session, expire/expiry and refresh. Only applied to natural queries,
// and never below a 3-letter stem, so short words stay as typed.
export const stem = (w: string): string => {
  const rules: [RegExp, string][] = [
    [/ies$/, ''],
    [/sses$/, 'ss'],
    [/ing$/, ''],
    [/ed$/, ''],
    [/es$/, ''],
    [/([^s])s$/, '$1'],
    [/er$/, ''],
    [/ly$/, ''],
    [/e$/, ''],
  ];
  for (const [re, to] of rules) {
    if (!re.test(w)) continue;
    const s = w.replace(re, to);
    return s.length >= 3 ? s : w;
  }
  return w;
};

const quote = (t: string): string => `"${t.replace(/"/g, '""')}"`;

// Columns an identifier query matches in (see migration v14).
const NAME_COLUMNS = '{name qualified_name tokens}';

export const parseQuery = (raw: string): ParsedQuery => {
  const ws = words(raw);
  if (ws.length === 0) return { shape: 'identifier', terms: [], fts: '' };
  if (queryShape(raw) === 'identifier') {
    // Same AND-of-prefixes as before v14, over the name-like columns. Quoting
    // keeps FTS5 syntax in the query literal; the tokenizer splits a quoted
    // "auth_store" into the phrase auth + store.
    const terms = ws.map((w) => w.toLowerCase());
    return {
      shape: 'identifier',
      terms,
      fts: `${NAME_COLUMNS} : (${ws.map((w) => `${quote(w)}*`).join(' AND ')})`,
    };
  }
  // Natural: split identifiers inside the sentence too ("why does
  // refreshToken fail" → refresh, token, fail).
  const all = ws.flatMap(splitIdentifier);
  const content = all.filter((w) => !STOPWORDS.has(w) && w.length >= 2);
  // A query made only of stopwords ("what is this") still searches, as typed.
  const terms = [...new Set(content.length > 0 ? content.map(stem) : all)];
  return { shape: 'natural', terms, fts: terms.map((t) => `${quote(t)}*`).join(' OR ') };
};

// Spellings of the query as one identifier, for the exact-name list: the
// query as typed plus its words joined as camelCase, PascalCase, snake_case,
// SCREAMING_CASE, kebab-case and run together. "handle login" finds a symbol
// named handleLogin, handle_login or handle-login.
export const nameVariants = (raw: string): string[] => {
  const typed = raw.trim().replace(/\(\)$/, '');
  if (!typed) return [];
  const ws = splitIdentifier(typed);
  const out = new Set<string>([typed]);
  if (ws.length > 0) {
    const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
    out.add(ws[0]! + ws.slice(1).map(cap).join(''));
    out.add(ws.map(cap).join(''));
    out.add(ws.join('_'));
    out.add(ws.join('_').toUpperCase());
    out.add(ws.join('-'));
    out.add(ws.join(''));
  }
  return [...out];
};
