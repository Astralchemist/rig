// SPDX-License-Identifier: Apache-2.0
// The token-cost bench harness (scripts/bench). Every model call goes through
// a mocked fetch; nothing here touches the network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { runAgent } from '../scripts/bench/agent.ts';
import { makeArm, parseArms, type Arm } from '../scripts/bench/arms.ts';
import { checkAnswer, validateExpected } from '../scripts/bench/criteria.ts';
import { judgeAnswer, parseVerdict } from '../scripts/bench/judge.ts';
import { estimatePlan } from '../scripts/bench/plan.ts';
import {
  fetchCatalogue,
  lookupPricing,
  openRouterIdFor,
  parsePricing,
  priceCall,
  type ModelPricing,
} from '../scripts/bench/pricing.ts';
import {
  AnthropicProvider,
  OPENROUTER_URL,
  OpenRouterProvider,
  ProviderError,
  postJson,
  resolveProviderName,
} from '../scripts/bench/providers.ts';
import { aggregate, renderMarkdown } from '../scripts/bench/report.ts';
import { BASELINE_TOOLS } from '../scripts/bench/tools-baseline.ts';
import { RIG_SEARCH_TOOLS, makeRigSearchRunner } from '../scripts/bench/tools-rig-search.ts';
import type { BenchFile, QueriesFile, RunResult } from '../scripts/bench/types.ts';

const QUERIES = resolve(__dirname, '../scripts/bench/queries.json');

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

// A fetch that answers from a script of responses and records each request.
const scriptedFetch = (replies: (() => Response)[]) => {
  const calls: Captured[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    });
    const next = replies.shift();
    if (!next) throw new Error('unexpected extra request');
    return next();
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
};

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

const orReply = (
  message: Record<string, unknown>,
  usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
) =>
  json({
    id: 'gen-1',
    model: 'anthropic/claude-haiku-5.5-20261007',
    provider: 'Anthropic',
    choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
    usage,
  });

const noSleep = { sleep: async () => {}, random: () => 1 };

const echoArm = (): Arm & { seen: { name: string; input: unknown }[] } => {
  const seen: { name: string; input: unknown }[] = [];
  return {
    name: 'baseline',
    tools: [
      {
        name: 'rg',
        description: 'ripgrep',
        input_schema: {
          type: 'object',
          properties: { args: { type: 'array' } },
          required: ['args'],
        },
      },
    ],
    seen,
    exec: async (name, input) => {
      seen.push({ name, input });
      return `result of ${name}`;
    },
  };
};

describe('OpenRouter provider', () => {
  test('sends an OpenAI-style request with converted tools and usage accounting on', async () => {
    const { fetch, calls } = scriptedFetch([orReply({ content: 'done' })]);
    const p = new OpenRouterProvider('anthropic/claude-haiku-5.5', 'sk-or-test', {
      fetch,
      ...noSleep,
    });
    const arm = echoArm();
    await runAgent(p, arm, 'where is X?', { maxTurns: 3, maxTokens: 512 });
    const req = calls[0]!;
    expect(req.url).toBe(OPENROUTER_URL);
    expect(req.headers.authorization).toBe('Bearer sk-or-test');
    expect(req.headers['HTTP-Referer']).toBe('https://github.com/Astralchemist/rig');
    expect(req.headers['X-Title']).toBe('rig bench');
    expect(req.body.model).toBe('anthropic/claude-haiku-5.5');
    expect(req.body.max_tokens).toBe(512);
    expect(req.body.usage).toEqual({ include: true });
    const messages = req.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]!.content).toBe('where is X?');
    expect(req.body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'rg', description: 'ripgrep', parameters: arm.tools[0]!.input_schema },
      },
    ]);
  });

  test('drives the tool_calls loop and feeds results back as tool messages', async () => {
    const { fetch, calls } = scriptedFetch([
      orReply({
        content: 'let me look',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'rg', arguments: '{"args":["foo"]}' },
          },
          { id: 'call_2', type: 'function', function: { name: 'rg', arguments: '{not json' } },
        ],
      }),
      orReply({ content: 'It is in foo.ts' }),
    ]);
    const p = new OpenRouterProvider('m', 'k', { fetch, ...noSleep });
    const arm = echoArm();
    const out = await runAgent(p, arm, 'q', { maxTurns: 5, maxTokens: 100 });

    expect(out.stop).toBe('answer');
    expect(out.final_text).toBe('It is in foo.ts');
    expect(out.model_calls).toBe(2);
    expect(out.tool_turns).toBe(2);
    // Only the well-formed call reaches the tool.
    expect(arm.seen).toEqual([{ name: 'rg', input: { args: ['foo'] } }]);

    const second = calls[1]!.body.messages as Record<string, unknown>[];
    expect(second).toHaveLength(5);
    expect(second[2]).toMatchObject({
      role: 'assistant',
      content: 'let me look',
      tool_calls: [{ id: 'call_1' }, { id: 'call_2' }],
    });
    expect(second[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'result of rg' });
    expect(second[4]).toMatchObject({ role: 'tool', tool_call_id: 'call_2' });
    expect(String(second[4]!.content)).toContain('not valid JSON');
  });

  test('omits tools when the conversation has none (judge calls)', async () => {
    const { fetch, calls } = scriptedFetch([
      orReply({ content: '{"verdict":"correct","reason":"ok"}' }),
    ]);
    const p = new OpenRouterProvider('judge-model', 'k', { fetch, ...noSleep });
    const r = await judgeAnswer(
      p,
      {
        id: 'q',
        category: 'lookup',
        ask: 'where?',
        reference: 'a.ts',
        expected: { all: ['a.ts'] },
      },
      'in a.ts',
    );
    expect(calls[0]!.body.tools).toBeUndefined();
    expect(r.verdict).toBe('correct');
    expect(r.cost_usd).toBe(0.001);
  });

  test('stops at the turn limit when the model never answers', async () => {
    const call = () =>
      orReply({
        content: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'rg', arguments: '{}' } }],
      });
    const { fetch } = scriptedFetch([call(), call()]);
    const out = await runAgent(
      new OpenRouterProvider('m', 'k', { fetch, ...noSleep }),
      echoArm(),
      'q',
      {
        maxTurns: 2,
        maxTokens: 100,
      },
    );
    expect(out.stop).toBe('turn_limit');
    expect(out.final_text).toBe('');
    expect(out.model_calls).toBe(2);
  });
});

describe('usage and cost accounting', () => {
  test('sums tokens and reported cost over every call and records the resolved model', async () => {
    const { fetch } = scriptedFetch([
      orReply(
        {
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'rg', arguments: '{}' } }],
        },
        { prompt_tokens: 1000, completion_tokens: 50, cost: 0.000125 },
      ),
      orReply({ content: 'answer' }, { prompt_tokens: 2000, completion_tokens: 80, cost: 0.00024 }),
    ]);
    const out = await runAgent(
      new OpenRouterProvider('m', 'k', { fetch, ...noSleep }),
      echoArm(),
      'q',
      {
        maxTurns: 5,
        maxTokens: 100,
      },
    );
    expect(out.prompt_tokens).toBe(3000);
    expect(out.completion_tokens).toBe(130);
    expect(out.cost_usd).toBeCloseTo(0.000365, 12);
    expect(out.resolved_models).toEqual(['anthropic/claude-haiku-5.5-20261007']);
    expect(out.upstreams).toEqual(['Anthropic']);
    expect(out.tool_chars).toEqual({ rg: 'result of rg'.length });
  });

  test('one call without a reported cost makes the run cost unknown', async () => {
    const { fetch } = scriptedFetch([
      orReply(
        {
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'rg', arguments: '{}' } }],
        },
        { prompt_tokens: 10, completion_tokens: 1 },
      ),
      orReply({ content: 'answer' }),
    ]);
    const out = await runAgent(
      new OpenRouterProvider('m', 'k', { fetch, ...noSleep }),
      echoArm(),
      'q',
      {
        maxTurns: 5,
        maxTokens: 100,
      },
    );
    expect(out.cost_usd).toBeNull();
    expect(out.prompt_tokens).toBe(110);
  });

  test('the Anthropic path prices calls from list prices, long-context tier included', async () => {
    const pricing = parsePricing({
      id: 'anthropic/claude-sonnet-5',
      pricing: {
        prompt: '0.000002',
        completion: '0.00001',
        overrides: [{ min_prompt_tokens: 100000, prompt: '0.000004', completion: '0.00002' }],
      },
    })!;
    const { fetch, calls } = scriptedFetch([
      json({
        model: 'claude-sonnet-5-20260630',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'tu_1', name: 'rg', input: { args: ['x'] } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 150_000, output_tokens: 100 },
      }),
      json({
        model: 'claude-sonnet-5-20260630',
        content: [{ type: 'text', text: 'final' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 10 },
      }),
    ]);
    const p = new AnthropicProvider('claude-sonnet-5', 'sk-ant', pricing, { fetch, ...noSleep });
    const out = await runAgent(p, echoArm(), 'q', { maxTurns: 5, maxTokens: 100 });
    expect(out.final_text).toBe('final');
    expect(out.prompt_tokens).toBe(151_000);
    // 150k-token call at the long-context tier, 1k-token call at base.
    expect(out.cost_usd).toBeCloseTo(150_000 * 4e-6 + 100 * 2e-5 + 1000 * 2e-6 + 10 * 1e-5, 10);
    expect(out.resolved_models).toEqual(['claude-sonnet-5-20260630']);
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant');
    expect(calls[0]!.body.system).toBeString();
    const second = calls[1]!.body.messages as { role: string; content: unknown }[];
    expect(second[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'result of rg' }],
    });
  });
});

describe('retry', () => {
  test('retries a 429, honouring Retry-After', async () => {
    const slept: number[] = [];
    const { fetch, calls } = scriptedFetch([
      json({ error: { code: 429, message: 'rate limited' } }, 429, { 'retry-after': '2' }),
      orReply({ content: 'ok' }),
    ]);
    const p = new OpenRouterProvider('m', 'k', {
      fetch,
      sleep: async (ms) => void slept.push(ms),
      random: () => 1,
    });
    const out = await runAgent(p, echoArm(), 'q', { maxTurns: 2, maxTokens: 10 });
    expect(out.stop).toBe('answer');
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([2000]);
  });

  test('backs off exponentially, capped, and gives up after maxAttempts', async () => {
    const slept: number[] = [];
    const { fetch, calls } = scriptedFetch([
      json({}, 503),
      json({}, 503),
      json({}, 503),
      json({}, 503),
    ]);
    const err = await postJson(
      'u',
      {},
      {},
      {
        fetch,
        sleep: async (ms) => void slept.push(ms),
        random: () => 1,
        maxAttempts: 4,
        baseDelayMs: 1000,
        maxDelayMs: 3000,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(503);
    expect(calls).toHaveLength(4);
    expect(slept).toEqual([1000, 2000, 3000]);
  });

  test('does not retry a 400', async () => {
    const { fetch, calls } = scriptedFetch([
      json({ error: { code: 400, message: 'bad model' } }, 400),
    ]);
    const out = await runAgent(
      new OpenRouterProvider('m', 'k', { fetch, ...noSleep }),
      echoArm(),
      'q',
      {
        maxTurns: 2,
        maxTokens: 10,
      },
    );
    expect(out.stop).toBe('error');
    expect(out.error).toContain('400');
    expect(calls).toHaveLength(1);
  });

  test('retries an upstream error reported inside a 200 and a network failure', async () => {
    let n = 0;
    const replies = [
      () => {
        throw new TypeError('socket hang up');
      },
      json({ error: { code: 502, message: 'provider down' } }),
      orReply({ content: 'ok' }),
    ];
    const fetch = (async () => replies[n++]!()) as unknown as typeof fetch;
    const out = await runAgent(
      new OpenRouterProvider('m', 'k', { fetch, ...noSleep }),
      echoArm(),
      'q',
      {
        maxTurns: 2,
        maxTokens: 10,
      },
    );
    expect(out.stop).toBe('answer');
    expect(n).toBe(3);
  });
});

describe('expected criteria', () => {
  test('substrings are case-insensitive, regexes keep their flags', () => {
    expect(checkAnswer('See `Providers/GitHub.ts`', { all: ['providers/github.ts'] }).pass).toBe(
      true,
    );
    expect(checkAnswer('Auth.js handles it', { all: ['/\\bAuth\\b(?!\\.js)/'] }).pass).toBe(false);
    expect(checkAnswer('the Auth function', { all: ['/\\bAuth\\b(?!\\.js)/'] }).pass).toBe(true);
    expect(checkAnswer('SIGNIN', { all: ['/\\bsignin\\b/'] }).pass).toBe(false);
    expect(checkAnswer('SIGNIN', { all: ['/\\bsignin\\b/i'] }).pass).toBe(true);
  });

  test('all, any with any_min, and none', () => {
    const e = { all: ['checks.ts'], any: ['state', 'pkce', 'nonce'], any_min: 2, none: ['csrf'] };
    expect(checkAnswer('checks.ts does state and nonce', e)).toEqual({
      pass: true,
      missing: [],
      any_matched: ['state', 'nonce'],
      forbidden: [],
    });
    expect(checkAnswer('checks.ts does state', e).pass).toBe(false);
    expect(checkAnswer('state and pkce', e).missing).toEqual(['checks.ts']);
    expect(checkAnswer('checks.ts: state, pkce, csrf', e).forbidden).toEqual(['csrf']);
  });

  test('validateExpected rejects uncheckable criteria', () => {
    expect(() => validateExpected('q', {})).toThrow('needs all or any');
    expect(() => validateExpected('q', { all: ['/(/'] })).toThrow('bad regex');
    expect(() => validateExpected('q', { any: ['a'], any_min: 2 })).toThrow('any_min');
    expect(() => validateExpected('q', { all: [''] })).toThrow('empty pattern');
  });

  test('queries.json is pinned, valid, and each reference answer passes its own check', () => {
    const qf = JSON.parse(readFileSync(QUERIES, 'utf-8')) as QueriesFile;
    expect(qf.target.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(new Set(qf.queries.map((q) => q.id)).size).toBe(qf.queries.length);
    for (const q of qf.queries) {
      validateExpected(q.id, q.expected);
      expect({ id: q.id, ...checkAnswer(q.reference, q.expected) }).toMatchObject({
        id: q.id,
        pass: true,
      });
    }
    const natural = qf.queries.filter((q) => q.category === 'natural');
    expect(natural.length).toBeGreaterThanOrEqual(4);
    // Natural-language asks name no identifiers: no backticks, paths or camelCase.
    for (const q of natural) expect(q.ask).not.toMatch(/`|\/|\.ts\b|[a-z][A-Z]/);
  });
});

const run = (over: Partial<RunResult> & Pick<RunResult, 'query_id' | 'arm'>): RunResult => ({
  trial: 0,
  prompt_tokens: 1000,
  completion_tokens: 0,
  cost_usd: 0.001,
  model_calls: 2,
  tool_turns: 1,
  tool_chars: {},
  stop: 'answer',
  final_text: 'ok',
  resolved_models: ['m-1'],
  upstreams: [],
  elapsed_ms: 1,
  check: { pass: true, missing: [], any_matched: [], forbidden: [] },
  ...over,
});
const fail = { pass: false, missing: ['x'], any_matched: [], forbidden: [] };

const benchFile = (results: RunResult[]): BenchFile => ({
  schema: 2,
  label: 'test',
  started_at: '',
  finished_at: '',
  provider: 'openrouter',
  model: 'anthropic/claude-haiku-5.5',
  judge_model: null,
  rig: { version: '0.2.0', commit: 'abc', dirty: false, fingerprint: 'f' },
  target: {
    repo: '/r',
    commit: 'c',
    expected_commit: 'c',
    index: { nodes: 1, files: 1, rebuilt: false, elapsed_ms: 0 },
  },
  arms: ['baseline', 'rig'],
  trials: 2,
  max_turns: 12,
  queries: [
    { id: 'q1', category: 'lookup', ask: '', reference: 'x', expected: { all: ['x'] } },
    { id: 'q2', category: 'natural', ask: '', reference: 'x', expected: { all: ['x'] } },
    { id: 'q3', category: 'natural', ask: '', reference: 'x', expected: { all: ['x'] } },
  ],
  results,
});

describe('report aggregation', () => {
  // q1: rig correct and cheaper. q2: rig correct but pricier. q3: rig wrong,
  // baseline wrong once out of two (still counts as correct: at least half).
  const file = benchFile([
    run({ query_id: 'q1', arm: 'baseline', prompt_tokens: 10_000, cost_usd: 0.01 }),
    run({ query_id: 'q1', arm: 'baseline', trial: 1, prompt_tokens: 20_000, cost_usd: 0.02 }),
    run({ query_id: 'q1', arm: 'rig', prompt_tokens: 2_000, cost_usd: 0.002 }),
    run({ query_id: 'q1', arm: 'rig', trial: 1, prompt_tokens: 4_000, cost_usd: 0.004 }),
    run({ query_id: 'q2', arm: 'baseline', prompt_tokens: 1_000 }),
    run({ query_id: 'q2', arm: 'baseline', trial: 1, prompt_tokens: 1_000 }),
    run({ query_id: 'q2', arm: 'rig', prompt_tokens: 3_000, tool_turns: 4 }),
    run({ query_id: 'q2', arm: 'rig', trial: 1, prompt_tokens: 3_000, tool_turns: 4 }),
    run({ query_id: 'q3', arm: 'baseline', prompt_tokens: 5_000 }),
    run({ query_id: 'q3', arm: 'baseline', trial: 1, prompt_tokens: 5_000, check: fail }),
    run({ query_id: 'q3', arm: 'rig', prompt_tokens: 500, check: fail, final_text: 'nope' }),
    run({
      query_id: 'q3',
      arm: 'rig',
      trial: 1,
      prompt_tokens: 500,
      check: fail,
      stop: 'turn_limit',
    }),
  ]);

  test('per-arm correctness, tokens, cost and tool turns', () => {
    const r = aggregate(file);
    const [base, rig] = r.arms;
    expect(base!.correct).toBe(5);
    expect(base!.correct_rate).toBeCloseTo(5 / 6);
    expect(rig!.correct).toBe(4);
    expect(rig!.turn_limits).toBe(1);
    // rig tokens: [2000, 4000, 3000, 3000, 500, 500]
    expect(rig!.tokens_all).toEqual({ median: 2500, mean: 13_000 / 6 });
    expect(rig!.tokens_correct).toEqual({ median: 3000, mean: 3000 });
    expect(rig!.cost_correct!.median).toBeCloseTo(0.0015);
    expect(rig!.tool_turns).toEqual({ median: 1, mean: 2 });
    expect(rig!.by_category.natural!.correct_rate).toBeCloseTo(0.5);
    expect(rig!.by_category.lookup!.correct_rate).toBe(1);
  });

  test('paired comparison against baseline', () => {
    const p = aggregate(file).arms[1]!.paired!;
    expect(p.queries).toBe(3);
    expect(p.correct_cheaper).toBe(1);
    expect(p.correct_pricier).toBe(1);
    expect(p.wrong).toBe(1);
    expect(p.baseline_wrong).toBe(0);
    // ratios: q1 3000/15000 = 0.2, q2 3, q3 0.1 → median 0.2
    expect(p.median_token_ratio).toBeCloseTo(0.2);
    // both correct: q1 and q2 → median of [0.2, 3]
    expect(p.median_token_ratio_both_correct).toBeCloseTo(1.6);
    expect(aggregate(file).arms[0]!.paired).toBeNull();
  });

  test('--recheck grades stored answers against new criteria', () => {
    const relaxed = file.queries.map((q) => ({ ...q, expected: { any: ['ok', 'nope'] } }));
    const r = aggregate(file, { queries: relaxed });
    expect(r.arms[1]!.correct).toBe(6);
    expect(r.failures).toHaveLength(0);
  });

  test('every non-baseline arm, grep+rig included, gets a paired row', () => {
    const withGrepRig: BenchFile = {
      ...file,
      arms: ['baseline', 'rig', 'grep+rig'],
      results: [
        ...file.results,
        ...file.results
          .filter((r) => r.arm === 'rig')
          .map((r) => ({ ...r, arm: 'grep+rig' as const })),
      ],
    };
    const r = aggregate(withGrepRig);
    expect(r.arms.map((a) => a.arm)).toEqual(['baseline', 'rig', 'grep+rig']);
    expect(r.arms[2]!.paired).toEqual(r.arms[1]!.paired);
    expect(renderMarkdown(r)).toContain('| grep+rig | 3 | 20.0% | 160.0% | 1 | 1 | 1 | 0 |');
  });

  test('renders markdown with every section', () => {
    const md = renderMarkdown(aggregate(file));
    expect(md).toContain('## Per arm');
    expect(md).toContain('## Paired against baseline');
    expect(md).toContain('| rig | 3 | 20.0% | 160.0% | 1 | 1 | 1 | 0 |');
    expect(md).toContain('## By query category');
    expect(md).toContain('`q3` / rig: 2/2 failed — missing `x`; turn_limit');
    expect(md).not.toContain('LLM judge');
  });
});

describe('pricing and plan', () => {
  test('maps Anthropic API ids to OpenRouter ids', () => {
    expect(openRouterIdFor('claude-haiku-4-5-20251001')).toBe('anthropic/claude-haiku-4.5');
    expect(openRouterIdFor('claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(openRouterIdFor('claude-opus-5-5')).toBe('anthropic/claude-opus-5.5');
  });

  test('reads the catalogue through a mocked fetch and estimates a plan', async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'anthropic/claude-haiku-5.5',
              pricing: { prompt: '0.0000001', completion: '0.0000005' },
            },
            { id: 'free/thing', pricing: { prompt: 'x' } },
          ],
        }),
      )) as unknown as typeof fetch;
    const cat = await fetchCatalogue(fetch);
    expect(cat!.size).toBe(1);
    const p = lookupPricing(cat, 'anthropic/claude-haiku-5.5') as ModelPricing;
    expect(priceCall(p, 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    const est = estimatePlan({
      arms: ['baseline', 'rig'],
      runsPerArm: 10,
      pricing: p,
      profiles: {
        baseline: { prompt_tokens: 50_000, completion_tokens: 1_000, model_calls: 5 },
        rig: { prompt_tokens: 10_000, completion_tokens: 1_000, model_calls: 5 },
      },
    });
    expect(est.arms[0]!.cost_usd).toBeCloseTo(10 * (0.005 + 0.0005));
    expect(est.total_usd).toBeCloseTo(10 * (0.005 + 0.0005 + 0.001 + 0.0005));
    expect(estimatePlan({ arms: ['rig'], runsPerArm: 1, pricing: null }).total_usd).toBeNull();
    expect(
      await fetchCatalogue(
        (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
      ),
    ).toBeNull();
  });

  test('provider choice: flag, then BENCH_PROVIDER, then whichever key is set', () => {
    expect(resolveProviderName('anthropic', { OPENROUTER_API_KEY: 'x' })).toBe('anthropic');
    expect(resolveProviderName(undefined, { BENCH_PROVIDER: 'anthropic' })).toBe('anthropic');
    expect(
      resolveProviderName(undefined, { OPENROUTER_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }),
    ).toBe('openrouter');
    expect(resolveProviderName(undefined, { ANTHROPIC_API_KEY: 'y' })).toBe('anthropic');
    expect(resolveProviderName(undefined, {})).toBe('openrouter');
    expect(() => resolveProviderName('openai', {})).toThrow('unknown provider');
    expect(parseArms(undefined)).toEqual(['baseline', 'rig', 'rig-search', 'grep+rig']);
    expect(parseArms('grep+rig')).toEqual(['grep+rig']);
    expect(parseArms('rig-search, baseline')).toEqual(['rig-search', 'baseline']);
    expect(() => parseArms('grep')).toThrow('unknown arm');
  });

  test('judge verdicts parse leniently and fail closed', () => {
    expect(parseVerdict('Sure: {"verdict":"incorrect","reason":"wrong file"}')).toEqual({
      verdict: 'incorrect',
      reason: 'wrong file',
    });
    expect(parseVerdict('looks right to me').verdict).toBe('error');
  });
});

describe('rig-search arm', () => {
  let project: string;
  let rig: Rig;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-bench-arm-'));
    writeFileSync(
      join(project, 'auth.ts'),
      `export class AuthStore {\n  login(): void { refresh(); }\n}\nexport function refresh(): void {}\n`,
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterAll(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('offers the MCP manifest entries for its seven tools', () => {
    expect(RIG_SEARCH_TOOLS.map((t) => t.name)).toEqual([
      'rig_search',
      'rig_context',
      'rig_explore',
      'rig_node',
      'rig_callers',
      'rig_neighbors',
      'rig_files',
    ]);
    for (const t of RIG_SEARCH_TOOLS) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.input_schema.type).toBe('object');
      expect(t.input_schema.$schema).toBeUndefined();
    }
  });

  test('runs the real tool handlers, contract validation included', async () => {
    const exec = makeRigSearchRunner(rig);
    const search = JSON.parse(await exec('rig_search', { query: 'AuthStore' })) as {
      nodes: { id: string; name: string }[];
    };
    const store = search.nodes.find((n) => n.name === 'AuthStore');
    expect(store).toBeDefined();
    const explore = JSON.parse(await exec('rig_explore', { question: 'AuthStore' })) as {
      anchors: { name: string; source: string }[];
    };
    expect(explore.anchors.find((a) => a.name === 'AuthStore')?.source).toContain(
      'class AuthStore',
    );
    expect(await exec('rig_node', { id: 'nope' })).toStartWith('error: NODE_NOT_FOUND');
    expect(await exec('rig_search', {})).toStartWith('error: INPUT_INVALID');
    expect(await exec('rig_deps', {})).toBe('error: unknown tool rig_deps');
  });

  test('grep+rig offers the baseline tools plus the rig-search tools, and routes each', async () => {
    const arm = makeArm('grep+rig', project, rig);
    expect(arm.tools.map((t) => t.name)).toEqual([
      'rg',
      'read_file',
      'list_dir',
      'rig_search',
      'rig_context',
      'rig_explore',
      'rig_node',
      'rig_callers',
      'rig_neighbors',
      'rig_files',
    ]);
    // Same definitions as the arms it combines, so no description changes.
    expect(arm.tools).toEqual([...BASELINE_TOOLS, ...RIG_SEARCH_TOOLS]);
    expect(await arm.exec('read_file', { path: 'auth.ts', limit: 1 })).toBe(
      '    1: export class AuthStore {',
    );
    const search = JSON.parse(await arm.exec('rig_search', { query: 'AuthStore' })) as {
      nodes: { name: string }[];
    };
    expect(search.nodes.some((n) => n.name === 'AuthStore')).toBe(true);
    expect(await arm.exec('rig_search', {})).toStartWith('error: INPUT_INVALID');
    expect(await arm.exec('rig_deps', {})).toBe('error: unknown tool rig_deps');
  });
});
