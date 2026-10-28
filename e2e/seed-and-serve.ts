// Bun script that boots a fresh Rig project for Playwright tests.
// Writes e2e/.state.json with { url, loginUrl, token, projectRoot, srcId,
// dstId, pendingId }, then keeps serveWeb running until SIGTERM.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rig } from '../packages/core/src/index.ts';
import { serveWeb } from '../packages/web/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(HERE, '.state.json');
const PORT = Number(process.env.E2E_PORT ?? 7475);

const projectRoot = mkdtempSync(join(tmpdir(), 'rig-e2e-'));
writeFileSync(
  join(projectRoot, 'auth.ts'),
  `export function login(user: string): void {}\nexport function logout(): void {}\n`,
);
writeFileSync(
  join(projectRoot, 'store.ts'),
  `import { login } from './auth.ts';\nexport const authStore = { login };\n`,
);
writeFileSync(
  join(projectRoot, 'view.ts'),
  `import { authStore } from './store.ts';\nexport function render() { authStore.login('x'); }\n`,
);

// DeterministicEmbedder so the test doesn't depend on bge model downloads.
const rig = await Rig.init(projectRoot, { embedder: new DeterministicEmbedder() });
await rig.indexAll();
const login = rig.searchNodes('login')[0];
const render = rig.searchNodes('render')[0];
if (!login || !render) throw new Error('seed: failed to find login/render anchors');

const logout = rig.searchNodes('logout')[0];
if (!logout) throw new Error('seed: failed to find logout anchor');
const pendingId1 = rig.writes.proposeEdge(
  {
    src: login.id,
    dst: render.id,
    kind: 'related',
    weight: 0.7,
    rationale: 'e2e seed — render touches login via authStore',
  },
  { sessionId: 'e2e-seed', actor: 'ai:e2e' },
);
const pendingId2 = rig.writes.proposeEdge(
  {
    src: logout.id,
    dst: render.id,
    kind: 'related',
    weight: 0.6,
    rationale: 'e2e seed — second pending for multi-tab test',
  },
  { sessionId: 'e2e-seed', actor: 'ai:e2e' },
);
rig.close();

const handle = await serveWeb({ projectRoot, port: PORT });
writeFileSync(
  STATE_FILE,
  JSON.stringify(
    {
      url: handle.url,
      // The map requires its session token, loopback included. Specs sign in
      // through the same /auth?t= link `rig start` opens.
      loginUrl: `${handle.url}/auth?t=${handle.token}`,
      token: handle.token,
      projectRoot,
      srcId: login.id,
      dstId: render.id,
      pendingId: pendingId1,
      pendingId2,
    },
    null,
    2,
  ),
);
console.log(`e2e: serving ${handle.url} pendingIds=[${pendingId1}, ${pendingId2}]`);

const shutdown = async (): Promise<void> => {
  await handle.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
