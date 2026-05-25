// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { computeMigrationHashes, readLock } from '../scripts/migration-lock.ts';

// Shipped migrations are immutable: their contract content is hashed into
// compat/migrations.lock.json. Editing or deleting a shipped migration trips
// this test — add a new version instead. Re-bless with `bun run migration:lock`.
describe('migration immutability lock', () => {
  const lock = readLock();
  const hashes = computeMigrationHashes();

  test('lock is non-empty and contiguous from v1', () => {
    const versions = Object.keys(lock).map(Number).sort((a, b) => a - b);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1));
  });

  for (const [v, h] of Object.entries(readLock())) {
    test(`v${v} unchanged since it shipped`, () => {
      expect(hashes[v]).toBe(h);
    });
  }
});
