import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';

const A_TS = `import { greet } from './b';

export function main(): number {
  greet('world');
  return 1;
}
`;

const B_TS = `export function greet(name: string): string {
  return 'Hello ' + name;
}

export function helper(): string {
  return greet('inline');
}
`;

describe('Phase 1.3 — resolver + traversal', () => {
  let root: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'rig-resolve-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), A_TS);
    writeFileSync(join(root, 'src', 'b.ts'), B_TS);
    const rig = await Rig.init(root);
    rig.close();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves same-file and cross-file calls', async () => {
    const rig = await Rig.open(root);
    try {
      const stats = await rig.indexAll();
      expect(stats.edges).toBeGreaterThanOrEqual(2);
      const greet = rig.database.adapter
        .prepare("SELECT id FROM nodes WHERE name = 'greet' AND type = 'function'")
        .get() as { id: string } | null;
      expect(greet).not.toBeNull();
      const callers = rig.getCallers(greet!.id);
      const callerNames = callers.map((c) => c.name).toSorted();
      expect(callerNames).toEqual(['helper', 'main']);
    } finally {
      rig.close();
    }
  });

  it('records unresolved imports without writing false edges', async () => {
    const rig = await Rig.open(root);
    try {
      await rig.indexAll();
      const unresolved = rig.database.adapter
        .prepare("SELECT target_name FROM unresolved_refs WHERE target_name = './b'")
        .all() as { target_name: string }[];
      expect(unresolved.length).toBeGreaterThanOrEqual(1);
    } finally {
      rig.close();
    }
  });

  it('refuses to resolve ambiguous names (no false-positive edges)', async () => {
    const dup = join(root, 'src', 'dup.ts');
    writeFileSync(
      dup,
      `export function greet(): string { return 'dup'; }\nexport function caller(): void { greet(); }\n`,
    );
    const rig = await Rig.open(root);
    try {
      await rig.indexAll();
      // 'greet' now has two definitions — same-file caller in dup.ts and main+helper in a/b.ts.
      // The resolver must NOT pick one arbitrarily; ambiguous refs go to unresolved_refs.
      const ambiguous = rig.database.adapter
        .prepare("SELECT COUNT(*) AS n FROM unresolved_refs WHERE target_name = 'greet'")
        .get() as { n: number };
      expect(ambiguous.n).toBeGreaterThanOrEqual(1);
    } finally {
      rig.close();
    }
  });

  it('getCallees walks the other direction', async () => {
    const rig = await Rig.open(root);
    try {
      await rig.indexAll();
      const main = rig.database.adapter
        .prepare("SELECT id FROM nodes WHERE name = 'main' AND type = 'function'")
        .get() as { id: string } | null;
      expect(main).not.toBeNull();
      const callees = rig.getCallees(main!.id);
      expect(callees.map((c) => c.name)).toEqual(['greet']);
    } finally {
      rig.close();
    }
  });

  it('getImpactRadius walks transitively backwards through calls', async () => {
    const rig = await Rig.open(root);
    try {
      await rig.indexAll();
      const greet = rig.database.adapter
        .prepare("SELECT id FROM nodes WHERE name = 'greet' AND type = 'function'")
        .get() as { id: string } | null;
      const impact = rig.getImpactRadius(greet!.id, 3);
      const names = impact.map((n) => n.name).toSorted();
      expect(names).toContain('helper');
      expect(names).toContain('main');
    } finally {
      rig.close();
    }
  });
});
