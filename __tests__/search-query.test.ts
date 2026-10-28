// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { EXACT_LIST_CAP, EXACT_WEIGHT, RRF_K, fuseRrf } from '@rig/core/search/fuse.ts';
import {
  nameVariants,
  parseQuery,
  queryShape,
  splitIdentifier,
  stem,
} from '@rig/core/search/query.ts';

describe('splitIdentifier', () => {
  test('camelCase, snake_case and kebab-case agree', () => {
    for (const id of [
      'handleLogin',
      'handle_login',
      'handle-login',
      'HandleLogin',
      'HANDLE_LOGIN',
    ]) {
      expect(splitIdentifier(id)).toEqual(['handle', 'login']);
    }
  });

  test('acronyms stay whole', () => {
    expect(splitIdentifier('parseHTTPRequest')).toEqual(['parse', 'http', 'request']);
    expect(splitIdentifier('HTTPServer')).toEqual(['http', 'server']);
    expect(splitIdentifier('getURL')).toEqual(['get', 'url']);
  });

  test('dotted, path and digit forms', () => {
    expect(splitIdentifier('AuthStore.login')).toEqual(['auth', 'store', 'login']);
    expect(splitIdentifier('src/auth/session.ts')).toEqual(['src', 'auth', 'session', 'ts']);
    expect(splitIdentifier('v2Parser')).toEqual(['v2', 'parser']);
  });
});

describe('queryShape', () => {
  test('single words and code-looking phrases are identifiers', () => {
    for (const q of [
      'AuthStore',
      'authStor',
      'auth_store',
      'login',
      'AuthStore.login',
      'foo::bar baz_qux',
    ]) {
      expect(queryShape(q)).toBe('identifier');
    }
  });

  test('anything with a plain word among several is natural language', () => {
    for (const q of [
      'where do we refresh expired sessions?',
      'fix the login bug',
      'AuthStore login',
      'handle login',
    ]) {
      expect(queryShape(q)).toBe('natural');
    }
  });
});

describe('stem', () => {
  test('strips common suffixes to a prefix of the related words', () => {
    expect(stem('sessions')).toBe('session');
    expect(stem('expired')).toBe('expir');
    expect(stem('refreshing')).toBe('refresh');
    expect(stem('dependencies')).toBe('dependenc');
    expect(stem('processes')).toBe('process');
    expect(stem('watcher')).toBe('watch');
  });

  test('never below three letters', () => {
    expect(stem('uses')).toBe('uses');
    expect(stem('user')).toBe('user');
    expect(stem('is')).toBe('is');
  });
});

describe('parseQuery', () => {
  test('identifier: AND of quoted prefixes over the name-like columns', () => {
    expect(parseQuery('AuthStore login_x')).toEqual({
      shape: 'identifier',
      terms: ['authstore', 'login_x'],
      fts: '{name qualified_name tokens} : ("AuthStore"* AND "login_x"*)',
    });
  });

  test('identifier: FTS syntax in the query stays literal', () => {
    expect(parseQuery('a"b').fts).toBe('{name qualified_name tokens} : ("a""b"*)');
    expect(parseQuery('NEAR(x)').fts).toBe('{name qualified_name tokens} : ("NEAR(x"*)');
  });

  test('natural: stopwords dropped, stems OR-ed as prefixes over every column', () => {
    expect(parseQuery('where do we refresh expired sessions?')).toEqual({
      shape: 'natural',
      terms: ['refresh', 'expir', 'session'],
      fts: '"refresh"* OR "expir"* OR "session"*',
    });
  });

  test('natural: identifiers inside a sentence are split', () => {
    expect(parseQuery('why does refreshToken fail').terms).toEqual(['refresh', 'token', 'fail']);
  });

  test('natural: a query of only stopwords still searches its words', () => {
    expect(parseQuery('what is this').terms).toEqual(['what', 'is', 'this']);
  });

  test('blank query matches nothing', () => {
    expect(parseQuery('   ').fts).toBe('');
    expect(parseQuery('?!').fts).toBe('');
  });
});

describe('nameVariants', () => {
  test('a phrase becomes every identifier spelling', () => {
    expect(nameVariants('handle login').sort()).toEqual(
      [
        'handle login',
        'handleLogin',
        'HandleLogin',
        'handle_login',
        'HANDLE_LOGIN',
        'handle-login',
        'handlelogin',
      ].sort(),
    );
  });

  test('the typed form is kept and call parens dropped', () => {
    expect(nameVariants('AuthStore')).toContain('AuthStore');
    expect(nameVariants('render()')).toContain('render');
    expect(nameVariants('  ')).toEqual([]);
  });
});

describe('fuseRrf', () => {
  test('scores Σ weight / (k + rank) and lists every source that matched', () => {
    const fused = fuseRrf([
      { source: 'keyword', ids: ['a', 'b'] },
      { source: 'vector', ids: ['b', 'c'] },
    ]);
    expect(fused.map((f) => f.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 12);
    expect(fused[0]!.matchedBy).toEqual(['keyword', 'vector']);
    expect(fused[1]!.score).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(fused[2]!.matchedBy).toEqual(['vector']);
  });

  test('matched_by follows name, alias, keyword, vector whatever the list order', () => {
    const [f] = fuseRrf([
      { source: 'vector', ids: ['x'] },
      { source: 'keyword', ids: ['x'] },
      { source: 'name', ids: ['x'], weight: EXACT_WEIGHT },
    ]);
    expect(f!.matchedBy).toEqual(['name', 'keyword', 'vector']);
  });

  test('an exact match at the end of a full list beats rank 1 in both other lists', () => {
    const names = Array.from({ length: EXACT_LIST_CAP }, (_, i) => `n${i}`);
    const fused = fuseRrf([
      { source: 'name', ids: names, weight: EXACT_WEIGHT },
      { source: 'keyword', ids: ['other'] },
      { source: 'vector', ids: ['other'] },
    ]);
    expect(fused.findIndex((f) => f.id === 'other')).toBe(EXACT_LIST_CAP);
  });

  test('ties keep first-seen order; a duplicate within a list counts once', () => {
    const fused = fuseRrf([
      { source: 'keyword', ids: ['a', 'a'] },
      { source: 'vector', ids: ['b'] },
    ]);
    expect(fused.map((f) => f.id)).toEqual(['a', 'b']);
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  test('no lists, no results', () => {
    expect(fuseRrf([])).toEqual([]);
  });
});
