// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
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
