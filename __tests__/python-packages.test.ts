// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import {
  DIST_IMPORT_NAMES,
  distributionKeysOf,
  importKeysOf,
  normalizePypiName,
} from '@rig/core/db/pypi-names.ts';
import { PYTHON_STDLIB } from '@rig/core/db/python-stdlib.ts';

describe('PYTHON_STDLIB', () => {
  test('holds the standard library, __future__ and modules removed since 3.10', () => {
    const modules = ['__future__', 'os', 'sys', 'json', 'typing', '_thread', 'distutils', 'imp'];
    for (const module of modules) {
      expect(PYTHON_STDLIB.has(module)).toBe(true);
    }
  });

  test('does not hold third-party packages', () => {
    for (const module of ['pandas', 'yaml', 'requests', 'setuptools', 'pip']) {
      expect(PYTHON_STDLIB.has(module)).toBe(false);
    }
  });
});

describe('PyPI distribution names', () => {
  test('normalize per PEP 503: case-insensitive, runs of - _ . are one -', () => {
    expect(normalizePypiName('Flask')).toBe('flask');
    expect(normalizePypiName('typing_extensions')).toBe('typing-extensions');
    expect(normalizePypiName('ruamel.yaml')).toBe('ruamel-yaml');
    expect(normalizePypiName('Foo__Bar-._baz')).toBe('foo-bar-baz');
  });

  test('an import matches by each dotted prefix of its module', () => {
    expect(importKeysOf('google.protobuf.json_format')).toEqual([
      'google',
      'google-protobuf',
      'google-protobuf-json-format',
    ]);
    expect(importKeysOf('yaml')).toEqual(['yaml']);
    expect(importKeysOf('.models')).toEqual([]);
  });

  test('a distribution answers to its own name and its known import names', () => {
    expect(distributionKeysOf('PyYAML')).toEqual(['pyyaml', 'yaml']);
    expect(distributionKeysOf('protobuf')).toEqual(['protobuf', 'google-protobuf']);
    expect(distributionKeysOf('requests')).toEqual(['requests']);
  });

  test('the rename table is keyed by normalized distribution names', () => {
    for (const name of Object.keys(DIST_IMPORT_NAMES)) {
      expect(normalizePypiName(name)).toBe(name);
    }
  });
});
