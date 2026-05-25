// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rig } from '@rig/core';

const PROJECT = '/tmp/rig-verify';
rmSync(PROJECT, { recursive: true, force: true });
mkdirSync(PROJECT, { recursive: true });

const filePath = (name: string): string => join(PROJECT, name);
writeFileSync(
  filePath('auth.ts'),
  `export class AuthStore {
  login(user: string): void { console.log(user); }
  logout(): void {}
}`,
);
writeFileSync(
  filePath('cart.ts'),
  `export class ShoppingCart {
  add(item: string): void { console.log(item); }
}`,
);
writeFileSync(
  filePath('doomed.ts'),
  `export function willBeDeleted(): number { return 42; }`,
);

let pass = true;
const check = (label: string, cond: boolean): void => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) pass = false;
};

const rig = await Rig.init(PROJECT);
const idx = await rig.indexAll();
check(`indexed ${idx.files} files`, idx.files === 3);
check(`extracted ${idx.nodes} nodes`, idx.nodes >= 5);

// --- FTS5 search ---
const hits = rig.searchNodes('AuthStore');
check('search "AuthStore" → ≥1 hit', hits.length >= 1);
check('search "AuthStore" returns AuthStore class', hits.some((n) => n.name === 'AuthStore'));

const prefix = rig.searchNodes('Shopp');
check('prefix "Shopp" → ≥1 hit (proves prefix match)', prefix.length >= 1);

const filtered = rig.searchNodes('login', { kind: 'method' });
check('search "login" kind=method → ≥1 hit', filtered.length >= 1);

const empty = rig.searchNodes('zzznotreal');
check('search "zzznotreal" → 0 hits', empty.length === 0);

// --- sync purge ---
const beforeNodes = (await rig.status()).nodes;
const beforeFiles = (await rig.status()).files;
rmSync(filePath('doomed.ts'));

const syncResult = await rig.sync();
check(`sync purged ${syncResult.filesPurged} file`, syncResult.filesPurged === 1);

const afterNodes = (await rig.status()).nodes;
const afterFiles = (await rig.status()).files;
check(`files count dropped from ${beforeFiles} to ${afterFiles}`, afterFiles === beforeFiles - 1);
check(`nodes dropped (was ${beforeNodes}, now ${afterNodes})`, afterNodes < beforeNodes);

const noDoomed = rig.searchNodes('willBeDeleted');
check('search for purged symbol → 0 hits (FTS5 trigger fired on cascade)', noDoomed.length === 0);

rig.close();
console.log(pass ? '\nVERIFY: PASS' : '\nVERIFY: FAIL');
process.exit(pass ? 0 : 1);
