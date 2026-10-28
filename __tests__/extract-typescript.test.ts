// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { extractFromSource } from '@rig/core/extract/extractor.ts';

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
});
