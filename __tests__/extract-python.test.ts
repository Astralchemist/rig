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

describe('python extraction', () => {
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
