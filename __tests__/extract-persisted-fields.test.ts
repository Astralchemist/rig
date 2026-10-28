// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { Database } from '@rig/core/db/database.ts';
import { upsertNode } from '@rig/core/db/node-queries.ts';
import { extractFromSource } from '@rig/core/extract/extractor.ts';
import { detectLanguage } from '@rig/core/extract/grammars.ts';
import { EXTRACTORS } from '@rig/core/extract/languages/index.ts';

// Node fields upsertNode is allowed not to store. Every other field an
// extractor sets must survive the round trip, or it is silently lost.
const NOT_PERSISTED = new Set([
  // upsertNode stamps the row's updated_at column itself at write time.
  'updatedAt',
]);

// One fixture per extractor: every tree-sitter language in EXTRACTORS, plus
// markdown and each manifest format.
const FIXTURES: Record<string, string> = {
  'src/service.ts': `import { readFile } from 'node:fs/promises';

/** A user record. */
export interface User {
  id: string;
}

export type UserId = User['id'];

export enum Role {
  Admin,
  Member,
}

export abstract class Repo {
  /** Loads one user. */
  async load(id: UserId): Promise<User> {
    return { id };
  }
  static create(): void {}
}

// Reads a file.
export async function read(path: string): Promise<string> {
  return readFile(path, 'utf-8');
}

/** Doubles a number. */
export const double = async (n: number): Promise<number> => n * 2;
const triple = function (n: number) {
  return n * 3;
};
`,
  'src/view.tsx': `export const Badge = ({ label }: { label: string }) => <span>{label}</span>;

export function Panel() {
  return <Badge label="x" />;
}
`,
  'src/legacy.js': `const helper = (x) => x + 1;

export class Counter {
  static zero() {
    return 0;
  }
  increment(n) {
    return helper(n);
  }
}

export function make() {
  return new Counter();
}
`,
  'src/app.jsx': `export function App() {
  return <div />;
}
`,
  'pkg/models.py': `import os
import pandas as pd
from .base import Base


class Model(Base):
    @staticmethod
    def build():
        return Model()

    async def save(self):
        pass


def load(path: str) -> "Model":
    return pd.read_csv(os.path.join(path))
`,
  'README.md': `# Project

## Usage
`,
  'package.json': JSON.stringify({
    dependencies: { zod: '^3.23' },
    devDependencies: { typescript: '^5.5' },
    peerDependencies: { react: '>=18' },
    optionalDependencies: { 'better-sqlite3': '^12' },
  }),
  'requirements.txt': 'pandas==2.1.4\nrequests\n',
  'requirements-dev.txt': 'pytest==8.0.0\n',
  'pyproject.toml': `[project]
dependencies = ["numpy>=1.26"]

[project.optional-dependencies]
dev = ["ruff"]
plot = ["matplotlib"]

[tool.poetry.dependencies]
python = "^3.11"
flask = "^3.0"
`,
};

describe('extracted node fields survive upsertNode', () => {
  test('fixtures cover every extractor', () => {
    const covered = Object.keys(FIXTURES).map(detectLanguage);
    for (const language of [...Object.keys(EXTRACTORS), 'markdown', 'json']) {
      expect(covered).toContain(language);
    }
  });

  test('every field an extractor sets is persisted or explicitly not persisted', async () => {
    const db = Database.open(':memory:');
    const dropped: string[] = [];
    try {
      for (const [path, source] of Object.entries(FIXTURES)) {
        const { nodes } = await extractFromSource(path, source);
        expect(nodes.some((n) => n.kind !== 'file')).toBe(true);
        for (const node of nodes) {
          upsertNode(db.adapter, node);
          const row = db.adapter
            .prepare('SELECT id, type, name, data FROM nodes WHERE id = ?')
            .get(node.id) as { id: string; type: string; name: string; data: string };
          const stored: Record<string, unknown> = {
            ...(JSON.parse(row.data) as Record<string, unknown>),
            id: row.id,
            kind: row.type,
            name: row.name,
          };
          for (const [key, value] of Object.entries(node)) {
            if (value === undefined || NOT_PERSISTED.has(key)) continue;
            if (!Bun.deepEquals(stored[key], value)) {
              dropped.push(`${path}: ${node.kind} ${node.name} loses '${key}'`);
            }
          }
        }
      }
    } finally {
      db.close();
    }
    expect(dropped).toEqual([]);
  });
});
