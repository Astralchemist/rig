import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { serveWeb } from '../packages/web/src/index.ts';

// Use the global WebSocket (Bun + Node 22 both ship it).
declare const WebSocket: typeof globalThis.WebSocket;

const PROJECT = '/tmp/rig-demo-p3';
const PORT = 7491;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (label: string, cond: boolean): void => {
  if (cond) {
    pass++;
    console.log(`  OK   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
};
const section = (s: string): void => console.log(`\n[${s}]`);

const setup = (): void => {
  rmSync(PROJECT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(
    join(PROJECT, 'auth.ts'),
    `export class AuthStore {
  async login(user: string): Promise<void> { console.log(user); }
}`,
  );
  writeFileSync(
    join(PROJECT, 'cart.ts'),
    `export class ShoppingCart {
  checkout(): void {}
}`,
  );
};

async function main(): Promise<void> {
  console.log('== Rig Phase 3 Demo ==');
  setup();

  section('index');
  const seed = await Rig.init(PROJECT);
  const idx = await seed.indexAll();
  check(`indexAll → ${idx.nodes} nodes`, idx.nodes >= 4);
  const auth = seed.searchNodes('AuthStore').find((n) => n.name === 'AuthStore');
  const cart = seed.searchNodes('ShoppingCart').find((n) => n.name === 'ShoppingCart');
  check('both anchors found', !!auth && !!cart);
  seed.close();
  if (!auth || !cart) {
    console.log('\nDEMO: FAIL');
    process.exit(1);
  }

  section('serve + ws');
  const handle = await serveWeb({ projectRoot: PROJECT, port: PORT });
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const events: Array<{ type: string; payload?: unknown }> = [];
  ws.addEventListener('message', (ev) => {
    events.push(JSON.parse(ev.data as string) as { type: string });
  });
  await new Promise<void>((res) =>
    ws.addEventListener('open', () => res(), { once: true }),
  );
  check('ws connected', ws.readyState === ws.OPEN);

  section('propose → accept');
  const proposeRes = await fetch(`http://127.0.0.1:${PORT}/api/status`).then((r) => r.json());
  check('server up', !!proposeRes);

  // Propose an edge directly via Rig.writes (simulating an MCP write tool call).
  const r = await Rig.open(PROJECT);
  const pendingId = r.writes.proposeEdge(
    {
      src: auth.id,
      dst: cart.id,
      kind: 'related',
      weight: 0.7,
      rationale: 'shopping cart checkout uses auth.login()',
    },
    { sessionId: 'demo', actor: 'ai:demo' },
  );
  r.close();
  check(`proposed pending edge id=${pendingId}`, pendingId > 0);

  await sleep(500);
  check(
    'WS edge:proposed event delivered',
    events.some((e) => e.type === 'edge:proposed'),
  );

  // List pending via REST
  const pending = (await fetch(`http://127.0.0.1:${PORT}/api/pending-edges`).then((x) =>
    x.json(),
  )) as Array<{ id: number }>;
  check(`REST lists 1 pending edge`, pending.length === 1);

  // Accept via REST
  const accept = await fetch(`http://127.0.0.1:${PORT}/api/pending-edges/${pendingId}/accept`, {
    method: 'POST',
  });
  check('accept returns 200', accept.status === 200);

  await sleep(500);
  check(
    'WS edge:accepted event delivered',
    events.some((e) => e.type === 'edge:accepted'),
  );

  // Verify semantic edge persisted
  const r2 = await Rig.open(PROJECT);
  const semCount = (
    r2.database.adapter
      .prepare(`SELECT COUNT(*) as n FROM edges_semantic`)
      .get() as { n: number }
  ).n;
  check('edges_semantic now has 1 row', semCount === 1);
  r2.close();

  section('undo');
  const undo = (await fetch(`http://127.0.0.1:${PORT}/api/undo`, { method: 'POST' }).then((x) =>
    x.json(),
  )) as { undone: { kind: string } | null };
  check(`undo last (kind=${undo.undone?.kind})`, undo.undone?.kind === 'accept_edge');

  const r3 = await Rig.open(PROJECT);
  const semAfter = (
    r3.database.adapter
      .prepare(`SELECT COUNT(*) as n FROM edges_semantic`)
      .get() as { n: number }
  ).n;
  check('edges_semantic emptied after undo', semAfter === 0);
  const pendingAfter = r3.writes.listPending();
  check('pending restored', pendingAfter.length === 1);
  r3.close();

  section('cleanup');
  ws.close();
  void handle.close();
  rmSync(PROJECT, { recursive: true, force: true });

  console.log(`\nDEMO: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} ok, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
