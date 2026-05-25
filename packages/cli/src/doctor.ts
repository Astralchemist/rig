// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

const detectAgents = (): { name: string; configPath: string; present: boolean }[] => {
  const home = homedir();
  return [
    { name: 'Claude Code', configPath: join(home, '.claude.json') },
    { name: 'Cursor', configPath: join(home, '.cursor/mcp.json') },
    { name: 'Codex CLI', configPath: join(home, '.codex/config.toml') },
    { name: 'opencode', configPath: join(home, '.config/opencode/opencode.jsonc') },
    { name: 'openrouter', configPath: join(home, '.config/openrouter/mcp.json') },
  ].map((a) => ({ ...a, present: existsSync(a.configPath) }));
};

const hasRigEntry = (configPath: string): boolean => {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return raw.includes('"rig"') || raw.includes('[mcp_servers.rig]');
  } catch {
    return false;
  }
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

  // 4. port 7474
  const portFree = await checkPort(7474);
  if (portFree) {
    checks.push(ok('port 7474', 'available for `rig serve --web`'));
  } else if (await isRigServer(7474)) {
    checks.push(ok('port 7474', 'rig map server already running here'));
  } else {
    checks.push(
      warn('port 7474', 'in use by another process', '`lsof -i :7474` to find the owner, or pass --port'),
    );
  }

  // 5. agent configs
  for (const a of detectAgents()) {
    if (a.present) {
      const wired = hasRigEntry(a.configPath);
      if (wired) checks.push(ok(`agent: ${a.name}`, `rig MCP entry present in ${a.configPath}`));
      else
        checks.push(
          warn(
            `agent: ${a.name}`,
            `${a.configPath} exists but no rig entry`,
            `run \`rig install ${a.name.toLowerCase().split(' ')[0]}\``,
          ),
        );
    }
  }

  // 6. runtime token freshness (only meaningful when --auth is on)
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
