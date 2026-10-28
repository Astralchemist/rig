// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

const dirSizeBytes = (dir: string): number => {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
};
import { Rig, RIG_DIR_NAME } from '@rig/core';
import { resolvePort } from '@rig/web';
import { allTargetNames, getTarget } from './install/loader.ts';
import { displayPath } from './install/paths.ts';
import { wiredLocations } from './install/uninstall.ts';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

const ok = (name: string, detail: string): Check => ({ name, ok: true, detail });
const warn = (name: string, detail: string, hint: string): Check => ({
  name,
  ok: false,
  detail,
  hint,
});

const checkPort = (port: number): Promise<boolean> =>
  new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.once('listening', () => {
      s.close(() => res(true));
    });
    s.listen(port, '127.0.0.1');
  });

// When the port is occupied, find out whether it's rig's own map server (so we
// don't alarm the user about a server they started). /health returns
// { name: 'rig-web' } — see packages/web/src/server.ts.
const isRigServer = (port: number): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) })
    .then((r) => (r.ok ? (r.json() as Promise<{ name?: string }>) : null))
    .then((b) => b?.name === 'rig-web')
    .catch(() => false);

// Every agent rig is wired into (this project's config or the user-level one),
// plus detected agents it isn't wired into yet.
const agentChecks = async (root: string): Promise<Check[]> => {
  const home = homedir();
  const checks: Check[] = [];
  for (const name of allTargetNames()) {
    const target = getTarget(name)!;
    const wired = wiredLocations(target, root, home);
    if (wired.length) {
      const where = wired.map((w) => displayPath(w.path, root, home)).join(', ');
      checks.push(ok(`agent: ${target.display_name}`, `rig wired in ${where}`));
    } else if (await target.detect()) {
      checks.push(
        warn(`agent: ${target.display_name}`, 'installed, but rig is not wired', `run \`rig install ${name}\``),
      );
    }
  }
  return checks;
};

export async function runDoctor(cwd: string): Promise<void> {
  const checks: Check[] = [];
  const root = resolve(cwd);
  const rigDir = join(root, RIG_DIR_NAME);

  // 1. .rig/ existence
  if (existsSync(rigDir)) {
    checks.push(ok('project initialized', rigDir));
  } else {
    checks.push(
      warn('project initialized', `${rigDir} missing`, 'run `rig init` here'),
    );
  }

  // 2. db schema version
  if (existsSync(join(rigDir, 'rig.db'))) {
    try {
      const rig = await Rig.open(root);
      const versions = rig.database.appliedVersions();
      checks.push(ok('db schema', `versions applied: ${versions.join(', ')}`));
      const status = await rig.status();
      checks.push(
        ok(
          'graph populated',
          `${status.nodes} nodes · ${status.edges_structural + status.edges_semantic} edges · ${status.files} files`,
        ),
      );
      rig.close();
    } catch (e) {
      checks.push(warn('db schema', String(e), 'try `rig index --force`'));
    }
  }

  // 3. bge-small model cache
  const modelDir = join(homedir(), '.cache', 'rig', 'models', 'Xenova', 'bge-small-en-v1.5');
  if (existsSync(modelDir)) {
    const size = (dirSizeBytes(modelDir) / 1024 / 1024).toFixed(1);
    checks.push(ok('embedding model', `bge-small cached (${size}MB at ${modelDir})`));
  } else {
    checks.push(
      warn(
        'embedding model',
        'bge-small not yet downloaded',
        'run `rig index` once — will fetch ~34MB from HuggingFace CDN',
      ),
    );
  }

  // 4. map server port — resolved per project (.rig/config.json → 7474), not
  // hardcoded. On a conflict, `rig serve` walks forward up to +64, so a busy
  // port is a note, not a blocker.
  const port = resolvePort(root);
  const portLabel = `port ${port}`;
  const portFree = await checkPort(port);
  if (portFree) {
    checks.push(ok(portLabel, 'available for `rig serve --web`'));
  } else if (await isRigServer(port)) {
    checks.push(ok(portLabel, 'rig map server already running here'));
  } else {
    checks.push(
      warn(portLabel, 'in use', `\`lsof -i :${port}\` to find the owner — rig will fall forward to the next free port`),
    );
  }

  // 5. agent configs — project-level and user-level
  checks.push(...(await agentChecks(root)));

  // 6. map session token (written the first time the map is served)
  const runtimePath = join(rigDir, '.runtime');
  if (existsSync(runtimePath)) {
    const mode = statSync(runtimePath).mode & 0o777;
    if (mode === 0o600) checks.push(ok('auth token', `.rig/.runtime mode 0600 OK`));
    else
      checks.push(
        warn(
          'auth token',
          `.rig/.runtime mode is ${mode.toString(8)}, expected 600`,
          `chmod 600 ${runtimePath}`,
        ),
      );
  }

  // 7. platform notes
  if (platform() === 'linux' && process.env.WSL_DISTRO_NAME) {
    checks.push(
      warn(
        'platform: WSL',
        'recursive fs.watch is unstable on /mnt/* mounts',
        'work inside the WSL filesystem (not /mnt/c/...) for reliable watcher behavior',
      ),
    );
  }

  // Print report.
  const passCount = checks.filter((c) => c.ok).length;
  const failCount = checks.length - passCount;
  console.log('');
  for (const c of checks) {
    const mark = c.ok ? '✓' : '✗';
    console.log(`  ${mark} ${c.name.padEnd(22)} ${c.detail}`);
    if (c.hint) console.log(`     hint: ${c.hint}`);
  }
  console.log('');
  console.log(`  ${passCount} ok · ${failCount} need attention`);
  if (failCount > 0) process.exitCode = 1;
}
