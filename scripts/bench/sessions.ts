// SPDX-License-Identifier: Apache-2.0
// Multi-session memory mode (--mode sessions). Each task is a pair of
// sessions on the pinned target: a scripted conversation in which the user
// states, or the agent finds, something the code does not say, then a fresh
// session whose task depends on it. The arms differ only in what carries over
// from session 1 to session 2:
//
//   memory-off  grep+rig in both sessions; session 2 opens a fresh copy of the
//               index, so nothing session 1 did reaches it.
//   memory-on   grep+rig in both, plus rig's waypoint tools and the waypoint
//               paragraphs of the installed agent instructions; session 2
//               opens the same database session 1 wrote to.
//   oracle      no session 1; session 2 gets a hand-written summary of what
//               session 1 establishes. An upper bound, for interpretation.
//   grep-only   no session 1; session 2 with the baseline tools. The sanity
//               check that the answers are not in the code.
//
// Every trial starts from a copy of one snapshot of the target's index, and
// the shared index itself is only ever read.
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Database, DB_FILE_NAME, RIG_DIR_NAME, Rig, type Embedder } from '@rig/core';
import { runConversation, type ConversationOutcome } from './agent.ts';
import type { Arm } from './arms.ts';
import { checkSessionAnswer, toMatcher, validateSessionExpected } from './criteria.ts';
import type { Provider } from './providers.ts';
import { BASELINE_TOOLS, runBaselineTool } from './tools-baseline.ts';
import { RIG_SEARCH_TOOL_NAMES, manifestToolDefs, makeRigToolRunner } from './tools-rig-search.ts';
import { RIG_ROOT } from './target.ts';
import type {
  DroppedWaypoint,
  MemoryArmName,
  SessionOutcome,
  SessionRunResult,
  SessionTask,
  SessionsBenchFile,
  SessionsFile,
} from './types.ts';

// The bar, as the user pre-registered it. It goes verbatim into the README,
// every results file (before the first model call) and every report.
export const PREREGISTERED_BAR =
  "Memory passes only if the memory-on arm raises multi-session task success by ≥ 15 percentage points over memory-off, while using ≤ 110% of memory-off's median total tokens (both sessions summed). If it doesn't, memory work stops and rig stays a code-map tool.";
// The confirmation rule, pre-registered after the first 10-task run came out
// INCONCLUSIVE and before any further run. It goes verbatim into the README
// and every later results file, and the report prints it.
export const CONFIRMATION_RULE =
  "Confirmation (written 2026-10-29, after the first 10-task run was INCONCLUSIVE and before any further run): 10 new task pairs are added; the verdict is decided once, on all 20 tasks combined (first run's trials for tasks 1–10 plus one new run for tasks 11–20, same model, arms, trials and bar). No further reruns or task changes are made to reach a verdict.";
export const BAR_DELTA = 0.15;
export const BAR_TOKEN_RATIO = 1.1;

export const MEMORY_ARM_NAMES: readonly MemoryArmName[] = [
  'memory-off',
  'memory-on',
  'oracle',
  'grep-only',
];
export const DEFAULT_MEMORY_ARMS: readonly MemoryArmName[] = ['memory-off', 'memory-on', 'oracle'];
// Arms that run session 1.
export const SESSION1_ARMS: readonly MemoryArmName[] = ['memory-off', 'memory-on'];

export const parseMemoryArms = (raw: string | undefined): MemoryArmName[] => {
  if (raw === undefined) return [...DEFAULT_MEMORY_ARMS];
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) {
    if (!MEMORY_ARM_NAMES.includes(n as MemoryArmName)) {
      throw new Error(`unknown arm "${n}" (expected ${MEMORY_ARM_NAMES.join(', ')})`);
    }
  }
  if (names.length === 0) throw new Error('--arms is empty');
  return [...new Set(names)] as MemoryArmName[];
};

// ------------------------------------------------------------------ prompts

// The instructions `rig install claude` writes. Every target gets the same
// "Session bootstrap" section; the bench quotes it, never paraphrases it.
export const INSTRUCTIONS_PATH = join(RIG_ROOT, 'generated/installer/claude.instructions.md');

// The paragraph of the installed "## Session bootstrap" section that starts
// with `prefix`, verbatim.
export const installedParagraph = (prefix: string, text?: string): string => {
  const md = text ?? readFileSync(INSTRUCTIONS_PATH, 'utf-8');
  const start = md.indexOf('## Session bootstrap');
  if (start < 0) throw new Error('bench: installed instructions have no "Session bootstrap"');
  const rest = md.slice(start).split('\n').slice(1).join('\n');
  const section = rest.split(/\n## /)[0]!;
  const para = section
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.startsWith(prefix));
  if (!para) throw new Error(`bench: no installed paragraph starts with "${prefix}"`);
  return para;
};

// Session 1 of memory-on: when to drop a waypoint.
export const waypointGuidance = (): string => installedParagraph('Drop a waypoint via');
// Session 2 of memory-on: load the last session's waypoints first.
export const sessionBootstrap = (): string =>
  installedParagraph('Before responding to the user in a new conversation');

export const SESSION_SYSTEM_PROMPT = `You are a senior engineer working with a teammate on their fork of this codebase. Use the tools you have. Be concise. When you have the answer, stop calling tools and respond in plain text.`;

export const INSTRUCTIONS_BEGIN = '<rig-instructions>';
export const INSTRUCTIONS_END = '</rig-instructions>';
export const NOTES_BEGIN = '<previous-session-notes>';
export const NOTES_END = '</previous-session-notes>';

// The shared prompt unchanged, then the installed text in a delimited block,
// as an installed CLAUDE.md / AGENTS.md section reaches the model.
export const systemWithInstructions = (text: string): string =>
  `${SESSION_SYSTEM_PROMPT}\n\nInstructions installed in this project for the rig MCP tools:\n` +
  `${INSTRUCTIONS_BEGIN}\n${text.trim()}\n${INSTRUCTIONS_END}`;

export const systemWithNotes = (notes: string): string =>
  `${SESSION_SYSTEM_PROMPT}\n\nNotes from your previous session with this teammate:\n` +
  `${NOTES_BEGIN}\n${notes.trim()}\n${NOTES_END}`;

// ------------------------------------------------------------------- arms

export const PROVENANCE = 'ai:rig-bench';
export const MEMORY_WRITE_TOOLS = ['rig_drop_waypoint', 'rig_waypoints'] as const;
export const MEMORY_READ_TOOLS = ['rig_waypoints'] as const;
const BASELINE_NAMES = new Set(BASELINE_TOOLS.map((t) => t.name));

// grep+rig plus `extra` rig tools, all rig tools on one MCP session.
const grepRigArm = (
  name: Arm['name'],
  repo: string,
  rig: Rig,
  sessionId: string,
  extra: readonly string[],
  system: string,
): Arm => {
  const names = [...RIG_SEARCH_TOOL_NAMES, ...extra];
  const rigExec = makeRigToolRunner(rig, names, { sessionId, provenance: PROVENANCE });
  return {
    name,
    tools: [...BASELINE_TOOLS, ...manifestToolDefs(names)],
    system,
    exec: async (tool, input) =>
      BASELINE_NAMES.has(tool) ? runBaselineTool(repo, tool, input) : rigExec(tool, input),
  };
};

export interface PhaseCtx {
  repo: string;
  rig: Rig;
  sessionId: string;
  task: SessionTask;
}

// The arm for one session of one trial, or null when the arm skips it.
export const sessionArm = (arm: MemoryArmName, phase: 1 | 2, ctx: PhaseCtx): Arm | null => {
  const { repo, rig, sessionId, task } = ctx;
  // The Arm type names the single-shot arms; these reuse grep+rig's machinery.
  if (phase === 1) {
    if (arm === 'memory-off')
      return grepRigArm('grep+rig', repo, rig, sessionId, [], SESSION_SYSTEM_PROMPT);
    if (arm === 'memory-on') {
      return grepRigArm(
        'grep+rig',
        repo,
        rig,
        sessionId,
        MEMORY_WRITE_TOOLS,
        systemWithInstructions(waypointGuidance()),
      );
    }
    return null;
  }
  if (arm === 'memory-off')
    return grepRigArm('grep+rig', repo, rig, sessionId, [], SESSION_SYSTEM_PROMPT);
  if (arm === 'memory-on') {
    return grepRigArm(
      'grep+rig',
      repo,
      rig,
      sessionId,
      MEMORY_READ_TOOLS,
      systemWithInstructions(sessionBootstrap()),
    );
  }
  if (arm === 'oracle') {
    return grepRigArm('grep+rig', repo, rig, sessionId, [], systemWithNotes(task.oracle));
  }
  return {
    name: 'baseline',
    tools: BASELINE_TOOLS,
    system: SESSION_SYSTEM_PROMPT,
    exec: async (tool, input) => runBaselineTool(repo, tool, input),
  };
};

// -------------------------------------------------------------- isolation

export interface Snapshot {
  path: string;
  sha256: string;
  bytes: number;
  nodes: number;
  waypoints: number;
}

const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const WAYPOINT_TYPE = 'conversation-waypoint';

/**
 * Copy the target's index into `workDir` as one self-contained database file.
 * Only the source files are read: rig.db and, when it holds frames, its WAL.
 * The copy is checkpointed so later per-trial copies are a single file.
 */
export const snapshotIndex = (repo: string, workDir: string): Snapshot => {
  const src = join(resolve(repo), RIG_DIR_NAME, DB_FILE_NAME);
  if (!existsSync(src)) throw new Error(`no index at ${src}; run bench:run --index-only first`);
  const dir = join(workDir, 'snapshot');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, DB_FILE_NAME);
  copyFileSync(src, path);
  if (existsSync(`${src}-wal`) && statSync(`${src}-wal`).size > 0) {
    copyFileSync(`${src}-wal`, `${path}-wal`);
  }
  const db = Database.open(path);
  let nodes = 0;
  let waypoints = 0;
  try {
    db.adapter.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    nodes = (db.adapter.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n;
    waypoints = (
      db.adapter.prepare('SELECT COUNT(*) AS n FROM nodes WHERE type = ?').get(WAYPOINT_TYPE) as {
        n: number;
      }
    ).n;
  } finally {
    db.close();
  }
  for (const side of ['-wal', '-shm']) rmSync(`${path}${side}`, { force: true });
  return { path, sha256: sha256File(path), bytes: statSync(path).size, nodes, waypoints };
};

export interface TrialDb {
  rig: Rig;
  path: string;
  // Wait for background embeds, close, and delete the copy.
  dispose(): Promise<void>;
}

// Hands out private copies of the snapshot. The Rig reads source from the
// target checkout but keeps its graph, waypoints included, in the copy.
export class TrialStore {
  private next = 0;
  constructor(
    readonly repo: string,
    readonly snapshot: Pick<Snapshot, 'path'>,
    readonly workDir: string,
    readonly embedder: Embedder,
  ) {}

  open(): TrialDb {
    const dir = join(this.workDir, 'trials', String(this.next++));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, DB_FILE_NAME);
    copyFileSync(this.snapshot.path, path);
    const rig = new Rig({
      projectRoot: resolve(this.repo),
      database: Database.open(path),
      embedder: this.embedder,
    });
    return {
      rig,
      path,
      dispose: async () => {
        await rig.whenIdle();
        rig.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }
}

// ------------------------------------------------------------- the trial

export interface TrialOpts {
  maxTurns: number;
  maxTokens: number;
  marker: string;
  // Injectable for tests; distinct ids per session either way.
  newSessionId?: () => string;
}

const outcome = (o: ConversationOutcome, sessionId: string, messages: number, t0: number) => {
  const s: SessionOutcome = {
    session_id: sessionId,
    messages,
    prompt_tokens: o.prompt_tokens,
    completion_tokens: o.completion_tokens,
    cost_usd: o.cost_usd,
    model_calls: o.model_calls,
    tool_turns: o.tool_turns,
    tool_calls: o.tool_calls,
    tool_chars: o.tool_chars,
    stop: o.stop,
    stops: o.stops,
    replies: o.replies,
    final_text: o.final_text,
    resolved_models: o.resolved_models,
    upstreams: o.upstreams,
    elapsed_ms: Date.now() - t0,
  };
  if (o.error !== undefined) s.error = o.error;
  return s;
};

// Session 1's waypoint ids that appear in rig_waypoints results.
const recallTracker = (s1Ids: ReadonlySet<string>) => {
  const seen = new Set<string>();
  const wrap = (arm: Arm): Arm => ({
    ...arm,
    exec: async (tool, input) => {
      const out = await arm.exec(tool, input);
      if (tool === 'rig_waypoints' && out.startsWith('{')) {
        try {
          const parsed = JSON.parse(out) as { waypoints?: { id?: unknown }[] };
          for (const w of parsed.waypoints ?? []) {
            if (typeof w.id === 'string' && s1Ids.has(w.id)) seen.add(w.id);
          }
        } catch {
          // Not JSON: nothing recalled.
        }
      }
      return out;
    },
  });
  return { wrap, count: () => seen.size };
};

export const sessionWaypoints = (rig: Rig, sessionId: string): DroppedWaypoint[] =>
  rig
    .getWaypoints({ sessionId, limit: 200 })
    .map((w) => ({ id: w.id, kind: w.kind, title: w.title, summary: w.summary }));

/**
 * One (task, arm, trial). memory-on keeps one database copy for both
 * sessions; memory-off throws session 1's copy away and gives session 2 a
 * fresh one; oracle and grep-only only run session 2, on a fresh copy.
 */
export const runTrial = async (
  provider: Provider,
  store: TrialStore,
  task: SessionTask,
  arm: MemoryArmName,
  trial: number,
  opts: TrialOpts,
): Promise<SessionRunResult> => {
  const newId = opts.newSessionId ?? randomUUID;
  const s1Id = newId();
  let s2Id = newId();
  while (s2Id === s1Id) s2Id = newId();
  const agentOpts = { maxTurns: opts.maxTurns, maxTokens: opts.maxTokens };

  let db = store.open();
  try {
    let s1: SessionOutcome | null = null;
    let waypoints: DroppedWaypoint[] = [];
    const a1 = sessionArm(arm, 1, { repo: store.repo, rig: db.rig, sessionId: s1Id, task });
    if (a1) {
      const t0 = Date.now();
      const o = await runConversation(provider, a1, task.session1, agentOpts);
      s1 = outcome(o, s1Id, task.session1.length, t0);
      await db.rig.whenIdle();
      waypoints = sessionWaypoints(db.rig, s1Id);
    }
    if (arm !== 'memory-on' && a1) {
      // The reset: session 2 never sees session 1's database.
      await db.dispose();
      db = store.open();
    }
    const a2 = sessionArm(arm, 2, { repo: store.repo, rig: db.rig, sessionId: s2Id, task })!;
    const hasRecall = a2.tools.some((t) => t.name === 'rig_waypoints');
    const recall = recallTracker(new Set(waypoints.map((w) => w.id)));
    const t0 = Date.now();
    const o2 = await runConversation(provider, recall.wrap(a2), [task.session2], agentOpts);
    const s2 = outcome(o2, s2Id, 1, t0);
    return {
      task_id: task.id,
      arm,
      trial,
      s1,
      s2,
      waypoints,
      recalled: hasRecall ? recall.count() : null,
      check: checkSessionAnswer(s2.final_text, task.expected, opts.marker),
    };
  } finally {
    await db.dispose();
  }
};

// -------------------------------------------------------- sessions.json

export const SESSIONS_PATH = resolve(import.meta.dir, 'sessions.json');

// Tasks with no `set` are the first ten, written before the first run.
export const taskSetOf = (t: SessionTask): string => t.set ?? 'first';

// --tasks and --task-set: both narrow, and an unknown id or set is an error.
export const selectTasks = (
  tasks: readonly SessionTask[],
  opts: { ids?: readonly string[]; set?: string },
): SessionTask[] => {
  const unknown = opts.ids?.filter((id) => !tasks.some((t) => t.id === id)) ?? [];
  if (unknown.length) throw new Error(`unknown task id(s): ${unknown.join(', ')}`);
  const sets = [...new Set(tasks.map(taskSetOf))];
  if (opts.set !== undefined && !sets.includes(opts.set)) {
    throw new Error(`unknown task set "${opts.set}" (expected ${sets.join(', ')})`);
  }
  const out = tasks.filter(
    (t) =>
      (!opts.ids || opts.ids.includes(t.id)) &&
      (opts.set === undefined || taskSetOf(t) === opts.set),
  );
  if (out.length === 0) throw new Error('--tasks and --task-set select no task');
  return out;
};

export const validateSessionsFile = (sf: SessionsFile): void => {
  if (!sf.answer_marker) throw new Error('sessions.json: answer_marker is empty');
  const ids = new Set<string>();
  for (const t of sf.tasks) {
    if (ids.has(t.id)) throw new Error(`sessions.json: duplicate task id ${t.id}`);
    ids.add(t.id);
    if (t.session1.length < 2 || t.session1.length > 4) {
      throw new Error(`${t.id}: session 1 needs 2-4 user messages`);
    }
    if (!t.session2.includes(sf.answer_marker)) {
      throw new Error(`${t.id}: session 2 must ask for the "${sf.answer_marker}" line`);
    }
    if (!t.oracle.trim()) throw new Error(`${t.id}: oracle summary is empty`);
    if (t.secret !== undefined) {
      const has = (text: string) => text.toLowerCase().includes(t.secret!.toLowerCase());
      if (!t.session1.some(has)) throw new Error(`${t.id}: session 1 never states its secret`);
      if (has(t.session2)) throw new Error(`${t.id}: session 2 gives away its secret`);
    }
    validateSessionExpected(t.id, t.expected);
    if (t.trap && !(t.expected.must_not?.length && t.code_evidence?.length)) {
      throw new Error(`${t.id}: a trap task needs must_not patterns and code_evidence`);
    }
    // must_not is for trap answers only; other wrong answers go in `none`.
    if (!t.trap && t.expected.must_not?.length) {
      throw new Error(`${t.id}: must_not is for trap tasks; use none`);
    }
  }
};

export const loadSessionsFile = (path = SESSIONS_PATH): SessionsFile => {
  const sf = JSON.parse(readFileSync(path, 'utf-8')) as SessionsFile;
  validateSessionsFile(sf);
  return sf;
};

// Static half of the sanity check: does the target's code really point to
// each trap answer? Reads files in the checkout, nothing else.
export const checkTrapEvidence = (
  repo: string,
  tasks: readonly SessionTask[],
): SessionsBenchFile['trap_evidence'] =>
  tasks.flatMap((t) =>
    (t.code_evidence ?? []).map((e) => {
      const abs = join(repo, e.file);
      const found = existsSync(abs) && toMatcher(e.pattern)(readFileSync(abs, 'utf-8'));
      return { task_id: t.id, file: e.file, pattern: e.pattern, found };
    }),
  );

// Directories the secret search skips: dependencies, VCS, rig's own index and
// build output, none of which is code an agent would read for the answer.
const SKIP_DIRS = new Set(['node_modules', '.git', RIG_DIR_NAME, 'dist', '.next', '.turbo']);
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const scanFiles = (dir: string, visit: (text: string) => void): void => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) scanFiles(p, visit);
    } else if (e.isFile() && statSync(p).size <= MAX_SCAN_BYTES) {
      visit(readFileSync(p, 'utf-8').toLowerCase());
    }
  }
};

// The other half of "stated only in session 1": no task's secret appears
// anywhere in the target checkout (case-insensitive). Reads files, nothing else.
export const checkSecrets = (
  repo: string,
  tasks: readonly SessionTask[],
): NonNullable<SessionsBenchFile['secret_check']> => {
  const wanted = tasks.flatMap((t) => (t.secret ? [{ task_id: t.id, secret: t.secret }] : []));
  if (wanted.length === 0) return [];
  const found = new Set<string>();
  scanFiles(repo, (text) => {
    for (const w of wanted) if (text.includes(w.secret.toLowerCase())) found.add(w.task_id);
  });
  return wanted.map((w) => ({ ...w, in_code: found.has(w.task_id) }));
};

export const instructionsInfo = (): SessionsBenchFile['instructions'] => ({
  path: 'generated/installer/claude.instructions.md',
  sha256: sha256File(INSTRUCTIONS_PATH),
});

// ------------------------------------------------------------- the loop

export interface SessionsLoopOpts extends TrialOpts {
  arms: readonly MemoryArmName[];
  tasks: readonly SessionTask[];
  trials: number;
  // Called after every trial, with the result already in file.results.
  onResult?: (r: SessionRunResult) => void;
}

// Every (task, trial, arm), arms interleaved so drift in the provider hits
// all of them alike.
export const runSessionsLoop = async (
  provider: Provider,
  store: TrialStore,
  file: SessionsBenchFile,
  opts: SessionsLoopOpts,
): Promise<void> => {
  for (const task of opts.tasks) {
    for (let t = 0; t < opts.trials; t++) {
      for (const arm of opts.arms) {
        const r = await runTrial(provider, store, task, arm, t, opts);
        file.results.push(r);
        opts.onResult?.(r);
      }
    }
  }
};
