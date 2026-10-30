// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { normalizeSource } from '../packages/core/src/memory/anchor-fingerprint.ts';

// Step 1, verify-on-read: a waypoint remembers the code it is about, and each
// read says whether that code is unchanged, changed or gone.
describe('verify-on-read', () => {
  let dir: string;
  let rig: Rig;
  const src = (body: string) =>
    `export function login(user: string): boolean {\n${body}\n}\nexport function logout(): void {}\n`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rig-verify-'));
    writeFileSync(join(dir, 'auth.ts'), src('  return user.length > 0;'));
    rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });
  afterEach(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const drop = () => {
    const login = rig.searchNodes('login').find((n) => n.name === 'login')!;
    rig.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'Login accepts any non-empty user',
        summary: 'No allow-list.',
        constellationRefs: [login.id],
        keyTerms: [],
        rationale: 'test',
      },
      { sessionId: 's1', actor: 'ai:test' },
    );
  };
  const status = () => rig.verifyWaypoints(rig.getWaypoints({ limit: 10 }))[0]!.verification.status;

  test('verified right after writing', () => {
    drop();
    expect(status()).toBe('verified');
  });

  test('a comment or formatting edit keeps it verified', async () => {
    drop();
    writeFileSync(
      join(dir, 'auth.ts'),
      src('  // any user will do\n  return user.length   >   0;'),
    );
    await rig.sync();
    expect(status()).toBe('verified');
  });

  test('a code change marks it changed', async () => {
    drop();
    writeFileSync(join(dir, 'auth.ts'), src('  return user.length > 3;'));
    await rig.sync();
    expect(status()).toBe('changed');
  });

  test('a deleted symbol marks it missing', async () => {
    drop();
    writeFileSync(join(dir, 'auth.ts'), 'export function logout(): void {}\n');
    await rig.sync();
    expect(status()).toBe('missing');
  });

  test('a waypoint written before fingerprints is unverified', () => {
    drop();
    const db = rig.database.adapter;
    const row = db
      .prepare(`SELECT id, data FROM nodes WHERE type = 'conversation-waypoint'`)
      .get() as {
      id: string;
      data: string;
    };
    const data = JSON.parse(row.data);
    delete data.anchor_fingerprints;
    db.prepare('UPDATE nodes SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);
    expect(status()).toBe('unverified');
  });

  test('normalizeSource drops comments and whitespace, keeps URLs in strings', () => {
    expect(normalizeSource('a  =  1; // note\n/* block */ b = "http://x"')).toBe(
      'a=1;b="http://x"',
    );
  });
});
