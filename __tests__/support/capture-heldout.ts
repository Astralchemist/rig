// SPDX-License-Identifier: Apache-2.0
import type { ConversationEvent } from '@rig/core/capture/types.ts';
import type { CaptureFixture } from './capture-fixtures.ts';

// Held-out fixtures, written after the extractor was frozen (9cb1f2a) and
// scored without changing it. Their precision and recall estimate how the
// rules generalise beyond the dev set they were tuned on; misses here are
// recorded, not fixed.

const u = (text: string): ConversationEvent => ({ type: 'user', text });
const a = (text: string): ConversationEvent => ({ type: 'assistant', text });

export const CAPTURE_HELDOUT: CaptureFixture[] = [
  {
    name: 'held-out: yeah to a rename',
    events: [
      a(
        '`getUsr` is used in four places. Should I rename it to `getUser` everywhere, including the tests?',
      ),
      u('yeah please'),
    ],
    expect: [{ kind: 'agreed', includes: 'getuser' }],
  },
  {
    name: 'held-out: approval with a reason',
    events: [
      a('I recommend pinning `typescript` to 5.4 until the decorator regression is fixed.'),
      u('agreed, the 5.5 build broke our decorators too'),
    ],
    expect: [{ kind: 'agreed', includes: 'pinning' }],
  },
  {
    name: 'held-out: nah to a proposal',
    events: [
      a('Would you like me to convert the config loader to async?'),
      u('nah, it runs once at startup, sync is fine'),
    ],
    expect: [{ kind: 'rejected', includes: 'config loader' }],
  },
  {
    name: 'held-out: correction with switch to',
    events: [u('switch to vitest instead, jest is too slow with ESM here')],
    expect: [{ kind: 'correction', includes: 'vitest' }],
  },
  {
    name: 'held-out: correction actually',
    events: [
      a('I will store the feature flags in a JSON file under config/.'),
      u('actually, use environment variables rather than a JSON file'),
    ],
    expect: [{ kind: 'correction', includes: 'environment variables' }],
  },
  {
    name: 'held-out: do not commit secrets',
    events: [u('Do not commit the .env file, ever.')],
    expect: [{ kind: 'constraint', includes: '.env' }],
  },
  {
    name: 'held-out: tests must pass',
    events: [u('Every PR must keep the coverage above 80%.')],
    expect: [{ kind: 'constraint', includes: 'coverage' }],
  },
  {
    name: 'held-out: avoid',
    events: [u('Avoid adding new runtime dependencies to the core package.')],
    expect: [{ kind: 'constraint', includes: 'runtime dependencies' }],
  },
  {
    name: 'held-out: we chose',
    events: [u('We chose Postgres advisory locks over Redis locks for the job queue.')],
    expect: [{ kind: 'decision', includes: 'advisory locks' }],
  },
  {
    name: 'held-out: decision stated mid paragraph',
    events: [
      u(
        'Quick background before you start. The service used to be in Python. We have decided to keep the ingestion worker in Go because of memory use. Please look at the retry bug in worker/retry.go.',
      ),
    ],
    expect: [{ kind: 'decision', includes: 'ingestion worker in go' }],
  },
  {
    name: 'held-out: dead end with different approach',
    events: [
      a('Let me try fixing the import cycle with a lazy require in src/plugins/index.ts.'),
      { type: 'tool_call', id: 'x', name: 'Bash', input: { command: 'bun test plugins' } },
      {
        type: 'tool_result',
        id: 'x',
        output: 'ReferenceError: Cannot access registry before initialization',
        is_error: true,
      },
      a(
        'The lazy require did not help. I will take a different approach and split the registry into its own module.',
      ),
    ],
    expect: [{ kind: 'dead-end', includes: 'lazy require' }],
  },
  {
    name: 'held-out trap: no worries',
    events: [a('Apologies for the confusion about the port.'), u('no worries')],
    expect: [],
  },
  {
    name: 'held-out trap: should we keep, as a question without mark',
    events: [u('should we keep the legacy endpoint around for another release')],
    expect: [],
  },
  {
    name: 'held-out trap: user pastes a log',
    events: [
      u(
        'here is the output:\n```\nERROR: you must not run this as root\nFAILED 3 tests\n```\nany idea?',
      ),
    ],
    expect: [],
  },
  {
    name: 'held-out trap: sure as filler',
    events: [a('The parser now handles trailing commas.'), u('sure, what about comments?')],
    expect: [],
  },
  {
    name: 'held-out trap: always in a description',
    events: [u('the job always times out after 30 seconds on staging')],
    expect: [],
  },
  {
    name: 'held-out trap: let us check',
    events: [u("let's check the logs first")],
    expect: [],
  },
];
