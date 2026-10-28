// SPDX-License-Identifier: Apache-2.0
// Optional LLM judge (--judge <model>): a second opinion next to the pattern
// check, never a replacement for it. It sees the question, the reference
// answer at the pinned commit and the agent's answer, and returns a verdict.
import type { Provider } from './providers.ts';
import type { JudgeResult, Query } from './types.ts';

const JUDGE_SYSTEM = `You grade answers to questions about a codebase against a reference answer. An answer is correct when it gives the facts the reference gives (file paths, symbol names, values); extra detail is fine, contradicting the reference or missing its key fact is not. Reply with JSON only: {"verdict":"correct"|"incorrect","reason":"<one sentence>"}`;

export const judgePrompt = (q: Query, answer: string): string =>
  [
    `Question: ${q.ask}`,
    '',
    `Reference answer: ${q.reference}`,
    '',
    'Answer to grade:',
    answer.trim() || '(empty)',
  ].join('\n');

export const parseVerdict = (text: string): { verdict: JudgeResult['verdict']; reason: string } => {
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { verdict?: unknown; reason?: unknown };
      if (j.verdict === 'correct' || j.verdict === 'incorrect') {
        return { verdict: j.verdict, reason: typeof j.reason === 'string' ? j.reason : '' };
      }
    } catch {
      // fall through
    }
  }
  return { verdict: 'error', reason: `unparseable verdict: ${text.slice(0, 200)}` };
};

export const judgeAnswer = async (
  judge: Provider,
  q: Query,
  answer: string,
): Promise<JudgeResult> => {
  try {
    const turn = await judge
      .start({ system: JUDGE_SYSTEM, user: judgePrompt(q, answer), tools: [], maxTokens: 300 })
      .send();
    return {
      ...parseVerdict(turn.text),
      cost_usd: turn.usage.cost_usd,
      prompt_tokens: turn.usage.prompt_tokens,
      completion_tokens: turn.usage.completion_tokens,
    };
  } catch (err) {
    return {
      verdict: 'error',
      reason: err instanceof Error ? err.message : String(err),
      cost_usd: null,
      prompt_tokens: 0,
      completion_tokens: 0,
    };
  }
};
