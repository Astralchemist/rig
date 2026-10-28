// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { extractFromSource } from '@rig/core/extract/extractor.ts';

const BINDINGS_TS = `/** Doubles. */
export const double = async (n: number): Promise<number> => n * 2;

// Triples.
const triple = function (n: number) {
  return n * 3;
};

let twice = x => double(double(x));

export const handler =
  (req: Request) => req;

const named = function inner() {};

const x = 1, square = (n: number) => n * n;

export function useAll(): void {
  triple(1);
  twice(2);
  const local = () => square(3);
  local();
}

export default () => {};
const wrapped = memo(() => {});
`;

const MAIN_TS = `import { double } from './math';

export function main(): Promise<number> {
  return double(21);
}
`;

const LEGACY_JS = `var legacy = function (a) {
  return a;
};
const helper = (x) => legacy(x);

export function make() {
  return helper(1);
}
`;

const DOCS_TS = `/** Exported function. */
export function read(): void {}

/** Default export. */
export default function main(): void {}

/** Decorated class. */
@sealed
export class Box {}

/** Exported interface. */
export interface Shape {}

/** Plain function. */
function local(): void {}
`;

describe('typescript extraction', () => {
  test('a doc comment above `export` documents the exported declaration', async () => {
    const { nodes } = await extractFromSource('src/docs.ts', DOCS_TS);
    const docOf = (name: string): string | undefined =>
      nodes.find((n) => n.name === name)?.docstring;
    expect(docOf('read')).toBe('Exported function.');
    expect(docOf('main')).toBe('Default export.');
    expect(docOf('Box')).toBe('Decorated class.');
    expect(docOf('Shape')).toBe('Exported interface.');
    expect(docOf('local')).toBe('Plain function.');
  });

  test('top-level and exported function bindings become function nodes', async () => {
    const { nodes } = await extractFromSource('src/math.ts', BINDINGS_TS);
    const functions = nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    // Not `inner` (named by the binding), not the nested `local`, not the
    // anonymous default export, not the `memo(...)`-wrapped value.
    expect(functions.toSorted()).toEqual([
      'double',
      'handler',
      'named',
      'square',
      'triple',
      'twice',
      'useAll',
    ]);
  });

  test('a bound function carries signature, span, export flag and docstring', async () => {
    const { nodes } = await extractFromSource('src/math.ts', BINDINGS_TS);
    const byName = (name: string) => nodes.find((n) => n.name === name);
    expect(byName('double')).toMatchObject({
      kind: 'function',
      qualifiedName: 'double',
      signature: '(n: number): Promise<number>',
      isExported: true,
      isAsync: true,
      docstring: 'Doubles.',
      startLine: 2,
      endLine: 2,
    });
    expect(byName('triple')).toMatchObject({
      signature: '(n: number)',
      isExported: false,
      isAsync: false,
      docstring: 'Triples.',
      startLine: 5,
      endLine: 7,
    });
    expect(byName('twice')?.signature).toBe('(x)');
    expect(byName('handler')).toMatchObject({ isExported: true, startLine: 11, endLine: 12 });
  });
});

describe('function bindings in the indexed graph', () => {
  let root: string;
  let rig: Rig;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'rig-bindings-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), BINDINGS_TS);
    writeFileSync(join(root, 'src', 'main.ts'), MAIN_TS);
    writeFileSync(join(root, 'src', 'legacy.js'), LEGACY_JS);
    rig = await Rig.init(root);
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(root, { recursive: true, force: true });
  });

  const idOf = (name: string): string => {
    const row = rig.database.adapter
      .prepare("SELECT id FROM nodes WHERE name = ? AND type = 'function'")
      .get(name) as { id: string } | null;
    expect(row).not.toBeNull();
    return row!.id;
  };
  const names = (nodes: { name: string }[]): string[] => nodes.map((n) => n.name).toSorted();

  test('calls to a bound function resolve like calls to a declared one', () => {
    // Same-file (from inside another binding) and cross-file callers.
    expect(names(rig.getCallers(idOf('double')))).toEqual(['main', 'twice']);
    expect(names(rig.getCallees(idOf('useAll')))).toEqual(['square', 'triple', 'twice']);
  });

  test('JavaScript bindings, including var, resolve too', () => {
    expect(names(rig.getCallees(idOf('make')))).toEqual(['helper']);
    expect(names(rig.getCallees(idOf('helper')))).toEqual(['legacy']);
  });
});
