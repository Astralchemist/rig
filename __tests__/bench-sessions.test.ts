// SPDX-License-Identifier: Apache-2.0
// The multi-session memory bench (scripts/bench, --mode sessions). Every model
// call goes through a mocked fetch; nothing here touches the network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { runConversation } from '../scripts/bench/agent.ts';
import type { Arm } from '../scripts/bench/arms.ts';
import {
  answerSection,
  checkSessionAnswer,
  validateSessionExpected,
} from '../scripts/bench/criteria.ts';
import { SESSION_PROFILES, estimateSessions, runCost } from '../scripts/bench/plan.ts';
import type { ModelPricing } from '../scripts/bench/pricing.ts';
import { AnthropicProvider, OpenRouterProvider } from '../scripts/bench/providers.ts';
import {
  aggregateSessions,
  bootstrapPaired,
  mergeSessionsFiles,
  renderSessionsMarkdown,
  verdictFor,
  type PairedDelta,
} from '../scripts/bench/report-sessions.ts';
import {
  CONFIRMATION_RULE,
  NOTES_BEGIN,
  PREREGISTERED_BAR,
  SESSION_SYSTEM_PROMPT,
  TrialStore,
  checkSecrets,
  installedParagraph,
  loadSessionsFile,
  parseMemoryArms,
  runSessionsLoop,
  runTrial,
  selectTasks,
  sessionBootstrap,
  snapshotIndex,
  validateSessionsFile,
  waypointGuidance,
} from '../scripts/bench/sessions.ts';
import {
  newSessionsFile,
  sessionOverheads,
  sessionsPlanLines,
  taskShapes,
} from '../scripts/bench/sessions-run.ts';
import type {
  QueriesFile,
  SessionRunResult,
  SessionTask,
  SessionsBenchFile,
  SessionsFile,
} from '../scripts/bench/types.ts';

const ROOT = resolve(__dirname, '..');
const SESSIONS = resolve(ROOT, 'scripts/bench/sessions.json');
const BENCH_TARGET = join(process.env.HOME ?? '', 'Development/rig-bench/next-auth');

interface Body {
  messages: { role: string; content: string | null; tool_calls?: unknown[] }[];
  tools?: { function: { name: string } }[];
}

const reply = (message: Record<string, unknown>, cost = 0.001) =>
  new Response(
    JSON.stringify({
      model: 'anthropic/claude-haiku-5.5-20261007',
      provider: 'Anthropic',
      choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const toolCall = (id: string, name: string, args: unknown) => ({
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

// A fetch that answers with whatever `policy` returns for each request body.
const policyFetch = (policy: (body: Body) => Record<string, unknown>) => {
  const bodies: Body[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Body;
    bodies.push(body);
    return reply(policy(body));
  }) as unknown as typeof fetch;
  return { fetch: f, bodies };
};

const noSleep = { sleep: async () => {}, random: () => 1 };

const echoArm = (): Arm => ({
  name: 'baseline',
  tools: [{ name: 'rg', description: 'ripgrep', input_schema: { type: 'object' } }],
  exec: async (name) => `result of ${name}`,
});

describe('scripted conversation loop', () => {
  test('each user message runs the tool loop; history carries over; usage sums', async () => {
    const script = [
      toolCall('c1', 'rg', { args: ['x'] }),
      { content: 'first answer' },
      { content: 'second answer' },
    ];
    const { fetch, bodies } = policyFetch(() => script.shift()!);
    const p = new OpenRouterProvider('m', 'k', { fetch, ...noSleep });
    const o = await runConversation(p, echoArm(), ['hello', 'and then?'], {
      maxTurns: 4,
      maxTokens: 100,
    });
    expect(o.replies).toEqual(['first answer', 'second answer']);
    expect(o.stops).toEqual(['answer', 'answer']);
    expect(o.final_text).toBe('second answer');
    expect(o.model_calls).toBe(3);
    expect(o.prompt_tokens).toBe(300);
    expect(o.cost_usd).toBeCloseTo(0.003);
    expect(o.tool_calls).toEqual({ rg: 1 });
    // The second user message follows the first answer, in one conversation.
    expect(bodies[2]!.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    expect(bodies[2]!.messages.at(-1)!.content).toBe('and then?');
    expect(bodies[2]!.messages[4]!.content).toBe('first answer');
  });

  test('a message that runs out of turns hands over to the next; the last decides', async () => {
    const script = [toolCall('c1', 'rg', {}), { content: 'late answer' }];
    const { fetch, bodies } = policyFetch(() => script.shift()!);
    const p = new OpenRouterProvider('m', 'k', { fetch, ...noSleep });
    const o = await runConversation(p, echoArm(), ['one', 'two'], { maxTurns: 1, maxTokens: 10 });
    expect(o.stops).toEqual(['turn_limit', 'answer']);
    expect(o.stop).toBe('answer');
    expect(o.replies).toEqual(['late answer']);
    expect(bodies[1]!.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    // Out of turns on the last message: no answer.
    const again = [toolCall('c1', 'rg', {})];
    const f2 = policyFetch(() => again.shift() ?? toolCall('c2', 'rg', {}));
    const o2 = await runConversation(
      new OpenRouterProvider('m', 'k', { fetch: f2.fetch, ...noSleep }),
      echoArm(),
      ['one'],
      { maxTurns: 2, maxTokens: 10 },
    );
    expect(o2.stop).toBe('turn_limit');
    expect(o2.final_text).toBe('');
  });

  test('an error ends the conversation', async () => {
    const f = (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch;
    const p = new OpenRouterProvider('m', 'k', { fetch: f, ...noSleep });
    const o = await runConversation(p, echoArm(), ['a', 'b'], { maxTurns: 3, maxTokens: 10 });
    expect(o.stop).toBe('error');
    expect(o.stops).toEqual(['error']);
    expect(o.error).toContain('HTTP 400');
  });

  test('Anthropic: a user message after unanswered tool results joins that user turn', async () => {
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    const replies = [
      { content: [{ type: 'tool_use', id: 't1', name: 'rg', input: {} }] },
      { content: [{ type: 'text', text: 'done' }] },
    ];
    const f = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(
        JSON.stringify({ ...replies.shift(), usage: { input_tokens: 5, output_tokens: 1 } }),
      );
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider('claude-haiku-5-5', 'k', null, { fetch: f, ...noSleep });
    const o = await runConversation(p, echoArm(), ['one', 'two'], { maxTurns: 1, maxTokens: 10 });
    expect(o.stops).toEqual(['turn_limit', 'answer']);
    const msgs = bodies[1]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'result of rg' },
      { type: 'text', text: 'two' },
    ]);
  });
});

describe('session criteria', () => {
  const e = {
    all: ['/strategy\\s*=\\s*jwt/i'],
    must_not: ['/strategy\\s*=\\s*database/i'],
    none: ['/config\\s*=\\s*none/i'],
  };

  test('checks only the text after the last marker; must_not is a trap hit', () => {
    const ok = checkSessionAnswer(
      'init.ts says strategy = database by default, but we decided otherwise.\nANSWER: strategy=jwt',
      e,
      'ANSWER:',
    );
    expect(ok).toMatchObject({ pass: true, trapped: [], marker_found: true });
    const trapped = checkSessionAnswer('ANSWER: strategy=database', e, 'ANSWER:');
    expect(trapped.pass).toBe(false);
    expect(trapped.trapped).toEqual(['/strategy\\s*=\\s*database/i']);
    expect(trapped.missing).toEqual(['/strategy\\s*=\\s*jwt/i']);
    // `none` stays a plain forbidden pattern, not a trap hit.
    const forbidden = checkSessionAnswer('ANSWER: strategy=jwt; config=none', e, 'ANSWER:');
    expect(forbidden).toMatchObject({
      pass: false,
      trapped: [],
      forbidden: ['/config\\s*=\\s*none/i'],
    });
    // The last marker wins; no marker means the whole text.
    expect(answerSection('ANSWER: a\nANSWER: b', 'ANSWER:')).toBe(' b');
    const whole = checkSessionAnswer('strategy=jwt, not strategy=database', e, 'ANSWER:');
    expect(whole).toMatchObject({ pass: false, marker_found: false });
    expect(whole.trapped).toHaveLength(1);
  });

  test('validation rejects bad must_not patterns and malformed task files', () => {
    expect(() => validateSessionExpected('t', { all: ['x'], must_not: ['/(/'] })).toThrow(
      'bad regex',
    );
    expect(() => validateSessionExpected('t', { must_not: ['x'] })).toThrow('needs all or any');
    const task = (over: Partial<SessionTask>): SessionTask => ({
      id: 't',
      type: 'decision',
      trap: false,
      session1: ['a', 'b'],
      session2: 'q? ANSWER: x=<y>',
      oracle: 'notes',
      reference: 'ANSWER: x=y',
      expected: { all: ['x=y'] },
      ...over,
    });
    const file = (t: SessionTask): SessionsFile => ({ answer_marker: 'ANSWER:', tasks: [t] });
    expect(() => validateSessionsFile(file(task({})))).not.toThrow();
    expect(() => validateSessionsFile(file(task({ session1: ['only one'] })))).toThrow('2-4');
    expect(() => validateSessionsFile(file(task({ session2: 'no marker' })))).toThrow('ANSWER:');
    expect(() => validateSessionsFile(file(task({ trap: true })))).toThrow('trap task needs');
    expect(() =>
      validateSessionsFile(file(task({ expected: { all: ['x'], must_not: ['y'] } }))),
    ).toThrow('must_not is for trap tasks');
  });

  // What an answer from the code alone says on each trap task.
  const TRAP_ANSWERS: Record<string, string> = {
    'jwt-only-with-adapter': 'ANSWER: strategy=database; config=none',
    'fork-default-max-age': 'ANSWER: default_max_age=2592000',
    'vendored-cookie': 'ANSWER: file=packages/core/src/lib/vendored/cookie.ts',
    'cookie-chunk-size': 'ANSWER: change=lower CHUNK_SIZE in lib/utils/cookie.ts and trim the jwt',
    'base-path': 'ANSWER: callback_url=https://app.acme.dev/api/auth/callback/github',
    'session-cookie-name': 'ANSWER: cookie=__Secure-authjs.session-token',
    'email-sender': 'ANSWER: from=Auth.js <no-reply@authjs.dev>',
    'sign-in-theme': 'ANSWER: color_scheme=auto; brand_color=',
    'secret-env-var': 'ANSWER: env_var=AUTH_SECRET',
    'iframe-same-site': 'ANSWER: same_site=lax',
    'forwarded-headers':
      'ANSWER: change=have the ingress forward X-Forwarded-Host and X-Forwarded-Proto',
  };
  const TYPES = ['decision', 'constraint', 'dead-end', 'discovery'] as const;

  test('sessions.json: two sets of 10 valid pairs, typed and trapped as registered', () => {
    const sf = loadSessionsFile(SESSIONS);
    expect(sf.tasks).toHaveLength(20);
    const first = selectTasks(sf.tasks, { set: 'first' });
    const confirmation = selectTasks(sf.tasks, { set: 'confirmation' });
    expect([first.length, confirmation.length]).toEqual([10, 10]);
    // Tasks 1-10 come first, then 11-20.
    expect(sf.tasks.slice(10)).toEqual(confirmation);
    for (const set of [first, confirmation]) {
      for (const type of TYPES) {
        expect(set.filter((t) => t.type === type).length).toBeGreaterThanOrEqual(2);
      }
    }
    expect(first.filter((t) => t.trap)).toHaveLength(4);
    expect(confirmation.filter((t) => t.trap).length).toBeGreaterThanOrEqual(6);
    for (const t of sf.tasks) {
      const ref = checkSessionAnswer(t.reference, t.expected, sf.answer_marker);
      expect({ id: t.id, ...ref }).toMatchObject({ id: t.id, pass: true, marker_found: true });
      // Session 2 never gives its answer away: asked of itself, it fails.
      expect({
        id: t.id,
        pass: checkSessionAnswer(t.session2, t.expected, 'ANSWER:').pass,
      }).toEqual({ id: t.id, pass: false });
    }
    for (const t of sf.tasks.filter((x) => x.trap)) {
      const hit = checkSessionAnswer(TRAP_ANSWERS[t.id]!, t.expected, sf.answer_marker);
      expect({ id: t.id, pass: hit.pass, trapped: hit.trapped.length > 0 }).toEqual({
        id: t.id,
        pass: false,
        trapped: true,
      });
    }
    // Confirmation traps state their fact as a literal only session 1 holds;
    // validation checks session 1 has it and session 2 doesn't.
    expect(confirmation.filter((t) => t.trap && t.secret).length).toBeGreaterThanOrEqual(6);
    // The pin is the single-shot bench's: sessions.json carries none of its own.
    expect((sf as unknown as { target?: unknown }).target).toBeUndefined();
  });

  const FIRST_RUN = resolve(ROOT, 'scripts/bench/results/2026-10-29-sessions-0.3.0.json');
  test.skipIf(!existsSync(FIRST_RUN))(
    'tasks 1-10 are exactly the tasks the first run used (the confirmation changes none)',
    () => {
      const run = JSON.parse(readFileSync(FIRST_RUN, 'utf-8')) as SessionsBenchFile;
      expect(selectTasks(loadSessionsFile(SESSIONS).tasks, { set: 'first' })).toEqual(run.tasks);
    },
  );

  test('validation: a secret must be stated in session 1 and never in session 2', () => {
    const base: SessionTask = { ...trapTask, secret: 'acme_sid' };
    const file = (t: SessionTask): SessionsFile => ({ answer_marker: 'ANSWER:', tasks: [t] });
    expect(() =>
      validateSessionsFile(file({ ...base, session1: ['the cookie is acme_sid', 'ok'] })),
    ).not.toThrow();
    expect(() => validateSessionsFile(file(base))).toThrow('session 1 never states its secret');
    expect(() =>
      validateSessionsFile(
        file({
          ...base,
          session1: ['the cookie is acme_sid', 'ok'],
          session2: 'is it ACME_SID? ANSWER: cookie=<name>',
        }),
      ),
    ).toThrow('session 2 gives away its secret');
  });

  test.skipIf(!existsSync(join(BENCH_TARGET, 'packages/core/src/lib/init.ts')))(
    "each trap's code evidence is in the pinned target, and no secret is",
    async () => {
      const { checkSecrets, checkTrapEvidence } = await import('../scripts/bench/sessions.ts');
      const qf = JSON.parse(
        readFileSync(resolve(ROOT, 'scripts/bench/queries.json'), 'utf-8'),
      ) as QueriesFile;
      expect(qf.target.commit).toMatch(/^[0-9a-f]{40}$/);
      const tasks = loadSessionsFile(SESSIONS).tasks;
      const ev = checkTrapEvidence(BENCH_TARGET, tasks);
      expect(ev.length).toBe(tasks.filter((t) => t.trap).length);
      expect(ev.filter((e) => !e.found)).toEqual([]);
      const secrets = checkSecrets(BENCH_TARGET, tasks);
      expect(secrets.length).toBeGreaterThanOrEqual(6);
      expect(secrets.filter((x) => x.in_code)).toEqual([]);
    },
  );

  test('the secret search reads the checkout and skips dependencies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-membench-secret-'));
    try {
      writeFileSync(join(dir, 'a.ts'), 'export const name = "ACME_SID";\n');
      const nm = join(dir, 'node_modules', 'x');
      mkdirSync(nm, { recursive: true });
      writeFileSync(join(nm, 'b.js'), 'login@acme.dev');
      const t = (id: string, secret: string): SessionTask => ({ ...trapTask, id, secret });
      expect(checkSecrets(dir, [t('a', 'acme_sid'), t('b', 'login@acme.dev')])).toEqual([
        { task_id: 'a', secret: 'acme_sid', in_code: true },
        { task_id: 'b', secret: 'login@acme.dev', in_code: false },
      ]);
      expect(checkSecrets(dir, [trapTask])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installed instructions', () => {
  test('memory-on quotes the generated installer paragraphs verbatim', () => {
    const md = readFileSync(resolve(ROOT, 'generated/installer/claude.instructions.md'), 'utf-8');
    expect(md).toContain(`\n${waypointGuidance()}\n`);
    expect(md).toContain(`\n${sessionBootstrap()}\n`);
    expect(waypointGuidance()).toStartWith('Drop a waypoint via `rig_drop_waypoint` when:');
    expect(sessionBootstrap()).toContain('`session_id="last"`');
    expect(() => installedParagraph('Nope', md)).toThrow('no installed paragraph');
    expect(() => installedParagraph('Drop', '# nothing here')).toThrow('Session bootstrap');
  });

  test('the bar and the confirmation rule are in the README verbatim', () => {
    const readme = readFileSync(resolve(ROOT, 'scripts/bench/README.md'), 'utf-8');
    expect(readme).toContain(`> ${PREREGISTERED_BAR}`);
    expect(readme).toContain(`> ${CONFIRMATION_RULE}`);
    expect(CONFIRMATION_RULE).toStartWith('Confirmation (written 2026-10-29, after the first');
  });
});

// A model that behaves like an agent using rig's memory when it has the
// tools, and answers from whatever it can see otherwise.
const FACT = 'Sessions stay JWT';
const trapTask: SessionTask = {
  id: 'jwt',
  type: 'decision',
  trap: true,
  session1: ['We keep sessions JWT; database sessions were rejected.', 'Keep that in mind.'],
  session2: 'Which strategy? ANSWER: strategy=<jwt|database>',
  oracle: `${FACT}: database sessions were rejected.`,
  reference: 'ANSWER: strategy=jwt',
  expected: { all: ['/strategy\\s*=\\s*jwt/i'], must_not: ['/strategy\\s*=\\s*database/i'] },
  code_evidence: [{ file: 'auth.ts', pattern: 'database' }],
};

interface Seen {
  // Waypoints an unfiltered rig_waypoints call saw at the start of session 1.
  preexisting: number[];
  systems: string[];
}

const memoryModel = (seen: Seen) => (body: Body) => {
  const tools = new Set((body.tools ?? []).map((t) => t.function.name));
  const msgs = body.messages;
  const system = msgs[0]!.content ?? '';
  const tail = msgs.slice(msgs.findLastIndex((m) => m.role === 'user'));
  const toolMsgs = tail.filter((m) => m.role === 'tool');
  const userTurns = msgs.filter((m) => m.role === 'user').length;
  if (toolMsgs.length === 0 && msgs.length === 2) seen.systems.push(system);
  if (tools.has('rig_drop_waypoint') && userTurns === 1) {
    if (toolMsgs.length === 0) return toolCall('w0', 'rig_waypoints', {});
    if (toolMsgs.length === 1) {
      const listed = JSON.parse(toolMsgs[0]!.content!) as { waypoints: unknown[] };
      seen.preexisting.push(listed.waypoints.length);
      return toolCall('w1', 'rig_drop_waypoint', {
        kind: 'decision',
        title: FACT,
        summary: 'Sessions stay JWT; database sessions were rejected for Edge latency.',
        rationale: 'The user locked this decision.',
      });
    }
  }
  if (tools.has('rig_waypoints') && !tools.has('rig_drop_waypoint') && toolMsgs.length === 0) {
    return toolCall('w2', 'rig_waypoints', { session_id: 'last', limit: 20 });
  }
  const knows =
    system.includes(FACT) || msgs.some((m) => m.role === 'tool' && m.content?.includes(FACT));
  const wantsAnswer = msgs
    .filter((m) => m.role === 'user')
    .at(-1)!
    .content!.includes('ANSWER:');
  if (!wantsAnswer) return { content: 'noted' };
  return { content: knows ? 'ANSWER: strategy=jwt' : 'ANSWER: strategy=database' };
};

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('per-trial isolation', () => {
  let project: string;
  let work: string;
  let srcDb: string;
  let srcHash: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-membench-target-'));
    work = mkdtempSync(join(tmpdir(), 'rig-membench-work-'));
    writeFileSync(
      join(project, 'auth.ts'),
      'export const strategy = (adapter: unknown) => (adapter ? "database" : "jwt");\n',
    );
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    rig.close();
    // bun:sqlite defers closing a connection that still has prepared
    // statements until they are collected, and that close checkpoints the
    // WAL into rig.db. Settle it now so the hash below is the final file.
    Bun.gc(true);
    srcDb = join(project, '.rig', 'rig.db');
    srcHash = sha(srcDb);
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test('snapshot copies the index without touching it', () => {
    const snap = snapshotIndex(project, join(work, 'snap-only'));
    expect(snap.nodes).toBeGreaterThan(0);
    expect(snap.waypoints).toBe(0);
    expect(snap.sha256).toBe(sha(snap.path));
    expect(sha(srcDb)).toBe(srcHash);
  });

  test('a trial copy is private: writes never reach another copy or the snapshot', async () => {
    const snap = snapshotIndex(project, join(work, 'private'));
    const store = new TrialStore(project, snap, join(work, 'private'), new DeterministicEmbedder());
    const a = store.open();
    a.rig.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'Only in A',
        summary: 'written to copy A only',
        rationale: 'test',
      },
      { sessionId: 's-a', actor: 'ai:test' },
    );
    const b = store.open();
    expect(a.rig.getWaypoints()).toHaveLength(1);
    expect(b.rig.getWaypoints()).toHaveLength(0);
    // session_id="last" never resolves to the caller's own session, which is
    // why session 2 needs an id of its own.
    expect(a.rig.getWaypoints({ sessionId: 'last', callerSessionId: 's-a' })).toHaveLength(0);
    expect(a.rig.getWaypoints({ sessionId: 'last', callerSessionId: 's-b' })).toHaveLength(1);
    await a.dispose();
    await b.dispose();
    expect(existsSync(a.path)).toBe(false);
    expect(sha(snap.path)).toBe(snap.sha256);
  });

  test('memory-on carries session 1 to session 2; nothing leaks across trials or arms', async () => {
    const dir = join(work, 'loop');
    const snap = snapshotIndex(project, dir);
    const opened: string[] = [];
    class CountingStore extends TrialStore {
      override open() {
        const db = super.open();
        opened.push(db.path);
        return db;
      }
    }
    const store = new CountingStore(project, snap, dir, new DeterministicEmbedder());
    const seen: Seen = { preexisting: [], systems: [] };
    const { fetch } = policyFetch(memoryModel(seen));
    const provider = new OpenRouterProvider('m', 'k', { fetch, ...noSleep });
    const file = { results: [] as SessionRunResult[] } as SessionsBenchFile;
    const arms = parseMemoryArms('memory-off,memory-on,oracle,grep-only');
    await runSessionsLoop(provider, store, file, {
      arms,
      tasks: [trapTask],
      trials: 3,
      maxTurns: 6,
      maxTokens: 100,
      marker: 'ANSWER:',
    });
    const of = (arm: string) => file.results.filter((r) => r.arm === arm);
    expect(file.results).toHaveLength(12);

    for (const r of of('memory-on')) {
      expect(r.waypoints.map((w) => w.title)).toEqual([FACT]);
      expect(r.recalled).toBe(1);
      expect(r.check.pass).toBe(true);
      expect(r.s2.tool_calls.rig_waypoints).toBe(1);
    }
    // Every memory-on session 1 started from an index with no waypoints:
    // earlier trials' writes never reached a later trial.
    expect(seen.preexisting).toEqual([0, 0, 0]);
    for (const r of of('memory-off')) {
      expect(r.s1).not.toBeNull();
      expect(r.waypoints).toEqual([]);
      expect(r.recalled).toBeNull();
      expect(r.check.trapped).toHaveLength(1);
    }
    for (const r of of('oracle')) {
      expect(r.s1).toBeNull();
      expect(r.check.pass).toBe(true);
    }
    for (const r of of('grep-only')) expect(r.check.pass).toBe(false);

    // Distinct session ids within a trial and across all of them.
    const ids = file.results.flatMap((r) => [r.s1?.session_id, r.s2.session_id]).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    // memory-off and memory-on run two sessions, but only memory-off resets:
    // 2 copies + 1 + 1 + 1 per trial.
    expect(opened).toHaveLength(3 * 5);
    expect(new Set(opened).size).toBe(opened.length);
    // Copies are deleted after each trial; the source index never changed.
    expect(readdirSync(join(dir, 'trials'))).toEqual([]);
    expect(sha(srcDb)).toBe(srcHash);
    expect(sha(snap.path)).toBe(snap.sha256);

    // Prompts: memory-on quotes the installed paragraphs; the rest share one.
    expect(seen.systems.filter((s) => s.includes(waypointGuidance()))).toHaveLength(3);
    expect(seen.systems.filter((s) => s.includes(sessionBootstrap()))).toHaveLength(3);
    expect(seen.systems.filter((s) => s.includes(NOTES_BEGIN))).toHaveLength(3);
    expect(seen.systems.filter((s) => s === SESSION_SYSTEM_PROMPT)).toHaveLength(9);
  });

  test('session ids differ even when the id source repeats itself', async () => {
    const dir = join(work, 'ids');
    const snap = snapshotIndex(project, dir);
    const store = new TrialStore(project, snap, dir, new DeterministicEmbedder());
    const { fetch } = policyFetch(memoryModel({ preexisting: [], systems: [] }));
    const provider = new OpenRouterProvider('m', 'k', { fetch, ...noSleep });
    const ids = ['same', 'same', 'other'];
    const r = await runTrial(provider, store, trapTask, 'memory-on', 0, {
      maxTurns: 6,
      maxTokens: 100,
      marker: 'ANSWER:',
      newSessionId: () => ids.shift()!,
    });
    expect(r.s1!.session_id).toBe('same');
    expect(r.s2.session_id).toBe('other');
    expect(r.recalled).toBe(1);
  });
});

const result = (over: Partial<SessionRunResult> & Pick<SessionRunResult, 'task_id' | 'arm'>) => {
  const session = (tokens: number) => ({
    session_id: 's',
    messages: 1,
    prompt_tokens: tokens,
    completion_tokens: 0,
    cost_usd: tokens / 1e6,
    model_calls: 2,
    tool_turns: 1,
    tool_calls: {},
    tool_chars: {},
    stop: 'answer' as const,
    stops: ['answer' as const],
    replies: ['ANSWER: x'],
    final_text: 'ANSWER: x',
    resolved_models: ['m-1'],
    upstreams: [],
    elapsed_ms: 1,
  });
  return {
    trial: 0,
    s1: session(10_000),
    s2: session(5_000),
    waypoints: [],
    recalled: null,
    check: {
      pass: true,
      missing: [],
      any_matched: [],
      forbidden: [],
      trapped: [],
      marker_found: true,
    },
    ...over,
  } satisfies SessionRunResult;
};

const delta = (over: Partial<PairedDelta>): PairedDelta => ({
  pairs: 30,
  tasks: 10,
  on_rate: 0.6,
  off_rate: 0.3,
  delta: 0.3,
  ci: [0.2, 0.4],
  on_median_tokens: 100,
  off_median_tokens: 100,
  token_ratio: 1,
  token_ratio_ci: [0.9, 1.1],
  iterations: 1000,
  seed: 1,
  ...over,
});

describe('verdict against the pre-registered bar', () => {
  test('PASS, FAIL and INCONCLUSIVE', () => {
    expect(verdictFor(delta({})).verdict).toBe('PASS');
    // Exactly on the threshold passes: the bar says ≥ 15 pp.
    expect(verdictFor(delta({ ci: [0.15, 0.3] })).verdict).toBe('PASS');
    expect(verdictFor(delta({ delta: 0.05, ci: [-0.05, 0.149] })).verdict).toBe('FAIL');
    const straddle = verdictFor(delta({ delta: 0.2, ci: [0.05, 0.35] }));
    expect(straddle.verdict).toBe('INCONCLUSIVE');
    expect(straddle.reason).toContain('straddles 15.0 pp');
    // Over the token cap fails, however good the success delta.
    const pricey = verdictFor(delta({ token_ratio: 1.11 }));
    expect(pricey.verdict).toBe('FAIL');
    expect(pricey.reason).toContain('111.0%');
    expect(verdictFor(delta({ token_ratio: 1.1 })).verdict).toBe('PASS');
    expect(verdictFor(delta({ token_ratio: null })).verdict).toBe('INCONCLUSIVE');
  });

  test('the bootstrap is paired, clustered by task and reproducible', () => {
    const pairs = Array.from({ length: 10 }, (_, t) =>
      [0, 1, 2].map((trial) => ({
        task: `t${t}`,
        trial,
        on: t < 6 ? 1 : 0,
        off: t < 2 ? 1 : 0,
        on_tokens: 110,
        off_tokens: 100,
      })),
    ).flat();
    const a = bootstrapPaired(pairs, { iterations: 2000, seed: 7 })!;
    const b = bootstrapPaired(pairs, { iterations: 2000, seed: 7 })!;
    expect(a).toEqual(b);
    expect(a.delta).toBeCloseTo(0.4);
    expect(a.ci[0]).toBeLessThan(0.4);
    expect(a.ci[1]).toBeGreaterThan(0.4);
    expect(a.token_ratio).toBeCloseTo(1.1);
    // Every pair agreeing gives a zero-width interval.
    const same = bootstrapPaired(
      pairs.map((p) => ({ ...p, on: 1, off: 0 })),
      { iterations: 200 },
    )!;
    expect(same.ci).toEqual([1, 1]);
    expect(bootstrapPaired([])).toBeNull();
  });

  test('the report: per-arm stats, waypoints, sanity, paired delta and verdict', () => {
    const trapHit = {
      pass: false,
      missing: ['x'],
      any_matched: [],
      forbidden: [],
      trapped: ['/db/'],
      marker_found: true,
    };
    const results: SessionRunResult[] = [];
    for (const task of ['t1', 't2', 't3', 't4']) {
      for (const trial of [0, 1]) {
        const trap = task !== 't4';
        results.push(
          result({
            task_id: task,
            arm: 'memory-off',
            trial,
            ...(trap ? { check: trapHit } : {}),
          }),
          result({
            task_id: task,
            arm: 'memory-on',
            trial,
            waypoints: trial === 0 ? [{ id: 'w', kind: 'decision', title: 'x', summary: 'y' }] : [],
            recalled: trial === 0 ? 1 : 0,
          }),
          result({ task_id: task, arm: 'oracle', trial, s1: null }),
        );
      }
    }
    const tasks = ['t1', 't2', 't3', 't4'].map(
      (id): SessionTask => ({ ...trapTask, id, trap: id !== 't4' }),
    );
    const file: SessionsBenchFile = {
      schema: 1,
      mode: 'sessions',
      preregistered_bar: PREREGISTERED_BAR,
      label: 'test',
      started_at: '',
      finished_at: '',
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-5.5',
      rig: { version: '0.3.0', commit: 'abc', dirty: false, fingerprint: 'f' },
      target: {
        repo: '/r',
        commit: 'c',
        expected_commit: 'c',
        snapshot: { sha256: 'a'.repeat(64), bytes: 1, nodes: 5, waypoints: 0 },
      },
      instructions: { path: 'generated/installer/claude.instructions.md', sha256: 'b'.repeat(64) },
      trap_evidence: [{ task_id: 't1', file: 'auth.ts', pattern: 'database', found: true }],
      answer_marker: 'ANSWER:',
      arms: ['memory-off', 'memory-on', 'oracle'],
      trials: 2,
      max_turns: 12,
      tasks,
      results,
    };
    const r = aggregateSessions(file, { iterations: 500 });
    const arm = (n: string) => r.arms.find((a) => a.arm === n)!;
    expect(arm('memory-off')).toMatchObject({ runs: 8, passed: 2 });
    expect(arm('memory-off').trap).toEqual({ runs: 6, avoided: 0, failed: 6, avoidance: 0 });
    expect(arm('memory-on')).toMatchObject({ passed: 8, pass_rate: 1 });
    expect(arm('memory-on').trap.avoidance).toBe(1);
    expect(arm('memory-on').waypoints).toEqual({
      runs: 8,
      runs_with_drops: 4,
      total: 4,
      mean: 0.5,
    });
    expect(arm('memory-on').recall).toEqual({ runs: 8, runs_called: 0, runs_recalled: 4 });
    expect(arm('memory-on').tokens.total!.median).toBe(15_000);
    expect(arm('oracle').tokens.s1).toBeNull();
    expect(arm('oracle').tokens.total!.median).toBe(5_000);
    expect(arm('oracle').waypoints).toBeNull();
    expect(r.paired!.delta).toBeCloseTo(0.75);
    expect(r.paired!.token_ratio).toBe(1);
    expect(r.verdict!.verdict).toBe('PASS');
    expect(r.sanity).toEqual([
      { arm: 'memory-off', trap_runs: 6, failed: 6, trapped: 6, ok: true },
    ]);
    const md = renderSessionsMarkdown(r);
    expect(md).toContain(`> ${PREREGISTERED_BAR}`);
    expect(md).not.toContain('Confirmation rule');
    expect(
      renderSessionsMarkdown(
        aggregateSessions({ ...file, confirmation_rule: CONFIRMATION_RULE }, { iterations: 50 }),
      ),
    ).toContain(`**Confirmation rule** (pre-registered):\n\n> ${CONFIRMATION_RULE}`);
    expect(md).toContain('**Verdict: PASS**');
    expect(md).toContain('## Waypoints');
    expect(md).toContain('| memory-on | 4/8 | 4 / 0.50 |');
    expect(md).toContain('## Paired: memory-on minus memory-off');
    expect(md).toContain('OK, code alone leads into most traps');
    expect(md).toContain('| `t4` | decision |  |');
    // Without memory-off there is nothing to pair, and no verdict.
    const onlyOn = aggregateSessions({ ...file, arms: ['memory-on'] });
    expect(onlyOn.verdict).toBeNull();
    expect(renderSessionsMarkdown(onlyOn)).toContain('**Verdict: not computed**');
  });
});

describe('combined runs', () => {
  // A run over `ids`: memory-on passes every trial, memory-off the first only.
  const run = (label: string, ids: string[], over: Partial<SessionsBenchFile> = {}) => {
    const results: SessionRunResult[] = ids.flatMap((task_id) =>
      [0, 1, 2].flatMap((trial) => [
        result({ task_id, arm: 'memory-on', trial }),
        result({
          task_id,
          arm: 'memory-off',
          trial,
          ...(trial === 0
            ? {}
            : {
                check: {
                  pass: false,
                  missing: ['x'],
                  any_matched: [],
                  forbidden: [],
                  trapped: [],
                  marker_found: true,
                },
              }),
        }),
      ]),
    );
    return {
      schema: 1,
      mode: 'sessions',
      preregistered_bar: PREREGISTERED_BAR,
      label,
      started_at: `2026-10-29T0${ids.length}:00:00Z`,
      finished_at: `2026-10-29T0${ids.length}:30:00Z`,
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-5.5',
      rig: { version: '0.3.0', commit: label, dirty: false, fingerprint: 'f' },
      target: {
        repo: '/r',
        commit: 'c',
        expected_commit: 'c',
        snapshot: { sha256: 'a'.repeat(64), bytes: 1, nodes: 5, waypoints: 0 },
      },
      instructions: { path: 'generated/installer/claude.instructions.md', sha256: 'b'.repeat(64) },
      trap_evidence: [],
      answer_marker: 'ANSWER:',
      arms: ['memory-off', 'memory-on'],
      trials: 3,
      max_turns: 12,
      tasks: ids.map((id): SessionTask => ({ ...trapTask, id })),
      results,
      ...over,
    } satisfies SessionsBenchFile;
  };
  const ten = (from: number) => Array.from({ length: 10 }, (_, i) => `t${from + i}`);

  test('two runs merge into one table, one bootstrap over all tasks and one verdict', () => {
    const a = run('first', ten(1));
    const b = run('confirmation', ten(11), { confirmation_rule: CONFIRMATION_RULE });
    const merged = mergeSessionsFiles([a, b]);
    expect(merged.tasks).toHaveLength(20);
    expect(merged.results).toHaveLength(120);
    expect(merged.label).toBe('first + confirmation');
    expect(merged.confirmation_rule).toBe(CONFIRMATION_RULE);
    expect(merged.combined!.map((c) => [c.label, c.tasks.length, c.trials])).toEqual([
      ['first', 10, 60],
      ['confirmation', 10, 60],
    ]);
    const r = aggregateSessions(merged, { iterations: 500 });
    expect(r.paired).toMatchObject({ pairs: 60, tasks: 20 });
    expect(r.paired!.delta).toBeCloseTo(2 / 3);
    expect(r.tasks).toHaveLength(20);
    const md = renderSessionsMarkdown(r);
    expect(md).toContain(`**Verdict, combined (2 runs): ${r.verdict!.verdict}**`);
    expect(md).toContain('- **Combined runs**: 2\n');
    expect(md).toContain(`> ${CONFIRMATION_RULE}`);
    // One file is not a combination.
    expect(mergeSessionsFiles([a])).toBe(a);
    expect(renderSessionsMarkdown(aggregateSessions(a, { iterations: 50 }))).toContain(
      '**Verdict: ',
    );
    // Differing rig builds still merge, but the header says so.
    const other = run('confirmation', ten(11), {
      rig: { version: '0.3.0', commit: 'x', dirty: true, fingerprint: 'g' },
    });
    expect(
      renderSessionsMarkdown(aggregateSessions(mergeSessionsFiles([a, other]), { iterations: 50 })),
    ).toContain('rig fingerprints differ between runs');
  });

  test('refuses runs that differ in model, arms, trials, bar, target or share a task', () => {
    const a = run('first', ten(1));
    const differing: [string, Partial<SessionsBenchFile>][] = [
      ['model', { model: 'anthropic/claude-sonnet-5' }],
      ['arms', { arms: ['memory-off', 'memory-on', 'oracle'] }],
      ['trials', { trials: 2 }],
      ['pre-registered bar', { preregistered_bar: `${PREREGISTERED_BAR} ` }],
      ['target commit', { target: { ...a.target, commit: 'd' } }],
      ['max turns', { max_turns: 8 }],
    ];
    for (const [what, over] of differing) {
      expect(() => mergeSessionsFiles([a, run('b', ten(11), over)])).toThrow(
        `refusing to merge: ${what} differs`,
      );
    }
    // Same arms in another order are the same arms.
    expect(() =>
      mergeSessionsFiles([a, run('b', ten(11), { arms: ['memory-on', 'memory-off'] })]),
    ).not.toThrow();
    expect(() => mergeSessionsFiles([a, run('b', ['t10', 't11'])])).toThrow(
      'task t10 is in both first and b',
    );
    expect(() => mergeSessionsFiles([])).toThrow('nothing to merge');
  });

  test('--tasks and --task-set select the tasks a run covers', () => {
    const ts = [
      { ...trapTask, id: 'a' },
      { ...trapTask, id: 'b' },
      { ...trapTask, id: 'c', set: 'confirmation' },
      { ...trapTask, id: 'd', set: 'confirmation' },
    ];
    const ids = (xs: SessionTask[]) => xs.map((t) => t.id);
    expect(ids(selectTasks(ts, {}))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(selectTasks(ts, { set: 'confirmation' }))).toEqual(['c', 'd']);
    expect(ids(selectTasks(ts, { set: 'first' }))).toEqual(['a', 'b']);
    expect(ids(selectTasks(ts, { set: 'confirmation', ids: ['a', 'd'] }))).toEqual(['d']);
    expect(() => selectTasks(ts, { set: 'second' })).toThrow('unknown task set "second"');
    expect(() => selectTasks(ts, { ids: ['z'] })).toThrow('unknown task id(s): z');
    expect(() => selectTasks(ts, { set: 'first', ids: ['c'] })).toThrow('select no task');
  });

  test('bench:report --in a --in b prints the combined report; a mismatch exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-membench-merge-'));
    try {
      const pa = join(dir, 'a.json');
      const pb = join(dir, 'b.json');
      const pc = join(dir, 'c.json');
      writeFileSync(pa, JSON.stringify(run('first', ten(1))));
      writeFileSync(pb, JSON.stringify(run('confirmation', ten(11))));
      writeFileSync(pc, JSON.stringify(run('other', ten(11), { model: 'm2' })));
      const report = resolve(ROOT, 'scripts/bench/report.ts');
      const ok = Bun.spawnSync(['bun', report, '--in', pa, '--in', pb], { cwd: ROOT });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.toString()).toContain('combined (2 runs)');
      expect(ok.stdout.toString()).toContain('Over 60 (task, trial) pairs from 20 tasks');
      const bad = Bun.spawnSync(['bun', report, '--in', pa, '--in', pc], { cwd: ROOT });
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr.toString()).toContain('refusing to merge: model differs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dry-run cost estimate', () => {
  const pricing: ModelPricing = {
    id: 'anthropic/claude-haiku-5.5',
    canonical: null,
    tiers: [{ min_prompt_tokens: 0, prompt: 0.1e-6, completion: 0.5e-6 }],
  };
  const overheads = {
    write_tools: 500,
    read_tools: 200,
    guidance: 80,
    bootstrap: 90,
    waypoint_output: 1_500,
  };

  test('prices each arm per session, overheads included', () => {
    const est = estimateSessions({
      arms: ['memory-off', 'memory-on', 'oracle', 'grep-only'],
      tasks: [
        { messages: 2, oracle_tokens: 100 },
        { messages: 3, oracle_tokens: 100 },
      ],
      trials: 3,
      pricing,
      overheads,
    });
    const arm = (n: string) => est.arms.find((a) => a.arm === n)!;
    const per = SESSION_PROFILES.s1_per_message;
    expect(arm('memory-off').trials).toBe(6);
    expect(arm('memory-off').s1!.prompt_tokens).toBe(per.prompt_tokens * 5 * 3);
    expect(arm('memory-off').cost_s2).toBeCloseTo(runCost(pricing, SESSION_PROFILES.s2) * 6);
    // memory-on pays for the extra tools and text on every call, plus a call.
    expect(arm('memory-on').s1!.prompt_tokens).toBeGreaterThan(arm('memory-off').s1!.prompt_tokens);
    expect(arm('memory-on').s1!.model_calls).toBe(arm('memory-off').s1!.model_calls + 6);
    expect(arm('memory-on').cost_usd!).toBeGreaterThan(arm('memory-off').cost_usd!);
    expect(arm('oracle').s1).toBeNull();
    expect(arm('oracle').cost_s1).toBe(0);
    expect(arm('oracle').s2.prompt_tokens).toBe(
      (SESSION_PROFILES.s2.prompt_tokens + 100 * SESSION_PROFILES.s2.model_calls) * 6,
    );
    expect(arm('grep-only').s1).toBeNull();
    expect(est.total_usd).toBeCloseTo(est.arms.reduce((s, a) => s + a.cost_usd!, 0));
    // Unknown price: tokens still add up, dollars are unknown.
    const unpriced = estimateSessions({
      arms: ['memory-off'],
      tasks: [{ messages: 2, oracle_tokens: 0 }],
      trials: 1,
      pricing: null,
      overheads,
    });
    expect(unpriced.total_usd).toBeNull();
    expect(unpriced.total_tokens).toBeGreaterThan(0);
    // Measured profiles replace the assumptions.
    const measured = estimateSessions({
      arms: ['memory-on'],
      tasks: [{ messages: 2, oracle_tokens: 0 }],
      trials: 2,
      pricing,
      overheads,
      measured: {
        'memory-on': {
          s1: { prompt_tokens: 1_000, completion_tokens: 100, model_calls: 2 },
          s2: { prompt_tokens: 500, completion_tokens: 50, model_calls: 1 },
        },
      },
    });
    expect(measured.arms[0]!.s1!.prompt_tokens).toBe(2_000);
    expect(measured.arms[0]!.cost_usd).toBeCloseTo(
      2 * (1_000 * 0.1e-6 + 100 * 0.5e-6) + 2 * (500 * 0.1e-6 + 50 * 0.5e-6),
    );
  });

  test('the plan states the bar, the arms, the task set and the 10 × 3 × 3 cost', () => {
    const sf = loadSessionsFile(SESSIONS);
    const arms = parseMemoryArms(undefined);
    expect(arms).toEqual(['memory-off', 'memory-on', 'oracle']);
    const plan = (
      taskSet: string,
      secrets: { task_id: string; secret: string; in_code: boolean }[],
    ) => {
      const tasks = selectTasks(sf.tasks, { set: taskSet });
      const estimate = estimateSessions({
        arms,
        tasks: taskShapes(tasks),
        trials: 3,
        pricing,
        overheads: sessionOverheads(),
      });
      expect(estimate.total_usd!).toBeGreaterThan(0);
      return sessionsPlanLines({
        provider: 'openrouter',
        hasKey: false,
        model: 'anthropic/claude-haiku-5.5',
        priceLine: '$0.10 in / $0.50 out per M tokens',
        rig: { version: '0.3.0', commit: 'abc1234', dirty: false, fingerprint: 'f' },
        repo: '/r',
        head: 'c',
        pinned: 'c',
        index: 'current',
        rg: true,
        arms,
        tasks,
        taskSet,
        trials: 3,
        maxTurns: 12,
        evidence: [],
        secrets,
        estimate,
        estimateFrom: null,
      }).join('\n');
    };
    const first = plan('first', []);
    expect(first).toContain(`> ${PREREGISTERED_BAR}`);
    expect(first).toContain(
      'tasks:     10 pairs in set "first" (3 decision, 3 constraint, 2 dead-end, 2 discovery; 4 traps)',
    );
    expect(first).toContain('runs:      90 trials (30 per arm), 150 sessions');
    expect(first).toContain('(no API key in env)');
    expect(first).toMatch(/total {7}~\d+\.\d\dM tokens ≈ \$\d/);
    expect(first).not.toContain('secrets:');
    const conf = plan('confirmation', [
      { task_id: 'a', secret: 'x', in_code: false },
      { task_id: 'b', secret: 'y', in_code: true },
    ]);
    expect(conf).toContain(
      '10 pairs in set "confirmation" (3 decision, 3 constraint, 2 dead-end, 2 discovery; 7 traps)',
    );
    expect(conf).toContain('runs:      90 trials (30 per arm), 150 sessions');
    expect(conf).toContain('absent from the target\'s files in 1/2 checks (FOUND in code: b "y")');
    // The results file has the bar before any trial has run.
    const fresh = newSessionsFile(
      {
        label: 'l',
        providerName: 'openrouter',
        model: 'm',
        rig: { version: '0.3.0', commit: null, dirty: false, fingerprint: 'f' },
        repo: '/r',
        head: 'c',
        pinned: 'c',
        sessions: sf,
        arms,
        tasks: sf.tasks,
        taskSet: 'confirmation',
        trials: 3,
        maxTurns: 12,
      },
      { path: '/x', sha256: 's', bytes: 1, nodes: 1, waypoints: 0 },
      [],
    );
    expect(fresh.preregistered_bar).toBe(PREREGISTERED_BAR);
    expect(fresh.confirmation_rule).toBe(CONFIRMATION_RULE);
    expect(fresh.task_set).toBe('confirmation');
    expect(fresh.results).toEqual([]);
  });
});
