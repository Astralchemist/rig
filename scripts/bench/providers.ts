// SPDX-License-Identifier: Apache-2.0
// Model providers behind one conversation interface. Each conversation keeps
// its history in the provider's native wire format, so nothing is lost in a
// round trip: the OpenRouter one speaks OpenAI-style chat completions with
// tool_calls, the Anthropic one speaks the Messages API with tool_use blocks.
import { priceCall, type ModelPricing } from './pricing.ts';
import type { ProviderName, ToolDef } from './types.ts';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const REPO_URL = 'https://github.com/Astralchemist/rig';

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  openrouter: 'anthropic/claude-haiku-5.5',
  anthropic: 'claude-sonnet-5',
};

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  // Set when the model sent arguments that are not valid JSON.
  inputError?: string;
}

export interface TurnUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | null;
}

export interface Turn {
  text: string;
  toolCalls: ToolCall[];
  usage: TurnUsage;
  // The model id the API says served the call (dated snapshot, usually).
  resolvedModel: string | null;
  // OpenRouter only: the upstream provider that served the call.
  upstream: string | null;
  // Why the model stopped, normalised across upstreams; null when unreported.
  finishReason?: FinishReason | null;
}

export interface Conversation {
  send(): Promise<Turn>;
  addToolResults(results: readonly { id: string; content: string }[]): void;
  // The next scripted user message of a multi-turn conversation.
  addUserMessage(text: string): void;
}

export interface ConversationOpts {
  system: string;
  user: string;
  tools: readonly ToolDef[];
  maxTokens: number;
}

export interface Provider {
  readonly name: ProviderName;
  readonly model: string;
  start(opts: ConversationOpts): Conversation;
}

export interface HttpOpts {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  // Total attempts per request, first one included.
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  log?: (line: string) => void;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

// Rate limits, timeouts, upstream outages and Anthropic's 529 "overloaded".
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const retryAfterMs = (res: Response): number | null => {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
};

/**
 * POST a JSON body and parse the JSON reply, retrying network failures and
 * retryable statuses with capped exponential backoff plus jitter. A server
 * Retry-After wins over the computed delay (still capped). `bodyError` lets a
 * provider flag an error inside a 200 reply, as OpenRouter sometimes does.
 */
export const postJson = async (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  http: HttpOpts = {},
  bodyError: (json: unknown) => ProviderError | null = () => null,
): Promise<unknown> => {
  const doFetch = http.fetch ?? fetch;
  const sleep = http.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = http.maxAttempts ?? 5;
  const base = http.baseDelayMs ?? 1000;
  const cap = http.maxDelayMs ?? 60_000;
  const random = http.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    let failure: ProviderError;
    try {
      const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await res.text();
      if (res.ok) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new ProviderError(
            `invalid JSON from ${url}: ${text.slice(0, 200)}`,
            res.status,
            true,
          );
        }
        const embedded = bodyError(json);
        if (!embedded) return json;
        failure = embedded;
      } else {
        failure = new ProviderError(
          `HTTP ${res.status}: ${text.slice(0, 500)}`,
          res.status,
          RETRYABLE.has(res.status),
          retryAfterMs(res),
        );
      }
    } catch (err) {
      failure =
        err instanceof ProviderError
          ? err
          : new ProviderError(
              `network: ${err instanceof Error ? err.message : String(err)}`,
              null,
              true,
            );
    }
    if (!failure.retryable || attempt >= maxAttempts) throw failure;
    const backoff = Math.min(cap, base * 2 ** (attempt - 1)) * (0.5 + random() / 2);
    const delay = Math.min(cap, failure.retryAfterMs ?? backoff);
    http.log?.(`retry ${attempt}/${maxAttempts - 1} in ${Math.round(delay)}ms: ${failure.message}`);
    await sleep(delay);
  }
};

// ---------------------------------------------------------------- OpenRouter

interface OaToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OaToolCall[];
  tool_call_id?: string;
  // Reasoning state some upstreams (Gemini's thought signatures) need back on
  // the next request; kept on the assistant message unchanged.
  reasoning_details?: unknown[];
}

interface OaResponse {
  model?: string;
  provider?: string;
  choices?: {
    message?: Record<string, unknown>;
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    error?: unknown;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export const toOpenAiTools = (tools: readonly ToolDef[]) =>
  tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

const parseArguments = (raw: string): { input: unknown; inputError?: string } => {
  if (raw.trim() === '') return { input: {} };
  try {
    return { input: JSON.parse(raw) };
  } catch (err) {
    return { input: {}, inputError: err instanceof Error ? err.message : String(err) };
  }
};

// Upstreams name the same few outcomes differently: OpenAI "tool_calls",
// legacy "function_call", Anthropic "tool_use" / "end_turn" / "max_tokens",
// Gemini "STOP" / "MAX_TOKENS" / "SAFETY".
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

export const normalizeFinishReason = (raw: unknown): FinishReason | null => {
  if (typeof raw !== 'string' || raw === '') return null;
  const r = raw.toLowerCase();
  if (r === 'tool_calls' || r === 'function_call' || r === 'tool_use') return 'tool_calls';
  if (r === 'stop' || r === 'end_turn' || r === 'stop_sequence' || r === 'eos') return 'stop';
  if (r === 'length' || r === 'max_tokens' || r === 'max_output_tokens') return 'length';
  if (r === 'content_filter' || r === 'safety' || r === 'recitation' || r === 'blocklist')
    return 'content_filter';
  return 'other';
};

// Message content as text: a string, or (some upstreams) an array of parts.
const contentText = (c: unknown): string => {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .flatMap((part) =>
      isRecord(part) &&
      (part.type === undefined || part.type === 'text') &&
      typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('');
};

/**
 * The tool calls of one reply in the canonical OpenAI shape, whatever the
 * upstream sent. Arguments arrive as a JSON string, an already-parsed object,
 * or nothing; a legacy `function_call` becomes one call. Ids that are
 * missing, empty or already used earlier in the conversation (Gemini and
 * Qwen reuse "call_0"-style ids across turns) are replaced with fresh ones,
 * so every tool result answers exactly one call.
 */
export const normalizeToolCalls = (
  message: Record<string, unknown>,
  used: Set<string>,
  nextId: () => string,
): OaToolCall[] => {
  const raw: unknown[] = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : isRecord(message.function_call)
      ? [{ function: message.function_call }]
      : [];
  const out: OaToolCall[] = [];
  for (const c of raw) {
    if (!isRecord(c) || !isRecord(c.function)) continue;
    const name = typeof c.function.name === 'string' ? c.function.name : '';
    const args = c.function.arguments;
    const argText =
      typeof args === 'string'
        ? args
        : args === undefined || args === null
          ? ''
          : JSON.stringify(args);
    let id = typeof c.id === 'string' ? c.id : '';
    if (id === '' || used.has(id)) id = nextId();
    used.add(id);
    out.push({ id, type: 'function', function: { name, arguments: argText } });
  }
  return out;
};

// OpenRouter reports upstream failures as {error: {code, message}}, sometimes
// with HTTP 200, and a mid-generation failure as finish_reason "error".
export const openRouterBodyError = (json: unknown): ProviderError | null => {
  if (!isRecord(json)) return new ProviderError('reply is not an object', null, true);
  if (isRecord(json.error)) {
    const code = typeof json.error.code === 'number' ? json.error.code : null;
    const msg = typeof json.error.message === 'string' ? json.error.message : 'unknown error';
    return new ProviderError(
      `openrouter ${code ?? '?'}: ${msg}`,
      code,
      code === null || RETRYABLE.has(code),
    );
  }
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  if (!isRecord(choice)) return new ProviderError('reply has no choices', null, true);
  if (choice.finish_reason === 'error' || choice.error !== undefined) {
    return new ProviderError(
      `openrouter choice error: ${JSON.stringify(choice.error ?? null)}`,
      null,
      true,
    );
  }
  return null;
};

export class OpenRouterProvider implements Provider {
  readonly name = 'openrouter' as const;
  // `pricing` costs a call whose reply carries token counts but no `cost`
  // (some upstreams omit it); OpenRouter's reported cost wins when present.
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly http: HttpOpts = {},
    private readonly pricing: ModelPricing | null = null,
  ) {}

  start(opts: ConversationOpts): Conversation {
    const messages: OaMessage[] = [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ];
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': REPO_URL,
      'X-Title': 'rig bench',
    };
    const usedIds = new Set<string>();
    let minted = 0;
    const nextId = (): string => `call_rig_${++minted}`;
    return {
      send: async (): Promise<Turn> => {
        const body = {
          model: this.model,
          messages,
          max_tokens: opts.maxTokens,
          ...(opts.tools.length ? { tools: toOpenAiTools(opts.tools) } : {}),
          usage: { include: true },
        };
        const json = (await postJson(
          OPENROUTER_URL,
          headers,
          body,
          this.http,
          openRouterBodyError,
        )) as OaResponse;
        const choice = json.choices?.[0];
        const msg = isRecord(choice?.message) ? choice.message : {};
        const calls = normalizeToolCalls(msg, usedIds, nextId);
        const text = contentText(msg.content);
        messages.push({
          role: 'assistant',
          // Empty text goes back as null: Anthropic upstreams reject an empty
          // text block.
          content: text === '' ? null : text,
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(Array.isArray(msg.reasoning_details)
            ? { reasoning_details: msg.reasoning_details }
            : {}),
        });
        const u = json.usage;
        const prompt = u?.prompt_tokens ?? 0;
        const completion = u?.completion_tokens ?? 0;
        // No usage block at all: the call's cost is unknown, not zero.
        const cost =
          typeof u?.cost === 'number'
            ? u.cost
            : u && this.pricing
              ? priceCall(this.pricing, prompt, completion)
              : null;
        return {
          text: text.trim(),
          toolCalls: calls.map((c) => ({
            id: c.id,
            name: c.function.name,
            ...parseArguments(c.function.arguments),
          })),
          usage: { prompt_tokens: prompt, completion_tokens: completion, cost_usd: cost },
          resolvedModel: json.model ?? null,
          upstream: json.provider ?? null,
          finishReason: normalizeFinishReason(
            choice?.finish_reason ?? choice?.native_finish_reason,
          ),
        };
      },
      addToolResults: (results) => {
        for (const r of results)
          messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      },
      addUserMessage: (text) => {
        messages.push({ role: 'user', content: text });
      },
    };
  }
}

// ----------------------------------------------------------------- Anthropic

interface AnBlock {
  type: string;
  [k: string]: unknown;
}

interface AnMessage {
  role: 'user' | 'assistant';
  content: AnBlock[] | string;
}

interface AnResponse {
  model?: string;
  stop_reason?: string | null;
  content?: AnBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic' as const;
  // The Messages API reports no cost, so it is computed from list prices
  // (OpenRouter's catalogue mirrors them) when those are known.
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly pricing: ModelPricing | null,
    private readonly http: HttpOpts = {},
  ) {}

  start(opts: ConversationOpts): Conversation {
    const messages: AnMessage[] = [{ role: 'user', content: opts.user }];
    const headers = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
    return {
      send: async (): Promise<Turn> => {
        const body = {
          model: this.model,
          max_tokens: opts.maxTokens,
          system: opts.system,
          ...(opts.tools.length ? { tools: opts.tools } : {}),
          messages,
        };
        const json = (await postJson(ANTHROPIC_URL, headers, body, this.http)) as AnResponse;
        const content = json.content ?? [];
        messages.push({ role: 'assistant', content });
        const u = json.usage ?? {};
        const prompt =
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0);
        const completion = u.output_tokens ?? 0;
        return {
          text: content
            .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
            .join('\n')
            .trim(),
          toolCalls: content
            .filter((b) => b.type === 'tool_use')
            .map((b) => ({ id: String(b.id), name: String(b.name), input: b.input ?? {} })),
          usage: {
            prompt_tokens: prompt,
            completion_tokens: completion,
            cost_usd: this.pricing ? priceCall(this.pricing, prompt, completion) : null,
          },
          resolvedModel: json.model ?? null,
          upstream: null,
          finishReason: normalizeFinishReason(json.stop_reason),
        };
      },
      addToolResults: (results) => {
        messages.push({
          role: 'user',
          content: results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.content,
          })),
        });
      },
      // After a turn that ran out of budget mid-tool-use the last message is
      // the user's tool results; the text joins it rather than opening a
      // second user turn in a row.
      addUserMessage: (text) => {
        const last = messages.at(-1);
        if (last?.role === 'user' && Array.isArray(last.content)) {
          last.content.push({ type: 'text', text });
        } else {
          messages.push({ role: 'user', content: text });
        }
      },
    };
  }
}

// Explicit choice, then BENCH_PROVIDER, then whichever key is set; OpenRouter
// wins when both are.
export const resolveProviderName = (
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ProviderName => {
  const pick = flag ?? env.BENCH_PROVIDER;
  if (pick !== undefined) {
    if (pick === 'openrouter' || pick === 'anthropic') return pick;
    throw new Error(`unknown provider "${pick}" (expected openrouter or anthropic)`);
  }
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'openrouter';
};

export const apiKeyFor = (
  name: ProviderName,
  env: Record<string, string | undefined> = process.env,
): string | undefined => (name === 'openrouter' ? env.OPENROUTER_API_KEY : env.ANTHROPIC_API_KEY);

export const makeProvider = (
  name: ProviderName,
  model: string,
  apiKey: string,
  pricing: ModelPricing | null,
  http: HttpOpts = {},
): Provider =>
  name === 'openrouter'
    ? new OpenRouterProvider(model, apiKey, http, pricing)
    : new AnthropicProvider(model, apiKey, pricing, http);
