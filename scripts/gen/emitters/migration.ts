// SPDX-License-Identifier: Apache-2.0
import type { LoadedContract, GeneratedFile } from '../types.ts';
import { sqlHeader, tsHeader } from '../header.ts';

export const emitMigrations = (migrations: LoadedContract<'migrations'>[]): GeneratedFile[] => {
  const sorted = migrations.toSorted((a, b) => a.data.version - b.data.version);

  const sqlParts = sorted.map(
    (m) => `-- v${m.data.version}: ${m.data.description}\n${m.data.forward}\n`,
  );
  const schemaSql: GeneratedFile = {
    path: 'core/schema.sql',
    content: sqlHeader(sorted.map((m) => m.file)) + sqlParts.join('\n'),
    source: sorted.map((m) => m.file),
  };

  const runnerEntries = sorted.map(
    (m) =>
      `  {
    version: ${m.data.version},
    description: ${JSON.stringify(m.data.description)},
    forward: ${JSON.stringify(m.data.forward)},
    rollback: ${JSON.stringify(m.data.rollback)},
  }`,
  );
  const runner: GeneratedFile = {
    path: 'core/migrations.ts',
    content:
      tsHeader(sorted.map((m) => m.file)) +
      `export interface Migration {
  version: number;
  description: string;
  forward: string;
  rollback: string;
}

export const MIGRATIONS: readonly Migration[] = [
${runnerEntries.join(',\n')},
];
`,
    source: sorted.map((m) => m.file),
  };

  return [schemaSql, runner];
};
