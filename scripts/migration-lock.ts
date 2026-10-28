// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hashContent } from './gen/manifest.ts';

const ROOT = resolve(import.meta.dir, '..');
const DIR = join(ROOT, '.contracts', 'migrations');
const LOCK = join(ROOT, 'compat', 'migrations.lock.json');

// Hash each shipped migration contract by raw file content. A shipped migration
// is immutable — editing it changes its hash and trips the lock. Only adding a
// new version is allowed. See COMPATIBILITY.md.
export const computeMigrationHashes = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of readdirSync(DIR).filter((f) => /^v\d+\.contract\.ts$/.test(f)).sort()) {
    const version = f.match(/^v(\d+)/)![1]!;
    out[version] = hashContent(readFileSync(join(DIR, f), 'utf-8'));
  }
  return out;
};

export const readLock = (): Record<string, string> => JSON.parse(readFileSync(LOCK, 'utf-8'));

if (import.meta.main) {
  const hashes = computeMigrationHashes();
  if (process.argv.includes('--write')) {
    mkdirSync(dirname(LOCK), { recursive: true });
    writeFileSync(LOCK, JSON.stringify(hashes, null, 2) + '\n');
    console.log(`✓ migration lock updated (${Object.keys(hashes).length} migrations)`);
    process.exit(0);
  }
  const lock = readLock();
  const drift: string[] = [];
  for (const [v, h] of Object.entries(lock)) {
    if (!(v in hashes)) drift.push(`v${v} removed`);
    else if (hashes[v] !== h) drift.push(`v${v} edited`);
  }
  if (drift.length) {
    console.error('✗ migration lock: shipped migrations are immutable —');
    for (const d of drift) console.error(`  ${d}`);
    console.error('  → add a new migration version instead. If intentional, run `bun run migration:lock`.');
    process.exit(1);
  }
  console.log(`✓ migration lock: ${Object.keys(lock).length} shipped migrations unchanged`);
}
