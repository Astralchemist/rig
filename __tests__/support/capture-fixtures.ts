// SPDX-License-Identifier: Apache-2.0
import type { ConversationEvent, SettledKind } from '@rig/core/capture/types.ts';

// Dev fixtures for the settled-moment extractor: realistic coding-chat
// snippets, positive and negative, including false-positive traps ("no
// problem", a question that only contains "should we", quoted text). Written
// from general conversational patterns, not from any benchmark task.

export interface ExpectedRecord {
  kind: SettledKind;
  // A lower-case fragment the summary must contain.
  includes: string;
}

export interface CaptureFixture {
  name: string;
  events: ConversationEvent[];
  expect: ExpectedRecord[];
}

const u = (text: string): ConversationEvent => ({ type: 'user', text });
const a = (text: string): ConversationEvent => ({ type: 'assistant', text });
const call = (name: string, input: Record<string, unknown>, id?: string): ConversationEvent => ({
  type: 'tool_call',
  name,
  input,
  ...(id ? { id } : {}),
});
const res = (output: string, isError = false, id?: string): ConversationEvent => ({
  type: 'tool_result',
  output,
  is_error: isError,
  ...(id ? { id } : {}),
});

export const CAPTURE_FIXTURES: CaptureFixture[] = [
  // ── agreed ────────────────────────────────────────────────────────────────
  {
    name: 'yes to a cache proposal',
    events: [
      u('the /search endpoint is slow on big repos'),
      a(
        'The hot path re-reads the index from disk on every request. I suggest we keep an in-memory LRU cache in `src/search/cache.ts`, invalidated on sync. Should I implement that?',
      ),
      u('yes'),
      call('Edit', { file_path: '/repo/src/search/cache.ts', old_string: 'a', new_string: 'b' }),
    ],
    expect: [{ kind: 'agreed', includes: 'in-memory lru cache' }],
  },
  {
    name: 'go ahead after want-me-to',
    events: [
      a('Want me to switch the date parsing from moment to date-fns in utils/date.ts?'),
      u('go ahead'),
    ],
    expect: [{ kind: 'agreed', includes: 'date-fns' }],
  },
  {
    name: 'sounds good to a recommendation',
    events: [
      a(
        'Both work. I would recommend storing the session tokens in an httpOnly cookie rather than localStorage, since it keeps them out of reach of injected scripts. Does that sound good?',
      ),
      u('sounds good, thanks'),
    ],
    expect: [{ kind: 'agreed', includes: 'httponly cookie' }],
  },
  {
    name: 'merge it after ready to merge',
    events: [
      a(
        'All checks are green on the `fix/retry-backoff` branch. Ready to merge the retry backoff fix into main?',
      ),
      u('merge it'),
    ],
    expect: [{ kind: 'agreed', includes: 'retry backoff' }],
  },
  {
    name: 'option pick from a list',
    events: [
      a(
        'Two ways to handle the migration:\n\nA) Add a nullable `archived_at` column and backfill lazily.\nB) Create a separate `archived_projects` table and move rows on archive.\n\nWhich do you prefer?',
      ),
      u('option A'),
    ],
    expect: [{ kind: 'agreed', includes: 'nullable' }],
  },
  {
    name: 'the second one',
    events: [
      a(
        'Options:\n1. Keep polling every 5s\n2. Switch the dashboard to server-sent events from /api/stream\n3. Use a websocket',
      ),
      u("let's go with the second one"),
    ],
    expect: [{ kind: 'agreed', includes: 'server-sent events' }],
  },
  {
    name: 'generic question takes the plan before it',
    events: [
      a(
        "Here's the plan:\n- Move the retry logic into `fetchWithRetry` in src/http/client.ts\n- Cap retries at 3 with jittered backoff\n\nShall I go ahead?",
      ),
      u('yep, do it'),
    ],
    expect: [{ kind: 'agreed', includes: 'fetchwithretry' }],
  },
  {
    name: 'lgtm on approach',
    events: [
      a(
        'I propose we validate the webhook signature in middleware before the JSON body parser runs.',
      ),
      u('lgtm'),
    ],
    expect: [{ kind: 'agreed', includes: 'webhook signature' }],
  },
  {
    name: 'approval with extra constraint',
    events: [
      a('Should I regenerate the API client from the OpenAPI spec?'),
      u("yes, but don't touch the hand-written wrappers in src/api/custom/"),
    ],
    expect: [
      { kind: 'agreed', includes: 'regenerate the api client' },
      { kind: 'constraint', includes: 'hand-written wrappers' },
    ],
  },
  {
    name: 'permission approved after proposal',
    events: [
      a(
        'I can remove the deprecated `legacyAuth` module now that nothing imports it. Okay to proceed?',
      ),
      call('Bash', { command: 'git rm -r src/legacyAuth' }, 't1'),
      { type: 'permission', id: 't1', tool: 'Bash', decision: 'approved' },
    ],
    expect: [{ kind: 'agreed', includes: 'legacyauth' }],
  },

  // ── rejected ──────────────────────────────────────────────────────────────
  {
    name: 'plain no to a proposal',
    events: [
      a('Do you want me to add Redis as a session store so sessions survive restarts?'),
      u("no, we can't run extra infrastructure on the free tier"),
    ],
    expect: [{ kind: 'rejected', includes: 'redis' }],
  },
  {
    name: 'revert after an edit',
    events: [
      u('can you tidy up the logger setup?'),
      a('Let me inline the logger config into the app bootstrap.'),
      call('Edit', { file_path: '/repo/src/bootstrap.ts', old_string: 'x', new_string: 'y' }),
      res('ok'),
      a('Done — the logger config now lives in bootstrap.ts.'),
      u('revert that, the config file is read by the ops tooling too'),
    ],
    expect: [{ kind: 'rejected', includes: 'logger config' }],
  },
  {
    name: 'permission denied with reason',
    events: [
      a('Let me push the branch so CI runs.'),
      call('Bash', { command: 'git push origin feat/billing' }, 'p1'),
      {
        type: 'permission',
        id: 'p1',
        tool: 'Bash',
        decision: 'denied',
        reason: 'not yet, I want to squash the commits first',
      },
    ],
    expect: [{ kind: 'rejected', includes: 'push the branch' }],
  },
  {
    name: 'stated ruled out',
    events: [u('GraphQL was rejected because the mobile team needs plain REST caching.')],
    expect: [{ kind: 'rejected', includes: 'graphql was rejected' }],
  },
  {
    name: 'decided against',
    events: [
      u('fyi we decided against server-side rendering for the admin panel, it is internal only'),
    ],
    expect: [{ kind: 'rejected', includes: 'server-side rendering' }],
  },

  // ── correction ────────────────────────────────────────────────────────────
  {
    name: 'no use X instead',
    events: [
      a('I will add the dependency with `npm install zod`.'),
      u('no, use pnpm instead, this repo is a pnpm workspace'),
    ],
    expect: [{ kind: 'correction', includes: 'use pnpm instead' }],
  },
  {
    name: 'instead of X, Y',
    events: [
      u(
        'instead of mocking the database in these tests, use the sqlite in-memory fixture from test/helpers.ts',
      ),
    ],
    expect: [{ kind: 'correction', includes: 'sqlite in-memory fixture' }],
  },
  {
    name: 'no then directive',
    events: [
      a('Should I put the formatter in `src/components/Price.tsx`?'),
      u('no, put it in src/lib/format.ts so the API can reuse it'),
    ],
    expect: [{ kind: 'correction', includes: 'src/lib/format.ts' }],
  },
  {
    name: 'dont use X, use Y',
    events: [u("don't use axios, use the built-in fetch")],
    expect: [{ kind: 'correction', includes: 'built-in fetch' }],
  },
  {
    name: 'rather than',
    events: [u('Return a Result type rather than throwing from parseConfig().')],
    expect: [{ kind: 'correction', includes: 'result type' }],
  },

  // ── constraint ────────────────────────────────────────────────────────────
  {
    name: 'never edit generated',
    events: [u('Never edit files under generated/ by hand, they come from `bun run gen`.')],
    expect: [{ kind: 'constraint', includes: 'generated/' }],
  },
  {
    name: 'always run typecheck',
    events: [u('always run the typecheck before you commit')],
    expect: [{ kind: 'constraint', includes: 'typecheck' }],
  },
  {
    name: 'must stay compatible',
    events: [u('The public API of the SDK must stay backwards compatible until v3.')],
    expect: [{ kind: 'constraint', includes: 'backwards compatible' }],
  },
  {
    name: 'only touch',
    events: [u('Only change files in packages/parser for this task.')],
    expect: [{ kind: 'constraint', includes: 'packages/parser' }],
  },
  {
    name: 'from now on',
    events: [u('from now on, every migration needs a rollback script')],
    expect: [{ kind: 'constraint', includes: 'rollback script' }],
  },
  {
    name: 'dont touch mid sentence',
    events: [
      u(
        'Fix the flaky test in auth.test.ts and do not modify the retry helper while you are at it.',
      ),
    ],
    expect: [{ kind: 'constraint', includes: 'retry helper' }],
  },
  {
    name: 'make sure',
    events: [u('Make sure the CLI still works under Node 20, a lot of users are on it.')],
    expect: [{ kind: 'constraint', includes: 'node 20' }],
  },

  // ── decision ──────────────────────────────────────────────────────────────
  {
    name: 'we decided',
    events: [u('We decided to keep the monorepo on Bun workspaces instead of moving to Nx.')],
    expect: [{ kind: 'decision', includes: 'bun workspaces' }],
  },
  {
    name: 'we went with',
    events: [u('For auth we went with Lucia, the OAuth flows are already wired up.')],
    expect: [{ kind: 'decision', includes: 'lucia' }],
  },
  {
    name: 'lets go with',
    events: [u("let's go with SQLite for the local cache, Postgres is overkill here")],
    expect: [{ kind: 'decision', includes: 'sqlite' }],
  },
  {
    name: 'we are keeping',
    events: [
      u("We're keeping the REST endpoints for v1 and only adding gRPC for internal services."),
    ],
    expect: [{ kind: 'decision', includes: 'rest endpoints' }],
  },

  // ── dead-end ──────────────────────────────────────────────────────────────
  {
    name: 'failed attempt abandoned with recovery',
    events: [
      u('the build is failing on the worker bundle'),
      a("Let me try bumping esbuild's target to es2022 in build.config.ts."),
      call('Bash', { command: 'bun run build' }, 'b1'),
      res(
        'error: Top-level await is not available in the configured target environment',
        true,
        'b1',
      ),
      a(
        "That approach doesn't work — the worker runtime rejects top-level await. I'll move the init into an async main() instead.",
      ),
      call('Bash', { command: 'bun run build' }, 'b2'),
      res('Build succeeded in 1.2s', false, 'b2'),
    ],
    expect: [{ kind: 'dead-end', includes: 'es2022' }],
  },
  {
    name: 'failed then reverted',
    events: [
      u('tests are slow, can you parallelize them?'),
      a('I will enable the parallel runner in vitest.config.ts.'),
      call('Edit', { file_path: '/repo/vitest.config.ts', old_string: 'a', new_string: 'b' }),
      res('ok'),
      call('Bash', { command: 'npx vitest run' }, 'v1'),
      res('Tests: 14 failed, 120 passed\nError: database is locked', false, 'v1'),
      a('The shared sqlite file cannot handle parallel workers.'),
      call('Bash', { command: 'git checkout -- vitest.config.ts' }),
      res(''),
    ],
    expect: [{ kind: 'dead-end', includes: 'parallel runner' }],
  },

  // ── traps (no record expected) ────────────────────────────────────────────
  {
    name: 'trap: no problem',
    events: [a('Sorry, I misread the stack trace earlier.'), u('no problem, thanks!')],
    expect: [],
  },
  {
    name: 'trap: question containing should we',
    events: [u('Should we use Redis here or is that overkill?')],
    expect: [],
  },
  {
    name: 'trap: quoted never',
    events: [u('The docs say "never call flush() in a hot loop" — is that still true for v4?')],
    expect: [],
  },
  {
    name: 'trap: quote block',
    events: [u('> Always validate input at the boundary\n\nwhere did this comment come from?')],
    expect: [],
  },
  {
    name: 'trap: ok after a report',
    events: [a('I fixed the off-by-one in paginate() and all tests pass now.'), u('ok')],
    expect: [],
  },
  {
    name: 'trap: thanks after a proposal',
    events: [a('Want me to also update the README?'), u('great, thanks')],
    expect: [],
  },
  {
    name: 'trap: dont worry',
    events: [u("don't worry about the lint warnings for now")],
    expect: [],
  },
  {
    name: 'trap: speculation with must',
    events: [u('it must be the cache that is stale, the data looks old')],
    expect: [],
  },
  {
    name: 'trap: only describing a symptom',
    events: [u('the test only fails on CI, never locally')],
    expect: [],
  },
  {
    name: 'trap: code block with never',
    events: [u('what does this do?\n```ts\n// never do this in prod\nprocess.exit(1)\n```')],
    expect: [],
  },
  {
    name: 'trap: wait question',
    events: [a('I removed the unused exports.'), u('wait, why did the build size go up?')],
    expect: [],
  },
  {
    name: 'trap: yes to a factual question',
    events: [a('Is this the file you meant: src/router.ts?'), u('yes')],
    expect: [],
  },
  {
    name: 'trap: no to a factual question',
    events: [a('Do you have Docker installed locally?'), u('no')],
    expect: [],
  },
  {
    name: 'trap: test fails then fixed normally',
    events: [
      a('Let me run the tests.'),
      call('Bash', { command: 'bun test' }, 'r1'),
      res('3 fail\n42 pass', false, 'r1'),
      a('The failures are a missing await in loadUser(). Fixing that.'),
      call('Edit', { file_path: '/repo/src/user.ts', old_string: 'a', new_string: 'b' }),
      res('ok'),
      call('Bash', { command: 'bun test' }, 'r2'),
      res('45 pass\n0 fail', false, 'r2'),
    ],
    expect: [],
  },
  {
    name: 'trap: hypothetical always',
    events: [u('What if we always retried failed uploads?')],
    expect: [],
  },
  {
    name: 'trap: lets look',
    events: [u("let's look at the parser next")],
    expect: [],
  },
  {
    name: 'trap: reported speech',
    events: [
      u(
        'the error message says you must not call setState during render, any idea which component?',
      ),
    ],
    expect: [],
  },
  {
    name: 'trap: not sure',
    events: [
      a('Should I bump the minimum Node version to 22?'),
      u('not sure yet, let me check with the team'),
    ],
    expect: [],
  },
  {
    name: 'trap: never seen',
    events: [u("I've never seen this error before, it started after the upgrade")],
    expect: [],
  },
  {
    name: 'trap: interrupted marker',
    events: [a('Should I delete the old migrations?'), u('[Request interrupted by user]')],
    expect: [],
  },
];
