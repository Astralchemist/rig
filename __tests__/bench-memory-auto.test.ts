// SPDX-License-Identifier: Apache-2.0
// The memory-auto arm of the multi-session bench: session 1 as memory-off,
// automatic capture in between, the SessionStart brief in session 2. Every
// model call goes through a mocked fetch; nothing here touches the network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { SESSION_PROFILES, estimateSessions } from '../scripts/bench/plan.ts';
import { OpenRouterProvider } from '../scripts/bench/providers.ts';
import {
  addArmsToBaseline,
  aggregateSessions,
  captureFacts,
  mergeSessionsFiles,
  renderSessionsMarkdown,
} from '../scripts/bench/report-sessions.ts';
import {
  BRIEF_INTRO,
  MEMORY_AUTO_PREREGISTRATION,
  PREREGISTERED_BAR,
  SESSION_SYSTEM_PROMPT,
  TrialStore,
  loadSessionsFile,
  parseMemoryArms,
  runSessionsLoop,
  sessionBootstrap,
  snapshotIndex,
} from '../scripts/bench/sessions.ts';
import { sessionOverheads, sessionsPlanLines, taskShapes } from '../scripts/bench/sessions-run.ts';
import type { SessionRunResult, SessionTask, SessionsBenchFile } from '../scripts/bench/types.ts';

const ROOT = resolve(__dirname, '..');

interface Body {
  messages: { role: string; content: string | null }[];
  tools?: { function: { name: string } }[];
}

const reply = (message: Record<string, unknown>) =>
  new Response(
    JSON.stringify({
      model: 'anthropic/claude-haiku-5.5-20261007',
      choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const noSleep = { sleep: async () => {}, random: () => 1 };

// Session 1 settles a decision in the user's own words; the code alone
// points to the other answer.
const task: SessionTask = {
  id: 'jwt',
  type: 'decision',
  trap: true,
  session1: [
    'Should sessions be JWT or database with the Prisma adapter?',
    'We decided to keep sessions on JWT; database sessions were rejected for Edge latency.',
  ],
  session2: 'Which session strategy? ANSWER: strategy=<jwt|database>',
  oracle: 'Sessions stay JWT.',
  reference: 'ANSWER: strategy=jwt',
  expected: { all: ['/strategy\\s*=\\s*jwt/i'], must_not: ['/strategy\\s*=\\s*database/i'] },
  code_evidence: [{ file: 'auth.ts', pattern: 'database' }],
};

interface Call {
  system: string;
  tools: string[];
  user: string;
}

// Answers jwt only when the decision reached its context.
const model = (calls: Call[]) => (body: Body) => {
  const system = body.messages[0]!.content ?? '';
  const user = body.messages.filter((m) => m.role === 'user').at(-1)!.content ?? '';
  calls.push({ system, tools: (body.tools ?? []).map((t) => t.function.name), user });
  if (!user.includes('ANSWER:')) return { content: 'Understood.' };
  return {
    content: /keep sessions on JWT/i.test(system)
      ? 'ANSWER: strategy=jwt'
      : 'ANSWER: strategy=database',
  };
};

describe('memory-auto arm', () => {
  let project: string;
  let work: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-memauto-target-'));
    work = mkdtempSync(join(tmpdir(), 'rig-memauto-work-'));
    writeFileSync(
      join(project, 'auth.ts'),
      'export const strategy = (adapter: unknown) => (adapter ? "database" : "jwt");\n',
    );
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    rig.close();
    Bun.gc(true);
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  const run = async (arms: string, dir: string) => {
    const snap = snapshotIndex(project, join(work, dir));
    const opened: string[] = [];
    class CountingStore extends TrialStore {
      override open() {
        const db = super.open();
        opened.push(db.path);
        return db;
      }
    }
    const store = new CountingStore(project, snap, join(work, dir), new DeterministicEmbedder());
    const calls: Call[] = [];
    const bodies = model(calls);
    const fetch = (async (_u: string, init: RequestInit) =>
      reply(bodies(JSON.parse(init.body as string) as Body))) as unknown as typeof globalThis.fetch;
    const provider = new OpenRouterProvider('m', 'k', { fetch, ...noSleep });
    const file = {
      ...baseFile('run', ['jwt'], parseMemoryArms(arms)),
      results: [] as SessionRunResult[],
    } as SessionsBenchFile;
    await runSessionsLoop(provider, store, file, {
      arms: file.arms,
      tasks: [task],
      trials: 2,
      maxTurns: 4,
      maxTokens: 100,
      marker: 'ANSWER:',
    });
    return { file, calls, opened, dir: join(work, dir) };
  };

  test('session 1 as memory-off; capture in between; session 2 gets the hook brief', async () => {
    const { file, calls, opened, dir } = await run('memory-off,memory-auto', 'loop');
    const of = (arm: string) => file.results.filter((r) => r.arm === arm);
    for (const r of of('memory-auto')) {
      expect(r.s1).not.toBeNull();
      const c = r.capture!;
      expect(c.error).toBeUndefined();
      expect(c.events).toBeGreaterThanOrEqual(4);
      expect(c.records.map((x) => x.kind).sort()).toEqual(['decision', 'rejected']);
      expect(c.records.every((x) => x.stored && x.injectable)).toBe(true);
      expect(c.brief).toContain('Settled in previous sessions in this project');
      expect(c.brief).toContain('We decided to keep sessions on JWT');
      // The captured waypoints are session 1's, and session 2 can load them.
      expect(r.waypoints.map((w) => w.kind).sort()).toEqual(['dead-end', 'decision']);
      expect(r.recalled).not.toBeNull();
      expect(r.check.pass).toBe(true);
    }
    for (const r of of('memory-off')) {
      expect(r.capture).toBeUndefined();
      expect(r.check.pass).toBe(false);
    }
    // Session 1 of memory-auto is memory-off's: same prompt, no memory tools.
    const s1 = calls.filter((c) => !c.user.includes('ANSWER:'));
    expect(s1.every((c) => c.system === SESSION_SYSTEM_PROMPT)).toBe(true);
    expect(
      s1.some((c) => c.tools.includes('rig_waypoints') || c.tools.includes('rig_drop_waypoint')),
    ).toBe(false);
    // Session 2 of memory-auto: bootstrap paragraph, brief, rig_waypoints.
    const s2auto = calls.filter((c) => c.system.includes(BRIEF_INTRO));
    expect(s2auto).toHaveLength(2);
    for (const c of s2auto) {
      expect(c.system).toContain(sessionBootstrap());
      expect(c.system).toContain('<rig-memory kind="data"');
      expect(c.tools).toContain('rig_waypoints');
      expect(c.tools).not.toContain('rig_drop_waypoint');
    }
    // memory-off resets between sessions; memory-auto keeps one copy.
    expect(opened).toHaveLength(2 * (2 + 1));
    expect(readdirSync(join(dir, 'trials'))).toEqual([]);

    // The report: the pre-registered verdict against memory-off, capture
    // statistics and capture recall (computed from the stored results).
    const r = aggregateSessions(file, { iterations: 200 });
    expect(r.memory_auto!.vs_off!.paired.delta).toBe(1);
    expect(r.memory_auto!.vs_off!.verdict.reason).toContain(
      "memory-auto used 100.0% of memory-off's median total tokens",
    );
    expect(r.memory_auto!.capture!.recall).toEqual({ runs: 2, captured: 2, briefed: 2 });
    expect(r.memory_auto!.capture!.by_kind).toEqual({ decision: 2, rejected: 2 });
    const md = renderSessionsMarkdown(r);
    expect(md).toContain(`> ${MEMORY_AUTO_PREREGISTRATION}`);
    expect(md).toContain('**Verdict, memory-auto vs memory-off:');
    expect(md).toContain('## Automatic capture (memory-auto)');
    expect(md).toContain('**Capture recall** (computed after the run; it did not feed the arm)');
    // No memory-on in this file: nothing to compare it with.
    expect(md).not.toContain('memory-auto vs memory-on');
  });

  test('capture facts: the secret, else literal criteria and key = value values', () => {
    const sf = loadSessionsFile(resolve(ROOT, 'scripts/bench/sessions.json'));
    const facts = Object.fromEntries(sf.tasks.map((t) => [t.id, captureFacts(t)]));
    expect(facts['session-cookie-name']).toEqual(['acme_sid']);
    expect(facts['actions-merge-rule']).toEqual(['[core-actions]', 'mfrost']);
    expect(facts['fork-default-max-age']).toEqual(['/28,?800\\b/i']);
    // `file =` has no value to look for.
    expect(facts['vendored-cookie']).toEqual([]);
  });
});

const baseFile = (
  label: string,
  ids: string[],
  arms: SessionsBenchFile['arms'],
  over: Partial<SessionsBenchFile> = {},
): SessionsBenchFile => ({
  schema: 1,
  mode: 'sessions',
  preregistered_bar: PREREGISTERED_BAR,
  memory_auto_preregistration: MEMORY_AUTO_PREREGISTRATION,
  label,
  started_at: '2026-10-29T00:00:00Z',
  finished_at: '2026-10-29T01:00:00Z',
  provider: 'openrouter',
  model: 'anthropic/claude-haiku-5.5',
  rig: { version: '0.3.0', commit: label, dirty: false, fingerprint: label },
  target: {
    repo: '/r',
    commit: 'c',
    expected_commit: 'c',
    snapshot: { sha256: 'a'.repeat(64), bytes: 1, nodes: 5, waypoints: 0 },
  },
  instructions: { path: 'generated/installer/claude.instructions.md', sha256: 'b'.repeat(64) },
  trap_evidence: [],
  answer_marker: 'ANSWER:',
  arms,
  trials: 3,
  max_turns: 12,
  tasks: ids.map((id) => ({ ...task, id })),
  results: [],
  ...over,
});

const session = (tokens: number, text: string) => ({
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
  replies: [text],
  final_text: text,
  resolved_models: ['m-1'],
  upstreams: [],
  elapsed_ms: 1,
});

const resultFor = (task_id: string, arm: SessionRunResult['arm'], trial: number, pass: boolean) =>
  ({
    task_id,
    arm,
    trial,
    s1: session(10_000, ''),
    s2: session(5_000, pass ? 'ANSWER: strategy=jwt' : 'ANSWER: strategy=database'),
    waypoints: [],
    recalled: null,
    check: {
      pass,
      missing: pass ? [] : ['x'],
      any_matched: [],
      forbidden: [],
      trapped: [],
      marker_found: true,
    },
    ...(arm === 'memory-auto'
      ? {
          capture: {
            events: 6,
            records: [
              {
                kind: 'decision',
                waypoint_kind: 'decision',
                summary: 'Keep sessions on JWT',
                rationale: 'We decided to keep sessions on JWT',
                confidence: 0.85,
                stored: true,
                injectable: true,
              },
            ],
            brief: '<rig-memory>…Keep sessions on JWT…</rig-memory>',
            elapsed_ms: 3,
          },
        }
      : {}),
  }) satisfies SessionRunResult;

describe('a new arm against stored baseline arms', () => {
  const ids = (from: number) => Array.from({ length: 10 }, (_, i) => `t${from + i}`);
  // Stored runs: memory-on passes every trial, memory-off one in three.
  const stored = (label: string, tids: string[]) =>
    baseFile(label, tids, ['memory-off', 'memory-on', 'oracle'], {
      memory_auto_preregistration: undefined,
      results: tids.flatMap((t) =>
        [0, 1, 2].flatMap((trial) => [
          resultFor(t, 'memory-off', trial, trial === 0),
          resultFor(t, 'memory-on', trial, true),
          resultFor(t, 'oracle', trial, true),
        ]),
      ),
    });
  const first = stored('sessions-0.3.0', ids(1));
  const confirmation = stored('sessions-confirmation-0.3.0', ids(11));
  // The new run: --arms memory-auto on all 20 tasks; passes two trials in three.
  const auto = baseFile('sessions-memory-auto', [...ids(1), ...ids(11)], ['memory-auto'], {
    results: [...ids(1), ...ids(11)].flatMap((t) =>
      [0, 1, 2].map((trial) => resultFor(t, 'memory-auto', trial, trial < 2)),
    ),
  });

  test('the new arm pairs with the stored trials; the report says how it was combined', () => {
    // The plain combiner refuses: the arms differ and the tasks are shared.
    expect(() => mergeSessionsFiles([mergeSessionsFiles([first, confirmation]), auto])).toThrow(
      'refusing to merge: arms differs',
    );
    const merged = addArmsToBaseline(mergeSessionsFiles([first, confirmation]), auto);
    expect(merged.arms).toEqual(['memory-off', 'memory-on', 'oracle', 'memory-auto']);
    expect(merged.results).toHaveLength(60 * 3 + 60);
    expect(merged.combined!.map((c) => c.label)).toEqual([
      'sessions-0.3.0',
      'sessions-confirmation-0.3.0',
      'sessions-memory-auto',
    ]);
    const r = aggregateSessions(merged, { iterations: 500 });
    // memory-on vs memory-off is the stored verdict, unchanged.
    expect(r.paired!.pairs).toBe(60);
    const ma = r.memory_auto!;
    expect(ma.vs_off!.paired.pairs).toBe(60);
    expect(ma.vs_off!.paired.delta).toBeCloseTo(2 / 3 - 1 / 3);
    expect(ma.vs_on!.delta).toBeCloseTo(2 / 3 - 1);
    expect(ma.capture!.runs).toBe(60);
    const md = renderSessionsMarkdown(r);
    expect(md).toContain(
      '**New arm against stored baseline arms**: memory-auto from `sessions-memory-auto`',
    );
    expect(md).toContain('**Verdict, memory-auto vs memory-off, combined (3 runs):');
    expect(md).toContain('**memory-auto vs memory-on** (descriptive, no bar)');
    expect(md).toContain('## Paired: memory-auto minus memory-off');
    expect(md).toContain('rig fingerprints differ between runs');
  });

  test('refuses a different model, trials or bar, an arm already stored, or changed tasks', () => {
    const base = mergeSessionsFiles([first, confirmation]);
    expect(() => addArmsToBaseline(base, { ...auto, model: 'other' })).toThrow('model differs');
    expect(() => addArmsToBaseline(base, { ...auto, trials: 1 })).toThrow('trials differs');
    expect(() => addArmsToBaseline(base, { ...auto, preregistered_bar: 'something else' })).toThrow(
      'pre-registered bar differs',
    );
    expect(() => addArmsToBaseline(base, { ...auto, arms: ['memory-auto', 'memory-off'] })).toThrow(
      'memory-off already in the baseline',
    );
    expect(() =>
      addArmsToBaseline(base, {
        ...auto,
        tasks: auto.tasks.map((t, i) => (i === 0 ? { ...t, session2: 'changed' } : t)),
      }),
    ).toThrow('task t1 differs');
    expect(() =>
      addArmsToBaseline(base, { ...auto, tasks: [...auto.tasks, { ...task, id: 'new' }] }),
    ).toThrow('task new is not in the baseline');
  });

  test('bench:report --baseline a --baseline b --in new prints the combined report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-memauto-report-'));
    try {
      const p = (n: string, f: SessionsBenchFile) => {
        const path = join(dir, `${n}.json`);
        writeFileSync(path, JSON.stringify(f));
        return path;
      };
      const out = Bun.spawnSync(
        [
          process.execPath,
          resolve(ROOT, 'scripts/bench/report.ts'),
          '--baseline',
          p('a', first),
          '--baseline',
          p('b', confirmation),
          '--in',
          p('auto', auto),
        ],
        { cwd: ROOT },
      );
      expect(out.exitCode).toBe(0);
      const md = out.stdout.toString();
      expect(md).toContain('**Verdict, memory-auto vs memory-off, combined (3 runs):');
      // Without --baseline the arms differ and the tasks overlap: refused.
      const bad = Bun.spawnSync(
        [
          process.execPath,
          resolve(ROOT, 'scripts/bench/report.ts'),
          '--in',
          p('a2', first),
          '--in',
          p('auto2', auto),
        ],
        { cwd: ROOT },
      );
      expect(bad.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('memory-auto: plan and pre-registration', () => {
  test('the pre-registration is in the README verbatim and names the frozen extractor', () => {
    const readme = readFileSync(resolve(ROOT, 'scripts/bench/README.md'), 'utf-8');
    expect(readme).toContain(`> ${MEMORY_AUTO_PREREGISTRATION}`);
    expect(MEMORY_AUTO_PREREGISTRATION).toContain(
      'extractor frozen at 9cb1f2ae28d7d1165b13f0aa76e334e22782da7e',
    );
  });

  test('--arms memory-auto plans session 1 as memory-off and session 2 with the brief', () => {
    expect(parseMemoryArms('memory-auto')).toEqual(['memory-auto']);
    const pricing = {
      id: 'anthropic/claude-haiku-5.5',
      canonical: null,
      tiers: [{ min_prompt_tokens: 0, prompt: 0.1e-6, completion: 0.5e-6 }],
    };
    const sf = loadSessionsFile(resolve(ROOT, 'scripts/bench/sessions.json'));
    const overheads = sessionOverheads();
    expect(overheads.brief).toBe(375);
    const est = estimateSessions({
      arms: ['memory-off', 'memory-auto'],
      tasks: taskShapes(sf.tasks),
      trials: 3,
      pricing,
      overheads,
    });
    const [off, auto] = est.arms;
    expect(auto!.trials).toBe(60);
    expect(auto!.s1).toEqual(off!.s1);
    expect(auto!.s2.prompt_tokens).toBeGreaterThan(off!.s2.prompt_tokens);
    expect(auto!.s2.model_calls).toBe(off!.s2.model_calls + 60);
    // From measured runs: memory-off's session 1, memory-on's session 2 plus the brief.
    const measured = estimateSessions({
      arms: ['memory-auto'],
      tasks: [{ messages: 3, oracle_tokens: 0 }],
      trials: 1,
      pricing,
      overheads,
      measured: {
        'memory-off': {
          s1: { prompt_tokens: 90_000, completion_tokens: 900, model_calls: 6 },
          s2: SESSION_PROFILES.s2,
        },
        'memory-on': {
          s1: null,
          s2: { prompt_tokens: 30_000, completion_tokens: 300, model_calls: 3 },
        },
      },
    });
    expect(measured.arms[0]!.s1!.prompt_tokens).toBe(90_000);
    expect(measured.arms[0]!.s2.prompt_tokens).toBe(30_000 + 375 * 3);
    const plan = sessionsPlanLines({
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
      arms: ['memory-auto'],
      tasks: sf.tasks,
      taskSet: null,
      trials: 3,
      maxTurns: 12,
      evidence: [],
      secrets: [],
      estimate: estimateSessions({
        arms: ['memory-auto'],
        tasks: taskShapes(sf.tasks),
        trials: 3,
        pricing,
        overheads,
      }),
      estimateFrom: null,
    }).join('\n');
    expect(plan).toContain('arms:      memory-auto');
    expect(plan).toContain("s1 as memory-off; then rig hook's capture pipeline");
    expect(plan).toContain('runs:      60 trials (60 per arm), 120 sessions');
  });
});
