// SPDX-License-Identifier: Apache-2.0
// OpenAI-style tool calling as non-Anthropic upstreams send it through
// OpenRouter, from mocked replies in each vendor's shape: OpenAI, Google,
// DeepSeek and Qwen. The quirks: tool_call ids, parallel calls, argument
// shapes, finish_reason spellings, reasoning state and missing usage cost.
// Then credits and billing errors, which must stop a run, never score 0%.
import { describe, expect, test } from 'bun:test';
import { runAgent } from '../scripts/bench/agent.ts';
import type { Arm } from '../scripts/bench/arms.ts';
import { parsePricing, type ModelPricing } from '../scripts/bench/pricing.ts';
import { judgeAnswer } from '../scripts/bench/judge.ts';
import {
  OpenRouterProvider,
  isCreditsFailure,
  isInsufficientCredits,
  normalizeFinishReason,
  normalizeToolCalls,
  type InsufficientCreditsError,
} from '../scripts/bench/providers.ts';

interface Captured {
  body: Record<string, unknown>;
}

const scriptedFetch = (replies: unknown[]) => {
  const calls: Captured[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(init.body as string) as Record<string, unknown> });
    const next = replies.shift();
    if (next === undefined) throw new Error('unexpected extra request');
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
};

const noSleep = { sleep: async () => {}, random: () => 1 };

const recordingArm = (): Arm & { seen: { name: string; input: unknown }[] } => {
  const seen: { name: string; input: unknown }[] = [];
  return {
    name: 'grep+rig',
    tools: [
      {
        name: 'rg',
        description: 'ripgrep',
        input_schema: { type: 'object', properties: { args: { type: 'array' } } },
      },
      {
        name: 'read_file',
        description: 'read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    seen,
    exec: async (name, input) => {
      seen.push({ name, input });
      return `result of ${name} #${seen.length}`;
    },
  };
};

const pricing = (id: string, inPerM: number, outPerM: number): ModelPricing =>
  parsePricing({
    id,
    canonical_slug: `${id}-20261001`,
    supported_parameters: ['tools', 'tool_choice', 'max_tokens'],
    pricing: { prompt: String(inPerM / 1e6), completion: String(outPerM / 1e6) },
  })!;

type Msg = Record<string, unknown>;
const messagesOf = (c: Captured): Msg[] => c.body.messages as Msg[];

describe('OpenAI-style tool calling across vendors (mocked OpenRouter replies)', () => {
  test('OpenAI: parallel tool calls with null content all run, results in call order', async () => {
    const { fetch, calls } = scriptedFetch([
      {
        model: 'openai/gpt-6-luna-20260922',
        provider: 'OpenAI',
        choices: [
          {
            finish_reason: 'tool_calls',
            native_finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_a1',
                  type: 'function',
                  function: { name: 'rg', arguments: '{"args":["sealCookie"]}' },
                },
                {
                  id: 'call_a2',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.0001 },
      },
      {
        model: 'openai/gpt-6-luna-20260922',
        provider: 'OpenAI',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'In a.ts' } }],
        usage: { prompt_tokens: 1200, completion_tokens: 20, cost: 0.0002 },
      },
    ]);
    const p = new OpenRouterProvider('openai/gpt-6-luna', 'k', { fetch, ...noSleep });
    const arm = recordingArm();
    const out = await runAgent(p, arm, 'q', { maxTurns: 4, maxTokens: 2048 });
    expect(out.stop).toBe('answer');
    expect(out.final_text).toBe('In a.ts');
    expect(arm.seen.map((s) => s.name)).toEqual(['rg', 'read_file']);
    expect(out.cost_usd).toBeCloseTo(0.0003, 10);
    expect(out.finish_reasons).toEqual({ tool_calls: 1, stop: 1 });
    expect(out.resolved_models).toEqual(['openai/gpt-6-luna-20260922']);
    const second = messagesOf(calls[1]!);
    expect(second[2]).toMatchObject({ role: 'assistant', content: null });
    expect(second.slice(3).map((m) => m.tool_call_id)).toEqual(['call_a1', 'call_a2']);
  });

  test('Google: missing and repeated ids get fresh ones, STOP with calls still runs them, reasoning_details go back', async () => {
    const details = [{ type: 'reasoning.encrypted', data: 'sig-1', id: 'tool_0' }];
    const { fetch, calls } = scriptedFetch([
      {
        model: 'google/gemini-3.8-flash-20260902',
        provider: 'Google',
        choices: [
          {
            finish_reason: 'STOP',
            message: {
              role: 'assistant',
              content: '',
              reasoning_details: details,
              tool_calls: [
                // Gemini-style: arguments already parsed, ids absent or reused.
                { function: { name: 'rg', arguments: { args: ['csrf'] } } },
                { id: 'tool_0', function: { name: 'rg', arguments: { args: ['token'] } } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 800, completion_tokens: 60, cost: 0.001 },
      },
      {
        model: 'google/gemini-3.8-flash-20260902',
        choices: [
          {
            finish_reason: 'STOP',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'tool_0', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 900, completion_tokens: 30, cost: 0.001 },
      },
      {
        model: 'google/gemini-3.8-flash-20260902',
        choices: [{ finish_reason: 'STOP', message: { role: 'assistant', content: 'b.ts' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 10, cost: 0.001 },
      },
    ]);
    const p = new OpenRouterProvider('google/gemini-3.8-flash', 'k', { fetch, ...noSleep });
    const arm = recordingArm();
    const out = await runAgent(p, arm, 'q', { maxTurns: 5, maxTokens: 2048 });
    expect(out.final_text).toBe('b.ts');
    expect(arm.seen).toEqual([
      { name: 'rg', input: { args: ['csrf'] } },
      { name: 'rg', input: { args: ['token'] } },
      { name: 'read_file', input: { path: 'b.ts' } },
    ]);
    expect(out.finish_reasons).toEqual({ stop: 3 });
    const second = messagesOf(calls[1]!);
    const assistant = second[2]!;
    expect(assistant.reasoning_details).toEqual(details);
    const ids = (assistant.tool_calls as { id: string }[]).map((c) => c.id);
    expect(ids[0]).toBe('call_rig_1');
    expect(ids[1]).toBe('tool_0');
    expect(second.slice(3).map((m) => m.tool_call_id)).toEqual(ids);
    // Turn 2 reuses "tool_0": renamed, so each tool result answers one call.
    const third = messagesOf(calls[2]!);
    const reused = (third.at(-2)!.tool_calls as { id: string }[])[0]!.id;
    expect(reused).toBe('call_rig_2');
    expect(third.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_rig_2' });
    const all = third.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : []));
    expect(new Set(all).size).toBe(all.length);
  });

  test('DeepSeek: a reply without usage.cost is priced from the list price; reasoning text is not the answer', async () => {
    const { fetch } = scriptedFetch([
      {
        model: 'deepseek/deepseek-v4.1-flash-20260910',
        provider: 'DeepSeek',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              reasoning: 'I should grep for the cookie chunk size.',
              tool_calls: [
                {
                  id: 'call_0_9f2',
                  type: 'function',
                  function: { name: 'rg', arguments: '{"args":["CHUNK_SIZE"]}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000 },
      },
      {
        model: 'deepseek/deepseek-v4.1-flash-20260910',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '4096' } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
      },
    ]);
    const p = new OpenRouterProvider(
      'deepseek/deepseek-v4.1-flash',
      'k',
      { fetch, ...noSleep },
      pricing('deepseek/deepseek-v4.1-flash', 0.045, 0.5),
    );
    const out = await runAgent(p, recordingArm(), 'q', { maxTurns: 3, maxTokens: 2048 });
    expect(out.final_text).toBe('4096');
    // 2M prompt × $0.045/M + 0.1M completion × $0.50/M.
    expect(out.cost_usd).toBeCloseTo(0.09 + 0.05, 10);
  });

  test('a reply with no usage block at all leaves the cost unknown, not zero', async () => {
    const { fetch } = scriptedFetch([
      { model: 'x', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] },
    ]);
    const p = new OpenRouterProvider('x', 'k', { fetch, ...noSleep }, pricing('x', 1, 1));
    const out = await runAgent(p, recordingArm(), 'q', { maxTurns: 2, maxTokens: 64 });
    expect(out.cost_usd).toBeNull();
  });

  test('Qwen: empty-string arguments, content parts, ids reused across turns, a cut-off call', async () => {
    const { fetch, calls } = scriptedFetch([
      {
        model: 'qwen/qwen3.8-flash-20260826',
        provider: 'Alibaba',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Looking.' }],
              tool_calls: [
                { id: 'call_0', type: 'function', function: { name: 'rg', arguments: '' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 500, completion_tokens: 5, cost: 0.00001 },
      },
      {
        model: 'qwen/qwen3.8-flash-20260826',
        choices: [
          {
            // max_tokens hit mid-arguments: the JSON is cut off.
            finish_reason: 'length',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_0',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"lib/ac' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 600, completion_tokens: 2048, cost: 0.001 },
      },
      {
        model: 'qwen/qwen3.8-flash-20260826',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 700, completion_tokens: 5, cost: 0.00001 },
      },
    ]);
    const p = new OpenRouterProvider('qwen/qwen3.8-flash', 'k', { fetch, ...noSleep });
    const arm = recordingArm();
    const out = await runAgent(p, arm, 'q', { maxTurns: 5, maxTokens: 2048 });
    expect(out.final_text).toBe('done');
    // "" arguments mean no arguments; the truncated call never reaches a tool.
    expect(arm.seen).toEqual([{ name: 'rg', input: {} }]);
    expect(out.tool_turns).toBe(2);
    expect(out.finish_reasons).toEqual({ tool_calls: 1, length: 1, stop: 1 });
    const second = messagesOf(calls[1]!);
    expect(second[2]).toMatchObject({ role: 'assistant', content: 'Looking.' });
    const third = messagesOf(calls[2]!);
    expect(third.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_rig_1' });
    expect(String(third.at(-1)!.content)).toContain('not valid JSON');
  });

  test('a legacy function_call becomes one tool call', () => {
    const used = new Set<string>();
    let n = 0;
    const calls = normalizeToolCalls(
      { function_call: { name: 'rg', arguments: '{"args":["x"]}' } },
      used,
      () => `id${++n}`,
    );
    expect(calls).toEqual([
      { id: 'id1', type: 'function', function: { name: 'rg', arguments: '{"args":["x"]}' } },
    ]);
  });

  test('finish reasons normalise across upstream spellings', () => {
    const cases: [unknown, string | null][] = [
      ['tool_calls', 'tool_calls'],
      ['function_call', 'tool_calls'],
      ['tool_use', 'tool_calls'],
      ['stop', 'stop'],
      ['STOP', 'stop'],
      ['end_turn', 'stop'],
      ['length', 'length'],
      ['MAX_TOKENS', 'length'],
      ['max_tokens', 'length'],
      ['content_filter', 'content_filter'],
      ['SAFETY', 'content_filter'],
      ['MALFORMED_FUNCTION_CALL', 'other'],
      [null, null],
      [undefined, null],
    ];
    for (const [raw, want] of cases) expect(normalizeFinishReason(raw)).toBe(want as never);
  });
});

describe('credits and billing errors are fatal', () => {
  const failing = (status: number, body: unknown) => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetch: f, calls: () => calls };
  };

  test('HTTP 402 is not retried and stops the agent run instead of becoming a failed trial', async () => {
    const f = failing(402, {
      error: { code: 402, message: 'This request requires more credits, or fewer max_tokens.' },
    });
    const p = new OpenRouterProvider('openai/gpt-6-luna', 'k', { fetch: f.fetch, ...noSleep });
    const err = await runAgent(p, recordingArm(), 'q', { maxTurns: 3, maxTokens: 64 }).catch(
      (e: unknown) => e,
    );
    expect(isInsufficientCredits(err)).toBe(true);
    expect((err as InsufficientCreditsError).status).toBe(402);
    expect(f.calls()).toBe(1);
  });

  test('an OpenRouter error inside a 200 reply that says credits is fatal too', async () => {
    const f = failing(200, {
      error: {
        code: 402,
        message: 'Insufficient credits. Add more using https://openrouter.ai/credits',
      },
    });
    const p = new OpenRouterProvider('m', 'k', { fetch: f.fetch, ...noSleep });
    const err = await p
      .start({ system: 's', user: 'u', tools: [], maxTokens: 8 })
      .send()
      .catch((e: unknown) => e);
    expect(isInsufficientCredits(err)).toBe(true);
    expect(f.calls()).toBe(1);
  });

  test('a credits message under another status counts (Anthropic 400, insufficient balance)', async () => {
    for (const [status, msg] of [
      [400, 'Your credit balance is too low to access the Anthropic API.'],
      [403, 'insufficient_balance: top up your account'],
      [429, 'Payment required to continue'],
    ] as const) {
      const f = failing(status, { error: { message: msg } });
      const p = new OpenRouterProvider('m', 'k', { fetch: f.fetch, ...noSleep });
      const err = await p
        .start({ system: 's', user: 'u', tools: [], maxTokens: 8 })
        .send()
        .catch((e: unknown) => e);
      expect(isInsufficientCredits(err)).toBe(true);
      expect(f.calls()).toBe(1);
    }
  });

  test('ordinary errors are unchanged: a 429 is retried, a 400 is a recorded failure', async () => {
    const replies = [
      new Response('{"error":{"message":"rate limited"}}', { status: 429 }),
      new Response(
        JSON.stringify({
          model: 'm',
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
        }),
        { status: 200 },
      ),
    ];
    const f = (async () => replies.shift()!) as unknown as typeof fetch;
    const p = new OpenRouterProvider('m', 'k', { fetch: f, ...noSleep });
    const ok = await runAgent(p, recordingArm(), 'q', { maxTurns: 2, maxTokens: 8 });
    expect(ok.final_text).toBe('ok');
    const bad = failing(400, { error: { message: 'context length exceeded' } });
    const p2 = new OpenRouterProvider('m', 'k', { fetch: bad.fetch, ...noSleep });
    const out = await runAgent(p2, recordingArm(), 'q', { maxTurns: 2, maxTokens: 8 });
    expect(out.stop).toBe('error');
    expect(isCreditsFailure(400, 'context length exceeded')).toBe(false);
  });

  test('the judge rethrows a credits error instead of recording a judge error', async () => {
    const f = failing(402, { error: { code: 402, message: 'requires more credits' } });
    const p = new OpenRouterProvider('judge', 'k', { fetch: f.fetch, ...noSleep });
    const err = await judgeAnswer(
      p,
      { id: 'q', category: 'lookup', ask: 'a?', reference: 'r', expected: { all: ['r'] } },
      'r',
    ).catch((e: unknown) => e);
    expect(isInsufficientCredits(err)).toBe(true);
  });
});
