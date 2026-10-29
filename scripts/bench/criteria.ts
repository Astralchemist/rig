// SPDX-License-Identifier: Apache-2.0
// Machine-checkable correctness: each query in queries.json lists patterns
// its answer must (all), may (any) and must not (none) contain. Plain strings
// match as case-insensitive substrings; "/source/flags" is a regex.
import type { CheckResult, Expected, Pattern, SessionCheck, SessionExpected } from './types.ts';

const REGEX = /^\/(.+)\/([dgimsuvy]*)$/s;

export const toMatcher = (p: Pattern): ((text: string) => boolean) => {
  const m = REGEX.exec(p);
  if (m) {
    // `g`/`y` make test() stateful; drop them.
    const re = new RegExp(m[1]!, m[2]!.replace(/[gy]/g, ''));
    return (text) => re.test(text);
  }
  const needle = p.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
};

export const checkAnswer = (text: string, expected: Expected): CheckResult => {
  const hits = (ps: Pattern[] | undefined) => (ps ?? []).filter((p) => toMatcher(p)(text));
  const all = expected.all ?? [];
  const matchedAll = new Set(hits(all));
  const missing = all.filter((p) => !matchedAll.has(p));
  const anyMatched = hits(expected.any);
  const anyNeeded = expected.any?.length ? (expected.any_min ?? 1) : 0;
  const forbidden = hits(expected.none);
  return {
    pass: missing.length === 0 && anyMatched.length >= anyNeeded && forbidden.length === 0,
    missing,
    any_matched: anyMatched,
    forbidden,
  };
};

// Throws on a criteria block that can never be checked: nothing to match, a
// bad regex, or an any_min larger than the any list.
export const validateExpected = (id: string, e: Expected): void => {
  const patterns = [...(e.all ?? []), ...(e.any ?? []), ...(e.none ?? [])];
  if (!(e.all?.length || e.any?.length)) throw new Error(`${id}: expected needs all or any`);
  for (const p of patterns) {
    if (typeof p !== 'string' || p === '') throw new Error(`${id}: empty pattern`);
    try {
      toMatcher(p);
    } catch (err) {
      throw new Error(`${id}: bad regex ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (e.any_min !== undefined && (e.any_min < 1 || e.any_min > (e.any?.length ?? 0))) {
    throw new Error(`${id}: any_min ${e.any_min} out of range`);
  }
};

// Session-2 answers end with a line such as "ANSWER: strategy=jwt; ...". The
// criteria are checked against what follows the last marker, so an answer
// that names a trap only to reject it in its reasoning is not marked down;
// without a marker the whole text is checked.
export const answerSection = (text: string, marker: string): string | null => {
  const i = text.lastIndexOf(marker);
  return i < 0 ? null : text.slice(i + marker.length);
};

// `must_not` lists the trap answers: what the code alone suggests. A match
// fails the check and is reported as a trap hit, apart from `none`.
export const checkSessionAnswer = (
  text: string,
  expected: SessionExpected,
  marker: string,
): SessionCheck => {
  const { must_not, ...rest } = expected;
  const section = answerSection(text, marker);
  const scoped = section ?? text;
  const base = checkAnswer(scoped, rest);
  const trapped = (must_not ?? []).filter((p) => toMatcher(p)(scoped));
  return {
    ...base,
    pass: base.pass && trapped.length === 0,
    trapped,
    marker_found: section !== null,
  };
};

export const validateSessionExpected = (id: string, e: SessionExpected): void => {
  const { must_not, ...rest } = e;
  validateExpected(id, rest);
  for (const p of must_not ?? []) {
    if (typeof p !== 'string' || p === '') throw new Error(`${id}: empty must_not pattern`);
    try {
      toMatcher(p);
    } catch (err) {
      throw new Error(`${id}: bad regex ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
};
