// SPDX-License-Identifier: Apache-2.0
// `bun test --preload scripts/impact-eval/record.ts`: records dynamic call
// edges (caller file:line -> callee file:line) for the E5 evaluation.
//
// A Bun plugin instruments the repo's own sources as they load
// (instrument.ts); each probe reads its caller from the stack. One call graph
// for the whole run is enough: the observed blast radius is everything that
// reaches a changed symbol in it, so no per-test attribution is needed.
//
// RIG_EVAL_ROOT  repo root to instrument (default: cwd); node_modules and
//                generated/ are left alone
// RIG_CALLS_OUT  where to write the edges as JSONL (default: .rig-calls.jsonl)
// RIG_CALLS_CAP  stacks read per callee before it stops sampling (default 500)
import { afterAll } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { instrumentSourceSync, loadParsers } from './instrument.ts';

await loadParsers();

const ROOT = resolve(process.env.RIG_EVAL_ROOT ?? process.cwd());
const OUT = resolve(process.env.RIG_CALLS_OUT ?? '.rig-calls.jsonl');
const CAP = Number(process.env.RIG_CALLS_CAP ?? 500);

const edges = new Map<string, number>();
const sampled = new Map<string, number>();

// "    at name (/abs/file.ts:12:3)" or "    at /abs/file.ts:12:3"
const FRAME = /\(?((?:\/|[A-Za-z]:\\)[^():]+):(\d+):\d+\)?\s*$/;

(globalThis as Record<string, unknown>).__rigCall = (file: string, line: number): void => {
  const callee = `${file}:${line}`;
  const n = sampled.get(callee) ?? 0;
  if (n >= CAP) return;
  sampled.set(callee, n + 1);
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 4;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  // [0] "Error", [1] __rigCall, [2] the callee, [3] its caller.
  const frame = stack.split('\n')[3];
  const m = frame ? FRAME.exec(frame) : null;
  if (!m) return;
  const key = `${m[1]}:${m[2]}>${callee}`;
  edges.set(key, (edges.get(key) ?? 0) + 1);
};

const escaped = ROOT.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// The repo's own TypeScript only: node_modules, generated/ and this
// recorder never reach the plugin (files returned through onLoad lose
// CommonJS interop, so they must not pass through it at all).
const OWN_SOURCES = new RegExp(
  `^${escaped}/(?!node_modules/|generated/|scripts/impact-eval/)(?:[^/]+/)*(?!.*/node_modules/)[^/]+\\.(ts|tsx|mts)$`,
);

plugin({
  name: 'rig-impact-eval',
  setup(build) {
    // Synchronous: an async onLoad turns modules async and breaks require().
    build.onLoad({ filter: OWN_SOURCES }, (args) => {
      const loader = args.path.endsWith('.tsx') ? 'tsx' : 'ts';
      const source = readFileSync(args.path, 'utf-8');
      const out = instrumentSourceSync(args.path, source);
      return { contents: out ?? source, loader };
    });
  },
});

const flush = (): void => {
  const lines: string[] = [];
  for (const [key, count] of edges) {
    const [caller, callee] = key.split('>') as [string, string];
    const cut = (s: string): [string, number] => {
      const i = s.lastIndexOf(':');
      return [s.slice(0, i), Number(s.slice(i + 1))];
    };
    const [callerFile, callerLine] = cut(caller);
    const [calleeFile, calleeLine] = cut(callee);
    lines.push(JSON.stringify({ callerFile, callerLine, calleeFile, calleeLine, count }));
  }
  writeFileSync(OUT, lines.join('\n') + (lines.length ? '\n' : ''));
};

// bun test doesn't emit 'exit' to the preload reliably; a global afterAll runs once the suite ends.
afterAll(flush);
process.on('exit', flush);
