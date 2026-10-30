// SPDX-License-Identifier: Apache-2.0
// `bench:run --mode sessions`: the plan and dry run, then the real run. The
// shared index of the target is never opened for writing: it must already be
// current (bench:run --index-only builds it), and every trial works on a copy
// of a snapshot taken at the start.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHARS_PER_TOKEN, estimateTokens } from '@rig/core';
import { BRIEF_MAX } from '@rig/core/capture/brief.ts';
import { selectEmbedder } from '@rig/core/embed/select.ts';
import {
  estimateSessions,
  sessionProfilesFrom,
  type SessionOverheads,
  type SessionsPlanEstimate,
} from './plan.ts';
import { perMillion, type ModelPricing } from './pricing.ts';
import type { Provider } from './providers.ts';
import {
  CONFIRMATION_RULE,
  MEMORY_AUTO_PREREGISTRATION,
  MEMORY_READ_TOOLS,
  MEMORY_WRITE_TOOLS,
  PREREGISTERED_BAR,
  SESSION1_ARMS,
  TrialStore,
  checkSecrets,
  checkTrapEvidence,
  instructionsInfo,
  runSessionsLoop,
  sessionBootstrap,
  snapshotIndex,
  waypointGuidance,
  type Snapshot,
} from './sessions.ts';
import { RG_BIN, rgAvailable } from './tools-baseline.ts';
import { manifestToolDefs } from './tools-rig-search.ts';
import { indexState, type IndexState } from './target.ts';
import type {
  MemoryArmName,
  RigVersion,
  SessionTask,
  SessionsBenchFile,
  SessionsFile,
} from './types.ts';

export const sessionOverheads = (): SessionOverheads => ({
  write_tools: estimateTokens(JSON.stringify(manifestToolDefs(MEMORY_WRITE_TOOLS))),
  read_tools: estimateTokens(JSON.stringify(manifestToolDefs(MEMORY_READ_TOOLS))),
  guidance: estimateTokens(waypointGuidance()),
  bootstrap: estimateTokens(sessionBootstrap()),
  // A load of a handful of waypoints, as JSON.
  waypoint_output: 1_500,
  // memory-auto: a full SessionStart brief.
  brief: Math.ceil(BRIEF_MAX / CHARS_PER_TOKEN),
});

export const taskShapes = (tasks: readonly SessionTask[]) =>
  tasks.map((t) => ({ messages: t.session1.length, oracle_tokens: estimateTokens(t.oracle) }));

const usd = (v: number | null): string => (v === null ? 'unknown' : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const k = (n: number): string => `${(n / 1000).toFixed(0)}k`;

export interface SessionsPlanInfo {
  provider: string;
  hasKey: boolean;
  model: string;
  priceLine: string;
  rig: RigVersion;
  repo: string;
  head: string | null;
  pinned: string;
  index: IndexState | 'missing';
  rg: boolean;
  arms: readonly MemoryArmName[];
  tasks: readonly SessionTask[];
  taskSet: string | null;
  trials: number;
  maxTurns: number;
  evidence: SessionsBenchFile['trap_evidence'];
  secrets: NonNullable<SessionsBenchFile['secret_check']>;
  estimate: SessionsPlanEstimate;
  estimateFrom: string | null;
}

// The dry-run text. Pure, so a test can pin what it promises.
export const sessionsPlanLines = (p: SessionsPlanInfo): string[] => {
  const types = ['decision', 'constraint', 'dead-end', 'discovery'] as const;
  const count = (ty: string) => p.tasks.filter((t) => t.type === ty).length;
  const traps = p.tasks.filter((t) => t.trap);
  const s1Arms = p.arms.filter((a) => SESSION1_ARMS.includes(a));
  const trials = p.tasks.length * p.trials;
  const sessions = trials * p.arms.length + trials * s1Arms.length;
  const found = p.evidence.filter((e) => e.found).length;
  return [
    '# rig bench — multi-session memory, dry run',
    '',
    'Pre-registered bar (written verbatim into every results file before the first model call):',
    `> ${PREREGISTERED_BAR}`,
    '',
    `provider:  ${p.provider}${p.hasKey ? '' : ' (no API key in env)'}`,
    `model:     ${p.model} — ${p.priceLine}`,
    `rig:       ${p.rig.version} @ ${p.rig.commit?.slice(0, 7) ?? '?'}${p.rig.dirty ? '+dirty' : ''} (fingerprint ${p.rig.fingerprint})`,
    `target:    ${p.repo}`,
    `commit:    ${p.head ?? 'missing'}${p.head === p.pinned ? ' (pinned)' : ` — expected ${p.pinned}`}`,
    `index:     ${p.index}${p.index === 'current' ? '; snapshotted once, then copied per trial (the shared index is only read)' : '; sessions mode needs a current index: run bench:run --index-only first'}`,
    `ripgrep:   ${p.rg ? RG_BIN : `MISSING (${RG_BIN}); every arm needs it`}`,
    `prompts:   memory-on quotes generated/installer/claude.instructions.md verbatim:`,
    `           session 1 "${waypointGuidance().slice(0, 60)}…"`,
    `           session 2 "${sessionBootstrap().slice(0, 60)}…"`,
    `arms:      ${p.arms.join(', ')}`,
    ...p.arms.map((a) => `  ${a.padEnd(11)} ${ARM_PLAN[a]}`),
    `tasks:     ${p.tasks.length} pairs${p.taskSet ? ` in set "${p.taskSet}"` : ''} (${types.map((ty) => `${count(ty)} ${ty}`).join(', ')}; ${traps.length} traps)`,
    ...p.tasks.map(
      (t) =>
        `  ${t.id.padEnd(22)} ${t.type.padEnd(10)} ${t.trap ? 'TRAP' : '    '}  session 1: ${t.session1.length} user messages`,
    ),
    `evidence:  code points to the trap answer in ${found}/${p.evidence.length} checks` +
      (found < p.evidence.length
        ? ` (missing: ${p.evidence
            .filter((e) => !e.found)
            .map((e) => `${e.task_id} ${e.file}`)
            .join(', ')})`
        : ''),
    ...(p.secrets.length
      ? [
          `secrets:   session-1 facts absent from the target's files in ${p.secrets.filter((x) => !x.in_code).length}/${p.secrets.length} checks` +
            (p.secrets.some((x) => x.in_code)
              ? ` (FOUND in code: ${p.secrets
                  .filter((x) => x.in_code)
                  .map((x) => `${x.task_id} "${x.secret}"`)
                  .join(', ')})`
              : ''),
        ]
      : []),
    `trials:    ${p.trials} per (task, arm), max ${p.maxTurns} model calls per user message`,
    `runs:      ${trials * p.arms.length} trials (${trials} per arm), ${sessions} sessions`,
    '',
    `estimate (${p.estimateFrom ? `per-arm session means from ${p.estimateFrom}` : 'assumed per-session token profiles'}):`,
    ...p.estimate.arms.map(
      (a) =>
        `  ${a.arm.padEnd(11)} ${a.trials} trials: s1 ${a.s1 ? `~${k(a.s1.prompt_tokens)} in + ${k(a.s1.completion_tokens)} out ≈ ${usd(a.cost_s1)}` : 'not run'}; s2 ~${k(a.s2.prompt_tokens)} in + ${k(a.s2.completion_tokens)} out ≈ ${usd(a.cost_s2)}; total ≈ ${usd(a.cost_usd)}`,
    ),
    `  total       ~${(p.estimate.total_tokens / 1e6).toFixed(2)}M tokens ≈ ${usd(p.estimate.total_usd)}`,
  ];
};

const ARM_PLAN: Record<MemoryArmName, string> = {
  'memory-off': 'grep+rig in both sessions; session 2 on a fresh copy of the index',
  'memory-on':
    'grep+rig in both; s1 + rig_drop_waypoint, rig_waypoints and the waypoint guidance; s2 + rig_waypoints and the session-bootstrap instruction, same database',
  oracle: 'session 2 only, grep+rig, with a reference summary of session 1 in its prompt',
  'grep-only': 'session 2 only, ripgrep and file reads: the sanity check (should fail most traps)',
  'memory-auto':
    "s1 as memory-off; then rig hook's capture pipeline on s1's conversation; s2 + the SessionStart brief, rig_waypoints and the session-bootstrap instruction, same database",
};

export const priceLine = (p: ModelPricing | null, haveCatalogue: boolean): string =>
  p
    ? `${perMillion(p.tiers[0]!.prompt)} in / ${perMillion(p.tiers[0]!.completion)} out per M tokens`
    : haveCatalogue
      ? 'not in the OpenRouter catalogue'
      : 'catalogue unreachable';

export interface SessionsCli {
  repo: string;
  pinned: string;
  head: string | null;
  rig: RigVersion;
  sessions: SessionsFile;
  tasks: SessionTask[];
  // The --task-set the tasks were limited to, if any.
  taskSet: string | null;
  arms: MemoryArmName[];
  trials: number;
  maxTurns: number;
  providerName: SessionsBenchFile['provider'];
  hasKey: boolean;
  model: string;
  pricing: ModelPricing | null;
  haveCatalogue: boolean;
  label: string;
  out: string | null;
  workDir: string | null;
  dryRun: boolean;
  estimateFrom: string | null;
  allowCommitMismatch: boolean;
  // Built only for a real run, after every check passed.
  makeProvider: () => Provider;
  log: (line: string) => void;
}

// A results file with no results yet. The bar is in it from the start, so it
// is on disk before the first model call.
export const newSessionsFile = (
  c: Pick<
    SessionsCli,
    | 'label'
    | 'providerName'
    | 'model'
    | 'rig'
    | 'repo'
    | 'head'
    | 'pinned'
    | 'sessions'
    | 'arms'
    | 'tasks'
    | 'taskSet'
    | 'trials'
    | 'maxTurns'
  >,
  snapshot: Snapshot,
  evidence: SessionsBenchFile['trap_evidence'],
  secrets: NonNullable<SessionsBenchFile['secret_check']> = [],
): SessionsBenchFile => ({
  schema: 1,
  mode: 'sessions',
  preregistered_bar: PREREGISTERED_BAR,
  confirmation_rule: CONFIRMATION_RULE,
  memory_auto_preregistration: MEMORY_AUTO_PREREGISTRATION,
  ...(c.taskSet !== null ? { task_set: c.taskSet } : {}),
  label: c.label,
  started_at: new Date().toISOString(),
  finished_at: null,
  provider: c.providerName,
  model: c.model,
  rig: c.rig,
  target: {
    repo: c.repo,
    commit: c.head,
    expected_commit: c.pinned,
    snapshot: {
      sha256: snapshot.sha256,
      bytes: snapshot.bytes,
      nodes: snapshot.nodes,
      waypoints: snapshot.waypoints,
    },
  },
  instructions: instructionsInfo(),
  trap_evidence: evidence,
  secret_check: secrets,
  answer_marker: c.sessions.answer_marker,
  arms: c.arms,
  trials: c.trials,
  max_turns: c.maxTurns,
  tasks: c.tasks,
  results: [],
});

export const mainSessions = async (c: SessionsCli): Promise<void> => {
  const index = existsSync(c.repo) ? indexState(c.repo, c.rig.fingerprint) : 'missing';
  const evidence = existsSync(c.repo) ? checkTrapEvidence(c.repo, c.tasks) : [];
  const secrets = existsSync(c.repo) ? checkSecrets(c.repo, c.tasks) : [];
  if (c.dryRun) {
    const measured = c.estimateFrom
      ? sessionProfilesFrom(JSON.parse(readFileSync(c.estimateFrom, 'utf-8')) as SessionsBenchFile)
      : undefined;
    const estimate = estimateSessions({
      arms: c.arms,
      tasks: taskShapes(c.tasks),
      trials: c.trials,
      pricing: c.pricing,
      overheads: sessionOverheads(),
      ...(measured ? { measured } : {}),
    });
    const lines = sessionsPlanLines({
      provider: c.providerName,
      hasKey: c.hasKey,
      model: c.model,
      priceLine: priceLine(c.pricing, c.haveCatalogue),
      rig: c.rig,
      repo: c.repo,
      head: c.head,
      pinned: c.pinned,
      index,
      rg: rgAvailable(),
      arms: c.arms,
      tasks: c.tasks,
      taskSet: c.taskSet,
      trials: c.trials,
      maxTurns: c.maxTurns,
      evidence,
      secrets,
      estimate,
      estimateFrom: c.estimateFrom,
    });
    console.log(lines.join('\n'));
    return;
  }

  if (!existsSync(c.repo))
    throw new Error(`target ${c.repo} does not exist; see README.md "Setup"`);
  if (c.head !== c.pinned && !c.allowCommitMismatch) {
    throw new Error(
      `target is at ${c.head ?? 'unknown'}, expected ${c.pinned}. ` +
        `Run \`git -C ${c.repo} checkout ${c.pinned}\` or pass --allow-commit-mismatch.`,
    );
  }
  if (index !== 'current') {
    throw new Error(
      `the target's index is ${index}; sessions mode never builds or replaces it. ` +
        'Run `bun run bench:run --index-only` first.',
    );
  }
  if (!rgAvailable()) throw new Error(`ripgrep not found (${RG_BIN}); every sessions arm needs it`);
  if (!c.hasKey) {
    const env = c.providerName === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
    throw new Error(`${env} is not set (provider ${c.providerName})`);
  }

  const outPath = (() => {
    if (c.out) return resolve(c.out);
    const dir = resolve(import.meta.dir, 'results');
    const stem = `${new Date().toISOString().slice(0, 10)}-${c.label}`;
    let p = join(dir, `${stem}.json`);
    for (let n = 2; existsSync(p); n++) p = join(dir, `${stem}-${n}.json`);
    return p;
  })();
  mkdirSync(resolve(outPath, '..'), { recursive: true });

  const workDir = c.workDir ? resolve(c.workDir) : mkdtempSync(join(tmpdir(), 'rig-membench-'));
  mkdirSync(workDir, { recursive: true });
  try {
    const snapshot = snapshotIndex(c.repo, workDir);
    c.log(
      `snapshot: ${snapshot.nodes.toLocaleString()} nodes, ${snapshot.waypoints} waypoints, ` +
        `sha256 ${snapshot.sha256.slice(0, 12)} (${workDir})`,
    );
    const file = newSessionsFile(c, snapshot, evidence, secrets);
    const save = (): void => writeFileSync(outPath, JSON.stringify(file, null, 2) + '\n');
    // The bar is on disk before the first model call.
    save();
    const provider = c.makeProvider();
    const store = new TrialStore(c.repo, snapshot, workDir, selectEmbedder(c.repo));
    let spent = 0;
    await runSessionsLoop(provider, store, file, {
      arms: c.arms,
      tasks: c.tasks,
      trials: c.trials,
      maxTurns: c.maxTurns,
      maxTokens: 2048,
      marker: c.sessions.answer_marker,
      onResult: (r) => {
        save();
        const cost = (r.s1?.cost_usd ?? 0) + (r.s2.cost_usd ?? 0);
        spent += cost;
        const toks =
          (r.s1 ? r.s1.prompt_tokens + r.s1.completion_tokens : 0) +
          r.s2.prompt_tokens +
          r.s2.completion_tokens;
        c.log(
          `  ${r.task_id} / ${r.arm} / trial ${r.trial + 1}: ${toks.toLocaleString()} toks, ${usd(cost)}, ` +
            `${r.check.pass ? 'pass' : 'FAIL'}${r.check.trapped.length ? ' (trap)' : ''}` +
            `${r.s1 ? `, ${r.waypoints.length} waypoints` : ''}` +
            `${r.recalled !== null ? `, ${r.recalled} recalled` : ''}` +
            `${(r.s2.error ?? r.s1?.error) ? ` (err: ${(r.s2.error ?? r.s1?.error ?? '').slice(0, 120)})` : ''}`,
        );
      },
    });
    file.finished_at = new Date().toISOString();
    save();
    console.log(`\nwrote ${file.results.length} trials to ${outPath} (spent ≈ ${usd(spent)})`);
    console.log(`next: bun run bench:report ${outPath}`);
  } finally {
    if (!c.workDir) rmSync(workDir, { recursive: true, force: true });
  }
};
