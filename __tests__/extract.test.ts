import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';

const TS_FIXTURE = `export interface User {
  id: string;
  name: string;
}

export class UserService {
  async getUser(id: string): Promise<User> {
    return { id, name: 'test' };
  }
  static createDefault(): User {
    return { id: '0', name: 'default' };
  }
}

export function greet(user: User): string {
  return \`Hello \${user.name}\`;
}
`;

const MD_FIXTURE = `# Sample Project

## Overview
A tiny TS fixture.

### Subsection
Nested heading.

## Setup
Run \`rig index\`.
`;

describe('Rig.indexAll — extraction', () => {
  let root: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'rig-extract-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'sample.ts'), TS_FIXTURE);
    writeFileSync(join(root, 'README.md'), MD_FIXTURE);
    const rig = await Rig.init(root);
    rig.close();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('extracts TS function + class + interface + methods', async () => {
    const rig = await Rig.open(root);
    try {
      const result = await rig.indexAll();
      expect(result.files).toBeGreaterThanOrEqual(2);
      const counts = (
        rig.database.adapter
          .prepare('SELECT type, COUNT(*) AS n FROM nodes GROUP BY type')
          .all() as { type: string; n: number }[]
      ).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.type]: r.n }), {});
      expect(counts.function ?? 0).toBeGreaterThanOrEqual(1);
      expect(counts.class ?? 0).toBeGreaterThanOrEqual(1);
      expect(counts.interface ?? 0).toBeGreaterThanOrEqual(1);
      expect(counts.method ?? 0).toBeGreaterThanOrEqual(2);
    } finally {
      rig.close();
    }
  });

  it('extracts markdown headings as nodes', async () => {
    const rig = await Rig.open(root);
    try {
      await rig.indexAll();
      const moduleNodes = rig.database.adapter
        .prepare("SELECT name FROM nodes WHERE type='module' ORDER BY name")
        .all() as { name: string }[];
      const names = moduleNodes.map((n) => n.name);
      expect(names).toContain('Sample Project');
      expect(names).toContain('Overview');
      expect(names).toContain('Subsection');
      expect(names).toContain('Setup');
    } finally {
      rig.close();
    }
  });

  it('records each indexed file in the files table', async () => {
    const rig = await Rig.open(root);
    try {
      await rig.indexAll();
      const files = (
        rig.database.adapter.prepare('SELECT path FROM files ORDER BY path').all() as {
          path: string;
        }[]
      ).map((f) => f.path);
      expect(files).toContain('README.md');
      expect(files).toContain('src/sample.ts');
    } finally {
      rig.close();
    }
  });

  it('extracts function signatures from TS source', async () => {
    const rig = await Rig.open(root);
    try {
      await rig.indexAll();
      const greet = rig.database.adapter
        .prepare("SELECT data FROM nodes WHERE name='greet' AND type='function'")
        .get() as { data: string } | null;
      expect(greet).not.toBeNull();
      const parsed = JSON.parse(greet!.data) as { signature?: string };
      expect(parsed.signature).toContain('(user: User)');
    } finally {
      rig.close();
    }
  });
});
