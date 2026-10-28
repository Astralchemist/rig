// SPDX-License-Identifier: Apache-2.0
// `bun test` preload (wired in bunfig.toml). wasm-embedded.ts is gitignored —
// generated from node_modules by `bun run gen:wasm` — and grammars.ts imports
// it, so a fresh clone couldn't run the suite without that manual step.
// Generate it only when missing: normal runs pay a single stat.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const WASM_EMBEDDED = resolve(import.meta.dir, '../packages/core/src/extract/wasm-embedded.ts');

if (!existsSync(WASM_EMBEDDED)) await import('./gen-wasm.ts');
