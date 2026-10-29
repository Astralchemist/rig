// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';
import { CLI, cliEnv, runCli } from './support/cli.ts';

// End to end: `rig hook <event>` as Claude Code runs it — JSON on stdin, a
// synthetic transcript JSONL, a temporary HOME and project. Nothing here
// touches the real user's config.

interface HookRun {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

const SID = 'e2e-session-1';

// Claude Code transcript lines (the shapes claude-transcript.ts reads).
const userLine = (text: string): string =>
  JSON.stringify({ type: 'user', sessionId: SID, message: { role: 'user', content: text } });
const assistantText = (text: string): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId: SID,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
const toolUse = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
const toolResult = (id: string, content: string, isError = false): string =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  });
const meta = (text: string): string =>
  JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: text } });

describe('rig hook (Claude Code, end to end)', () => {
  let base: string;
  let home: string;
  let project: string;
  let transcript: string;

  const hook = (event: string, input: Record<string, unknown>, cwd = project): HookRun => {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [CLI, 'hook', event, '--client', 'claude'], {
      cwd,
      env: { ...cliEnv(home), CLAUDE_PROJECT_DIR: cwd },
      input: JSON.stringify({
        session_id: SID,
        transcript_path: transcript,
        cwd,
        hook_event_name: event,
        ...input,
      }),
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return {
      code: r.status ?? -1,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      ms: performance.now() - t0,
    };
  };

  const waypoints = async (): Promise<{ kind: string; summary: string; source?: string }[]> => {
    const rig = await Rig.open(project, { embedder: new DeterministicEmbedder() });
    try {
      return rig.getWaypoints({ source: 'hook' });
    } finally {
      rig.close();
    }
  };

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'rig-hooks-')));
    home = join(base, 'home');
    project = join(base, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src/cache.ts'), 'export function loadCache() { return 1; }\n');
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    rig.close();
    // No model download in tests: the hook opens the graph with this embedder.
    writeFileSync(
      join(project, '.rig/config.json'),
      JSON.stringify({ embedder: { kind: 'deterministic' } }),
    );
    transcript = join(home, '.claude/projects/p/e2e-session-1.jsonl');
    mkdirSync(join(home, '.claude/projects/p'), { recursive: true });
    writeFileSync(transcript, '');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('a session: spool, capture on Stop, queue on SessionEnd, brief on SessionStart', async () => {
    // Turn 1: a proposal, approved, then implemented.
    appendFileSync(
      transcript,
      [
        meta('<system-reminder>Never use emojis.</system-reminder>'),
        userLine('the cache reload is slow'),
        assistantText(
          'loadCache() re-reads the file each time. I suggest we memoize `loadCache` in src/cache.ts and invalidate on write. Should I do that?',
        ),
        userLine('yes, go ahead'),
        toolUse('t1', 'Edit', { file_path: join(project, 'src/cache.ts') }),
        toolResult('t1', 'ok'),
        assistantText('Done.'),
      ].join('\n') + '\n',
    );
    const prompt = hook('UserPromptSubmit', { prompt: 'yes, go ahead' });
    expect(prompt.code).toBe(0);
    expect(prompt.stdout).toBe('');
    const post = hook('PostToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: join(project, 'src/cache.ts') },
      tool_response: { success: true },
      tool_use_id: 't1',
    });
    expect(post.code).toBe(0);
    const spool = readFileSync(join(project, '.rig/capture/spool/e2e-session-1.jsonl'), 'utf-8');
    expect(
      spool
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).type),
    ).toEqual(['user', 'tool_call', 'tool_result']);

    const stop1 = hook('Stop', { last_assistant_message: 'Done.' });
    expect(stop1.code).toBe(0);
    let wps = await waypoints();
    expect(wps.map((w) => w.kind)).toEqual(['decision']);
    expect(wps[0]!.summary).toContain('Memoize `loadCache` in src/cache.ts');

    // Turn 2: a constraint and a declined tool call. Stop again only reads
    // what is new (the approval is not stored twice).
    appendFileSync(
      transcript,
      [
        userLine(
          'Never touch the vendored files under vendor/. Also, the API key is OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx1234',
        ),
        assistantText('Understood. Let me push the branch so CI runs.'),
        toolUse('t2', 'Bash', { command: 'git push origin main' }),
        toolResult(
          't2',
          "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nnot to main, open a PR from a branch instead",
        ),
      ].join('\n') + '\n',
    );
    const stop2 = hook('Stop', {});
    expect(stop2.code).toBe(0);
    wps = await waypoints();
    expect(wps.map((w) => w.kind).sort()).toEqual(['constraint', 'dead-end', 'decision']);
    expect(wps.find((w) => w.kind === 'constraint')!.summary).toContain('vendor/');
    // The declined push (the user's reason is its rationale).
    expect(wps.find((w) => w.kind === 'dead-end')!.summary).toContain('Declined: push the branch');
    // Nothing secret reached the graph or the capture state.
    for (const f of ['.rig/rig.db', '.rig/rig.db-wal', '.rig/capture/cursors/e2e-session-1.json']) {
      const p = join(project, f);
      if (existsSync(p))
        expect(readFileSync(p).toString('latin1')).not.toContain('abcdefghijklmnopqrstuvwx1234');
    }

    // A Stop with nothing new stores nothing.
    expect(hook('Stop', {}).code).toBe(0);
    expect(await waypoints()).toHaveLength(3);

    // SessionEnd only queues.
    const end = hook('SessionEnd', { reason: 'prompt_input_exit' });
    expect(end.code).toBe(0);
    expect(readdirSync(join(project, '.rig/capture/queue'))).toEqual(['e2e-session-1.json']);

    // The next session starts: the queue is drained and the brief injected.
    const start = hook('SessionStart', { session_id: 'e2e-session-2', source: 'startup' });
    expect(start.code).toBe(0);
    const out = JSON.parse(start.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const brief = out.hookSpecificOutput.additionalContext;
    expect(brief.length).toBeLessThanOrEqual(1500);
    expect(brief).toContain('Settled in previous sessions in this project');
    expect(brief).toContain('Memoize `loadCache`');
    expect(brief).toContain('vendor/');
    expect(readdirSync(join(project, '.rig/capture/queue'))).toEqual([]);
    expect(existsSync(join(project, '.rig/capture/spool/e2e-session-1.jsonl'))).toBe(false);
  });

  test('never fails the agent: bad input, missing transcript, outside a project', () => {
    const bad = spawnSync(process.execPath, [CLI, 'hook', 'Stop'], {
      cwd: project,
      env: { ...cliEnv(home), CLAUDE_PROJECT_DIR: project },
      input: '{not json',
      encoding: 'utf-8',
    });
    expect(bad.status).toBe(0);
    expect(readFileSync(join(project, '.rig/capture/hook.log'), 'utf-8')).toContain('"error"');

    expect(hook('Stop', { transcript_path: join(base, 'missing.jsonl') }).code).toBe(0);
    expect(hook('Bogus', {}).code).toBe(0);

    const outside = join(base, 'elsewhere');
    mkdirSync(outside);
    const r = hook('SessionStart', { source: 'startup' }, outside);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(join(outside, '.rig'))).toBe(false);
  });

  test('without a transcript the spool is captured', async () => {
    hook('UserPromptSubmit', {
      prompt: 'From now on, every migration needs a rollback script.',
      transcript_path: undefined,
    });
    const r = hook('Stop', { transcript_path: undefined, last_assistant_message: 'Noted.' });
    expect(r.code).toBe(0);
    const wps = await waypoints();
    expect(wps.map((w) => w.kind)).toEqual(['constraint']);
  });

  test('RIG_CAPTURE=0 switches capture off', () => {
    const r = spawnSync(process.execPath, [CLI, 'hook', 'UserPromptSubmit'], {
      cwd: project,
      env: { ...cliEnv(home), CLAUDE_PROJECT_DIR: project, RIG_CAPTURE: '0' },
      input: JSON.stringify({ session_id: SID, prompt: 'Never do X.' }),
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(project, '.rig/capture'))).toBe(false);
  });

  test('install writes the hooks into .claude/settings.json; --no-hooks and uninstall take them out', () => {
    const settings = join(project, '.claude/settings.json');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const userHook = { type: 'command', command: './scripts/lint.sh' };
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [userHook] }] },
        permissions: { allow: ['Bash(ls)'] },
      }),
    );
    expect(runCli(['install', 'claude'], { cwd: project, home }).code).toBe(0);
    const s = JSON.parse(readFileSync(settings, 'utf-8'));
    expect(Object.keys(s.hooks).sort()).toEqual(
      [
        'PostToolUse',
        'PreCompact',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ].sort(),
    );
    expect(s.hooks.Stop[0].hooks).toEqual([userHook]);
    expect(s.hooks.Stop[1].hooks[0]).toMatchObject({
      command: 'rig hook Stop --client claude',
      async: true,
    });
    expect(s.hooks.SessionStart[0].matcher).toBe('startup|resume|compact');

    // Re-install: unchanged.
    const again = runCli(['install', 'claude'], { cwd: project, home });
    expect(again.stdout).not.toMatch(/wrote .*settings\.json/);
    expect(readFileSync(settings, 'utf-8')).toBe(JSON.stringify(s, null, 2) + '\n');

    // --no-hooks opts out: rig's hooks go, the user's stays.
    const off = runCli(['install', 'claude', '--no-hooks'], { cwd: project, home });
    expect(off.stdout).toContain('6 rig hooks');
    const s2 = JSON.parse(readFileSync(settings, 'utf-8'));
    expect(s2.hooks).toEqual({ Stop: [{ hooks: [userHook] }] });

    runCli(['install', 'claude'], { cwd: project, home });
    expect(runCli(['uninstall', 'claude'], { cwd: project, home }).code).toBe(0);
    const s3 = JSON.parse(readFileSync(settings, 'utf-8'));
    expect(s3).toEqual({
      hooks: { Stop: [{ hooks: [userHook] }] },
      permissions: { allow: ['Bash(ls)'] },
    });
    // The temporary HOME got no Claude config of rig's.
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
    expect(existsSync(join(home, '.claude/settings.json'))).toBe(false);
  });
});
