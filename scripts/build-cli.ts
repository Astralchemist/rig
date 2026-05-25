import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Bundle the CLI into a single node-runnable file. Only @rig/* workspace code
// and local modules are inlined (the @rig/* packages are never published);
// real npm deps stay external and are installed from package.json. Native /
// builtin SQLite bindings are external — factory.ts picks one at runtime.
const ROOT = resolve(import.meta.dir, '..');
const OUT = join(ROOT, 'dist');

const EXTERNAL = [
  'bun:sqlite', // builtin under Bun; never reached under Node
  'better-sqlite3', // optional native fallback for Node
  '@xenova/transformers',
  'web-tree-sitter',
  'tree-sitter-wasms',
  'ignore',
  'zod',
  'fastify',
  '@fastify/compress',
  '@fastify/cors',
  '@fastify/static',
  'ws',
  'jsonc-parser',
];

await rm(OUT, { recursive: true, force: true });

const res = await Bun.build({
  entrypoints: [join(ROOT, 'packages/cli/src/index.ts')],
  outdir: OUT,
  target: 'node',
  external: EXTERNAL,
  // Keep the bun:sqlite / better-sqlite3 adapters in lazy chunks so the Node
  // entry never statically imports `bun:sqlite` (whose URL scheme Node rejects
  // at load). factory.ts only dynamically imports the right one at runtime.
  splitting: true,
});

if (!res.success) {
  for (const log of res.logs) console.error(log);
  process.exit(1);
}

// The source entry carries a `#!/usr/bin/env bun` shebang; rewrite to node so
// the published bin runs under either runtime, and name it dist/rig.js.
const built = join(OUT, 'index.js');
const code = (await readFile(built, 'utf8')).replace(/^#![^\n]*\n/, '');
const binPath = join(OUT, 'rig.js');
await writeFile(binPath, '#!/usr/bin/env node\n' + code);
await rm(built, { force: true });
await chmod(binPath, 0o755);

console.log('✓ build:cli → dist/rig.js');
