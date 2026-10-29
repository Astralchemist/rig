// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { extractSettled } from '@rig/core/capture/extractor.ts';
import { filesIn, mask, symbolsIn } from '@rig/core/capture/text.ts';
import type { ConversationEvent } from '@rig/core/capture/types.ts';
import { CAPTURE_FIXTURES } from './support/capture-fixtures.ts';
import { scoreFixtures } from './support/capture-score.ts';

const u = (text: string): ConversationEvent => ({ type: 'user', text });
const a = (text: string): ConversationEvent => ({ type: 'assistant', text });

describe('settled-moment extractor', () => {
  test('dev fixtures: precision and recall', () => {
    expect(CAPTURE_FIXTURES.length).toBeGreaterThanOrEqual(30);
    const s = scoreFixtures(CAPTURE_FIXTURES);
    const misses = s.outcomes
      .filter((o) => o.fp.length || o.fn.length)
      .map(
        (o) =>
          `${o.name}: fp=${o.fp.map((r) => r.summary).join(' | ')} fn=${o.fn.map((e) => e.includes).join(' | ')}`,
      );
    expect(misses).toEqual([]);
    expect(s.precision).toBeGreaterThanOrEqual(0.9);
    expect(s.recall).toBeGreaterThanOrEqual(0.85);
  });

  test('every record is well formed', () => {
    for (const f of CAPTURE_FIXTURES) {
      for (const r of extractSettled({ session_id: 's', events: f.events })) {
        expect(r.summary.length).toBeGreaterThan(0);
        expect(r.summary.length).toBeLessThanOrEqual(200);
        expect(r.rationale.length).toBeLessThanOrEqual(300);
        expect(r.confidence).toBeGreaterThan(0);
        expect(r.confidence).toBeLessThanOrEqual(0.95);
        expect(r.span.from).toBeLessThanOrEqual(r.span.to);
        expect(r.span.to).toBeLessThan(f.events.length);
      }
    }
  });

  test('is deterministic', () => {
    const events = CAPTURE_FIXTURES.flatMap((f) => f.events);
    const once = JSON.stringify(extractSettled({ session_id: 's', events }));
    expect(JSON.stringify(extractSettled({ session_id: 's', events }))).toBe(once);
  });

  test('offset and emit_from: context events are read, not re-emitted', () => {
    const events = [
      u('Never commit directly to main.'),
      a('Should I squash the fixup commits before opening the PR?'),
      u('yes'),
    ];
    const all = extractSettled({ session_id: 's', events, offset: 10 });
    expect(all.map((r) => r.kind).sort()).toEqual(['agreed', 'constraint']);
    expect(all.find((r) => r.kind === 'agreed')!.span).toEqual({ from: 11, to: 12 });
    // Incremental run: the first two events were already processed; the
    // proposal is still context for the approval.
    const tail = extractSettled({ session_id: 's', events, offset: 10, emit_from: 12 });
    expect(tail.map((r) => r.kind)).toEqual(['agreed']);
    expect(tail[0]!.summary).toContain('Squash the fixup commits');
  });

  test('approval anchors include the files the assistant then edited', () => {
    const [r] = extractSettled({
      session_id: 's',
      events: [
        a('Want me to move the retry policy into its own module?'),
        u('please do'),
        { type: 'tool_call', name: 'Write', input: { file_path: '/p/src/retry-policy.ts' } },
        { type: 'tool_result', output: 'ok' },
        u('thanks'),
        { type: 'tool_call', name: 'Write', input: { file_path: '/p/src/unrelated.ts' } },
      ],
    });
    expect(r!.kind).toBe('agreed');
    expect(r!.anchors.files).toEqual(['/p/src/retry-policy.ts']);
    expect(r!.span).toEqual({ from: 0, to: 2 });
  });

  test('a long message lowers confidence', () => {
    const filler = 'Context about the service and its history. '.repeat(25);
    const [short] = extractSettled({ session_id: 's', events: [u('Never log request bodies.')] });
    const [long] = extractSettled({
      session_id: 's',
      events: [u(`${filler}\nNever log request bodies.`)],
    });
    expect(long!.confidence).toBeLessThan(short!.confidence);
  });

  test('host-injected blocks and quotes do not fire', () => {
    expect(
      extractSettled({
        session_id: 's',
        events: [
          u(
            '<system-reminder>Never use emojis. Always answer in English.</system-reminder>\nwhat is in this file?',
          ),
          u('<command-name>/clear</command-name>'),
          u('he wrote "we decided to drop Python 3.8" in the issue — is that accurate?'),
        ],
      }),
    ).toEqual([]);
  });

  test('permission denial with a correction becomes a correction', () => {
    const recs = extractSettled({
      session_id: 's',
      events: [
        a('Let me install the dependency.'),
        { type: 'tool_call', id: 't', name: 'Bash', input: { command: 'npm install lodash' } },
        {
          type: 'permission',
          id: 't',
          tool: 'Bash',
          decision: 'denied',
          reason: 'use pnpm instead. Never run npm in this repo.',
        },
      ],
    });
    expect(recs.map((r) => r.kind).sort()).toEqual(['constraint', 'correction']);
    expect(recs.find((r) => r.kind === 'correction')!.summary).toContain('Use pnpm instead');
  });

  test('mask restores inline code and drops fences', () => {
    const m = mask('use `fooBar()` here\n```\nnever\n```\n"quoted never"');
    expect(m.text).not.toContain('never');
    expect(m.restore(m.text)).toContain('`fooBar()`');
    expect(m.restore(m.text)).toContain('"quoted never"');
  });

  test('anchors: files, directories and symbols', () => {
    expect(filesIn('see src/a/b.ts, ./c.py and `generated/` but not 1.2.3 or and/or')).toEqual([
      'src/a/b.ts',
      './c.py',
      'generated/',
    ]);
    expect(symbolsIn('call `Store.load()` from handleLogin and parse_args() ok')).toEqual([
      'Store.load',
      'handleLogin',
      'parse_args',
    ]);
  });
});
