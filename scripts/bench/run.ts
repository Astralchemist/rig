import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Rig } from '@rig/core';
import { BASELINE_TOOLS, runBaselineTool, type ToolDef } from './tools-baseline.ts';
import { RIG_TOOLS, runRigTool } from './tools-rig.ts';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.BENCH_MODEL ?? 'claude-sonnet-4-5-20250929';
const MAX_TOOL_TURNS = 12;

const argValue = (n: string): string | undefined => {
  const i = process.argv.indexOf(n);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

interface Query { id: string; ask: string; judge_hint: string; expected_winner_hypothesis: string; }
interface QueriesFile { target_hint: string; queries: Query[]; }
interface Usage { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; }
interface RunResult {
  query_id: string;
  path: 'baseline' | 'rig';
  trial: number;
  total_input_tokens: number;
  total_output_tokens: number;
  tool_turns: number;
  final_text: string;
  error?: string;
}

interface MsgBlock { type: string; [k: string]: unknown; }
interface ApiMessage { role: 'user' | 'assistant'; content: MsgBlock[] | string; }
interface ApiResponse {
  content: MsgBlock[];
  stop_reason: string;
  usage: Usage;
}

const SYSTEM_PROMPT = `You are a senior engineer answering a question about an unfamiliar codebase. Use the tools you have. Be concise. When you have the answer, stop calling tools and respond in plain text.`;

const callApi = async (messages: ApiMessage[], tools: ToolDef[]): Promise<ApiResponse> => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, system: SYSTEM_PROMPT, tools, messages }),
  });
  if (!res.ok) throw new Error(`api ${res.status}: ${await res.text()}`);
  return (await res.json()) as ApiResponse;
};

const runOne = async (
  query: Query,
  path: 'baseline' | 'rig',
  trial: number,
  repoRoot: string,
  rig: Rig | null,
): Promise<RunResult> => {
  const tools = path === 'baseline' ? BASELINE_TOOLS : RIG_TOOLS;
  const exec = (name: string, input: unknown): string =>
    path === 'baseline'
      ? runBaselineTool(repoRoot, name, input)
      : runRigTool(rig as Rig, name, input);

  const messages: ApiMessage[] = [{ role: 'user', content: query.ask }];
  let totIn = 0, totOut = 0, finalText = '', turns = 0;
  try {
    for (let i = 0; i < MAX_TOOL_TURNS; i++) {
      const res = await callApi(messages, tools);
      totIn += res.usage.input_tokens;
      totOut += res.usage.output_tokens;
      messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason !== 'tool_use') {
        finalText = res.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n')
          .trim();
        break;
      }
      const toolResults: MsgBlock[] = [];
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue;
        const out = exec(block.name as string, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id as string, content: out });
        turns++;
      }
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    return {
      query_id: query.id, path, trial,
      total_input_tokens: totIn, total_output_tokens: totOut, tool_turns: turns,
      final_text: finalText, error: err instanceof Error ? err.message : String(err),
    };
  }
  return { query_id: query.id, path, trial, total_input_tokens: totIn, total_output_tokens: totOut, tool_turns: turns, final_text: finalText };
};

const repoRoot = argValue('--repo');
const queriesPath = argValue('--queries') ?? resolve(import.meta.dir, 'queries.json');
const outPath = argValue('--out') ?? resolve(import.meta.dir, 'results.json');
const trials = Number.parseInt(argValue('--trials') ?? '3', 10);
const only = argValue('--only');
if (!repoRoot) {
  console.error('usage: bun scripts/bench/run.ts --repo <path-to-nextauth> [--trials 3] [--only query-id] [--out results.json]');
  process.exit(2);
}
const queriesFile = JSON.parse(readFileSync(queriesPath, 'utf-8')) as QueriesFile;
const queries = only ? queriesFile.queries.filter((q) => q.id === only) : queriesFile.queries;
if (!Rig.isInitialized(repoRoot)) {
  console.error(`rig: ${repoRoot} not initialized. Run \`cd ${repoRoot} && rig init && rig index\` first.`);
  process.exit(2);
}
const rig = await Rig.open(repoRoot);
const results: RunResult[] = [];
for (const q of queries) {
  for (let t = 0; t < trials; t++) {
    for (const path of ['baseline', 'rig'] as const) {
      process.stderr.write(`  ${q.id} / ${path} / trial ${t + 1}... `);
      const r = await runOne(q, path, t, repoRoot, path === 'rig' ? rig : null);
      results.push(r);
      process.stderr.write(`${r.total_input_tokens + r.total_output_tokens} toks${r.error ? ` (err: ${r.error})` : ''}\n`);
    }
  }
}
rig.close();
mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(outPath, JSON.stringify({ model: MODEL, target: repoRoot, results }, null, 2));
console.log(`\nwrote ${results.length} runs to ${outPath}`);
console.log('next: bun scripts/bench/report.ts --in', outPath);
