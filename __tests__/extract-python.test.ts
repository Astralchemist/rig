// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { extractFromSource } from '@rig/core/extract/extractor.ts';

const SHAPES_PY = `class Shape:
    def scale(self, k):
        def clamp(v):
            return max(v, 0)
        return clamp(k)

    @staticmethod
    def unit():
        return Shape()

    if True:
        def conditional(self):
            pass


def area(s):
    def square(x):
        return x * x

    class Local:
        def size(self):
            return 1

    return square(s)


@functools.cache
def cached():
    return 1


async def fetch():
    pass
`;

const IMPORTS_PY = `import os
import pandas as pd
import os.path, numpy as np
import matplotlib.pyplot as plt
from .base import Base, Mixin as M
from pkg.sub import *
`;

describe('python extraction', () => {
  test('plain and aliased imports become import refs that keep the alias', async () => {
    const { unresolvedReferences } = await extractFromSource('app/main.py', IMPORTS_PY);
    const imports = unresolvedReferences
      .filter((r) => r.referenceKind === 'imports')
      .map((r) => ({ module: r.referenceName, alias: r.alias, line: r.line }));
    expect(imports).toEqual([
      { module: 'os', alias: undefined, line: 1 },
      { module: 'pandas', alias: 'pd', line: 2 },
      { module: 'os.path', alias: undefined, line: 3 },
      { module: 'numpy', alias: 'np', line: 3 },
      { module: 'matplotlib.pyplot', alias: 'plt', line: 4 },
      { module: '.base', alias: undefined, line: 5 },
      { module: 'pkg.sub', alias: undefined, line: 6 },
    ]);
  });

  test('from-imports keep the names they pull in, for submodule resolution', async () => {
    const { unresolvedReferences } = await extractFromSource('app/main.py', IMPORTS_PY);
    const names = (module: string): string[] | undefined =>
      unresolvedReferences.find((r) => r.referenceName === module)?.importedNames;
    expect(names('.base')).toEqual(['Base', 'Mixin']);
    expect(names('pkg.sub')).toBeUndefined(); // wildcard
    expect(names('pandas')).toBeUndefined(); // plain import
  });

  test('module-level defs are functions, defs in a class body are methods', async () => {
    const { nodes } = await extractFromSource('pkg/shapes.py', SHAPES_PY);
    const kindOf = (qualifiedName: string): string | undefined =>
      nodes.find((n) => n.qualifiedName === qualifiedName)?.kind;

    expect(kindOf('area')).toBe('function');
    expect(kindOf('cached')).toBe('function'); // decorated
    expect(kindOf('fetch')).toBe('function'); // async
    expect(kindOf('Shape.scale')).toBe('method');
    expect(kindOf('Shape.unit')).toBe('method'); // decorated
    expect(kindOf('Shape.conditional')).toBe('method'); // nested block, still the class body
    expect(kindOf('area.Local.size')).toBe('method'); // class defined inside a function
    expect(kindOf('Shape.scale.clamp')).toBe('function'); // nested in a method
    expect(kindOf('area.square')).toBe('function'); // nested in a function
  });
});
