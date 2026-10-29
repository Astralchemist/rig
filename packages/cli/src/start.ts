// SPDX-License-Identifier: Apache-2.0
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rig } from '@rig/core';
import { findAssetRoot } from '@rig/core/asset-root.ts';
import { serveWeb } from '@rig/web';
import toolsManifest from '../../../generated/mcp/tools-manifest.json' with { type: 'json' };
import { deriveProjectName, ensureInit } from './init.ts';
import { openUrl } from './open-url.ts';
import { banner, dim, endProgress, line, makeProgress, sym } from './ui.ts';
import { describeWiring, wireDetectedAgents } from './install/wire.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = join(findAssetRoot(HERE), 'generated/installer');

const flag = (n: string): boolean => process.argv.includes(n);
const opt = (n: string): string | undefined => {
  const i = process.argv.indexOf(n);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

// The one-shot onboarding flow: init → open the live map → index (streaming
// progress so the map assembles in real time) → wire detected agents. Does NOT
// run MCP in-process — the wired agent spawns its own `rig serve --mcp` on
// demand; this process just keeps the web map alive.
export const runStart = async (cwd: string): Promise<void> => {
  const root = resolve(cwd);
  const project = deriveProjectName(root);

  const init = await ensureInit(root);

  // Open the map first so it's connected before nodes start landing. The WS
  // file watcher fires db:changed as the index writes; we add explicit
  // index:progress ticks for phase + counts.
  const portStr = opt('--port');
  const host = opt('--host');
  const web = await serveWeb({
    projectRoot: root,
    auth: 'auto',
    // Started below, once the initial index is done.
    watch: false,
    ...(portStr ? { port: Number.parseInt(portStr, 10) } : {}),
    ...(host ? { host } : {}),
  });
  const mapUrl = web.token ? `${web.url}/auth?t=${web.token}` : web.url;

  banner(project, mapUrl);
  line(init.created ? sym.ok : sym.dot, init.created ? 'initialized' : 'already set up', init.rigDir);
  if (!flag('--no-open')) openUrl(mapUrl);
  line(sym.ok, 'map live', web.url);

  const progress = makeProgress();
  const rig = await Rig.open(root);
  try {
    const r = await rig.indexAll({
      onProgress: (p) => {
        progress(p);
        web.ws.broadcast({
          type: 'index:progress',
          ts: Date.now(),
          payload: { phase: p.phase, current: p.current, total: p.total, detail: p.detail },
        });
      },
    });
    endProgress();
    const skills = rig.seedSkills((toolsManifest as { tools: { name: string; description: string; tier: string }[] }).tools);
    web.ws.broadcast({
      type: 'index:progress',
      ts: Date.now(),
      payload: { phase: 'done', done: true, nodes: r.nodes, edges: r.edges, files: r.files },
    });
    line(sym.ok, 'indexed', `${r.nodes} nodes · ${r.edges} edges · ${r.files} files · ${skills} skills`);
  } finally {
    rig.close();
  }
  // Keep the map live while it is open (RIG_NO_WATCH=1 / --no-watch to skip).
  if (web.rig.watch()) line(sym.ok, 'watching', 'the graph follows file changes');

  if (!flag('--no-wire')) {
    // Project scope only: list every file written so nothing changes unseen.
    const report = await wireDetectedAgents({
      rigBin: opt('--bin') ?? 'rig',
      generatedDir: GENERATED_DIR,
      projectRoot: root,
      // --no-hooks: no automatic-capture hooks (see `rig install --no-hooks`).
      ...(flag('--no-hooks') ? { skipRoles: ['hooks'] } : {}),
    });
    for (const w of describeWiring(report, root)) {
      line(w.ok ? sym.ok : sym.dot, w.label, w.detail);
      for (const f of w.files) process.stderr.write(`      ${dim(f)}\n`);
    }
  }

  process.stderr.write(`\n  ${dim('press Ctrl-C to stop the map.')}\n`);

  const shutdown = async (): Promise<never> => {
    await web.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGPIPE', () => {});
  await new Promise<void>(() => {});
};
