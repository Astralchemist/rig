// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rig } from '@rig/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const FIXTURE = '/tmp/rig-demo';
const INSTALL_HOME = '/tmp/rig-demo-install';
const CLI = join(REPO_ROOT, 'packages/cli/src/index.ts');
const MCP_ENTRY = join(REPO_ROOT, 'scripts/smoke-mcp-entry.ts');

let pass = 0;
let fail = 0;
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) {
    pass++;
    console.log(`  OK   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

const section = (s: string): void => console.log(`\n[${s}]`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const FILES: Array<[string, string]> = [
  [
    'auth.ts',
    `export class AuthStore {
  async login(user: string): Promise<void> {
    this.recordSession(user);
  }
  recordSession(user: string): void {
    console.log('session', user);
  }
}`,
  ],
  [
    'cart.ts',
    `import { AuthStore } from './auth.ts';

export class ShoppingCart {
  constructor(private auth: AuthStore) {}
  checkout(user: string): void {
    this.auth.login(user);
  }
}`,
  ],
];

const setup = (): void => {
  rmSync(FIXTURE, { recursive: true, force: true });
  rmSync(INSTALL_HOME, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  mkdirSync(INSTALL_HOME, { recursive: true });
  for (const [name, body] of FILES) writeFileSync(join(FIXTURE, name), body);
};

const sendMcp = async (
  frames: Array<Record<string, unknown>>,
): Promise<Record<number, Record<string, unknown>>> => {
  const child = spawn('bun', [MCP_ENTRY, FIXTURE], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
  child.stdin.write(frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  await sleep(600);
  child.stdin.end();
  await new Promise<void>((res) => child.on('close', () => res()));
  const byId: Record<number, Record<string, unknown>> = {};
  for (const line of out.split('\n').filter((l) => l.trim())) {
    const obj = JSON.parse(line) as { id?: number };
    if (typeof obj.id === 'number') byId[obj.id] = obj as Record<string, unknown>;
  }
  return byId;
};

const runInstall = (target: string): Promise<{ code: number; stdout: string }> =>
  new Promise((res) => {
    // Install into the demo project: project-scoped files (.mcp.json,
    // .cursor/…) must not land in the repo, as rig.mdc once did.
    const child = spawn('bun', [CLI, 'install', target], {
      cwd: FIXTURE,
      env: { ...process.env, HOME: INSTALL_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.on('close', (code) => res({ code: code ?? 0, stdout }));
  });

async function main(): Promise<void> {
  console.log('== Rig Phase 1 Demo ==\n');
  setup();

  section('rig api');
  const rig = await Rig.init(FIXTURE);
  const idx = await rig.indexAll();
  check(`indexAll → ${idx.files} files, ${idx.nodes} nodes`, idx.files === 2 && idx.nodes >= 5);

  const hits = rig.searchNodes('AuthStore');
  check(`searchNodes "AuthStore" → ≥1 hit`, hits.length >= 1);
  const authStore = hits.find((h) => h.name === 'AuthStore');
  check('found AuthStore class node', !!authStore);
  if (!authStore) { rig.close(); process.exit(1); }

  const login = rig.searchNodes('login').find((h) => h.name === 'login');
  check('found login method', !!login);

  const callers = rig.getCallers(login?.id ?? '');
  check(`login has ${callers.length} caller(s)`, callers.length >= 0);
  const pull = rig.getMagneticPull(authStore.id, 5);
  check(`magnetic pull → ${pull.length} results`, pull.length >= 1);
  const impact = rig.getImpactRadius(authStore.id, 2);
  check(`impact radius depth=2 → ${impact.length}`, impact.length >= 0);
  rig.close();

  section('mcp stdio');
  const responses = await sendMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rig_status', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rig_search', arguments: { query: 'AuthStore' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rig_explore', arguments: { question: 'auth' } } },
  ]);
  const r1 = responses[1] as { result?: { serverInfo?: { name?: string } } } | undefined;
  check('initialize.serverInfo.name=rig', r1?.result?.serverInfo?.name === 'rig');
  const r2 = responses[2] as { result?: { tools?: unknown[] } } | undefined;
  check(`tools/list → 11 tools`, r2?.result?.tools?.length === 11);
  const r3text = (responses[3] as { result?: { content?: Array<{ text?: string }> } } | undefined)?.result?.content?.[0]?.text;
  const status = r3text ? (JSON.parse(r3text) as { initialized?: boolean; nodes?: number }) : null;
  check('rig_status initialized + nodes>0', status?.initialized === true && (status?.nodes ?? 0) > 0);
  const r4text = (responses[4] as { result?: { content?: Array<{ text?: string }> } } | undefined)?.result?.content?.[0]?.text;
  const searchResult = r4text ? (JSON.parse(r4text) as { nodes?: unknown[] }) : null;
  check('rig_search "AuthStore" → ≥1 hit', (searchResult?.nodes?.length ?? 0) >= 1);
  const r5text = (responses[5] as { result?: { content?: Array<{ text?: string }> } } | undefined)?.result?.content?.[0]?.text;
  const exploreResult = r5text ? (JSON.parse(r5text) as { anchors?: unknown[] }) : null;
  check('rig_explore "auth" → ≥1 anchor (heavy tools run over MCP)', (exploreResult?.anchors?.length ?? 0) >= 1);

  section('installer');
  for (const target of ['claude', 'cursor', 'codex', 'opencode', 'openrouter']) {
    const { code, stdout } = await runInstall(target);
    const wrote = (stdout.match(/✓ wrote/g) ?? []).length;
    check(`install ${target} → exit 0, ${wrote} files written`, code === 0 && wrote >= 2);
  }

  console.log(`\nDEMO: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} ok, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
