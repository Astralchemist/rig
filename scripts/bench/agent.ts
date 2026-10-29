// SPDX-License-Identifier: Apache-2.0
// One agent run: send the query, execute every tool call the model makes,
// feed the results back, repeat until the model answers without calling a
// tool or the turn budget runs out. Usage is summed over every model call.
// runConversation does the same over several scripted user messages.
import type { Arm } from './arms.ts';
import type { Provider } from './providers.ts';
import type { StopReason } from './types.ts';

export const SYSTEM_PROMPT = `You are a senior engineer answering a question about an unfamiliar codebase. Use the tools you have. Be concise. When you have the answer, stop calling tools and respond in plain text.`;

export interface AgentOpts {
  maxTurns: number;
  maxTokens: number;
}

export interface AgentOutcome {
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | null;
  model_calls: number;
  tool_turns: number;
  tool_chars: Record<string, number>;
  stop: StopReason;
  final_text: string;
  error?: string;
  resolved_models: string[];
  upstreams: string[];
}

// A scripted conversation: each message in `messages` is one user turn, and
// each user turn runs the tool loop until the model answers or `maxTurns`
// calls are spent on it. A turn that runs out of budget still hands over to
// the next message, as a user would carry on; an error ends the conversation.
export interface ConversationOutcome extends AgentOutcome {
  // The model's final text for each user message that got an answer.
  replies: string[];
  // How each user message ended, in order.
  stops: StopReason[];
  // Tool calls made, per tool name.
  tool_calls: Record<string, number>;
}

export const runConversation = async (
  provider: Provider,
  arm: Arm,
  messages: readonly string[],
  opts: AgentOpts,
): Promise<ConversationOutcome> => {
  if (messages.length === 0) throw new Error('runConversation needs at least one message');
  const convo = provider.start({
    system: arm.system ?? SYSTEM_PROMPT,
    user: messages[0]!,
    tools: arm.tools,
    maxTokens: opts.maxTokens,
  });
  const out: ConversationOutcome = {
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    model_calls: 0,
    tool_turns: 0,
    tool_chars: {},
    stop: 'turn_limit',
    final_text: '',
    resolved_models: [],
    upstreams: [],
    replies: [],
    stops: [],
    tool_calls: {},
  };
  const resolved = new Set<string>();
  const upstreams = new Set<string>();
  try {
    for (const [m, message] of messages.entries()) {
      if (m > 0) convo.addUserMessage(message);
      let stop: StopReason = 'turn_limit';
      for (let i = 0; i < opts.maxTurns; i++) {
        const turn = await convo.send();
        out.model_calls++;
        out.prompt_tokens += turn.usage.prompt_tokens;
        out.completion_tokens += turn.usage.completion_tokens;
        // One unpriced call makes the run's total unknown, not cheaper.
        out.cost_usd =
          out.cost_usd === null || turn.usage.cost_usd === null
            ? null
            : out.cost_usd + turn.usage.cost_usd;
        if (turn.resolvedModel) resolved.add(turn.resolvedModel);
        if (turn.upstream) upstreams.add(turn.upstream);
        if (turn.toolCalls.length === 0) {
          out.final_text = turn.text;
          out.replies.push(turn.text);
          stop = 'answer';
          break;
        }
        const results: { id: string; content: string }[] = [];
        for (const call of turn.toolCalls) {
          const content = call.inputError
            ? `error: tool arguments were not valid JSON (${call.inputError})`
            : await arm.exec(call.name, call.input);
          out.tool_chars[call.name] = (out.tool_chars[call.name] ?? 0) + content.length;
          out.tool_calls[call.name] = (out.tool_calls[call.name] ?? 0) + 1;
          out.tool_turns++;
          results.push({ id: call.id, content });
        }
        convo.addToolResults(results);
      }
      out.stops.push(stop);
      out.stop = stop;
      // The last message's answer is the conversation's answer.
      if (stop !== 'answer') out.final_text = '';
    }
  } catch (err) {
    out.stop = 'error';
    out.stops.push('error');
    out.error = err instanceof Error ? err.message : String(err);
  }
  out.resolved_models = [...resolved];
  out.upstreams = [...upstreams];
  return out;
};

export const runAgent = async (
  provider: Provider,
  arm: Arm,
  ask: string,
  opts: AgentOpts,
): Promise<AgentOutcome> => {
  const {
    replies: _replies,
    stops: _stops,
    tool_calls: _calls,
    ...out
  } = await runConversation(provider, arm, [ask], opts);
  return out;
};
